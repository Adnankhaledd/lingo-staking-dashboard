import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list } from '@vercel/blob';

/**
 * /api/lingo-buys — watches the buy-and-stake wallet for incoming USDC and
 * posts each buy to Slack (#lingo-buys) with the day's, month's and average
 * totals.
 *
 * Cron: every 2 minutes (vercel.json). Each run is one eth_blockNumber plus one
 * eth_getLogs (~85 CU). The LINGO price is only fetched when a buy is posted.
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
 * Setup: set LINGO_BUYS_SLACK_WEBHOOK_URL to an Incoming Webhook for
 * #lingo-buys. Until then the job does nothing. The first configured run seeds
 * the totals from history and posts nothing, so there is no backlog spam.
 *
 * GET ?dryRun=1 (cron or admin auth): rebuild the totals from history and
 * render the message for the most recent buy — no post, no state written.
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const PRICES_URL = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/by-address`;
const SLACK_URL = process.env.LINGO_BUYS_SLACK_WEBHOOK_URL || '';
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
const START_BLOCK = 0x2700000;  // before the wallet's first activity (Jan 2026)
const MIN_USDC = 1;             // below this is dust / poisoning, not a buy
const STATE_KEY = 'lingo-buys-state.json';
const SEEN_LIMIT = 1000;        // rolling dedupe window of txHash:logIndex keys
const LOG_PAGE_LIMIT = 9500;
const MAX_REQUESTS = 60;

interface Agg { micro: number; count: number } // micro = USDC in 6-decimal units (exact)
interface BuysState {
  lastBlock: number;
  seen: string[];
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

async function fetchBlobJson<T>(pathname: string): Promise<T | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const match = token.match(/^vercel_blob_rw_([^_]+)_/);
  if (match) {
    try {
      const res = await fetch(`https://${match[1]}.public.blob.vercel-storage.com/${pathname}?t=${Date.now()}`);
      if (res.ok) return (await res.json()) as T;
    } catch { /* fall through */ }
  }
  try {
    const { blobs } = await list({ prefix: pathname });
    if (blobs.length === 0) return null;
    const res = await fetch(`${blobs[blobs.length - 1].url}?t=${Date.now()}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

async function saveState(state: BuysState): Promise<void> {
  await put(STATE_KEY, JSON.stringify({ ...state, seen: state.seen.slice(-SEEN_LIMIT), updatedAt: new Date().toISOString() }), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
  });
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
async function getBuys(from: number, to: number, budget: { left: number }): Promise<Buy[] | null> {
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
    const logIndex = parseInt(log.logIndex, 16);
    buys.push({
      key: `${log.transactionHash}:${logIndex}`,
      txHash: log.transactionHash,
      from: '0x' + log.topics[1].slice(26).toLowerCase(),
      token, micro, ts, block, logIndex,
    });
  }
  return buys.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

async function getLingoPriceUsd(): Promise<number | null> {
  try {
    const res = await fetch(PRICES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [{ network: 'base-mainnet', address: LINGO_TOKEN }] }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const usd = (json?.data?.[0]?.prices ?? []).find((p: { currency?: string }) => p?.currency === 'usd');
    const price = Number(usd?.value);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch { return null; }
}

// ─── Aggregates + message ────────────────────────────────────────────────

const dayKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const monthKey = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 7);

function emptyState(lastBlock: number): BuysState {
  return { lastBlock, seen: [], days: {}, months: {}, total: { micro: 0, count: 0 } };
}

/** Returns a NEW state with the buy added — the caller commits it only once posted. */
function withBuy(st: BuysState, b: Buy): BuysState {
  const add = (a: Agg | undefined): Agg => ({ micro: (a?.micro ?? 0) + b.micro, count: (a?.count ?? 0) + 1 });
  return {
    ...st,
    seen: [...st.seen, b.key],
    days: { ...st.days, [dayKey(b.ts)]: add(st.days[dayKey(b.ts)]) },
    months: { ...st.months, [monthKey(b.ts)]: add(st.months[monthKey(b.ts)]) },
    total: add(st.total),
  };
}

const usd = (micro: number) =>
  '$' + (micro / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function buildMessage(b: Buy, st: BuysState, priceUsd: number | null) {
  const day = st.days[dayKey(b.ts)] ?? { micro: 0, count: 0 };
  const month = st.months[monthKey(b.ts)] ?? { micro: 0, count: 0 };
  const avg = st.total.count ? st.total.micro / st.total.count : 0;
  const lingo = priceUsd ? (b.micro / 1e6) / priceUsd : null;
  const plural = (n: number) => `${n} buy${n === 1 ? '' : 's'}`;
  const when = new Date(b.ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  });

  const fields = [
    { type: 'mrkdwn', text: `*Amount:*\n${usd(b.micro)} ${b.token}${lingo ? `\n≈ ${Math.round(lingo).toLocaleString()} LINGO @ $${priceUsd!.toFixed(5)}` : ''}` },
    { type: 'mrkdwn', text: `*Transaction:*\n<https://basescan.org/tx/${b.txHash}|View on BaseScan> · ${when} UTC` },
    { type: 'mrkdwn', text: `*Today (UTC):*\n${usd(day.micro)} · ${plural(day.count)}` },
    { type: 'mrkdwn', text: `*This month:*\n${usd(month.micro)} · ${plural(month.count)}` },
    { type: 'mrkdwn', text: `*Average buy:*\n${usd(avg)} · across ${plural(st.total.count)}` },
    { type: 'mrkdwn', text: `*All-time:*\n${usd(st.total.micro)}` },
  ];

  return {
    text: `New LINGO buy: ${usd(b.micro)} ${b.token} from ${b.from}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `🟢 New LINGO buy — ${usd(b.micro)}`, emoji: true } },
      // Full address on its own line: poisoning relies on truncated addresses.
      { type: 'section', text: { type: 'mrkdwn', text: `*Buyer:* <https://basescan.org/address/${b.from}|\`${b.from}\`>` } },
      { type: 'section', fields },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Genuine USDC only — lookalike tokens are ignored. Always compare the FULL buyer address.' }] },
    ],
  };
}

