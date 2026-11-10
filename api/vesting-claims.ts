import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/vesting-claims — LINGO claimed from a claim/vesting contract, per week
 * (default) or month, live from Alchemy.
 *
 * Measured from the contract's OWN Claimed(address,uint256) event, NOT from
 * token transfers — because this vesting contract MINTS to the claimer
 * (Transfer from 0x0), so the token Transfer doesn't involve the contract
 * address at all and a transfers scan misses every claim. The Claimed event is
 * emitted by the contract (log.address == contract), so eth_getLogs on it
 * captures claims regardless of mint-vs-transfer. Event has no indexed params:
 *   data word[0] = claimer, data word[1] = amount (1e18).
 *
 * Each log is dated by its own blockTimestamp, or by Base's block clock if a
 * log ever lacks one (never a fixed seconds-per-block: Base went 2s → 200ms).
 *
 * Params: ?bucket=week|month (default week), ?address=, ?topic=, ?fromBlock=.
 *
 * Rescanning all history cost up to 220 eth_getLogs per CDN cache miss — by
 * far the heaviest endpoint here. The per-bucket totals are now kept in Vercel
 * Blob with the last block scanned, so a run only reads blocks added since
 * then: typically ONE eth_getLogs. Only the default contract/topic/range is
 * cached; an overridden ?address=/?topic=/?fromBlock= still scans fresh.
 *
 * The stored cursor stops REORG_MARGIN blocks behind the head, so the tip is
 * rescanned next time rather than being frozen into the cache by a reorg.
 */

import { put, list } from '@vercel/blob';

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const DEFAULT_ADDRESS = '0xad11f733e401e16c72033c5decaf05dcc0e1beb8'; // vesting contract
const DEFAULT_TOPIC = '0xc7798891864187665ac6dd119286e44ec13f014527aeeb2b8eb3fd413df93179'; // Claimed(address,uint256)
const DEFAULT_FROM_BLOCK = 20_000_000; // no activity before this
const MAX_REQUESTS = 220;
const LOG_PAGE_LIMIT = 9500;
const CACHE_KEY = 'vesting-claims-cache.json';
const REORG_MARGIN = 1_000; // a few minutes of Base blocks — never cache the very tip

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

/** period -> [wei as a decimal string, claim count] */
type CacheBuckets = Record<string, [string, number]>;
interface ClaimsCache {
  address: string;
  topic: string;
  fromBlock: number;
  asOfBlock: number;
  weekly: CacheBuckets;
  monthly: CacheBuckets;
  updatedAt: string;
}

// Inline blob read — direct URL fetch with a list() fallback.
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

interface RawLog { data: string; blockNumber: string; blockTimestamp?: string; transactionHash?: string }

async function rpc<T>(method: string, params: unknown[]): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.error) return { ok: false, error: JSON.stringify(data.error).slice(0, 200) };
    return { ok: true, result: data.result as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'fetch failed' };
  }
}

async function getAllLogs(address: string, topic: string, from: number, to: number, budget: { left: number }): Promise<RawLog[] | null> {
  const out: RawLog[] = [];
  const stack: Array<[number, number]> = [[from, to]];
  while (stack.length) {
    if (budget.left <= 0) return null;
    const [lo, hi] = stack.pop()!;
    if (lo > hi) continue;
    budget.left--;
    const r = await rpc<RawLog[]>('eth_getLogs', [{
      address, topics: [topic],
      fromBlock: '0x' + lo.toString(16),
      toBlock: '0x' + hi.toString(16),
    }]);
    if (!r.ok || (r.result?.length ?? 0) >= LOG_PAGE_LIMIT) {
      if (lo === hi) { if (!r.ok) return null; out.push(...(r.result ?? [])); continue; }
      const mid = Math.floor((lo + hi) / 2);
      stack.push([mid + 1, hi], [lo, mid]);
      continue;
    }
    out.push(...r.result);
  }
  return out;
}

function weekKey(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day; // back to Monday
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff)).toISOString().slice(0, 10);
}
function monthKey(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 7);
}

