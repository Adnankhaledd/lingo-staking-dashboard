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
 * Cached 15 min.
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const DEFAULT_ADDRESS = '0xad11f733e401e16c72033c5decaf05dcc0e1beb8'; // vesting contract
const DEFAULT_TOPIC = '0xc7798891864187665ac6dd119286e44ec13f014527aeeb2b8eb3fd413df93179'; // Claimed(address,uint256)
const DEFAULT_FROM_BLOCK = 20_000_000; // no activity before this
const MAX_REQUESTS = 220;
const LOG_PAGE_LIMIT = 9500;

interface RawLog { data: string; blockNumber: string }

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
    const headBlk = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [headRes.result, false]);
    const headTs = headBlk.ok ? parseInt(headBlk.result.timestamp, 16) : Math.floor(Date.now() / 1000);

    const logs = await getAllLogs(address, topic, fromBlock, head, budget);
    if (!logs) return res.status(200).json({ error: 'Request budget exhausted — pass ?fromBlock= to narrow' });

    if (logs.length === 0) {
      return res.status(200).json({ address, bucket, asOfBlock: head, totalClaims: 0, totalLingoClaimed: 0, buckets: [] });
    }

    const claimBlocks = logs.map(l => parseInt(l.blockNumber, 16));
    const blockToTs = await buildBlockToTs(Math.min(...claimBlocks), Math.max(...claimBlocks), head, headTs);

    const weiByBucket = new Map<string, bigint>();
    const countByBucket = new Map<string, number>();
    let totalWei = 0n;
    for (const log of logs) {
      const d = log.data.slice(2);
      if (d.length < 128) continue;
      const amountWei = BigInt('0x' + d.slice(64, 128));
      const ts = blockToTs(parseInt(log.blockNumber, 16));
      const key = bucket === 'week' ? weekKey(ts) : monthKey(ts);
      weiByBucket.set(key, (weiByBucket.get(key) ?? 0n) + amountWei);
      countByBucket.set(key, (countByBucket.get(key) ?? 0) + 1);
      totalWei += amountWei;
    }

    const buckets = [...weiByBucket.keys()].sort().map(k => ({
      period: k,
      lingoClaimed: Math.round(toLingo(weiByBucket.get(k)!)),
      claims: countByBucket.get(k) ?? 0,
    }));

    return res.status(200).json({
      address,
      bucket,
      asOfBlock: head,
      requestsUsed: MAX_REQUESTS - budget.left,
      totalClaims: logs.length,
      totalLingoClaimed: Math.round(toLingo(totalWei)),
      buckets,
    });
  } catch (error) {
    return res.status(200).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