async function postSlack(payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(SLACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return res.ok;
  } catch { return false; }
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
  if (!dryRun && !SLACK_URL) {
    return res.status(200).json({ message: 'Not configured — set LINGO_BUYS_SLACK_WEBHOOK_URL' });
  }

  try {
    const headHex = await rpc<string>('eth_blockNumber', []);
    if (!headHex) return res.status(200).json({ error: 'RPC unavailable' });
    const head = parseInt(headHex, 16);
    const budget = { left: MAX_REQUESTS };

    // ── Dry run: full history, rendered, nothing written or posted ──
    if (dryRun) {
      const buys = await getBuys(START_BLOCK, head, budget);
      if (!buys) return res.status(200).json({ error: 'Log budget exhausted' });
      let st = emptyState(head);
      for (const b of buys) st = withBuy(st, b);
      const latest = buys[buys.length - 1];
      return res.status(200).json({
        dryRun: true,
        buys: buys.map(b => ({ when: new Date(b.ts * 1000).toISOString(), usd: b.micro / 1e6, token: b.token, from: b.from, tx: b.txHash })),
        totals: { count: st.total.count, usd: st.total.micro / 1e6, avg: st.total.count ? st.total.micro / st.total.count / 1e6 : 0 },
        message: latest ? buildMessage(latest, st, await getLingoPriceUsd()) : null,
        requestsUsed: MAX_REQUESTS - budget.left,
      });
    }

    const state = await fetchBlobJson<BuysState>(STATE_KEY);

    // ── Cold start: seed totals from history, post nothing ──
    if (!state || typeof state.lastBlock !== 'number') {
      const buys = await getBuys(START_BLOCK, head, budget);
      if (!buys) return res.status(200).json({ error: 'Log budget exhausted on cold start' });
      let st = emptyState(head);
      for (const b of buys) st = withBuy(st, b);
      await saveState(st);
      return res.status(200).json({ message: `Cold start — seeded ${buys.length} historical buys, posted nothing`, lastBlock: head });
    }

    const seen = new Set(state.seen);
    const fresh = await getBuys(state.lastBlock + 1, head, budget);
    if (!fresh) return res.status(200).json({ error: 'Log budget exhausted' });
    const buys = fresh.filter(b => !seen.has(b.key));

    let st: BuysState = { ...state, lastBlock: state.lastBlock };
    let posted = 0;
    let failed = false;
    const price = buys.length ? await getLingoPriceUsd() : null;
    for (const b of buys) {
      const next = withBuy(st, b);
      // Commit the buy to the totals only once it has actually been posted,
      // so a failed post is retried next run instead of being counted twice.
      if (!(await postSlack(buildMessage(b, next, price)))) { failed = true; break; }
      st = next;
      posted++;
    }
    // Hold the block pointer back if a post failed; the seen-set stops the
    // already-posted buys from being sent again on the retry.
    st.lastBlock = failed ? state.lastBlock : head;
    await saveState(st);

    return res.status(200).json({
      posted,
      pending: buys.length - posted,
      fromBlock: state.lastBlock + 1,
      toBlock: head,
      ...(failed ? { warning: 'Slack post failed — will retry next run' } : {}),
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
