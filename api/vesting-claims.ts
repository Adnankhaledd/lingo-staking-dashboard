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
 * For weekly buckets, block→timestamp is interpolated from ~8 sampled block
 * timestamps across the range (fixed 2s/block drifts too much over months).
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
const REORG_MARGIN = 100; // ~3 min on Base — never cache the very tip

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

/** Build an accurate block→unix-seconds function from sampled real timestamps. */
async function buildBlockToTs(minBlock: number, maxBlock: number, head: number, headTs: number) {
  const fallback = (b: number) => headTs - (head - b) * 2;
  if (maxBlock <= minBlock) return fallback;
  const N = 8;
  const wanted = new Set<number>();
  for (let i = 0; i <= N; i++) wanted.add(Math.round(minBlock + (maxBlock - minBlock) * i / N));
  wanted.add(head);
  const samples: Array<[number, number]> = [];
  for (const b of [...wanted].sort((a, z) => a - z)) {
    const r = await rpc<{ timestamp: string }>('eth_getBlockByNumber', ['0x' + b.toString(16), false]);
    if (r.ok && r.result) samples.push([b, parseInt(r.result.timestamp, 16)]);
  }
  if (samples.length < 2) return fallback;
  return (b: number) => {
    // piecewise-linear interpolation / endpoint extrapolation
    if (b <= samples[0][0]) {
      const [b0, t0] = samples[0], [b1, t1] = samples[1];
      return Math.round(t0 + (b - b0) * (t1 - t0) / (b1 - b0));
    }
    for (let i = 0; i < samples.length - 1; i++) {
      const [b0, t0] = samples[i], [b1, t1] = samples[i + 1];
      if (b <= b1) return Math.round(t0 + (b - b0) * (t1 - t0) / (b1 - b0));
    }
    const [b0, t0] = samples[samples.length - 2], [b1, t1] = samples[samples.length - 1];
    return Math.round(t0 + (b - b0) * (t1 - t0) / (b1 - b0));
  };
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

  const qAddr = req.query.address;
  const address = (typeof qAddr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(qAddr)) ? qAddr.toLowerCase() : DEFAULT_ADDRESS;
  const qTopic = req.query.topic;
  const topic = (typeof qTopic === 'string' && /^0x[0-9a-fA-F]{64}$/.test(qTopic)) ? qTopic.toLowerCase() : DEFAULT_TOPIC;
  const bucket = req.query.bucket === 'month' ? 'month' : 'week';
  const qFrom = req.query.fromBlock;
  const fromBlock = (typeof qFrom === 'string' && /^\d+$/.test(qFrom)) ? parseInt(qFrom, 10) : DEFAULT_FROM_BLOCK;

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

    // Only pay for a head-block timestamp when some log lacks its own.
    const needsInterp = logs.some(l => !l.blockTimestamp);
    let blockToTs: (b: number) => number = () => 0;
    if (needsInterp) {
      const headBlk = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [headRes.result, false]);
      const headTs = headBlk.ok ? parseInt(headBlk.result.timestamp, 16) : Math.floor(Date.now() / 1000);
      // NOTE: spread (Math.min(...arr)) overflows the call stack at ~100k+ logs.
      let minBlock = Infinity, maxBlock = -Infinity;
      for (const l of logs) {
        const b = parseInt(l.blockNumber, 16);
        if (b < minBlock) minBlock = b;
        if (b > maxBlock) maxBlock = b;
      }
      blockToTs = await buildBlockToTs(minBlock, maxBlock, head, headTs);
    }

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
