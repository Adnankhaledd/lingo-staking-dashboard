import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list } from '@vercel/blob';

/**
 * /api/pool-prices — LINGO's USD price for every day since launch, from the
 * LINGO/WETH pool's own trades: each swap valued by its WETH side × ETH/USD,
 * volume-weighted over the day. Same method and pool as /api/fees-collected.
 * The Alchemy LINGO price feed is not used: it disagreed with the pool by
 * 1.6–2.7× in Jan–Mar 2026.
 *
 * Finished months are computed once and stored write-once; a rebuild fills
 * missing months within its time budget, recomputes the current month, and
 * writes the summary that page views read. Page views make no Alchemy calls.
 *
 *   GET              stored summary (never builds)
 *   GET ?rebuild=1   (cron/admin) fill missing months + refresh the current one.
 *                    One rebuild per 30-minute slot, claimed write-once, so a
 *                    burst of calls can't multiply Alchemy usage (CRON_SECRET
 *                    unset leaves this open, like the other cron endpoints).
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const HIST_PRICES_URL = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/historical`;
const CRON_SECRET = process.env.CRON_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const POOL = '0x9399da51c1a85e64cce4b30b554875d2b89b2445';   // LINGO/WETH V3: token0 = WETH, token1 = LINGO
// keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)") — Uniswap V3
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const FIRST_MONTH = '2024-12';
const MONTH_PREFIX = 'pool-prices-v1/months/';
const SUMMARY_KEY = 'pool-prices-v1/summary.json';
const CLAIM_PREFIX = 'pool-prices-v1/claims/';     // one write-once file per 30-minute rebuild slot
const DAY = 86_400;
const BLOCK_SECONDS = 2;
const MONTH_MARGIN_BLOCKS = 2_000;    // block↔time is estimated; swaps are filtered by their own timestamp
const INITIAL_CHUNK_BLOCKS = 650_000; // ~15 days; split only when a page is full or refused
const LOG_PAGE_LIMIT = 9_500;
const WORK_BUDGET_MS = 40_000;
const REBUILD_MIN_AGE_MS = 30 * 60 * 1000;
const MAX_REQUESTS = 300;
const RETRIES = 3;

export interface MonthPrices {
  version: 1;
  month: string;
  computedAt: string;
  swaps: number;
  /** [YYYY-MM-DD, LINGO/USD, LINGO traded] for each day with trades. */
  days: Array<[string, number, number]>;
}

export interface Summary {
  version: 1;
  generatedAt: string;
  complete: boolean;
  pool: string;
  /** [YYYY-MM-DD, LINGO/USD] for each day with trades, ascending. */
  days: Array<[string, number]>;
}

// ─── Pure (exported for tests) ───────────────────────────────────────────

export interface SwapIn { ts: number; lingoDelta: number; wethDelta: number }

/** A day's LINGO/USD from the pool's trades, volume-weighted. */
export function dailyVwap(swaps: SwapIn[], ethPriceAt: (day: number) => number | null): Array<[string, number, number]> {
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
  return [...acc.entries()]
    .filter(([, a]) => a.lingo > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([day, a]) => [isoDay(day), a.usd / a.lingo, Math.round(a.lingo)]);
}

const isoDay = (day: number) => new Date(day * DAY * 1000).toISOString().slice(0, 10);
const monthStartTs = (m: string) => { const [y, mo] = m.split('-').map(Number); return Date.UTC(y, mo - 1, 1) / 1000; };
const nextMonth = (m: string) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const monthOfTs = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 7);

// ─── Chain + prices ──────────────────────────────────────────────────────

interface RawLog { data: string; blockNumber: string; blockTimestamp?: string }

