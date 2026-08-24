import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/vesting-large-claims — recent individual LINGO claims from the vesting
 * contract above a size threshold, live from Alchemy.
 *
 * Reads the contract's OWN Claimed(address,uint256) event (mint-safe — see
 * api/vesting-claims.ts). Each Alchemy log carries a real blockTimestamp and
 * transactionHash, so we can list exact claims with wallet + time + tx.
 *
 * Params:
 *   ?days=30       lookback window in days (default 30, max 365)
 *   ?minLingo=50000 minimum claim size to include (default 50000)
 *   ?limit=200     max rows returned (default 200, max 1000)
 *   ?address= ?topic=  overrides (default = LINGO vesting contract)
 * Cached 10 min.
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const DEFAULT_ADDRESS = '0xad11f733e401e16c72033c5decaf05dcc0e1beb8';
const DEFAULT_TOPIC = '0xc7798891864187665ac6dd119286e44ec13f014527aeeb2b8eb3fd413df93179';
const ABS_MIN_BLOCK = 20_000_000;
const MAX_REQUESTS = 120;
const LOG_PAGE_LIMIT = 9500;
const SEC_PER_BLOCK = 2; // Base ~2s/block; we over-cover then filter by real ts

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

const WEI = 10n ** 18n;
const toLingo = (w: bigint) => Number(w / WEI) + Number(w % WEI) / 1e18;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ALCHEMY_API_KEY) return res.status(200).json({ configured: false, error: 'ALCHEMY_API_KEY not set' });

  const qAddr = req.query.address;
  const address = (typeof qAddr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(qAddr)) ? qAddr.toLowerCase() : DEFAULT_ADDRESS;
  const qTopic = req.query.topic;
  const topic = (typeof qTopic === 'string' && /^0x[0-9a-fA-F]{64}$/.test(qTopic)) ? qTopic.toLowerCase() : DEFAULT_TOPIC;

  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const minLingo = Math.max(0, Number(req.query.minLingo) || 50000);
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));

  const budget = { left: MAX_REQUESTS };
  try {
    const headRes = await rpc<string>('eth_blockNumber', []);
    if (!headRes.ok) return res.status(200).json({ error: `head: ${headRes.error}` });
    const head = parseInt(headRes.result, 16);
    const headBlk = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [headRes.result, false]);
    const nowTs = headBlk.ok ? parseInt(headBlk.result.timestamp, 16) : Math.floor(Date.now() / 1000);
    const cutoffTs = nowTs - days * 86400;

    // Over-cover the window in blocks, then filter precisely by real blockTimestamp.
    const blocksBack = Math.ceil((days * 86400) / SEC_PER_BLOCK) + 5000;
    const fromBlock = Math.max(ABS_MIN_BLOCK, head - blocksBack);

    const logs = await getAllLogs(address, topic, fromBlock, head, budget);
    if (!logs) return res.status(200).json({ error: 'Request budget exhausted — narrow ?days=' });

    const minWei = BigInt(Math.round(minLingo)) * WEI;
    const rows: Array<{ wallet: string; lingo: number; timestamp: number; txHash: string | null }> = [];
    let windowWei = 0n; // total (all sizes) claimed in window, for context
    let windowClaims = 0;
    for (const log of logs) {
      const d = log.data.slice(2);
      if (d.length < 128) continue;
      const ts = log.blockTimestamp ? parseInt(log.blockTimestamp, 16) : 0;
      if (ts && ts < cutoffTs) continue;
      const amountWei = BigInt('0x' + d.slice(64, 128));
      windowWei += amountWei;
      windowClaims++;
      if (amountWei < minWei) continue;
      const wallet = '0x' + d.slice(24, 64); // claimer (word[0], last 20 bytes)
      rows.push({ wallet, lingo: toLingo(amountWei), timestamp: ts, txHash: log.transactionHash ?? null });
    }

    rows.sort((a, b) => b.timestamp - a.timestamp || b.lingo - a.lingo);
    const largeWei = rows.reduce((s, r) => s + BigInt(Math.round(r.lingo)) * WEI, 0n);

    return res.status(200).json({
      address,
      days,
      minLingo,
      asOfBlock: head,
      nowTs,
      cutoffTs,
      requestsUsed: MAX_REQUESTS - budget.left,
      windowClaims,
      windowLingo: Math.round(toLingo(windowWei)),
      largeClaims: rows.length,
      largeLingo: Math.round(toLingo(largeWei)),
      claims: rows.slice(0, limit),
      truncated: rows.length > limit,
    });
  } catch (error) {
    return res.status(200).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