const WEI = 10n ** 18n;
const toLingo = (w: bigint) => Number(w / WEI) + Number(w % WEI) / 1e18;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ALCHEMY_API_KEY) return res.status(200).json({ configured: false, error: 'ALCHEMY_API_KEY not set' });

  // The dashboard only asks for the default contract and range. Overrides used
  // to start an uncached scan (up to ~16k CU) per distinct value, so they're refused.
  if (req.query.address !== undefined || req.query.topic !== undefined || req.query.fromBlock !== undefined) {
    return res.status(400).json({ error: 'address/topic/fromBlock overrides are not supported' });
  }
  const address = DEFAULT_ADDRESS;
  const topic = DEFAULT_TOPIC;
  const bucket = req.query.bucket === 'month' ? 'month' : 'week';
  const fromBlock = DEFAULT_FROM_BLOCK;

  const budget = { left: MAX_REQUESTS };
  try {
    const headRes = await rpc<string>('eth_blockNumber', []);
    if (!headRes.ok) return res.status(200).json({ error: `head: ${headRes.error}` });
    const head = parseInt(headRes.result, 16);
    const safeHead = Math.max(fromBlock, head - REORG_MARGIN);

    // Only the default contract/topic/range shares the cache.
    const cacheable = address === DEFAULT_ADDRESS && topic === DEFAULT_TOPIC && fromBlock === DEFAULT_FROM_BLOCK;
    const cached = cacheable ? await fetchBlobJson<ClaimsCache>(CACHE_KEY) : null;
    const usable = !!cached
      && cached.address === address && cached.topic === topic && cached.fromBlock === fromBlock
      && typeof cached.asOfBlock === 'number' && cached.asOfBlock >= fromBlock - 1 && cached.asOfBlock <= head;

    const weekly = new Map<string, [bigint, number]>();
    const monthly = new Map<string, [bigint, number]>();
    if (usable && cached) {
      for (const [k, v] of Object.entries(cached.weekly ?? {})) weekly.set(k, [BigInt(v[0]), v[1]]);
      for (const [k, v] of Object.entries(cached.monthly ?? {})) monthly.set(k, [BigInt(v[0]), v[1]]);
    }

    const scanFrom = usable && cached ? cached.asOfBlock + 1 : fromBlock;
    const didScan = scanFrom <= safeHead;
    let logs: RawLog[] = [];
    if (didScan) {
      const got = await getAllLogs(address, topic, scanFrom, safeHead, budget);
      if (!got) return res.status(200).json({ error: 'Request budget exhausted — pass ?fromBlock= to narrow' });
      logs = got;
    }

    // Alchemy puts a blockTimestamp on every log; date any that lack one by the block clock.
    for (const log of logs) {
      const d = log.data.slice(2);
      if (d.length < 128) continue;
      const amountWei = BigInt('0x' + d.slice(64, 128));
      const ts = log.blockTimestamp ? parseInt(log.blockTimestamp, 16) : blockToTs(parseInt(log.blockNumber, 16));
      for (const [map, key] of [[weekly, weekKey(ts)], [monthly, monthKey(ts)]] as const) {
        const cur = map.get(key) ?? [0n, 0];
        map.set(key, [cur[0] + amountWei, cur[1] + 1]);
      }
    }

    const asOfBlock = didScan ? safeHead : (usable && cached ? cached.asOfBlock : fromBlock - 1);

    if (cacheable && (logs.length > 0 || !usable)) {
      const ser = (m: Map<string, [bigint, number]>): CacheBuckets =>
        Object.fromEntries([...m].map(([k, v]) => [k, [v[0].toString(), v[1]] as [string, number]]));
      try {
        await put(CACHE_KEY, JSON.stringify({
          address, topic, fromBlock, asOfBlock,
          weekly: ser(weekly), monthly: ser(monthly),
          updatedAt: new Date().toISOString(),
        }), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
      } catch (err) {
        console.warn('vesting-claims cache write failed:', err instanceof Error ? err.message : err);
      }
    }

    let totalWei = 0n;
    let totalClaims = 0;
    for (const v of monthly.values()) { totalWei += v[0]; totalClaims += v[1]; }

    const src = bucket === 'week' ? weekly : monthly;
    const buckets = [...src.keys()].sort().map(k => ({
      period: k,
      lingoClaimed: Math.round(toLingo(src.get(k)![0])),
      claims: src.get(k)![1],
    }));

    return res.status(200).json({
      address,
      bucket,
      asOfBlock,
      cached: usable,
      newLogs: logs.length,
      requestsUsed: MAX_REQUESTS - budget.left,
      totalClaims,
      totalLingoClaimed: Math.round(toLingo(totalWei)),
      buckets,
    });
  } catch (error) {
    return res.status(200).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
