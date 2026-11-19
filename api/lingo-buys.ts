import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list, del } from '@vercel/blob';

/**
 * /api/lingo-buys — watches the buy-and-stake wallet for incoming USDC and
 * posts each buy to Slack (#lingo-buys) with the day's, month's, last 30 days'
 * and all-time totals, the average buy, and the average LINGO price paid
 * ("$26,327.51 @ $0.0147").
 *
 * Cron: every 2 minutes (vercel.json). Each run is one eth_blockNumber plus one
 * eth_getLogs (~85 CU). The LINGO price is only fetched when a buy is posted.
 *
 * PRICES. The app pins each direct buy at CoinGecko's LINGO price the moment the
 * USDC lands (staking-api otc.service.ts → lingoMarketDataService), so every
 * buy is priced from CoinGecko too: the live price when it is claimed within
 * minutes of landing (Alchemy's price if CoinGecko is down), and CoinGecko's
 * history at the moment it landed when it is picked up late (after a stall) or
 * when totals are rebuilt from the chain. That history matched the app's pinned
 * price on all 327 buys to Nov 19 2026 within 0.08% (median); the pool's own
 * hourly VWAP ran ~0.6% high. The average price is the true average cost: total
 * USDC ÷ total LINGO bought over the buys that have a price, so "$X @ $p" means
 * X/p LINGO (a buy no price could be found for still counts in $X, just not in
 * the average). The app's admin panel shows a USDC-weighted mean of prices
 * instead, which reads ~1.6% higher.
 *
 * GENUINE USDC ONLY. This wallet is already targeted by address poisoning: a
 * lookalike "UṢDC" token (0x6c9458b7…, with a dotted Ṣ) sent minutes after each
 * real transfer from vanity addresses copying the real sender's first and last
 * characters, plus scam "claim" tokens whose Transfer events spoof the USDC
 * contract as `from`. So buys are read ONLY from logs EMITTED BY the real USDC
 * contracts (filtered on log address server-side), never matched by token name
 * or symbol, and amounts under MIN_USDC are ignored. The alert prints the FULL
 * sender address, because poisoning works by being identical once truncated.
 *
 * Destinations: Slack (LINGO_BUYS_SLACK_WEBHOOK_URL) and/or Telegram
 * (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). Both get the same buy. Delivery is
 * tracked PER CHANNEL: if one is down the buy is still counted and announced
 * on the other, and the retry only re-sends to the channel that missed it.
 * Adding a channel later does not replay history into it. Until at least one
 * is configured the job does nothing. The first configured run seeds
 * the totals from history and posts nothing, so there is no backlog spam.
 *
 * GET ?dryRun=1 (cron or admin auth): rebuild the totals from history and
 * render the message for the most recent buy — no post, no state written.
 *
 * GET ?replay=1&channel=telegram (cron or admin auth): re-send earlier buys to
 * one channel — for a channel added after the fact. Each message is marked as a
 * backfill and shows the totals as they stood at that buy. Totals and delivery
 * state are NOT touched, so nothing is double-counted. Bounded by `limit`
 * (default 25) and paced to stay under Telegram's per-group rate limit.
 *
 * GET ?test=1 (cron or admin auth): post a clearly labelled TEST alert, built
 * from the most recent genuine USDC transfer (project wallets included), so the
 * channel can be checked without sending USDC. Never touches the totals.
 * Limited to one per TEST_COOLDOWN_MS, since it posts on demand.
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

// ── Base block clock ──
// Base made a block every 2s from genesis, and every 200ms from block
// 53,556,128 (2026-11-05 18:00:01 UTC). Convert between blocks and time with
// these, never with a fixed seconds-per-block. If Base changes block time
// again, add a segment here — and in every api/ file (they can't share code).
const BASE_CLOCK = [
  { block: 0, ts: 1_686_789_347, msPerBlock: 2_000 },
  { block: 53_556_127, ts: 1_793_901_601, msPerBlock: 200 },
] as const;
/** Timestamp (unix seconds) of a block, past or future. */
function blockToTs(block: number): number {
  let s: (typeof BASE_CLOCK)[number] = BASE_CLOCK[0];
  for (const seg of BASE_CLOCK) if (block >= seg.block) s = seg;
  return s.ts + Math.floor(((block - s.block) * s.msPerBlock) / 1000);
}
/** The block produced at (or just before) a unix-seconds time. */
function tsToBlock(ts: number): number {
  let s: (typeof BASE_CLOCK)[number] = BASE_CLOCK[0];
  for (const seg of BASE_CLOCK) if (ts >= seg.ts) s = seg;
  return Math.max(0, s.block + Math.floor(((ts - s.ts) * 1000) / s.msPerBlock));
}
const PRICES_URL = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/by-address`;
// CoinGecko's public API (no key). The app's own price comes from CoinGecko.
const COINGECKO_URL = 'https://api.coingecko.com/api/v3';
const COINGECKO_ID = 'lingo';
const PRICE_TIMEOUT_MS = 8_000;
const LIVE_PRICE_MAX_AGE_S = 30 * 60;     // an older CoinGecko quote falls back to Alchemy
// market_chart/range answers hourly for ranges up to 90 days (daily beyond), so
// history is fetched in chunks just under that. The public API keeps 365 days.
const HISTORY_CHUNK_S = 89 * 86_400;
const HISTORY_MAX_AGE_S = 360 * 86_400;   // older buys stay unpriced (left out of the averages)
const HISTORY_MAX_GAP_S = 3 * 3_600;      // a buy further than this from any price point stays unpriced
// `priced: 1` on a state = its price totals were built for every buy it counts
// (one no price could be found for is left out of the averages). A state
// without it (anything written before prices were added) is backfilled from
// CoinGecko's history once, in place — never by a cold start, which would
// silently absorb any buy that landed in between.
const PRICED_VERSION = 1;
const PRICE_BACKFILL_RETRY_S = 30 * 60;
// A buy claimed this long after it landed (the job stalled: Blob, RPC or cron
// down) is priced at CoinGecko's history for its landing time, not today's quote.
const LATE_CLAIM_S = 10 * 60;
const SLACK_URL = process.env.LINGO_BUYS_SLACK_WEBHOOK_URL || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const BUY_WALLET = '0x2bd8fc849f7c91ce2d3e9c78dd85792a0b14da6d';
// The ONLY contracts whose transfers count. Keyed by address, never by symbol.
const USDC_CONTRACTS: Record<string, string> = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',   // native USDC on Base
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC',  // bridged USDC on Base
};
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
// Count from go-live: the block right after the team's two test sends on
// 2026-09-18 ($1 at 0x3118912, $2 at 0x3119a60). That also skips everything
// earlier — the Nov-2025 Treasury test and the operator's own bridge-ins —
// which was funding, not user buys, and would otherwise distort the totals.
const START_BLOCK = 0x3119a61;
// USDC arriving from these is the project funding the wallet, not a buy.
const PROJECT_SENDERS = new Set([
  '0x0e0bc2919540119fc22a502842a74af4d81502b6', // Treasury
  '0x0fe275fdfde7eb75a15c0ae8971450dd6f06e7f8', // Project Safe
  '0x61f8d3fc749ecda98d378bc2cc8459ba0f7dfd58', // Team Multisig
  '0x7e3e2d6b8b87ce617b7ccdd63d0f5449e4057513', // Team Buybacks
  '0x69892fc8e176d9750e7f0ca06fc9aede0fc97bcb', // Team Buybacks
  '0xc588e4415ab61aa8a9496efbe9d715de75550e2a', // Deployer
  '0xe8313a4b7a6aaea9e92a8d4acbb08034cb39bf2f', // Team wallet
  '0xffc781ddfa8d1358ce8c7dda7ced1e56e922aea6', // Reward wallet
  '0x64967c0dd5605dd3efc6a9bb148b2687a532c15f', // Previous reward wallet
]);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MIN_USDC = 1;             // below this is dust / poisoning, not a buy
// v3 is a FOLDER of numbered, write-once state files, not one file rewritten in
// place. Vercel Blob serves public blobs from a CDN with a ~30-day max-age, and
// a `?t=` query string does not vary that cache, so an overwritten blob can
// still be served stale — measured at 141s, longer than the 2-minute cron
// period. On 2026-09-24 a run read a state that did not yet contain the buy the
// previous run had just announced, and announced it again on every channel.
// Numbered files are immutable, so a cached copy is always the right answer.
// Writing the next number with allowOverwrite:false is also a compare-and-swap:
// if two runs overlap, the second one's claim fails and it posts nothing.
const STATE_PREFIX = 'lingo-buys-state-v3/';
const LEGACY_STATE_KEY = 'lingo-buys-state-v2.json'; // adopted once, then unused
const STATE_KEEP = 5;           // older numbered states are pruned
const SEEN_LIMIT = 1000;        // rolling dedupe window of txHash:logIndex keys
const TEST_KEY = 'lingo-buys-test.json';
const TEST_COOLDOWN_MS = 5 * 60 * 1000;
const LOG_PAGE_LIMIT = 9500;
const MAX_REQUESTS = 60;
const SEND_TIMEOUT_MS = 10_000; // a channel gets this long to accept a message

interface Agg {
  micro: number;   // USDC in 6-decimal units (exact)
  count: number;
  /** USDC (micro) of the buys in here that have a price, and the LINGO they
   *  bought (USDC ÷ price). Average price = pMicro / 1e6 / lingo. A buy whose
   *  price could not be fetched is left out of these two, never of micro/count. */
  pMicro?: number;
  lingo?: number;
}
interface BuysState {
  lastBlock: number;
  seen: string[];
  /** key → channels that already have it. Missing = delivered everywhere
   *  (state written before multi-channel, or by a single-channel run). */
  delivered?: Record<string, string[]>;
  /** key → the LINGO price recorded when the buy was claimed, so a retry shows
   *  the same price as the first post and a backfill keeps live prices. */
  prices?: Record<string, number>;
  /** PRICED_VERSION once pMicro/lingo cover every counted buy. */
  priced?: number;
  /** Unix seconds before which a failed price backfill isn't retried. */
  pricedRetryAfter?: number;
  days: Record<string, Agg>;
  months: Record<string, Agg>;
  total: Agg;
}
interface Buy { key: string; txHash: string; from: string; token: string; micro: number; ts: number; block: number; logIndex: number }
interface RawLog {
  address: string; topics: string[]; data: string;
  blockNumber: string; blockTimestamp?: string; transactionHash: string; logIndex: string;
}

// ─── Blob state ──────────────────────────────────────────────────────────

/**
 * Read state, telling "there is none yet" apart from "we couldn't read it".
 * Collapsing both to null would turn a transient Blob error into a cold
 * start, which reseeds the totals and silently absorbs any buys that had
 * not been posted yet — a missed alert with no trace.
 */
async function readBlob<T>(key: string): Promise<{ data: T | null; error: boolean }> {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const match = token.match(/^vercel_blob_rw_([^_]+)_/);
  if (match) {
    try {
      const res = await fetch(`https://${match[1]}.public.blob.vercel-storage.com/${key}?t=${Date.now()}`);
      if (res.ok) return { data: (await res.json()) as T, error: false };
      if (res.status === 404) return { data: null, error: false };
    } catch { /* fall through to list() */ }
  }
  try {
    const { blobs } = await list({ prefix: key });
    if (blobs.length === 0) return { data: null, error: false };
    const res = await fetch(`${blobs[blobs.length - 1].url}?t=${Date.now()}`);
    if (!res.ok) return { data: null, error: true };
    return { data: (await res.json()) as T, error: false };
  } catch {
    return { data: null, error: true };
  }
}

