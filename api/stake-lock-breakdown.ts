import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/stake-lock-breakdown — exact current breakdown of staked LINGO by lock
 * tier, computed from events only (no per-staker calls, so it's light enough
 * to run on demand).
 *
 * How it works:
 *   Staked(user, amount, duration) at block B  →  position unlocks at B+duration
 *   Unstake-ish event (user, amount, unlockBlock) → closes a matching position
 *   Whatever is still open = current positions, with their ORIGINAL duration
 *   known exactly, and locked-vs-matured = unlockBlock > currentBlock.
 *
 * Self-verifying: the response reconciles the computed net total against the
 * staking contract's actual LINGO balance, so you can see at a glance whether
 * the second event really is an unstake (delta ≈ 0) or something else.
 *
 * Cached 10 min on the CDN — repeat checks are free.
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '0x9aF8C0dac726CcEE2BFd6c0f3E21f320d42398AC').toLowerCase();
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';

// keccak256("Staked(address,uint256,uint256)")
const STAKED_TOPIC = '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90';
// The contract's only other event: (user indexed, uint256 amount, uint256 unlockBlock).
// Empirically an unstake/withdraw — the reconciliation figure in the response confirms it.
const CLOSE_TOPIC = '0x7fc4727e062e336010f2c282598ef5f14facb3de68cf8195c2f23e1454b2b74e';

const DEFAULT_FROM_BLOCK = 0;
const MAX_REQUESTS = 90;   // hard ceiling on getLogs calls
const LOG_PAGE_LIMIT = 9500; // treat a near-10k response as "split this range"

// Known lock durations in blocks (Base ~2s/block). Index 5-8 are currently 0 in
// the contract, but historical positions can use tiers no longer configured
// (e.g. the legacy 24-month), so we label by value, not by array index.
const DURATION_LABELS: Record<string, string> = {
  '0': 'Flexible',
  '1296000': '1 Month',
  '3888000': '3 Months',
  '7776000': '6 Months',
  '15552000': '12 Months',
  '30283200': '24 Months (legacy)',
};

function labelFor(duration: bigint): string {
  const known = DURATION_LABELS[duration.toString()];
  if (known) return known;
  const days = Number(duration) * 2 / 86_400;
  return days > 0 ? `${days.toFixed(0)}d (unlisted)` : 'Flexible';
}

interface RawLog { topics: string[]; data: string; blockNumber: string }

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

/**
 * Fetch all logs for a topic over [from,to], splitting the range whenever the
 * provider errors or returns a suspiciously full page. Returns null if the
 * request budget is exhausted (so we never silently report partial data).
 */
