import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list } from '@vercel/blob';

/**
 * /api/fees-collected — fees since launch, from on-chain data via Alchemy.
 * Replaces the two frozen Dune queries behind the old "Total Fees Collected"
 * card (6288543 treasury fees, 6693715 LP fees), keeping their definitions:
 *
 *   Treasury fees  LINGO transferred INTO the Treasury, each transfer ≤ 100k
 *                  (larger ones are internal moves, as in the Dune query).
 *                  Valued at the LINGO price ON THE DAY it arrived — the Dune
 *                  query used a monthly average and hardcoded $0.50 / $0.40
 *                  for the launch months.
 *   LP fees        The LINGO/WETH V3 pool's fee tier × its swap volume, which
 *                  is what the pool paid its liquidity providers.
 *
 * Nothing is dropped from the Treasury side: every inflow is tagged by who
 * sent it (users, swap routers, DEX pools, project wallets, claim contracts,
 * mints), and the page decides what counts as a fee. That way the definition
 * can change without re-reading a million events.
 *
 * SCALE. ~750k Treasury transfers and ~250k swaps since launch — far too much
 * for one 60s call. So each month is computed once and stored write-once
 * under fees-v1/months/; a call processes as many missing months as fit in
 * its time budget and reports progress. Once history is filled, a refresh
 * only re-reads the current month (a handful of requests).
 *
 *   GET             summary (fills missing months first if needed)
 *   GET ?rebuild=1  (cron/admin) recompute the current month, at most every 30 min
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const HIST_PRICES_URL = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/historical`;
const CRON_SECRET = process.env.CRON_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const TREASURY = '0x0e0bc2919540119fc22a502842a74af4d81502b6';
const POOL = '0x9399da51c1a85e64cce4b30b554875d2b89b2445'; // LINGO/WETH V3 — the pool the Dune query used
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)") — Uniswap V3
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const ZERO = '0x0000000000000000000000000000000000000000';

const FIRST_MONTH = '2024-12';          // launch
const MONTH_PREFIX = 'fees-v1/months/';
const SUMMARY_KEY = 'fees-v1/summary.json';
const MAX_TRANSFER_LINGO = 100_000;     // same cut-off as Dune query 6288543
const DUST_LINGO = 1;                   // below this is address-poisoning dust
const WORK_BUDGET_MS = 40_000;
const SUMMARY_FRESH_MS = 6 * 60 * 60 * 1000;
const REBUILD_MIN_AGE_MS = 30 * 60 * 1000;
const MAX_REQUESTS = 250;
const LOG_PAGE_LIMIT = 9500;
const DAY = 86_400;
// Month ranges are found by estimating blocks from the head, then every log is
// filed by its own timestamp. The margin makes a slightly-off estimate harmless.
const BLOCK_MARGIN = 43_200;            // ~1 day of Base blocks
const BLOCK_SECONDS = 2;
// Start from chunks this size and only split further on a full page. Asking
// for a whole month at once made the node do a month-long scan of LINGO's
// entire transfer history per request.
const INITIAL_CHUNK_BLOCKS = 100_000;   // ~2.3 days
const RETRIES = 3;

// ─── Who sent it ─────────────────────────────────────────────────────────

export type SenderCategory = 'user' | 'router' | 'dex' | 'project' | 'claims' | 'mint';
export const CATEGORIES: SenderCategory[] = ['user', 'router', 'dex', 'project', 'claims', 'mint'];

// Same lists as api/backfill-stake-sources.ts (api/ can't share modules).
const PROJECT_WALLETS: Record<string, string> = {
  '0x0e0bc2919540119fc22a502842a74af4d81502b6': 'Treasury',
  '0x7e3e2d6b8b87ce617b7ccdd63d0f5449e4057513': 'Team Buybacks',
  '0x69892fc8e176d9750e7f0ca06fc9aede0fc97bcb': 'Team Buybacks',
  '0x61f8d3fc749ecda98d378bc2cc8459ba0f7dfd58': 'Team Multisig',
  '0x0fe275fdfde7eb75a15c0ae8971450dd6f06e7f8': 'Project Safe',
  '0x8557ef53d037408d225479dd8544dffb06c88d46': 'Liquidity Locker',
  '0x3ea37aa113b092dd14dfada7118efb919c092d0d': 'Liquidity Locker',
  '0xc588e4415ab61aa8a9496efbe9d715de75550e2a': 'Deployer',
  '0xe8313a4b7a6aaea9e92a8d4acbb08034cb39bf2f': 'Team wallet',
  '0xffc781ddfa8d1358ce8c7dda7ced1e56e922aea6': 'Reward wallet',
  '0x64967c0dd5605dd3efc6a9bb148b2687a532c15f': 'Previous reward wallet',
};
const CLAIM_CONTRACTS: Record<string, string> = {
  '0x2f26621e931c32542579cf8860d7e8616df32e0e': 'APY rewards',
  '0xad11f733e401e16c72033c5decaf05dcc0e1beb8': 'Vesting',
  '0x8001b2029782bbf1b3c85c3a23ecae60e3fa0447': 'Vesting (Decubate)',
  '0x610111763a4a6c64dd8926c12ca3e52fb7b7897c': 'Token claim',
};
const DEX_POOLS: Record<string, string> = {
  '0x9399da51c1a85e64cce4b30b554875d2b89b2445': 'LINGO/WETH V3',
  '0xb08fefa8f0f01b9a224fdef416e919b1ceba0d84': 'LINGO/WETH V2',
  '0x6d85d9f6d80b433ef9eed943e83868d71805a6cd': 'LINGO/WETH 1%',
  '0x498581ff718922c3f8e6a244956af099b2652b2b': 'Uniswap V4',
  '0x675177f8ede3f25f8149b4e9df7562798014467f': 'Aerodrome USDC/LINGO',
  '0x6d2205bd16d9f132713e00fb9e1da8ffb5150d37': 'Aerodrome',
  '0x1ba7301b43b69f1dc9a6d2017b090a52ff386478': 'Aerodrome',
  '0x0191fea2ff26116dec46ea699c65b8696020e766': 'Aerodrome',
};
const ROUTERS: Record<string, string> = {
  '0x6ff5693b99212da76ad316178a184ab56d299b43': 'Uniswap', '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap',
  '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap', '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aerodrome',
  '0x6cb442acf35158d5eda88fe602221b67b400be3e': 'Aerodrome', '0x19ceead7105607cd444f5ad10dd51356436095a1': 'Odos',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch', '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch',
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'KyberSwap', '0xc7d3ab410d49b664d03fe5b1038852ac852b1b29': 'KyberSwap',
  '0x6a000f20005980200259b80c5102003040001068': 'ParaSwap', '0xdef171fe48cf0115b1d80b88dc8eab59176fee57': 'ParaSwap',
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41': 'CoW Swap', '0x6352a56caadc4f1e25cd6c75970fa768a3304e64': 'OpenOcean',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x/Matcha', '0x053bd88ae6fb19ad94d6ac781dcfc178a463436c': '0x/Matcha',
  '0xdb6f1920a889355780af7570773609bd8cb1f498': '0x/Matcha', '0x881d40237659c251811cec9c364ef91dc08d300c': 'MetaMask Swaps',
  '0x67d03631fe51b741c0c00c4e16eb662ac84381df': 'OKX DEX', '0x6b2c0c7be2048daa9b5527982c29f48062b34d58': 'OKX DEX',
  '0x5e8df5b010d57e525562791717011d496676552a': 'OKX DEX', '0x3d98f6f05e7940c056788ff8492a943a0904240d': 'OKX DEX',
  '0x69c236e021f5775b0d0328ded5eac708e3b869df': 'OKX DEX', '0x5e2f47bd7d4b357fcfd0bb224eb665773b1b9801': 'OKX DEX',
  '0x2bd541ab3b704f7d4c9dff79efadeaa85ec034f1': 'OKX DEX', '0xbc1d9760bd6ca468ca9fb5ff2cfbeac35d86c973': 'Bitget DEX',
  '0xb141f554188cf306fde443f6e991949636f80e49': 'Bitget Swap', '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae': 'LI.FI/Jumper',
  '0x02e5be68d46dac0b524905bff209cf47ee6db2a9': 'a swap proxy', '0x278d858f05b94576c1e6f73285886876ff6ef8d2': 'a swap router',
  '0x411d2c093e4c2e69bf0d8e94be1bf13dadd879c6': 'an aggregator', '0xd688ab46dc476a05a093e4442d06ceb348adbda8': 'an aggregator',
};

function categoryOf(addr: string): { category: SenderCategory; label: string | null } {
  if (addr === ZERO) return { category: 'mint', label: 'Mint' };
  if (PROJECT_WALLETS[addr]) return { category: 'project', label: PROJECT_WALLETS[addr] };
  if (CLAIM_CONTRACTS[addr]) return { category: 'claims', label: CLAIM_CONTRACTS[addr] };
  if (DEX_POOLS[addr]) return { category: 'dex', label: DEX_POOLS[addr] };
  if (ROUTERS[addr]) return { category: 'router', label: ROUTERS[addr] };
  return { category: 'user', label: null };
}

// ─── Records ─────────────────────────────────────────────────────────────

export interface Agg { lingo: number; usd: number; transfers: number }

export interface MonthRecord {
  version: 1;
  month: string;                 // YYYY-MM
  final: boolean;                // a finished month, stored once
  computedAt: string;
  avgPrice: number | null;       // mean daily LINGO/USD over the month
  treasury: {
    byCategory: Record<SenderCategory, Agg>;   // transfers ≥ 1 and ≤ 100k LINGO
    uniqueSenders: number;
    dust: Agg;                                  // < 1 LINGO
    over100k: Agg;                              // excluded, as in the Dune query
    topSenders: Array<{ address: string; category: SenderCategory; label: string | null; lingo: number; transfers: number }>;
  };
  pool: { swaps: number; volumeUsd: number; feesUsd: number; volumeLingo: number };
}

export interface Summary {
  version: 1;
  generatedAt: string;
  complete: boolean;
  pool: { address: string; feeTier: number; lingoIsToken0: boolean };
  months: MonthRecord[];
}

// ─── Pure aggregation (exported for tests) ───────────────────────────────

export interface TransferIn { ts: number; from: string; lingo: number }
export interface SwapIn { ts: number; lingoDelta: number }

const zeroAgg = (): Agg => ({ lingo: 0, usd: 0, transfers: 0 });
const r2 = (n: number) => Math.round(n * 100) / 100;

export function aggregateMonth(
  month: string,
  final: boolean,
  transfers: TransferIn[],
  swaps: SwapIn[],
  priceAt: (day: number) => number | null,
  feeTier: number,               // e.g. 3000 = 0.3%
  now: string,
): MonthRecord {
  const byCategory = Object.fromEntries(CATEGORIES.map(c => [c, zeroAgg()])) as Record<SenderCategory, Agg>;
  const dust = zeroAgg();
  const over100k = zeroAgg();
  const senders = new Map<string, { lingo: number; transfers: number }>();

  for (const t of transfers) {
    const usd = t.lingo * (priceAt(Math.floor(t.ts / DAY)) ?? 0);
    const bucket = t.lingo < DUST_LINGO ? dust : t.lingo > MAX_TRANSFER_LINGO ? over100k : byCategory[categoryOf(t.from).category];
    bucket.lingo += t.lingo; bucket.usd += usd; bucket.transfers++;
    if (t.lingo >= DUST_LINGO && t.lingo <= MAX_TRANSFER_LINGO) {
      const s = senders.get(t.from) ?? { lingo: 0, transfers: 0 };
      s.lingo += t.lingo; s.transfers++;
      senders.set(t.from, s);
    }
  }

  let volumeUsd = 0, volumeLingo = 0;
  for (const s of swaps) {
    const lingo = Math.abs(s.lingoDelta);
    volumeLingo += lingo;
    volumeUsd += lingo * (priceAt(Math.floor(s.ts / DAY)) ?? 0);
  }

  const days = new Set<number>();
  for (const t of transfers) days.add(Math.floor(t.ts / DAY));
  for (const s of swaps) days.add(Math.floor(s.ts / DAY));
  const prices = [...days].map(d => priceAt(d)).filter((p): p is number => p != null);

  const roundAgg = (a: Agg): Agg => ({ lingo: r2(a.lingo), usd: r2(a.usd), transfers: a.transfers });
  return {
    version: 1,
    month,
    final,
    computedAt: now,
    avgPrice: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
    treasury: {
      byCategory: Object.fromEntries(CATEGORIES.map(c => [c, roundAgg(byCategory[c])])) as Record<SenderCategory, Agg>,
      uniqueSenders: senders.size,
      dust: roundAgg(dust),
      over100k: roundAgg(over100k),
      topSenders: [...senders.entries()]
        .sort((a, b) => b[1].lingo - a[1].lingo)
        .slice(0, 15)
        .map(([address, v]) => ({ address, ...categoryOf(address), lingo: r2(v.lingo), transfers: v.transfers })),
    },
    pool: {
      swaps: swaps.length,
      volumeLingo: r2(volumeLingo),
      volumeUsd: r2(volumeUsd),
      feesUsd: r2(volumeUsd * feeTier / 1_000_000),
    },
  };
}

// ─── Chain + prices ──────────────────────────────────────────────────────

interface RawLog { topics: string[]; data: string; blockNumber: string; blockTimestamp?: string }

class Budget {
  left = MAX_REQUESTS;
  calls = 0;
  retries = 0;
  errors: string[] = [];
  take() { if (this.left <= 0) return false; this.left--; this.calls++; return true; }
  note(e: string) { if (this.errors.length < 8 && !this.errors.includes(e)) this.errors.push(e); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Rate limits and server errors are retried, not treated as "range too big". */
