import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list } from '@vercel/blob';

/**
 * /api/fees-collected — fees since launch, from on-chain data via Alchemy.
 * Replaces the two frozen Dune queries behind the old "Total Fees Collected"
 * card (6288543, 6693715).
 *
 * TREASURY FEES. The LINGO token takes a transfer fee on every non-exempt
 * transfer (LingoToken._executeTransfer, verified source on Blockscout):
 *     _transfer(from, treasuryWallet, fee);      // fee
 *     _transfer(from, to, amount - fee);         // net leg, the very next log
 * The rate is read from the token's TransferFeeUpdated events: 2% for the
 * first hour after deployment (Dec 10 2024), then 1.25%, switched to 0% on
 * Sep 22 2026. treasuryWallet has been the same address since deployment.
 * So an inflow is a fee only while the rate is above zero, and every inflow of
 * VERIFY_MIN_LINGO or more is checked for its net leg — a transfer straight
 * into the Treasury (a deposit) has none. Fees paid by project wallets, reward
 * and vesting contracts are the project paying itself and are not counted.
 *
 * LP FEES. The LINGO/WETH V3 pool's fee tier × its swap volume — what the pool
 * paid its liquidity providers. Same method as the Dune query.
 *
 * PRICES come from the pool itself: each swap is valued by its WETH side ×
 * ETH/USD, and a day's LINGO price is the pool's volume-weighted average. The
 * Alchemy LINGO price feed is used only for a day with no swaps — it disagreed
 * with the pool by 1.6–2.7× in Jan–Mar 2026.
 *
 * SCALE. ~750k Treasury transfers and ~250k swaps since launch, so each
 * finished month is computed once and stored write-once; a call fills as many
 * missing months as fit in its time budget and reports progress.
 *
 *   GET                    summary (fills missing months first if needed)
 *   GET ?rebuild=1         (cron/admin) recompute the current month, at most every 30 min
 *   GET ?month=YYYY-MM     (admin) one month, not stored, with diagnostics
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
// keccak256("TransferFeeUpdated(uint256)") on the LINGO token
const FEE_UPDATED_TOPIC = '0xf9f635b7cf851af6071aaf78ef8a5f752dc52f19d556fea4512b0c2ad4baea72';

const FIRST_MONTH = '2024-12';          // launch
// v2: transfer-fee verification + pool pricing. v1 files are left untouched.
const MONTH_PREFIX = 'fees-v2/months/';
const SUMMARY_KEY = 'fees-v2/summary.json';
// Inflows this large are checked for the net leg that proves a transfer fee.
// Below it a deposit would be immaterial, and routers/pools never deposit.
const VERIFY_MIN_LINGO = 1_000;
const VERIFY_BATCH = 10;          // small batches: the throughput limit is shared with the Lingo app
const MAX_TRANSFER_LINGO = 100_000;     // same cut-off as Dune query 6288543
const DUST_LINGO = 1;                   // below this is address-poisoning dust
const WORK_BUDGET_MS = 40_000;
const SUMMARY_FRESH_MS = 6 * 60 * 60 * 1000;
const REBUILD_MIN_AGE_MS = 30 * 60 * 1000;
const MAX_REQUESTS = 800;          // runaway guard: HTTP requests per call (a verify batch counts once)
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

// 'deposit' = sent straight to the Treasury (no net leg), or sent while the fee
// was 0%. Everything in user/router/dex is a verified or small transfer fee.
export type SenderCategory = 'user' | 'router' | 'dex' | 'project' | 'claims' | 'mint' | 'deposit';
export const CATEGORIES: SenderCategory[] = ['user', 'router', 'dex', 'project', 'claims', 'mint', 'deposit'];
export const FEE_CATEGORIES: SenderCategory[] = ['user', 'router', 'dex'];

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

function categoryOf(addr: string): { category: Exclude<SenderCategory, 'deposit'>; label: string | null } {
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
  version: 2;
  month: string;                 // YYYY-MM
  final: boolean;                // a finished month, stored once
  computedAt: string;
  avgPrice: number | null;       // mean daily LINGO/USD (pool VWAP) over the month
  pricedFromPoolDays: number;    // days valued from the pool's own trades
  pricedFromFeedDays: number;    // days with no swaps, valued from the Alchemy feed
  treasury: {
    byCategory: Record<SenderCategory, Agg>;   // transfers ≥ 1 and ≤ 100k LINGO
    verified: { checked: number; fees: number; deposits: number };
    uniqueSenders: number;
    dust: Agg;                                  // < 1 LINGO
    over100k: Agg;                              // excluded, as in the Dune query
    topSenders: Array<{ address: string; category: SenderCategory; label: string | null; lingo: number; transfers: number }>;
  };
  pool: { swaps: number; volumeUsd: number; feesUsd: number; volumeLingo: number };
}

export interface Summary {
  version: 2;
  generatedAt: string;
  complete: boolean;
  pool: { address: string; feeTier: number; lingoIsToken0: boolean };
  /** The token's transfer-fee rate over time, from TransferFeeUpdated events. */
  feeSchedule: Array<{ fromBlock: number; fromTs: number; bps: number }>;
  months: MonthRecord[];
}

