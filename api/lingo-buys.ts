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
const PRICES_URL = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/by-address`;
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
// v2: v1 had already seeded the two test sends into its totals before they
// were excluded; a new key makes the next run re-seed cleanly from START_BLOCK.
const STATE_KEY = 'lingo-buys-state-v2.json';
const SEEN_LIMIT = 1000;        // rolling dedupe window of txHash:logIndex keys
const TEST_KEY = 'lingo-buys-test.json';
const TEST_COOLDOWN_MS = 5 * 60 * 1000;
const LOG_PAGE_LIMIT = 9500;
const MAX_REQUESTS = 60;

interface Agg { micro: number; count: number } // micro = USDC in 6-decimal units (exact)
interface BuysState {
  lastBlock: number;
  seen: string[];
  /** key → channels that already have it. Missing = delivered everywhere
   *  (state written before multi-channel, or by a single-channel run). */
  delivered?: Record<string, string[]>;
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

async function readState(): Promise<{ state: BuysState | null; error: boolean }> {
  const { data, error } = await readBlob<BuysState>(STATE_KEY);
  return { state: data, error };
}

async function saveState(state: BuysState): Promise<void> {
  const seen = state.seen.slice(-SEEN_LIMIT);
  const keep = new Set(seen);
  const delivered = Object.fromEntries(Object.entries(state.delivered ?? {}).filter(([k]) => keep.has(k)));
  await put(STATE_KEY, JSON.stringify({ ...state, seen, delivered, updatedAt: new Date().toISOString() }), {
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
      { type: 'section', text: { type: 'mrkdwn', text: b.from === ZERO_ADDRESS
        ? '*Buyer:* not visible — USDC was minted straight to the wallet (Circle CCTP bridge)'
        : `*Buyer:* <https://basescan.org/address/${b.from}|\`${b.from}\`>` } },
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

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Same content as the Slack card, in Telegram HTML. */
function buildTelegramText(b: Buy, st: BuysState, priceUsd: number | null, test = false, backfill = false): string {
  const day = st.days[dayKey(b.ts)] ?? { micro: 0, count: 0 };
  const month = st.months[monthKey(b.ts)] ?? { micro: 0, count: 0 };
  const avg = st.total.count ? st.total.micro / st.total.count : 0;
  const lingo = priceUsd ? (b.micro / 1e6) / priceUsd : null;
  const plural = (n: number) => `${n} buy${n === 1 ? '' : 's'}`;
  const when = new Date(b.ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  });
  const buyer = b.from === ZERO_ADDRESS
    ? 'not visible — USDC was minted straight to the wallet (Circle CCTP bridge)'
    : `<a href="https://basescan.org/address/${esc(b.from)}"><code>${esc(b.from)}</code></a>`;

  return [
    test ? '🧪 <b>TEST — this is how a buy alert will look</b>' : `🟢 <b>New LINGO buy — ${esc(usd(b.micro))}</b>`,
    '',
    `<b>Buyer:</b> ${buyer}`,
    `<b>Amount:</b> ${esc(usd(b.micro))} ${esc(b.token)}${lingo ? ` (≈ ${Math.round(lingo).toLocaleString()} LINGO @ $${priceUsd!.toFixed(5)})` : ''}`,
    `<b>When:</b> ${esc(when)} UTC · <a href="https://basescan.org/tx/${esc(b.txHash)}">transaction</a>`,
    '',
    `<b>Today (UTC):</b> ${esc(usd(day.micro))} · ${plural(day.count)}`,
    `<b>This month:</b> ${esc(usd(month.micro))} · ${plural(month.count)}`,
    `<b>Average buy:</b> ${esc(usd(avg))} · across ${plural(st.total.count)}`,
    `<b>All-time:</b> ${esc(usd(st.total.micro))}`,
    '',
    test
      ? '<i>Test message only — not a new buy, and NOT counted in the totals.</i>'
      : backfill
        ? '<i>Backfill of an earlier buy — already counted, shown with the totals as they stood then.</i>'
        : '<i>Genuine USDC only — lookalike tokens are ignored. Always compare the FULL buyer address.</i>',
  ].join('\n');
}