const isTransient = (status: number, msg: string) =>
  status === 429 || status >= 500 || /rate|capacity|timeout|timed out|exceeded.*compute|throughput/i.test(msg);

async function rpc<T>(method: string, params: unknown[], budget: Budget): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  for (let attempt = 0; ; attempt++) {
    if (!budget.take()) return { ok: false, error: 'request budget exhausted' };
    let status = 0, error = '';
    try {
      const res = await fetch(ALCHEMY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      status = res.status;
      if (res.ok) {
        const data = await res.json();
        if (!data.error) return { ok: true, result: data.result as T };
        error = JSON.stringify(data.error).slice(0, 200);
      } else {
        error = `HTTP ${res.status}`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'fetch failed';
      status = 599;
    }
    budget.note(`${method}: ${error}`);
    if (attempt >= RETRIES || !isTransient(status, error)) return { ok: false, error };
    budget.retries++;
    await sleep(400 * 2 ** attempt);
  }
}

async function getAllLogs(filter: Record<string, unknown>, from: number, to: number, budget: Budget): Promise<RawLog[]> {
  const out: RawLog[] = [];
  const stack: Array<[number, number]> = [];
  for (let hi = to; hi >= from; hi -= INITIAL_CHUNK_BLOCKS) stack.push([Math.max(from, hi - INITIAL_CHUNK_BLOCKS + 1), hi]);
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (lo > hi) continue;
    const r = await rpc<RawLog[]>('eth_getLogs', [{ ...filter, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }], budget);
    if (!r.ok && r.error === 'request budget exhausted') throw new Error('Request budget exhausted');
    if (!r.ok || (r.result?.length ?? 0) >= LOG_PAGE_LIMIT) {
      if (lo === hi) { if (!r.ok) throw new Error(`getLogs failed at block ${lo}: ${r.error}`); out.push(...r.result); continue; }
      const mid = Math.floor((lo + hi) / 2);
      stack.push([mid + 1, hi], [lo, mid]);
      continue;
    }
    out.push(...r.result);
  }
  return out;
}