async function getAllLogs(topic: string, from: number, to: number, budget: { left: number }): Promise<RawLog[] | null> {
  const out: RawLog[] = [];
  const stack: Array<[number, number]> = [[from, to]];
  while (stack.length) {
    if (budget.left <= 0) return null;
    const [lo, hi] = stack.pop()!;
    if (lo > hi) continue;
    budget.left--;
    const r = await rpc<RawLog[]>('eth_getLogs', [{
      address: STAKING_CONTRACT,
      topics: [topic],
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
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ALCHEMY_API_KEY) return res.status(200).json({ configured: false, error: 'ALCHEMY_API_KEY not set' });

  const budget = { left: MAX_REQUESTS };

  try {
    const headRes = await rpc<string>('eth_blockNumber', []);
    if (!headRes.ok) return res.status(200).json({ error: `head: ${headRes.error}` });
    const head = parseInt(headRes.result, 16);
    const fromBlock = req.query.fromBlock ? parseInt(String(req.query.fromBlock), 10) : DEFAULT_FROM_BLOCK;

    const [stakedLogs, closeLogs] = await Promise.all([
      getAllLogs(STAKED_TOPIC, fromBlock, head, budget),
      getAllLogs(CLOSE_TOPIC, fromBlock, head, budget),
    ]);
    if (!stakedLogs || !closeLogs) {
      return res.status(200).json({ error: 'Request budget exhausted before full history was read — retry or pass ?fromBlock=' });
    }

    // Open positions keyed by user|unlockBlock|amount → count
    const open = new Map<string, number>();
    // Per-position metadata so we can bucket what remains open
    const meta = new Map<string, { duration: bigint; unlockBlock: number; amountWei: bigint }>();

    for (const log of stakedLogs) {
      if (log.data.length < 130) continue;
      const user = '0x' + log.topics[1].slice(26).toLowerCase();
      const amountWei = BigInt('0x' + log.data.slice(2, 66));
      const duration = BigInt('0x' + log.data.slice(66, 130));
      const block = parseInt(log.blockNumber, 16);
      const unlockBlock = block + Number(duration);
      const key = `${user}|${unlockBlock}|${amountWei.toString()}`;
      open.set(key, (open.get(key) ?? 0) + 1);
      if (!meta.has(key)) meta.set(key, { duration, unlockBlock, amountWei });
    }

    // Close positions using the second event (user, amount, unlockBlock)
    let closedMatched = 0;
    let closedUnmatchedWei = 0n;
    let closedUnmatched = 0;
    for (const log of closeLogs) {
      if (log.data.length < 130) continue;
      const user = '0x' + log.topics[1].slice(26).toLowerCase();
      const amountWei = BigInt('0x' + log.data.slice(2, 66));
      const unlockBlock = Number(BigInt('0x' + log.data.slice(66, 130)));
      const key = `${user}|${unlockBlock}|${amountWei.toString()}`;
      const n = open.get(key) ?? 0;
      if (n > 0) { open.set(key, n - 1); closedMatched++; }
      else { closedUnmatched++; closedUnmatchedWei += amountWei; }
    }

    // Aggregate what's still open
    interface Bucket { label: string; durationBlocks: string; lockedWei: bigint; maturedWei: bigint; positions: number }
    const buckets = new Map<string, Bucket>();
    let totalOpenWei = 0n;
    for (const [key, count] of open) {
      if (count <= 0) continue;
      const m = meta.get(key)!;
      const dk = m.duration.toString();
      let b = buckets.get(dk);
      if (!b) { b = { label: labelFor(m.duration), durationBlocks: dk, lockedWei: 0n, maturedWei: 0n, positions: 0 }; buckets.set(dk, b); }
      const amt = m.amountWei * BigInt(count);
      // duration 0 = flexible (never "locked"); otherwise locked until unlockBlock
      if (m.duration > 0n && m.unlockBlock > head) b.lockedWei += amt; else b.maturedWei += amt;
      b.positions += count;
      totalOpenWei += amt;
    }

    // Ground truth: LINGO actually held by the staking contract
    const balRes = await rpc<string>('eth_call', [{
      to: LINGO_TOKEN,
      data: '0x70a08231' + STAKING_CONTRACT.replace('0x', '').padStart(64, '0'),
    }, 'latest']);
    const onChainWei = balRes.ok && balRes.result && balRes.result !== '0x' ? BigInt(balRes.result) : null;

    const tiers = [...buckets.values()]
      .sort((a, b) => Number(BigInt(a.durationBlocks) - BigInt(b.durationBlocks)))
      .map(b => ({
        tier: b.label,
        stillLocked: Math.round(toLingo(b.lockedWei)),
        unlockedOrFlexible: Math.round(toLingo(b.maturedWei)),
        total: Math.round(toLingo(b.lockedWei + b.maturedWei)),
        positions: b.positions,
      }));

    const totalLocked = tiers.reduce((s, t) => s + t.stillLocked, 0);
    const totalFree = tiers.reduce((s, t) => s + t.unlockedOrFlexible, 0);

    return res.status(200).json({
      asOfBlock: head,
      requestsUsed: MAX_REQUESTS - budget.left,
      events: { staked: stakedLogs.length, closed: closeLogs.length, closedMatched, closedUnmatched },
      summary: {
        stillLocked: totalLocked,
        flexibleOrUnlocked: totalFree,
        totalOpen: Math.round(toLingo(totalOpenWei)),
      },
      tiers,
      reconciliation: onChainWei == null ? null : {
        onChainBalance: Math.round(toLingo(onChainWei)),
        computedOpen: Math.round(toLingo(totalOpenWei)),
        deltaLingo: Math.round(toLingo(totalOpenWei) - toLingo(onChainWei)),
        note: 'delta ≈ 0 means the event model ties out to the contract balance',
      },
      unmatchedCloseEvents: { count: closedUnmatched, lingo: Math.round(toLingo(closedUnmatchedWei)) },
    });
  } catch (error) {
    return res.status(200).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