async function postTelegram(text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
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
      sendTest: (b, st, price) => {
        const real = buildMessage(b, st, price);
        const blocks = real.blocks.map(blk => {
          if (blk.type === 'header') return { type: 'header', text: { type: 'plain_text', text: '🧪 TEST — this is how a buy alert will look', emoji: true } };
          if (blk.type === 'context') return { type: 'context', elements: [{ type: 'mrkdwn', text: '*Test message only* — not a new buy, and NOT counted in the totals.' }] };
          return blk;
        });
        return postSlack({ text: `TEST — ${real.text}`, blocks });
      },
      sendBackfill: (b, st, price) => {
        const real = buildMessage(b, st, price);
        const blocks = real.blocks.map(blk => blk.type === 'context'
          ? { type: 'context', elements: [{ type: 'mrkdwn', text: '_Backfill of an earlier buy — already counted._' }] }
          : blk);
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
      const cap = Math.min(30, Math.max(1, Number(req.query.limit) || 25));
      const sinceTs = req.query.since ? Math.floor(Date.parse(String(req.query.since)) / 1000) : 0;

      const all = await getBuys(START_BLOCK, head, budget);
      if (!all) return res.status(200).json({ error: 'Log budget exhausted' });
      const price = await getLingoPriceUsd();

      // Walk from the start so each message shows the totals as they stood at
      // that buy — the same numbers the live alert would have carried.
      let st = emptyState(head);
      const sent: Array<{ tx: string; usd: number; ok: boolean }> = [];
      let skipped = 0;
      for (const b of all) {
        st = withBuy(st, b);
        if (Number.isFinite(sinceTs) && b.ts < sinceTs) { skipped++; continue; }
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
      const recent = await getBuys(Math.max(START_BLOCK, head - 302_400), head, budget, true);
      const sample: Buy = recent?.length ? recent[recent.length - 1] : {
        key: 'test', txHash: '0x' + '0'.repeat(64), from: BUY_WALLET, token: 'USDC',
        micro: 100_000_000, ts: Math.floor(Date.now() / 1000), block: head, logIndex: 0,
      };
      const { state } = await readState();
      // Totals shown are what they WOULD be — the stored state is not written.
      const hypothetical = withBuy(state ?? emptyState(head), sample);
      const price = await getLingoPriceUsd();
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

    const { state, error: readError } = await readState();
    if (readError) {
      return res.status(503).json({ error: 'State unreadable — skipped this run rather than risk absorbing unposted buys' });
    }

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
    const destIds = dests.map(d => d.id);
    const fresh = await getBuys(state.lastBlock + 1, head, budget);
    if (!fresh) return res.status(200).json({ error: 'Log budget exhausted' });

    // Already counted, but a channel still owes it — retry just that channel.
    const retries = fresh.filter(b => seen.has(b.key)
      && (state.delivered?.[b.key] ?? destIds).length < destIds.length);
    const buys = fresh.filter(b => !seen.has(b.key));

    let st: BuysState = { ...state, lastBlock: state.lastBlock, delivered: { ...(state.delivered ?? {}) } };
    let posted = 0;
    let failed: string | null = null;
    // A buy that reached some channels but not all must stay inside the scan
    // window, or the pointer moves past it and the retry never happens.
    let incomplete = false;
    const price = (buys.length || retries.length) ? await getLingoPriceUsd() : null;

    for (const b of retries) {
      const done = new Set(st.delivered?.[b.key] ?? []);
      for (const d of dests) {
        if (done.has(d.id)) continue;
        if (await d.send(b, st, price)) done.add(d.id);
      }
      st.delivered = { ...st.delivered, [b.key]: [...done] };
      if (done.size < destIds.length) incomplete = true;
      try { await saveState(st); } catch { failed = 'state save failed'; break; }
    }

    for (const b of buys) {
      if (failed) break;
      const next = withBuy(st, b);
      // Send everywhere, then commit if ANY channel took it: the buy is
      // announced and counted once, and whoever missed it is retried above.
      const done: string[] = [];
      for (const d of dests) {
        if (await d.send(b, next, price)) done.push(d.id);
      }
      if (!done.length) { failed = `no channel accepted the post (${destIds.join(', ')})`; break; }
      st = next;
      st.delivered = { ...st.delivered, [b.key]: done };
      if (done.length < destIds.length) incomplete = true;
      posted++;
      // Persist after EVERY post, keeping the old block pointer. Saving once
      // at the end meant a failed save (or a killed run) re-posted every buy
      // already announced, every 2 minutes until the save went through.
      try {
        await saveState(st);
      } catch {
        failed = 'state save failed after posting';
        break;
      }
    }
    // Only advance the pointer once the whole batch is posted and saved; the
    // seen-set keeps already-posted buys from repeating on the retry.
    if (!failed && !incomplete) {
      st.lastBlock = head;
      try { await saveState(st); } catch { failed = 'state save failed'; }
    }

    // A non-2xx makes a broken webhook visible in Vercel's cron logs instead
    // of stalling silently behind a 200.
    return res.status(failed || incomplete ? 502 : 200).json({
      posted,
      channels: destIds,
      retried: retries.length,
      pending: buys.length - posted,
      fromBlock: state.lastBlock + 1,
      toBlock: head,
      ...(failed ? { error: `${failed} — will retry next run` }
        : incomplete ? { error: 'a channel did not accept every buy — retrying the missing one next run' } : {}),
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