async function getDailyPrices(startTs: number, endTs: number, budget: Budget): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let from = startTs; from <= endTs; from += 360 * DAY) {
    const to = Math.min(endTs, from + 360 * DAY);
    if (!budget.take()) break;
    try {
      const res = await fetch(HIST_PRICES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          network: 'base-mainnet', address: LINGO_TOKEN,
          startTime: new Date(from * 1000).toISOString(), endTime: new Date(to * 1000).toISOString(), interval: '1d',
        }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      for (const d of json?.data ?? []) {
        const v = Number(d?.value);
        const t = Date.parse(d?.timestamp ?? '');
        if (Number.isFinite(v) && v > 0 && Number.isFinite(t)) out.set(Math.floor(t / 1000 / DAY), v);
      }
    } catch { /* missing days fall back to the nearest known price */ }
  }
  return out;
}

function makePriceAt(byDay: Map<number, number>): (day: number) => number | null {
  const days = [...byDay.keys()].sort((a, b) => a - b);
  return (day: number) => {
    if (!days.length) return null;
    const exact = byDay.get(day);
    if (exact != null) return exact;
    let lo = 0, hi = days.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] <= day) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return byDay.get(days[best >= 0 ? best : 0]) ?? null;   // before the first quote → first quote
  };
}

const int256 = (hex: string): bigint => {
  const v = BigInt('0x' + hex);
  return v >= (1n << 255n) ? v - (1n << 256n) : v;
};
const WEI = 10n ** 18n;
const toLingo = (w: bigint) => Number(w / WEI) + Number(w % WEI) / 1e18;