class Budget {
  left = MAX_REQUESTS;
  calls = 0;
  take() { if (this.left <= 0) return false; this.left--; this.calls++; return true; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const isTransient = (status: number, msg: string) =>
  status === 429 || status >= 500 || /rate|capacity|timeout|timed out|exceeded.*compute|throughput/i.test(msg);

type RpcResult<T> = { ok: true; result: T } | { ok: false; error: string; transient: boolean };

async function rpc<T>(method: string, params: unknown[], budget: Budget): Promise<RpcResult<T>> {
  for (let attempt = 0; ; attempt++) {
    if (!budget.take()) return { ok: false, error: 'request budget exhausted', transient: false };
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
      } else error = `HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : 'fetch failed';
      status = 599;
    }
    const transient = isTransient(status, error);
    if (attempt >= RETRIES || !transient) return { ok: false, error, transient };
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
    // Throttling is not "range too big": splitting would turn one refused call into dozens.
    if (!r.ok && r.transient) throw new Error(`getLogs throttled: ${r.error}`);
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

/**
 * ETH/USD by UTC day from Alchemy's price history. Every chunk must arrive:
 * a month priced off a neighbouring chunk's ETH would be stored write-once.
 */
async function ethDailyPrices(startTs: number, endTs: number, budget: Budget): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let from = startTs; from <= endTs; from += 360 * DAY) {
    const to = Math.min(endTs, from + 360 * DAY);
    let got = false;
    for (let attempt = 0; attempt <= RETRIES && !got; attempt++) {
      if (attempt) await sleep(400 * 2 ** attempt);
      if (!budget.take()) throw new Error('Request budget exhausted');
      try {
        const res = await fetch(HIST_PRICES_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: 'ETH', startTime: new Date(from * 1000).toISOString(), endTime: new Date(to * 1000).toISOString(), interval: '1d' }),
        });
        if (!res.ok) { if (isTransient(res.status, '')) continue; break; }
        const json = await res.json();
        for (const d of json?.data ?? []) {
          const v = Number(d?.value);
          const t = Date.parse(d?.timestamp ?? '');
          if (Number.isFinite(v) && v > 0 && Number.isFinite(t)) out.set(Math.floor(t / 1000 / DAY), v);
        }
        got = true;
      } catch { /* retried */ }
    }
    if (!got) throw new Error(`ETH price history unavailable for ${new Date(from * 1000).toISOString().slice(0, 10)}…`);
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
    return byDay.get(days[best >= 0 ? best : 0]) ?? null;
  };
}

const int256 = (hex: string): bigint => {
  const v = BigInt('0x' + hex);
  return v >= (1n << 255n) ? v - (1n << 256n) : v;
};

interface Ctx { head: number; headTs: number; budget: Budget; ethPriceAt: (day: number) => number | null }

async function computeMonth(month: string, ctx: Ctx): Promise<MonthPrices> {
  const startTs = monthStartTs(month);
  const endTs = Math.min(monthStartTs(nextMonth(month)), ctx.headTs + 1);
  const blockAt = (ts: number) => ctx.head - Math.round((ctx.headTs - ts) / BLOCK_SECONDS);
  const from = Math.max(0, blockAt(startTs) - MONTH_MARGIN_BLOCKS);
  const to = Math.min(ctx.head, blockAt(endTs) + MONTH_MARGIN_BLOCKS);
  const logs = await getAllLogs({ address: POOL, topics: [SWAP_TOPIC] }, from, to, ctx.budget);
  const swaps: SwapIn[] = [];
  for (const l of logs) {
    if (l.data.length < 130) continue;
    const ts = l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : ctx.headTs - (ctx.head - parseInt(l.blockNumber, 16)) * BLOCK_SECONDS;
    if (ts < startTs || ts >= endTs) continue;
    const weth = Number(int256(l.data.slice(2, 66))) / 1e18;
    const lingo = Number(int256(l.data.slice(66, 130))) / 1e18;
    swaps.push({ ts, lingoDelta: lingo, wethDelta: weth });
  }
  return { version: 1, month, computedAt: new Date().toISOString(), swaps: swaps.length, days: dailyVwap(swaps, ctx.ethPriceAt) };
}

// ─── Storage ─────────────────────────────────────────────────────────────

async function readSummary(): Promise<Summary | null> {
  const m = (process.env.BLOB_READ_WRITE_TOKEN || '').match(/^vercel_blob_rw_([^_]+)_/);
  if (!m) return null;
  try {
    const r = await fetch(`https://${m[1]}.public.blob.vercel-storage.com/${SUMMARY_KEY}`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Claim this 30-minute slot's rebuild. False if another call already has it. */
async function claimSlot(): Promise<boolean> {
  const slot = new Date(Math.floor(Date.now() / REBUILD_MIN_AGE_MS) * REBUILD_MIN_AGE_MS).toISOString().slice(0, 16).replace(':', '-');
  try {
    await put(`${CLAIM_PREFIX}${slot}.json`, '{}', { access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json' });
    return true;
  } catch { return false; }
}

/** Finished months already stored. Write-once files, so a CDN copy is never stale. */
async function storedMonths(): Promise<Map<string, MonthPrices>> {
  const out = new Map<string, MonthPrices>();
  const { blobs } = await list({ prefix: MONTH_PREFIX });
  await Promise.all(blobs.map(async b => {
    try {
      const r = await fetch(b.url);
      if (!r.ok) return;
      const rec = await r.json() as MonthPrices;
      if (rec?.version === 1 && Array.isArray(rec.days)) out.set(rec.month, rec);
    } catch { /* recomputed below */ }
  }));
  return out;
}

// ─── Handler ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isCron = !CRON_SECRET || req.headers.authorization === `Bearer ${CRON_SECRET}`;
  const pw = (req.headers['x-admin-password'] as string | undefined) ?? (req.query.password as string | undefined);
  const isAdmin = !!ADMIN_PASSWORD && pw === ADMIN_PASSWORD;
  const wantsRebuild = req.query.rebuild === '1';
  if (wantsRebuild && !isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });

  const summary = await readSummary();
  const age = summary ? Date.now() - Date.parse(summary.generatedAt) : Infinity;
  const serveStored = () => {
    if (!summary) return res.status(200).json({ error: 'Pool prices have not been built yet' });
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ ...summary, served: 'stored' });
  };
  if (!wantsRebuild || (summary?.complete && age < REBUILD_MIN_AGE_MS)) return serveStored();
  if (!ALCHEMY_API_KEY) return res.status(200).json({ error: 'ALCHEMY_API_KEY not set' });
  // One rebuild per slot: concurrent or repeated calls get the stored summary.
  // (A partial backfill therefore continues in the next slot.)
  if (!(await claimSlot())) return serveStored();

  const t0 = Date.now();
  const budget = new Budget();
  try {
    const headRes = await rpc<string>('eth_blockNumber', [], budget);
    if (!headRes.ok) throw new Error(`head: ${headRes.error}`);
    const head = parseInt(headRes.result, 16);
    const blk = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [headRes.result, false], budget);
    const headTs = blk.ok ? parseInt(blk.result.timestamp, 16) : Math.floor(Date.now() / 1000);

    const currentMonth = monthOfTs(headTs);
    const months: string[] = [];
    for (let m = FIRST_MONTH; m <= currentMonth; m = nextMonth(m)) months.push(m);
    const stored = await storedMonths();
    const missing = months.filter(m => m !== currentMonth && !stored.has(m));

    // ETH prices only for the span being computed.
    const firstNeeded = missing[0] ?? currentMonth;
    const eth = await ethDailyPrices(monthStartTs(firstNeeded) - DAY, headTs, budget);
    if (!eth.size) throw new Error('No ETH price history');
    const ctx: Ctx = { head, headTs, budget, ethPriceAt: makePriceAt(eth) };

    const computed: string[] = [];
    for (const m of missing) {
      if (Date.now() - t0 > WORK_BUDGET_MS) break;
      const rec = await computeMonth(m, ctx);
      stored.set(m, rec);
      computed.push(m);
      try {
        await put(`${MONTH_PREFIX}${m}.json`, JSON.stringify(rec), {
          access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json',
        });
      } catch { /* already written by an overlapping call — same content */ }
    }
    const stillMissing = missing.filter(m => !stored.has(m));
    if (stillMissing.length) {
      return res.status(202).json({
        complete: false,
        progress: `${months.length - 1 - stillMissing.length} of ${months.length - 1} finished months stored`,
        next: stillMissing[0], computedThisCall: computed, requests: budget.calls, elapsedMs: Date.now() - t0,
      });
    }

    if (Date.now() - t0 > WORK_BUDGET_MS) {
      return res.status(202).json({ complete: false, progress: 'finished months stored; current month next run', computedThisCall: computed, requests: budget.calls, elapsedMs: Date.now() - t0 });
    }
    const current = await computeMonth(currentMonth, ctx);
    const days: Array<[string, number]> = [];
    for (const m of months) {
      const rec = m === currentMonth ? current : stored.get(m)!;
      for (const [d, p] of rec.days) days.push([d, p]);
    }
    const body: Summary = { version: 1, generatedAt: new Date().toISOString(), complete: true, pool: POOL, days };
    // Display-only and fully rebuilt from write-once months each time, so one
    // overwritten key is fine (see memory: vercel-blob-cdn-stale).
    await put(SUMMARY_KEY, JSON.stringify(body), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60,
    });
    return res.status(200).json({ ...body, served: 'built', computedThisCall: [...computed, currentMonth], requests: budget.calls, elapsedMs: Date.now() - t0 });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error', requests: budget.calls, elapsedMs: Date.now() - t0 });
  }
}