/** Zero-padded so lexicographic order matches numeric order. */
const seqName = (n: number) => `${STATE_PREFIX}${String(n).padStart(12, '0')}.json`;
const seqOf = (pathname: string) => {
  const m = pathname.match(/(\d+)\.json$/);
  return m ? parseInt(m[1], 10) : -1;
};

/** Every numbered state file currently stored, oldest first. */
async function listStates(): Promise<Array<{ url: string; pathname: string; seq: number }>> {
  const out: Array<{ url: string; pathname: string; seq: number }> = [];
  let cursor: string | undefined;
  // Paginate: a page is capped, and with zero-padded names the FIRST page holds
  // the OLDEST entries, so taking the max of one page could miss the newest.
  do {
    const page = await list({ prefix: STATE_PREFIX, cursor });
    for (const b of page.blobs) {
      const seq = seqOf(b.pathname);
      if (seq >= 0) out.push({ url: b.url, pathname: b.pathname, seq });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * Read the newest state. `seq` is the number it was stored under; the next
 * write must be seq + 1. Numbered files are never rewritten, so this read is
 * not exposed to the CDN staleness that made a run re-announce a buy.
 */
async function readState(): Promise<{ state: BuysState | null; seq: number; error: boolean }> {
  let states: Array<{ url: string; seq: number }>;
  try {
    states = await listStates();
  } catch {
    return { state: null, seq: -1, error: true };
  }

  const newest = states[states.length - 1];
  if (!newest) {
    // One-time migration off the single rewritten v2 file, so the totals and
    // the dedupe window carry over instead of cold-starting.
    const legacy = await readBlob<BuysState>(LEGACY_STATE_KEY);
    if (legacy.error) return { state: null, seq: -1, error: true };
    return { state: legacy.data, seq: 0, error: false };
  }

  try {
    const res = await fetch(newest.url);
    if (!res.ok) return { state: null, seq: newest.seq, error: true };
    return { state: (await res.json()) as BuysState, seq: newest.seq, error: false };
  } catch {
    return { state: null, seq: newest.seq, error: true };
  }
}

/**
 * Write the next numbered state and return its number. THROWS if that number
 * already exists — which means another run claimed it first, and this run must
 * post nothing. Callers treat a throw as "stop", never as "carry on".
 */
async function saveState(state: BuysState, seq: number): Promise<number> {
  const next = seq + 1;
  const seen = state.seen.slice(-SEEN_LIMIT);
  const keep = new Set(seen);
  const delivered = Object.fromEntries(Object.entries(state.delivered ?? {}).filter(([k]) => keep.has(k)));
  const prices = Object.fromEntries(Object.entries(state.prices ?? {}).filter(([k]) => keep.has(k)));
  await put(seqName(next), JSON.stringify({ ...state, seen, delivered, prices, updatedAt: new Date().toISOString() }), {
    access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json',
  });
  return next;
}

/** Drop superseded state files. Best effort — never fails the run. */
async function pruneStates(keepFrom: number): Promise<void> {
  try {
    const stale = (await listStates()).filter(s => s.seq <= keepFrom - STATE_KEEP);
    if (stale.length) await del(stale.map(s => s.url));
  } catch { /* a leftover file costs nothing; the newest still wins */ }
}

// ─── Chain ───────────────────────────────────────────────────────────────

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return (data.result ?? null) as T | null;
  } catch { return null; }
}

/** eth_getLogs with adaptive range-splitting; null if the budget runs out. */
async function getLogs(filter: Record<string, unknown>, from: number, to: number, budget: { left: number }): Promise<RawLog[] | null> {
  const out: RawLog[] = [];
  const stack: Array<[number, number]> = [[from, to]];
  while (stack.length) {
    if (budget.left-- <= 0) return null;
    const [lo, hi] = stack.pop()!;
    if (lo > hi) continue;
    const logs = await rpc<RawLog[]>('eth_getLogs', [{ ...filter, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }]);
    if (logs === null || logs.length >= LOG_PAGE_LIMIT) {
      if (lo === hi) return null;
      const mid = Math.floor((lo + hi) / 2);
      stack.push([mid + 1, hi], [lo, mid]);
      continue;
    }
    out.push(...logs);
  }
  return out;
}

/** Genuine USDC transfers INTO the buy wallet, oldest first. */
async function getBuys(from: number, to: number, budget: { left: number }, includeProject = false): Promise<Buy[] | null> {
  const padded = '0x' + BUY_WALLET.slice(2).padStart(64, '0');
  const logs = await getLogs({
    // Server-side filter on the EMITTING contract: a lookalike token's
    // Transfer is emitted by the lookalike, so it can never match here.
    address: Object.keys(USDC_CONTRACTS),
    topics: [TRANSFER_TOPIC, null, padded],
  }, from, to, budget);
  if (!logs) return null;

  const tsCache = new Map<number, number>();
  const buys: Buy[] = [];
  for (const log of logs) {
    const token = USDC_CONTRACTS[log.address.toLowerCase()];
    if (!token || log.topics.length < 3) continue;  // belt and braces
    let raw = 0n;
    try { raw = BigInt(log.data); } catch { continue; }
    const micro = Number(raw);
    if (!Number.isFinite(micro) || micro < MIN_USDC * 1e6) continue;
    const block = parseInt(log.blockNumber, 16);
    let ts = log.blockTimestamp ? parseInt(log.blockTimestamp, 16) : NaN;
    if (!Number.isFinite(ts)) {
      if (!tsCache.has(block)) {
        const b = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [log.blockNumber, false]);
        tsCache.set(block, b ? parseInt(b.timestamp, 16) : Math.floor(Date.now() / 1000));
      }
      ts = tsCache.get(block)!;
    }
    const from = '0x' + log.topics[1].slice(26).toLowerCase();
    if (!includeProject && PROJECT_SENDERS.has(from)) continue; // the project topping up, not a buy
    const logIndex = parseInt(log.logIndex, 16);
    buys.push({
      key: `${log.transactionHash}:${logIndex}`,
      txHash: log.transactionHash,
      from,
      token, micro, ts, block, logIndex,
    });
  }
  return buys.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

// ─── Prices ──────────────────────────────────────────────────────────────

const validPrice = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** CoinGecko's current LINGO price — the feed the app pins buys at. */
async function getCoinGeckoPrice(): Promise<number | null> {
  try {
    const res = await fetch(`${COINGECKO_URL}/simple/price?ids=${COINGECKO_ID}&vs_currencies=usd&include_last_updated_at=true`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const quote = json?.[COINGECKO_ID];
    const updated = Number(quote?.last_updated_at);
    if (Number.isFinite(updated) && Date.now() / 1000 - updated > LIVE_PRICE_MAX_AGE_S) return null;
    return validPrice(quote?.usd);
  } catch { return null; }
}

/** Alchemy's current LINGO price — the fallback (within ~0.1% of CoinGecko). */
async function getAlchemyPrice(): Promise<number | null> {
  try {
    const res = await fetch(PRICES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [{ network: 'base-mainnet', address: LINGO_TOKEN }] }),
      // Bounded like every other outbound call: a hung fetch must not run the
      // instance into maxDuration mid-run.
      signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const usd = (json?.data?.[0]?.prices ?? []).find((p: { currency?: string }) => p?.currency === 'usd');
    const updated = Date.parse(usd?.lastUpdatedAt ?? '');
    if (Number.isFinite(updated) && Date.now() / 1000 - updated / 1000 > LIVE_PRICE_MAX_AGE_S) return null;
    return validPrice(usd?.value);
  } catch { return null; }
}

/** The price a buy landing now is recorded at. */
async function getLingoPriceUsd(): Promise<number | null> {
  return (await getCoinGeckoPrice()) ?? (await getAlchemyPrice());
}

type PriceAt = (ts: number) => number | null;

/**
 * CoinGecko's hourly LINGO price over [fromTs, toTs], as a lookup: the last
 * point at or before a time, else the first one after it, if within
 * HISTORY_MAX_GAP_S. Null if any chunk can't be fetched — a partly priced
 * history would skew the averages, so callers price nothing instead.
 */
async function getPriceHistory(fromTs: number, toTs: number): Promise<PriceAt | null> {
  const points: Array<[number, number]> = [];
  // Asking past the public API's 365 days fails the whole request.
  const start = Math.max(fromTs - HISTORY_MAX_GAP_S, Math.floor(Date.now() / 1000) - HISTORY_MAX_AGE_S);
  for (let lo = start; lo <= toTs; lo += HISTORY_CHUNK_S) {
    const hi = Math.min(lo + HISTORY_CHUNK_S, toTs + HISTORY_MAX_GAP_S);
    try {
      const res = await fetch(`${COINGECKO_URL}/coins/${COINGECKO_ID}/market_chart/range?vs_currency=usd&from=${lo}&to=${hi}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const json = await res.json();
      if (!Array.isArray(json?.prices)) return null;
      for (const pt of json.prices) {
        const ts = Math.floor(Number(pt?.[0]) / 1000);
        const price = validPrice(pt?.[1]);
        if (Number.isFinite(ts) && price) points.push([ts, price]);
      }
    } catch { return null; }
  }
  if (!points.length) return null;
  points.sort((a, b) => a[0] - b[0]);
  return (ts: number) => {
    let lo = 0, hi = points.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid][0] <= ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best >= 0 && ts - points[best][0] <= HISTORY_MAX_GAP_S) return points[best][1];
    const next = points[best + 1];
    return next && next[0] - ts <= HISTORY_MAX_GAP_S ? next[1] : null;
  };
}

/** CoinGecko's history covering these buys (oldest first), or null. */
async function historyPricer(buys: Buy[]): Promise<PriceAt | null> {
  return buys.length ? getPriceHistory(buys[0].ts, buys[buys.length - 1].ts) : null;
}

// ─── Aggregates + message ────────────────────────────────────────────────

const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const monthKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 7);

function emptyState(lastBlock: number, priced: boolean): BuysState {
  return { lastBlock, seen: [], days: {}, months: {}, total: { micro: 0, count: 0 }, ...(priced ? { priced: PRICED_VERSION } : {}) };
}

/** An aggregate with one more buy, priced at `price` if there is one. */
function addTo(a: Agg | undefined, micro: number, price: number | null): Agg {
  const out: Agg = { micro: (a?.micro ?? 0) + micro, count: (a?.count ?? 0) + 1 };
  const pMicro = (a?.pMicro ?? 0) + (price ? micro : 0);
  const lingo = (a?.lingo ?? 0) + (price ? micro / 1e6 / price : 0);
  return pMicro > 0 ? { ...out, pMicro, lingo } : out;
}

/**
 * Returns a NEW state with the buy added — the caller commits it only once
 * posted. `price` is the LINGO price the buy is recorded at (null = unknown:
 * it still counts, it just isn't in the average price).
 */
function withBuy(st: BuysState, b: Buy, price: number | null): BuysState {
  return {
    ...st,
    seen: [...st.seen, b.key],
    ...(price ? { prices: { ...(st.prices ?? {}), [b.key]: price } } : {}),
    days: { ...st.days, [dayKey(b.ts)]: addTo(st.days[dayKey(b.ts)], b.micro, price) },
    months: { ...st.months, [monthKey(b.ts)]: addTo(st.months[monthKey(b.ts)], b.micro, price) },
    total: addTo(st.total, b.micro, price),
  };
}

/**
 * Rebuild the price totals (pMicro/lingo) of every day, month and the total
 * from `counted` — the buys this state already counts — leaving micro/count,
 * seen and delivery untouched. A buy whose day or month the state doesn't have
 * is skipped rather than invented. Returns the new state and what it covered.
 */
function repriced(st: BuysState, counted: Buy[], priceOf: (b: Buy) => number | null) {
  const strip = (a: Agg): Agg => ({ micro: a.micro, count: a.count });
  const days: Record<string, Agg> = Object.fromEntries(Object.entries(st.days).map(([k, a]) => [k, strip(a)]));
  const months: Record<string, Agg> = Object.fromEntries(Object.entries(st.months).map(([k, a]) => [k, strip(a)]));
  let total = strip(st.total);
  let priced = 0, unpriced = 0, skipped = 0, micro = 0;
  const addPrice = (a: Agg, m: number, p: number): Agg =>
    ({ ...a, pMicro: (a.pMicro ?? 0) + m, lingo: (a.lingo ?? 0) + m / 1e6 / p });
  for (const b of counted) {
    const d = dayKey(b.ts), mo = monthKey(b.ts);
    if (!days[d] || !months[mo]) { skipped++; continue; }
    micro += b.micro;
    const p = priceOf(b);
    if (!p) { unpriced++; continue; }
    days[d] = addPrice(days[d], b.micro, p);
    months[mo] = addPrice(months[mo], b.micro, p);
    total = addPrice(total, b.micro, p);
    priced++;
  }
  return {
    state: { ...st, days, months, total, priced: PRICED_VERSION, pricedRetryAfter: undefined } as BuysState,
    report: {
      counted: counted.length, priced, unpriced, skipped,
      // Should equal the stored totals; a gap means the chain and the state
      // disagree on what was counted (only the averages are affected).
      chainUsd: micro / 1e6, storedUsd: st.total.micro / 1e6,
    },
  };
}

/** Average price paid: total USDC ÷ total LINGO, over the buys with a price. */
const avgPrice = (a: Agg | undefined): number | null =>
  a?.pMicro && a.lingo ? a.pMicro / 1e6 / a.lingo : null;

/** The 30 UTC days ending on the buy's day (that day included). */
function last30Days(st: BuysState, ts: number): Agg {
  let out: Agg = { micro: 0, count: 0 };
  const end = Date.parse(`${dayKey(ts)}T00:00:00Z`);
  for (let i = 0; i < 30; i++) {
    const a = st.days[new Date(end - i * 86_400_000).toISOString().slice(0, 10)];
    if (!a) continue;
    out = {
      micro: out.micro + a.micro, count: out.count + a.count,
      ...(a.pMicro || out.pMicro ? { pMicro: (out.pMicro ?? 0) + (a.pMicro ?? 0), lingo: (out.lingo ?? 0) + (a.lingo ?? 0) } : {}),
    };
  }
  return out;
}

const usd = (micro: number) =>
  '$' + (micro / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Three significant digits, at least four decimals: $0.0162, $0.00162. */
const fmtPrice = (p: number) => '$' + p.toFixed(Math.min(12, Math.max(4, 2 - Math.floor(Math.log10(p)))));

/** Everything both channels show, worked out once. */
function summarize(b: Buy, st: BuysState, priceUsd: number | null) {
  const zero: Agg = { micro: 0, count: 0 };
  // Averages only once the state's price totals cover all its history: before
  // that they'd describe just the buys since prices were added.
  const at = (a: Agg) => {
    const p = st.priced === PRICED_VERSION ? avgPrice(a) : null;
    return p ? ` @ ${fmtPrice(p)}` : '';
  };
  const plural = (n: number) => `${n} buy${n === 1 ? '' : 's'}`;
  const day = st.days[dayKey(b.ts)] ?? zero;
  const month = st.months[monthKey(b.ts)] ?? zero;
  const recent = last30Days(st, b.ts);
  const avgMicro = st.total.count ? st.total.micro / st.total.count : 0;
  const lingo = priceUsd ? (b.micro / 1e6) / priceUsd : null;
  return {
    when: new Date(b.ts * 1000).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    }),
    amount: `${usd(b.micro)} ${b.token}`,
    bought: lingo ? `≈ ${Math.round(lingo).toLocaleString('en-US')} LINGO @ ${fmtPrice(priceUsd!)}` : '',
    rows: [
      ['Today (UTC)', `${usd(day.micro)}${at(day)} · ${plural(day.count)}`],
      ['This month', `${usd(month.micro)}${at(month)} · ${plural(month.count)}`],
      ['Last 30 days', `${usd(recent.micro)}${at(recent)} · ${plural(recent.count)}`],
      ['Average buy', `${usd(avgMicro)}${at(st.total)} · across ${plural(st.total.count)}`],
      ['All-time', `${usd(st.total.micro)}${at(st.total)}`],
    ] as Array<[string, string]>,
  };
}

function buildMessage(b: Buy, st: BuysState, priceUsd: number | null) {
  const s = summarize(b, st, priceUsd);
  const fields = [
    { type: 'mrkdwn', text: `*Amount:*\n${s.amount}${s.bought ? `\n${s.bought}` : ''}` },
    { type: 'mrkdwn', text: `*Transaction:*\n<https://basescan.org/tx/${b.txHash}|View on BaseScan> · ${s.when} UTC` },
    ...s.rows.map(([label, value]) => ({ type: 'mrkdwn', text: `*${label}:*\n${value}` })),
  ];

  return {
    text: `New LINGO buy: ${usd(b.micro)} ${b.token} from ${b.from}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `🟢 New LINGO buy — ${usd(b.micro)}`, emoji: true } },
      // Full address on its own line: poisoning relies on truncated addresses.
      { type: 'section', text: { type: 'mrkdwn', text: b.from === ZERO_ADDRESS
        ? '*Buyer:* not visible — USDC was minted straight to the wallet (Circle CCTP bridge)'
        : `*Buyer:* <https://basescan.org/address/${b.from}|\`${b.from}\`>` } },
      { type: 'section', fields },
    ] as Array<Record<string, unknown>>,
  };
}

async function postSlack(payload: unknown): Promise<boolean> {
  try {
    // Bounded: without this a hung POST runs to undici's 300s default, the
    // 60s maxDuration kills the instance mid-run, and the buy is left posted
    // but unrecorded — which is exactly how a duplicate gets made.
    const res = await fetch(SLACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    return res.ok;
  } catch { return false; }
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Same content as the Slack card, in Telegram HTML. */
function buildTelegramText(b: Buy, st: BuysState, priceUsd: number | null, test = false, backfill = false): string {
  const s = summarize(b, st, priceUsd);
  const buyer = b.from === ZERO_ADDRESS
    ? 'not visible — USDC was minted straight to the wallet (Circle CCTP bridge)'
    : `<a href="https://basescan.org/address/${esc(b.from)}"><code>${esc(b.from)}</code></a>`;
  const note = test
    ? '<i>Test message only — not a new buy, and NOT counted in the totals.</i>'
    : backfill
      ? '<i>Backfill of an earlier buy — already counted, shown with the totals as they stood then.</i>'
      : null;

  return [
    test ? '🧪 <b>TEST — this is how a buy alert will look</b>' : `🟢 <b>New LINGO buy — ${esc(usd(b.micro))}</b>`,
    '',
    `<b>Buyer:</b> ${buyer}`,
    `<b>Amount:</b> ${esc(s.amount)}${s.bought ? ` (${esc(s.bought)})` : ''}`,
    `<b>When:</b> ${esc(s.when)} UTC · <a href="https://basescan.org/tx/${esc(b.txHash)}">transaction</a>`,
    '',
    ...s.rows.map(([label, value]) => `<b>${esc(label)}:</b> ${esc(value)}`),
    ...(note ? ['', note] : []),
  ].join('\n');
}

async function postTelegram(text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    // Telegram can answer 200 with {ok:false}, so the body decides.
    const body = await res.json().catch(() => null);
    return res.ok && !!body?.ok;
  } catch { return false; }
}

interface Destination {
  id: string;
  send: (b: Buy, st: BuysState, price: number | null) => Promise<boolean>;
  sendTest: (b: Buy, st: BuysState, price: number | null) => Promise<boolean>;
  sendBackfill: (b: Buy, st: BuysState, price: number | null) => Promise<boolean>;
}

/** Every channel currently configured. */
function destinations(): Destination[] {
  const out: Destination[] = [];
  if (SLACK_URL) {
    out.push({
      id: 'slack',
      send: (b, st, price) => postSlack(buildMessage(b, st, price)),
      // The live card has no footer; test and backfill posts add one saying what they are.
      sendTest: (b, st, price) => {
        const real = buildMessage(b, st, price);
        const blocks = [
          ...real.blocks.map(blk => blk.type === 'header'
            ? { type: 'header', text: { type: 'plain_text', text: '🧪 TEST — this is how a buy alert will look', emoji: true } }
            : blk),
          { type: 'context', elements: [{ type: 'mrkdwn', text: '*Test message only* — not a new buy, and NOT counted in the totals.' }] },
        ];
        return postSlack({ text: `TEST — ${real.text}`, blocks });
      },
      sendBackfill: (b, st, price) => {
        const real = buildMessage(b, st, price);
        const blocks = [
          ...real.blocks,
          { type: 'context', elements: [{ type: 'mrkdwn', text: '_Backfill of an earlier buy — already counted._' }] },
        ];
        return postSlack({ text: real.text, blocks });
      },
    });
  }
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    out.push({
      id: 'telegram',
      send: (b, st, price) => postTelegram(buildTelegramText(b, st, price)),
      sendTest: (b, st, price) => postTelegram(buildTelegramText(b, st, price, true)),
      sendBackfill: (b, st, price) => postTelegram(buildTelegramText(b, st, price, false, true)),
    });
  }
  return out;
}

// ─── Handler ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // When CRON_SECRET is set, Vercel cron sends it as a Bearer token.
  const isCron = !CRON_SECRET || req.headers.authorization === `Bearer ${CRON_SECRET}`;
  const pw = (req.headers['x-admin-password'] as string | undefined) ?? (req.query.password as string | undefined);
  const isAdmin = !!ADMIN_PASSWORD && pw === ADMIN_PASSWORD;
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  if (!ALCHEMY_API_KEY) return res.status(200).json({ error: 'ALCHEMY_API_KEY not set' });

  const dryRun = req.query.dryRun === '1';
  const testMode = req.query.test === '1';
  const dests = destinations();
  if (!dryRun && !dests.length) {
    return res.status(200).json({ message: 'Not configured — set LINGO_BUYS_SLACK_WEBHOOK_URL and/or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID' });
  }

  try {
    const headHex = await rpc<string>('eth_blockNumber', []);
    if (!headHex) return res.status(200).json({ error: 'RPC unavailable' });
    const head = parseInt(headHex, 16);
    const budget = { left: MAX_REQUESTS };

    // ── Replay earlier buys into one channel; never re-counted ──
    if (req.query.replay === '1') {
      const want = String(req.query.channel ?? 'telegram').toLowerCase();
      const targets = want === 'all' ? dests : dests.filter(d => d.id === want);
      if (!targets.length) return res.status(400).json({ error: `No such channel configured: ${want}`, channels: dests.map(d => d.id) });
      // `Number(x) || 25` turned limit=0 into 25 — the opposite of "send none".
      const rawLimit = req.query.limit === undefined ? 25 : Number(req.query.limit);
      if (!Number.isFinite(rawLimit) || rawLimit < 0) return res.status(400).json({ error: `Bad limit: ${req.query.limit}` });
      const cap = Math.min(30, Math.floor(rawLimit));
      // An unparseable `since` used to yield NaN, and the NaN-guard on the
      // filter below then disabled it entirely — a typo replayed from the
      // OLDEST buy instead of erroring. Reject it instead.
      let sinceTs = 0;
      if (req.query.since !== undefined) {
        const parsed = Date.parse(String(req.query.since));
        if (!Number.isFinite(parsed)) return res.status(400).json({ error: `Unparseable since: ${req.query.since}` });
        sinceTs = Math.floor(parsed / 1000);
      }

      const all = await getBuys(START_BLOCK, head, budget);
      if (!all) return res.status(200).json({ error: 'Log budget exhausted' });
      // Each buy at CoinGecko's price for its own hour, not today's price.
      const pricer = await historyPricer(all);

      // Walk from the start so each message shows the totals as they stood at
      // that buy — the same numbers the live alert would have carried.
      let st = emptyState(head, !!pricer);
      const sent: Array<{ tx: string; usd: number; ok: boolean }> = [];
      let skipped = 0;
      for (const b of all) {
        const price = pricer?.(b.ts) ?? null;
        st = withBuy(st, b, price);
        if (b.ts < sinceTs) { skipped++; continue; }
        if (sent.length >= cap) { skipped++; continue; }
        let ok = true;
        for (const d of targets) ok = (await d.sendBackfill(b, st, price)) && ok;
        sent.push({ tx: b.txHash, usd: b.micro / 1e6, ok });
        if (!ok) break;
        // Telegram allows ~20 messages a minute to one group.
        await new Promise(r => setTimeout(r, 1_200));
      }
      return res.status(sent.every(x => x.ok) ? 200 : 502).json({
        replay: true,
        channels: targets.map(d => d.id),
        totalBuys: all.length,
        priced: !!pricer,
        sent: sent.length,
        skipped,
        stateTouched: false,
        results: sent,
      });
    }

    // ── Test post: labelled, rate-limited, never counted ──
    if (testMode) {
      const last = await readBlob<{ at: number }>(TEST_KEY);
      if (last.error) return res.status(503).json({ error: 'Could not check the test cooldown — try again' });
      const since = last.data ? Date.now() - last.data.at : Infinity;
      if (since < TEST_COOLDOWN_MS) {
        return res.status(429).json({ error: `A test was posted recently — try again in ${Math.ceil((TEST_COOLDOWN_MS - since) / 1000)}s` });
      }
      // Use the latest real transfer (project wallets included) so the test
      // looks exactly like a live alert; fall back to a sample if none.
      const recent = await getBuys(Math.max(START_BLOCK, Math.min(head, tsToBlock(blockToTs(head) - 7 * 86_400))), head, budget, true);
      const sample: Buy = recent?.length ? recent[recent.length - 1] : {
        key: 'test', txHash: '0x' + '0'.repeat(64), from: BUY_WALLET, token: 'USDC',
        micro: 100_000_000, ts: Math.floor(Date.now() / 1000), block: head, logIndex: 0,
      };
      const { state } = await readState();
      const price = await getLingoPriceUsd();
      // Totals shown are what they WOULD be — the stored state is not written.
      const hypothetical = withBuy(state ?? emptyState(head, false), sample, price);
      const results: Record<string, boolean> = {};
      for (const d of dests) results[d.id] = await d.sendTest(sample, hypothetical, price);
      const ok = Object.values(results).some(Boolean);
      if (ok) await put(TEST_KEY, JSON.stringify({ at: Date.now() }), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
      return res.status(ok ? 200 : 502).json({ test: true, posted: results, sampleTx: sample.txHash });
    }

    // ── Dry run: full history, rendered, nothing written or posted ──
    if (dryRun) {
      const buys = await getBuys(START_BLOCK, head, budget);
      if (!buys) return res.status(200).json({ error: 'Log budget exhausted' });
      const pricer = await historyPricer(buys);
      let st = emptyState(head, !!pricer);
      for (const b of buys) st = withBuy(st, b, pricer?.(b.ts) ?? null);
      const latest = buys[buys.length - 1];
      const stored = await readState();
      return res.status(200).json({
        dryRun: true,
        buys: buys.map(b => ({ when: new Date(b.ts * 1000).toISOString(), usd: b.micro / 1e6, price: pricer?.(b.ts) ?? null, token: b.token, from: b.from, tx: b.txHash })),
        totals: {
          count: st.total.count, usd: st.total.micro / 1e6, avg: st.total.count ? st.total.micro / st.total.count / 1e6 : 0,
          avgPrice: avgPrice(st.total), pricedUsd: (st.total.pMicro ?? 0) / 1e6, priced: !!pricer,
        },
        // What the live job is working from, to check the stored totals against the chain.
        stored: stored.state ? {
          seq: stored.seq, lastBlock: stored.state.lastBlock, priced: stored.state.priced ?? null,
          count: stored.state.total.count, usd: stored.state.total.micro / 1e6,
          avgPrice: avgPrice(stored.state.total), pricedUsd: (stored.state.total.pMicro ?? 0) / 1e6,
        } : null,
        message: latest ? buildMessage(latest, st, pricer?.(latest.ts) ?? null) : null,
        requestsUsed: MAX_REQUESTS - budget.left,
      });
    }

    const { state, seq: readSeq, error: readError } = await readState();
    if (readError) {
      return res.status(503).json({ error: 'State unreadable — skipped this run rather than risk absorbing unposted buys' });
    }
    let seq = readSeq;

    // ── Cold start: seed totals from history, post nothing ──
    if (!state || typeof state.lastBlock !== 'number') {
      const buys = await getBuys(START_BLOCK, head, budget);
      if (!buys) return res.status(200).json({ error: 'Log budget exhausted on cold start' });
      // Without CoinGecko the seed is unpriced, and the backfill below prices it later.
      const pricer = await historyPricer(buys);
      let st = emptyState(head, !!pricer);
      for (const b of buys) st = withBuy(st, b, pricer?.(b.ts) ?? null);
      try {
        seq = await saveState(st, seq);
      } catch {
        return res.status(502).json({ error: 'Another run seeded first — nothing posted' });
      }
      return res.status(200).json({ message: `Cold start — seeded ${buys.length} historical buys, posted nothing`, lastBlock: head });
    }

    // ── One-time price backfill, IN PLACE ──
    // A state written before prices were added has no price totals. Rebuild
    // them from the chain for exactly the buys it already counts (everything up
    // to lastBlock, plus any claimed beyond it), keeping its counts, `seen` and
    // delivery as they are — a cold start would instead silently absorb any buy
    // that landed meanwhile. CoinGecko is asked first so an outage costs no log
    // scan, and a failure waits PRICE_BACKFILL_RETRY_S before trying again so
    // it can't turn every run into a full-history scan.
    let current: BuysState = state;
    let backfill: Record<string, unknown> | undefined;
    let history: Buy[] | null = null;
    const nowS = Math.floor(Date.now() / 1000);
    if (current.priced !== PRICED_VERSION && !((current.pricedRetryAfter ?? 0) > nowS)) {
      const pricer = await getPriceHistory(blockToTs(START_BLOCK), blockToTs(head));
      const scanned = pricer ? await getBuys(START_BLOCK, head, { left: MAX_REQUESTS }) : null;
      let next: BuysState;
      if (pricer && scanned) {
        const seenSet = new Set(current.seen);
        const counted = scanned.filter(b => b.block <= current.lastBlock || seenSet.has(b.key));
        const recorded = current.prices ?? {};
        const r = repriced(current, counted, b => recorded[b.key] ?? pricer(b.ts));
        next = r.state;
        backfill = { done: true, ...r.report };
        history = scanned;
      } else {
        next = { ...current, pricedRetryAfter: nowS + PRICE_BACKFILL_RETRY_S };
        backfill = { done: false, error: pricer ? 'log budget exhausted' : 'CoinGecko history unavailable', retryAfter: next.pricedRetryAfter };
      }
      try {
        seq = await saveState(next, seq);
      } catch {
        return res.status(502).json({ error: 'Another run saved first — nothing posted', backfill });
      }
      current = next;
    }

    const seen = new Set(current.seen);
    const destIds = dests.map(d => d.id);
    // The backfill already scanned to head; reuse it rather than scan again.
    const fresh = history
      ? history.filter(b => b.block > current.lastBlock)
      : await getBuys(current.lastBlock + 1, head, budget);
    if (!fresh) return res.status(200).json({ error: 'Log budget exhausted', ...(backfill ? { backfill } : {}) });

    // Already counted, but a channel still owes it — retry just that channel.
    const retries = fresh.filter(b => seen.has(b.key)
      && (current.delivered?.[b.key] ?? destIds).length < destIds.length);
    const buys = fresh.filter(b => !seen.has(b.key));

    let st: BuysState = { ...current, lastBlock: current.lastBlock, delivered: { ...(current.delivered ?? {}) } };
    let posted = 0;
    let failed: string | null = null;
    // A buy that reached some channels but not all must stay inside the scan
    // window, or the pointer moves past it and the retry never happens.
    let incomplete = false;
    const price = (buys.length || retries.length) ? await getLingoPriceUsd() : null;
    // Buys that sat unclaimed through a stall get the price from when they
    // landed, as the app pinned them — one history call, only after a stall.
    const late = buys.filter(b => nowS - b.ts > LATE_CLAIM_S);
    const landed = late.length ? await historyPricer(late) : null;
    const priceFor = (b: Buy) => (nowS - b.ts > LATE_CLAIM_S ? landed?.(b.ts) : null) ?? price;

    // Record each channel the moment it accepts, so a write that fails after a
    // successful send costs at most a repeat on that ONE channel — not on all
    // of them, and not the whole buy.
    const sendAndRecord = async (b: Buy, done: Set<string>): Promise<boolean> => {
      for (const d of dests) {
        if (done.has(d.id)) continue;
        if (!(await d.send(b, st, st.prices?.[b.key] ?? price))) continue;
        done.add(d.id);
        st = { ...st, delivered: { ...st.delivered, [b.key]: [...done] } };
        try {
          seq = await saveState(st, seq);
        } catch {
          failed = 'state save failed after posting';
          return false;
        }
      }
      return true;
    };

    for (const b of retries) {
      const done = new Set(st.delivered?.[b.key] ?? []);
      const ok = await sendAndRecord(b, done);
      if (done.size < destIds.length) incomplete = true;
      if (!ok) break;
    }

    for (const b of buys) {
      if (failed) break;
      // CLAIM FIRST, POST SECOND. The old order — post, then record — meant any
      // lost write re-announced a buy that had already gone out. Claiming first
      // turns that failure into a two-minute delay instead: the buy is in
      // `seen` with an empty `delivered`, which the retry pass above picks up
      // and sends. saveState throwing here means another run already took this
      // number, so this run must post nothing at all.
      const claimed: BuysState = { ...withBuy(st, b, priceFor(b)), delivered: { ...st.delivered, [b.key]: [] } };
      try {
        seq = await saveState(claimed, seq);
      } catch {
        failed = 'could not claim the buy before posting — another run may hold it';
        break;
      }
      st = claimed;

      const done = new Set<string>();
      const ok = await sendAndRecord(b, done);
      if (done.size) posted++;
      if (done.size < destIds.length) incomplete = true;
      if (!ok) break;
      if (!done.size) { failed = `no channel accepted the post (${destIds.join(', ')})`; break; }
    }
    // Only advance the pointer once the whole batch is posted and saved; the
    // seen-set keeps already-posted buys from repeating on the retry.
    if (!failed && !incomplete) {
      st.lastBlock = head;
      try { seq = await saveState(st, seq); } catch { failed = 'state save failed'; }
    }
    await pruneStates(seq);

    // A non-2xx makes a broken webhook visible in Vercel's cron logs instead
    // of stalling silently behind a 200.
    return res.status(failed || incomplete ? 502 : 200).json({
      posted,
      channels: destIds,
      retried: retries.length,
      pending: buys.length - posted,
      fromBlock: current.lastBlock + 1,
      toBlock: head,
      ...(backfill ? { backfill } : {}),
      ...(failed ? { error: `${failed} — will retry next run` }
        : incomplete ? { error: 'a channel did not accept every buy — retrying the missing one next run' } : {}),
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