interface Ctx {
  head: number; headTs: number; budget: Budget;
  priceAt: (day: number) => number | null;
  feeTier: number; lingoIsToken0: boolean;
}

async function loadContext(): Promise<Ctx> {
  const budget = new Budget();
  const headRes = await rpc<string>('eth_blockNumber', [], budget);
  if (!headRes.ok) throw new Error(`head: ${headRes.error}`);
  const head = parseInt(headRes.result, 16);
  const [headBlock, feeRes, t0Res] = await Promise.all([
    rpc<{ timestamp: string }>('eth_getBlockByNumber', [headRes.result, false], budget),
    rpc<string>('eth_call', [{ to: POOL, data: '0xddca3f43' }, 'latest'], budget),   // fee()
    rpc<string>('eth_call', [{ to: POOL, data: '0x0dfe1681' }, 'latest'], budget),   // token0()
  ]);
  const headTs = headBlock.ok ? parseInt(headBlock.result.timestamp, 16) : Math.floor(Date.now() / 1000);
  if (!feeRes.ok || !t0Res.ok) throw new Error('Could not read the pool');
  const feeTier = Number(BigInt(feeRes.result));
  const lingoIsToken0 = ('0x' + t0Res.result.slice(-40)).toLowerCase() === LINGO_TOKEN;
  const [y, m] = FIRST_MONTH.split('-').map(Number);
  const prices = await getDailyPrices(Date.UTC(y, m - 1, 1) / 1000, headTs, budget);
  return { head, headTs, budget, priceAt: makePriceAt(prices), feeTier, lingoIsToken0 };
}