// ─── Pure aggregation (exported for tests) ───────────────────────────────

export interface TransferIn { ts: number; block: number; from: string; lingo: number; feeActive: boolean; verified?: boolean }
export interface SwapIn { ts: number; lingoDelta: number; wethDelta: number }

const zeroAgg = (): Agg => ({ lingo: 0, usd: 0, transfers: 0 });
const r2 = (n: number) => Math.round(n * 100) / 100;

/** A day's LINGO/USD from the pool's own trades (volume-weighted). */
export function poolDailyPrices(swaps: SwapIn[], ethPriceAt: (day: number) => number | null): Map<number, number> {
  const acc = new Map<number, { usd: number; lingo: number }>();
  for (const s of swaps) {
    const day = Math.floor(s.ts / DAY);
    const eth = ethPriceAt(day);
    if (eth == null || s.lingoDelta === 0) continue;
    const a = acc.get(day) ?? { usd: 0, lingo: 0 };
    a.usd += Math.abs(s.wethDelta) * eth;
    a.lingo += Math.abs(s.lingoDelta);
    acc.set(day, a);
  }
  const out = new Map<number, number>();
  for (const [day, a] of acc) if (a.lingo > 0) out.set(day, a.usd / a.lingo);
  return out;
}

export function aggregateMonth(
  month: string,
  final: boolean,
  transfers: TransferIn[],
  swaps: SwapIn[],
  ethPriceAt: (day: number) => number | null,
  feedPriceAt: (day: number) => number | null,   // fallback for a day with no swaps
  feeTier: number,                                // e.g. 3000 = 0.3%
  now: string,
): MonthRecord {
  // ── LINGO price: the pool's VWAP for the day, else the nearest pool day, else the feed ──
  const pool = poolDailyPrices(swaps, ethPriceAt);
  const poolDays = [...pool.keys()].sort((a, b) => a - b);
  let fromPool = 0, fromFeed = 0;
  const priceCache = new Map<number, number | null>();
  const lingoPriceAt = (day: number): number | null => {
    if (priceCache.has(day)) return priceCache.get(day)!;
    let p: number | null = pool.get(day) ?? null;
    if (p != null) fromPool++;
    else {
      const earlier = poolDays.filter(d => d < day).pop();
      const later = poolDays.find(d => d > day);
      const near = earlier ?? later;
      p = near != null ? pool.get(near)! : feedPriceAt(day);
      if (near != null) fromPool++; else fromFeed++;
    }
    priceCache.set(day, p);
    return p;
  };

  const byCategory = Object.fromEntries(CATEGORIES.map(c => [c, zeroAgg()])) as Record<SenderCategory, Agg>;
  const dust = zeroAgg();
  const over100k = zeroAgg();
  const senders = new Map<string, { lingo: number; transfers: number }>();
  const verified = { checked: 0, fees: 0, deposits: 0 };

  for (const t of transfers) {
    const usd = t.lingo * (lingoPriceAt(Math.floor(t.ts / DAY)) ?? 0);
    let bucket: Agg;
    if (t.lingo < DUST_LINGO) bucket = dust;
    else if (t.lingo > MAX_TRANSFER_LINGO) bucket = over100k;
    else {
      const { category } = categoryOf(t.from);
      if (t.verified !== undefined) { verified.checked++; if (t.verified) verified.fees++; else verified.deposits++; }
      const isFeeCategory = FEE_CATEGORIES.includes(category);
      bucket = byCategory[isFeeCategory && (!t.feeActive || t.verified === false) ? 'deposit' : category];
      const s = senders.get(t.from) ?? { lingo: 0, transfers: 0 };
      s.lingo += t.lingo; s.transfers++;
      senders.set(t.from, s);
    }
    bucket.lingo += t.lingo; bucket.usd += usd; bucket.transfers++;
  }

  let volumeUsd = 0, volumeLingo = 0;
  for (const s of swaps) {
    volumeLingo += Math.abs(s.lingoDelta);
    volumeUsd += Math.abs(s.wethDelta) * (ethPriceAt(Math.floor(s.ts / DAY)) ?? 0);
  }

  const days = new Set<number>();
  for (const t of transfers) days.add(Math.floor(t.ts / DAY));
  for (const s of swaps) days.add(Math.floor(s.ts / DAY));
  const prices = [...days].map(d => lingoPriceAt(d)).filter((p): p is number => p != null);

  const roundAgg = (a: Agg): Agg => ({ lingo: r2(a.lingo), usd: r2(a.usd), transfers: a.transfers });
  return {
    version: 2,
    month,
    final,
    computedAt: now,
    avgPrice: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null,
    pricedFromPoolDays: fromPool,
    pricedFromFeedDays: fromFeed,
    treasury: {
      byCategory: Object.fromEntries(CATEGORIES.map(c => [c, roundAgg(byCategory[c])])) as Record<SenderCategory, Agg>,
      verified,
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

interface RawLog { topics: string[]; data: string; blockNumber: string; blockTimestamp?: string; transactionHash: string; logIndex: string }

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

async function getAllLogs(filter: Record<string, unknown>, from: number, to: number, budget: Budget, initialChunk = INITIAL_CHUNK_BLOCKS): Promise<RawLog[]> {
  const out: RawLog[] = [];
  const stack: Array<[number, number]> = [];
  for (let hi = to; hi >= from; hi -= initialChunk) stack.push([Math.max(from, hi - initialChunk + 1), hi]);
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

/** Daily USD prices from Alchemy's history endpoint, by token address or symbol. */
async function getDailyPrices(
  token: { network: string; address: string } | { symbol: string },
  startTs: number, endTs: number, budget: Budget,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let from = startTs; from <= endTs; from += 360 * DAY) {
    const to = Math.min(endTs, from + 360 * DAY);
    if (!budget.take()) break;
    try {
      const res = await fetch(HIST_PRICES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...token,
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
  ethPriceAt: (day: number) => number | null;
  feedPriceAt: (day: number) => number | null;
  feeTier: number; lingoIsToken0: boolean;
  feeSchedule: Array<{ fromBlock: number; fromTs: number; bps: number }>;
}

/** Transfer-fee rate in force at a block (0 before deployment). */
function feeBpsAt(schedule: Ctx['feeSchedule'], block: number): number {
  let bps = 0;
  for (const s of schedule) { if (s.fromBlock <= block) bps = s.bps; else break; }
  return bps;
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

  // A handful of events across the whole history: one full-range query, split only if refused.
  const feeLogs = await getAllLogs({ address: LINGO_TOKEN, topics: [FEE_UPDATED_TOPIC] }, 0, head, budget, head + 1);
  const feeSchedule = feeLogs
    .map(l => ({
      fromBlock: parseInt(l.blockNumber, 16),
      fromTs: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : headTs - (head - parseInt(l.blockNumber, 16)) * BLOCK_SECONDS,
      bps: Number(BigInt(l.data)),
      logIndex: parseInt(l.logIndex, 16),
    }))
    .sort((a, b) => a.fromBlock - b.fromBlock || a.logIndex - b.logIndex)
    .map(({ fromBlock, fromTs, bps }) => ({ fromBlock, fromTs, bps }));
  if (!feeSchedule.length) throw new Error('No TransferFeeUpdated events found on the token');

  const [y, m] = FIRST_MONTH.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1) / 1000;
  const [eth, lingo] = await Promise.all([
    getDailyPrices({ symbol: 'ETH' }, start, headTs, budget),
    getDailyPrices({ network: 'base-mainnet', address: LINGO_TOKEN }, start, headTs, budget),
  ]);
  if (!eth.size) throw new Error('No ETH price history');
  return { head, headTs, budget, ethPriceAt: makePriceAt(eth), feedPriceAt: makePriceAt(lingo), feeTier, lingoIsToken0, feeSchedule };
}

/**
 * Confirm transfer fees by their net leg: the fee log is followed, in the same
 * transaction, by a Transfer from the same sender. Batched JSON-RPC.
 */
async function verifyFees(cands: Array<{ from: string; block: number; tx: string; logIndex: number }>, budget: Budget): Promise<boolean[]> {
  const out: boolean[] = new Array(cands.length).fill(false);
  for (let i = 0; i < cands.length; i += VERIFY_BATCH) {
    const chunk = cands.slice(i, i + VERIFY_BATCH);
    if (!budget.take()) throw new Error('Request budget exhausted');
    const body = chunk.map((c, j) => ({
      jsonrpc: '2.0', id: j, method: 'eth_getLogs',
      params: [{ address: LINGO_TOKEN, topics: [TRANSFER_TOPIC, '0x' + c.from.slice(2).padStart(64, '0')], fromBlock: '0x' + c.block.toString(16), toBlock: '0x' + c.block.toString(16) }],
    }));
    let results: Array<{ id: number; result?: RawLog[] }> | null = null;
    for (let attempt = 0; attempt <= RETRIES && !results; attempt++) {
      try {
        const res = await fetch(ALCHEMY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (res.ok) { const j = await res.json(); if (Array.isArray(j)) results = j; }
        else budget.note(`verify batch: HTTP ${res.status}`);
      } catch (e) { budget.note(`verify batch: ${e instanceof Error ? e.message : 'failed'}`); }
      if (!results) { budget.retries++; await sleep(400 * 2 ** attempt); }
    }
    if (!results) throw new Error('Fee verification failed');
    for (const r of results) {
      const c = chunk[r.id];
      const logs = r.result ?? [];
      out[i + r.id] = logs.some(l => l.transactionHash === c.tx && parseInt(l.logIndex, 16) === c.logIndex + 1);
    }
  }
  return out;
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
  const cands: Array<{ from: string; block: number; tx: string; logIndex: number; at: number }> = [];
  for (const log of transferLogs) {
    const ts = tsOf(log);
    if (!inMonth(ts) || log.topics.length < 3) continue;
    const block = parseInt(log.blockNumber, 16);
    const from = ('0x' + log.topics[1].slice(26)).toLowerCase();
    const lingo = toLingo(BigInt(log.data));
    const feeActive = feeBpsAt(ctx.feeSchedule, block) > 0;
    transfers.push({ ts, block, from, lingo, feeActive });
    if (feeActive && lingo >= VERIFY_MIN_LINGO && lingo <= MAX_TRANSFER_LINGO && FEE_CATEGORIES.includes(categoryOf(from).category)) {
      cands.push({ from, block, tx: log.transactionHash, logIndex: parseInt(log.logIndex, 16), at: transfers.length - 1 });
    }
  }
  const ok = await verifyFees(cands, ctx.budget);
  cands.forEach((c, i) => { transfers[c.at].verified = ok[i]; });

  const signed = (hex: string) => { const v = int256(hex); return Number(v / WEI) + Number(v % WEI) / 1e18; };
  const swaps: SwapIn[] = [];
  for (const log of swapLogs) {
    const ts = tsOf(log);
    if (!inMonth(ts) || log.data.length < 130) continue;
    const a0 = signed(log.data.slice(2, 66));
    const a1 = signed(log.data.slice(66, 130));
    // WETH has 18 decimals, like LINGO.
    swaps.push({ ts, lingoDelta: ctx.lingoIsToken0 ? a0 : a1, wethDelta: ctx.lingoIsToken0 ? a1 : a0 });
  }
  return aggregateMonth(month, !current, transfers, swaps, ctx.ethPriceAt, ctx.feedPriceAt, ctx.feeTier, new Date().toISOString());
}

// ─── Diagnostic: the other LINGO pools ───────────────────────────────────
// Only POOL is counted. This measures every other venue's swaps so we can tell
// whether their LP fees matter. Monthly LINGO volume per pool; valued offline.

const OTHER_POOLS: Array<{ address: string; name: string; kind: 'v2' | 'v3' | 'solidly' }> = [
  { address: '0xb08fefa8f0f01b9a224fdef416e919b1ceba0d84', name: 'LINGO/WETH V2 (0.3%)', kind: 'v2' },
  { address: '0x6d85d9f6d80b433ef9eed943e83868d71805a6cd', name: 'LINGO/WETH V3 1%', kind: 'v3' },
  { address: '0x675177f8ede3f25f8149b4e9df7562798014467f', name: 'Aerodrome USDC/LINGO', kind: 'solidly' },
  { address: '0x6d2205bd16d9f132713e00fb9e1da8ffb5150d37', name: 'Aerodrome LINGO pool', kind: 'solidly' },
  { address: '0x1ba7301b43b69f1dc9a6d2017b090a52ff386478', name: 'Aerodrome LINGO pool', kind: 'solidly' },
  { address: '0x0191fea2ff26116dec46ea699c65b8696020e766', name: 'Aerodrome LINGO pool', kind: 'solidly' },
];
const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const SOLIDLY_SWAP = '0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b';
const V4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const V4_INITIALIZE = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const V4_SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';

async function otherPoolsReport(ctx: Ctx) {
  const month = (log: RawLog) => new Date((log.blockTimestamp ? parseInt(log.blockTimestamp, 16) : ctx.headTs) * 1000).toISOString().slice(0, 7);
  const u = (hex: string) => toLingo(BigInt('0x' + hex));
  const i = (hex: string, bits: number) => { let v = BigInt('0x' + hex); if (v >= 1n << BigInt(bits - 1)) v -= 1n << BigInt(bits); return v; };
  const signedLingo = (v: bigint) => Number(v / WEI) + Number(v % WEI) / 1e18;
  const out: Array<{ name: string; address: string; feeBps: number | null; swaps: number; byMonth: Record<string, { swaps: number; lingo: number; feeLingo?: number }> }> = [];

  for (const p of OTHER_POOLS) {
    const t0 = await rpc<string>('eth_call', [{ to: p.address, data: '0x0dfe1681' }, 'latest'], ctx.budget);
    const lingoIs0 = t0.ok && ('0x' + t0.result.slice(-40)).toLowerCase() === LINGO_TOKEN;
    const topic = p.kind === 'v2' ? V2_SWAP : p.kind === 'solidly' ? SOLIDLY_SWAP : SWAP_TOPIC;
    const logs = await getAllLogs({ address: p.address, topics: [topic] }, 0, ctx.head, ctx.budget, ctx.head + 1);
    let feeBps: number | null = p.kind === 'v2' ? 30 : null;
    if (p.kind === 'v3') { const f = await rpc<string>('eth_call', [{ to: p.address, data: '0xddca3f43' }, 'latest'], ctx.budget); if (f.ok) feeBps = Number(BigInt(f.result)) / 100; }
    const byMonth: Record<string, { swaps: number; lingo: number }> = {};
    for (const l of logs) {
      const d = l.data.slice(2);
      let lingo: number;
      if (p.kind === 'v3') lingo = Math.abs(signedLingo(i(lingoIs0 ? d.slice(0, 64) : d.slice(64, 128), 256)));
      else { const [a0i, a1i, a0o, a1o] = [0, 64, 128, 192].map(o => u(d.slice(o, o + 64))); lingo = lingoIs0 ? Math.max(a0i, a0o) : Math.max(a1i, a1o); }
      const m = month(l);
      const e = byMonth[m] ?? (byMonth[m] = { swaps: 0, lingo: 0 });
      e.swaps++; e.lingo += lingo;
    }
    out.push({ name: p.name, address: p.address, feeBps, swaps: logs.length, byMonth });
  }

  // Uniswap V4 is one contract for every pool: find LINGO's pools by their Initialize event.
  const pad = '0x' + LINGO_TOKEN.slice(2).padStart(64, '0');
  const inits = [
    ...(await getAllLogs({ address: V4_POOL_MANAGER, topics: [V4_INITIALIZE, null, pad] }, 0, ctx.head, ctx.budget, ctx.head + 1)),
    ...(await getAllLogs({ address: V4_POOL_MANAGER, topics: [V4_INITIALIZE, null, null, pad] }, 0, ctx.head, ctx.budget, ctx.head + 1)),
  ];
  for (const init of inits) {
    const id = init.topics[1];
    const lingoIs0 = ('0x' + init.topics[2].slice(-40)).toLowerCase() === LINGO_TOKEN;
    const other = '0x' + (lingoIs0 ? init.topics[3] : init.topics[2]).slice(-40);
    const logs = await getAllLogs({ address: V4_POOL_MANAGER, topics: [V4_SWAP, id] }, 0, ctx.head, ctx.budget, ctx.head + 1);
    const byMonth: Record<string, { swaps: number; lingo: number; feeLingo: number }> = {};
    for (const l of logs) {
      const d = l.data.slice(2);
      const a = signedLingo(i((lingoIs0 ? d.slice(0, 64) : d.slice(64, 128)).slice(32), 128));   // int128 in a 32-byte word
      const fee = Number(BigInt('0x' + d.slice(-64)));                                               // pips, per swap
      const m = month(l);
      const e = byMonth[m] ?? (byMonth[m] = { swaps: 0, lingo: 0, feeLingo: 0 });
      e.swaps++; e.lingo += Math.abs(a); e.feeLingo += Math.abs(a) * fee / 1_000_000;
    }
    out.push({ name: `Uniswap V4 LINGO/${other.slice(0, 8)}… (id ${id.slice(0, 10)}…)`, address: V4_POOL_MANAGER, feeBps: null, swaps: logs.length, byMonth });
  }
  return out;
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
    // Manual diagnostics only — admin password required, never the cron path.
    if (req.query.otherPools === '1' && isAdmin) {
      ctx = await loadContext();
      const pools = await otherPoolsReport(ctx);
      return res.status(200).json({ pools, calls: ctx.budget.calls, errors: ctx.budget.errors, elapsedMs: Date.now() - t0 });
    }

    // Diagnostics: compute one month without storing it.
    if (typeof req.query.month === 'string' && isAdmin) {
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
      version: 2,
      generatedAt: new Date().toISOString(),
      complete: !!current,
      pool: { address: POOL, feeTier: ctx.feeTier, lingoIsToken0: ctx.lingoIsToken0 },
      feeSchedule: ctx.feeSchedule,
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
