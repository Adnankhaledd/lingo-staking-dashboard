import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/vesting-claims-monthly — monthly LINGO claimed from a claim/vesting
 * contract, measured from the contract's OWN claim event.
 *
 * Why not just sum LINGO transfers out of the contract? Because this vesting
 * contract MINTS to the claimer (Transfer from 0x0) rather than sending tokens
 * it holds — so a "transfers from the contract address" scan reports zero even
 * while claims are happening. The claim event fires either way, so it is the
 * only reliable measure.
 *
 * Event: Claimed(address user, uint256 amount) — no indexed params, so
 *   data word[0] = claimer, data word[1] = amount (1e18).
 *
 * ?address= to point at another claim contract, ?topic= for a different event.
 * Cached 30 min.
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const DEFAULT_ADDRESS = '0xad11f733e401e16c72033c5decaf05dcc0e1beb8'; // vesting contract
const DEFAULT_TOPIC = '0xc7798891864187665ac6dd119286e44ec13f014527aeeb2b8eb3fd413df93179';
const MAX_REQUESTS = 140;
const LOG_PAGE_LIMIT = 9500;
const BASE_BLOCK_SECONDS = 2;
// The contract has no activity before this; starting at 0 wastes splits.
const DEFAULT_FROM_BLOCK = 20_000_000;

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

/** Fetch all logs, splitting the block range on error or a full page. */
async function getAllLogs(
  address: string, topic: string, from: number, to: number,
  budget: { left: number }, diag: { firstError: string | null; splits: number },
): Promise<RawLog[] | null> {
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
    if (!r.ok && !diag.firstError) diag.firstError = `[${lo}-${hi}] ${r.error}`;
    if (!r.ok || (r.result?.length ?? 0) >= LOG_PAGE_LIMIT) {
      if (lo === hi) { if (!r.ok) return null; out.push(...(r.result ?? [])); continue; }
      diag.splits++;
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
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ALCHEMY_API_KEY) return res.status(200).json({ configured: false, error: 'ALCHEMY_API_KEY not set' });

  const qAddr = req.query.address;
  const address = (typeof qAddr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(qAddr)) ? qAddr.toLowerCase() : DEFAULT_ADDRESS;
  const qTopic = req.query.topic;
  const topic = (typeof qTopic === 'string' && /^0x[0-9a-fA-F]{64}$/.test(qTopic)) ? qTopic.toLowerCase() : DEFAULT_TOPIC;

  const budget = { left: MAX_REQUESTS };
  try {
    const headRes = await rpc<string>('eth_blockNumber', []);
    if (!headRes.ok) return res.status(200).json({ error: `head: ${headRes.error}` });
    const head = parseInt(headRes.result, 16);
    const blkRes = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [headRes.result, false]);
    const headTs = blkRes.ok ? parseInt(blkRes.result.timestamp, 16) : Math.floor(Date.now() / 1000);

    const qFrom = req.query.fromBlock;
    const fromBlock = (typeof qFrom === 'string' && /^\d+$/.test(qFrom)) ? parseInt(qFrom, 10) : DEFAULT_FROM_BLOCK;

    const diag = { firstError: null as string | null, splits: 0 };
    const logs = await getAllLogs(address, topic, fromBlock, head, budget, diag);
    if (!logs) {
      return res.status(200).json({
        error: 'Request budget exhausted — narrow the range with ?fromBlock=',
        fromBlock, head, splits: diag.splits, firstRpcError: diag.firstError,
      });
    }

    const weiByMonth = new Map<string, bigint>();
    const countByMonth = new Map<string, number>();
    let totalWei = 0n;
    for (const log of logs) {
      const d = log.data.slice(2);
      if (d.length < 128) continue;
      // word[0] = claimer address, word[1] = amount
      const amountWei = BigInt('0x' + d.slice(64, 128));
      const block = parseInt(log.blockNumber, 16);
      const ts = headTs - (head - block) * BASE_BLOCK_SECONDS;
      const month = new Date(ts * 1000).toISOString().slice(0, 7);
      weiByMonth.set(month, (weiByMonth.get(month) ?? 0n) + amountWei);
      countByMonth.set(month, (countByMonth.get(month) ?? 0) + 1);
      totalWei += amountWei;
    }

    const months = [...weiByMonth.keys()].sort().map(m => ({
      month: m,
      lingoClaimed: Math.round(toLingo(weiByMonth.get(m)!)),
      claims: countByMonth.get(m) ?? 0,
    }));

    return res.status(200).json({
      address,
      topic,
      asOfBlock: head,
      requestsUsed: MAX_REQUESTS - budget.left,
      fromBlock,
      splits: diag.splits,
      firstRpcError: diag.firstError,
      totalClaims: logs.length,
      totalLingoClaimed: Math.round(toLingo(totalWei)),
      months,
    });
  } catch (error) {
    return res.status(200).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