const monthStartTs = (month: string) => { const [y, m] = month.split('-').map(Number); return Date.UTC(y, m - 1, 1) / 1000; };
const nextMonth = (month: string) => { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const monthOfTs = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 7);

async function computeMonth(month: string, ctx: Ctx): Promise<MonthRecord> {
  const startTs = monthStartTs(month);
  const current = month === monthOfTs(ctx.headTs);
  const endTs = current ? ctx.headTs + 1 : monthStartTs(nextMonth(month));
  const blockAt = (ts: number) => ctx.head - Math.round((ctx.headTs - ts) / BLOCK_SECONDS);
  const from = Math.max(0, blockAt(startTs) - BLOCK_MARGIN);
  const to = Math.min(ctx.head, blockAt(endTs) + BLOCK_MARGIN);
  const tsOf = (log: RawLog) => log.blockTimestamp
    ? parseInt(log.blockTimestamp, 16)
    : ctx.headTs - (ctx.head - parseInt(log.blockNumber, 16)) * BLOCK_SECONDS;
  const inMonth = (ts: number) => ts >= startTs && ts < endTs;

  const transferLogs = await getAllLogs({ address: LINGO_TOKEN, topics: [TRANSFER_TOPIC, null, '0x' + TREASURY.slice(2).padStart(64, '0')] }, from, to, ctx.budget);
  const swapLogs = await getAllLogs({ address: POOL, topics: [SWAP_TOPIC] }, from, to, ctx.budget);

  const transfers: TransferIn[] = [];
  for (const log of transferLogs) {
    const ts = tsOf(log);
    if (!inMonth(ts) || log.topics.length < 3) continue;
    transfers.push({ ts, from: ('0x' + log.topics[1].slice(26)).toLowerCase(), lingo: toLingo(BigInt(log.data)) });
  }
  const swaps: SwapIn[] = [];
  for (const log of swapLogs) {
    const ts = tsOf(log);
    if (!inMonth(ts) || log.data.length < 130) continue;
    const amount0 = int256(log.data.slice(2, 66));
    const amount1 = int256(log.data.slice(66, 130));
    const d = ctx.lingoIsToken0 ? amount0 : amount1;
    swaps.push({ ts, lingoDelta: Number(d / WEI) + Number(d % WEI) / 1e18 });
  }
  return aggregateMonth(month, !current, transfers, swaps, ctx.priceAt, ctx.feeTier, new Date().toISOString());
}

// ─── Storage ─────────────────────────────────────────────────────────────

async function readJson<T>(url: string): Promise<T | null> {
  try { const r = await fetch(url); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}

async function readSummary(): Promise<Summary | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const m = token.match(/^vercel_blob_rw_([^_]+)_/);
  if (!m) return null;
  return readJson<Summary>(`https://${m[1]}.public.blob.vercel-storage.com/${SUMMARY_KEY}`);
}

/** Finished months already stored. Each is written once and never changes. */
async function storedMonths(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: MONTH_PREFIX, cursor });
    for (const b of page.blobs) {
      const mm = b.pathname.match(/(\d{4}-\d{2})\.json$/);
      if (mm) out.set(mm[1], b.url);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// ─── Handler ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ALCHEMY_API_KEY) return res.status(200).json({ configured: false, error: 'ALCHEMY_API_KEY not set' });

  const isCron = !CRON_SECRET || req.headers.authorization === `Bearer ${CRON_SECRET}`;
  const pw = (req.headers['x-admin-password'] as string | undefined) ?? (req.query.password as string | undefined);
  const isAdmin = !!ADMIN_PASSWORD && pw === ADMIN_PASSWORD;
  const wantsRebuild = req.query.rebuild === '1';
  if (wantsRebuild && !isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });

  const t0 = Date.now();
  let ctx: Ctx | null = null;
  try {
    // Diagnostics: compute one month without storing it.
    if (typeof req.query.month === 'string' && (isCron || isAdmin)) {
      ctx = await loadContext();
      const rec = await computeMonth(req.query.month, ctx);
      return res.status(200).json({ ...rec, calls: ctx.budget.calls, retries: ctx.budget.retries, errors: ctx.budget.errors, elapsedMs: Date.now() - t0 });
    }

    const summary = await readSummary();
    const age = summary ? Date.now() - Date.parse(summary.generatedAt) : Infinity;
    const serveStored = summary?.complete && (wantsRebuild ? age < REBUILD_MIN_AGE_MS : age < SUMMARY_FRESH_MS);
    if (summary && serveStored) {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
      return res.status(200).json({ ...summary, served: 'stored' });
    }

    ctx = await loadContext();
    const currentMonth = monthOfTs(ctx.headTs);
    const months: string[] = [];
    for (let m = FIRST_MONTH; m <= currentMonth; m = nextMonth(m)) months.push(m);

    const stored = await storedMonths();
    const missing = months.filter(m => m !== currentMonth && !stored.has(m));
    const computed = new Map<string, MonthRecord>();
    for (const m of missing) {
      if (Date.now() - t0 > WORK_BUDGET_MS) break;
      const rec = await computeMonth(m, ctx);
      computed.set(m, rec);
      try {
        await put(`${MONTH_PREFIX}${m}.json`, JSON.stringify(rec), {
          access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json',
        });
      } catch { /* already written by an overlapping call — same content */ }
    }
    const stillMissing = missing.filter(m => !computed.has(m));
    if (stillMissing.length) {
      return res.status(202).json({
        complete: false,
        progress: `${months.length - 1 - stillMissing.length} of ${months.length - 1} finished months stored`,
        next: stillMissing[0],
        computedThisCall: [...computed.keys()],
        elapsedMs: Date.now() - t0,
      });
    }

    const current = Date.now() - t0 < WORK_BUDGET_MS
      ? await computeMonth(currentMonth, ctx)
      : summary?.months.find(r => r.month === currentMonth) ?? null;

    const finals = await Promise.all(months.filter(m => m !== currentMonth).map(async m =>
      computed.get(m) ?? (await readJson<MonthRecord>(stored.get(m)!))));
    if (finals.some(f => !f)) return res.status(503).json({ error: 'A stored month could not be read — try again' });

    const out: Summary = {
      version: 1,
      generatedAt: new Date().toISOString(),
      complete: !!current,
      pool: { address: POOL, feeTier: ctx.feeTier, lingoIsToken0: ctx.lingoIsToken0 },
      months: [...(finals as MonthRecord[]), ...(current ? [current] : [])],
    };
    // Display-only summary, so a single overwritten key is fine (it decides nothing).
    try {
      await put(SUMMARY_KEY, JSON.stringify(out), {
        access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60,
      });
    } catch { /* still serve it */ }
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json({ ...out, served: 'built', elapsedMs: Date.now() - t0 });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
      calls: ctx?.budget.calls, retries: ctx?.budget.retries, errors: ctx?.budget.errors,
      elapsedMs: Date.now() - t0,
    });
  }
}
