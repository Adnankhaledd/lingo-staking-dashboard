import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/stake-lock-breakdown — exact breakdown of staked LINGO by lock tier,
 * both right now and month-by-month, computed from events only (no per-staker
 * calls) so it's light enough to run on demand.
 *
 * Model:
 *   Staked(user, amount, duration) at block B  →  position unlocks at B+duration
 *   Close event (user, amount, unlockBlock)    →  closes a matching position
 *   Still-open positions = current state, with the ORIGINAL duration known
 *   exactly; "locked" = unlockBlock > the block we're evaluating at.
 *
 * History is nearly free: the same event list is replayed against each
 * month-end block, so no extra RPC calls are needed for the full timeline.
 *
 * Self-verifying: reconciles the computed open total against the staking
 * contract's real LINGO balance (delta ≈ 0 ⇒ the model ties out).
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
// Verified as the unstake/withdraw: 100% of these match an open position.
const CLOSE_TOPIC = '0x7fc4727e062e336010f2c282598ef5f14facb3de68cf8195c2f23e1454b2b74e';

const DEFAULT_FROM_BLOCK = 0;
const MAX_REQUESTS = 90;
const LOG_PAGE_LIMIT = 9500;
const BASE_BLOCK_SECONDS = 2;

// Label by duration VALUE (not lockDurations index) so tiers that are no
// longer configured still surface correctly.
const DURATION_LABELS: Record<string, string> = {
  '0': 'Flexible',
  '1296000': '1 Month',
  '3888000': '3 Months',
  '7776000': '6 Months',
  '15552000': '12 Months',
  '30283200': '24 Months',
};

function labelFor(duration: bigint): string {
  const known = DURATION_LABELS[duration.toString()];
  if (known) return known;
  const days = Number(duration) * BASE_BLOCK_SECONDS / 86_400;
  return days > 0 ? `${days < 1 ? days.toFixed(1) : days.toFixed(0)}d (other)` : 'Flexible';
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

/** Fetch all logs for a topic, splitting the range on error / full page. */
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

interface PositionMeta { duration: bigint; unlockBlock: number; amountWei: bigint }
interface TierAgg { tier: string; durationBlocks: string; stillLocked: number; unlockedOrFlexible: number; total: number; positions: number }

/** Bucket the currently-open positions as of `atBlock`. */
function snapshot(open: Map<string, number>, meta: Map<string, PositionMeta>, atBlock: number) {
  const buckets = new Map<string, { label: string; d: bigint; locked: bigint; free: bigint; positions: number }>();
  let totalWei = 0n;
  for (const [key, count] of open) {
    if (count <= 0) continue;
    const m = meta.get(key);
    if (!m) continue;
    const dk = m.duration.toString();
    let b = buckets.get(dk);
    if (!b) { b = { label: labelFor(m.duration), d: m.duration, locked: 0n, free: 0n, positions: 0 }; buckets.set(dk, b); }
    const amt = m.amountWei * BigInt(count);
    // duration 0 is flexible (never "locked"); otherwise locked until unlockBlock
    if (m.duration > 0n && m.unlockBlock > atBlock) b.locked += amt; else b.free += amt;
    b.positions += count;
    totalWei += amt;
  }
  const tiers: TierAgg[] = [...buckets.values()]
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    .map(b => ({
      tier: b.label,
      durationBlocks: b.d.toString(),
      stillLocked: Math.round(toLingo(b.locked)),
      unlockedOrFlexible: Math.round(toLingo(b.free)),
      total: Math.round(toLingo(b.locked + b.free)),
      positions: b.positions,
    }));
  const locked = tiers.reduce((s, t) => s + t.stillLocked, 0);
  const free = tiers.reduce((s, t) => s + t.unlockedOrFlexible, 0);
  return { tiers, locked, free, total: Math.round(toLingo(totalWei)), totalWei };
}

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
    const headBlockRes = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [headRes.result, false]);
    const headTs = headBlockRes.ok ? parseInt(headBlockRes.result.timestamp, 16) : Math.floor(Date.now() / 1000);
    const fromBlock = req.query.fromBlock ? parseInt(String(req.query.fromBlock), 10) : DEFAULT_FROM_BLOCK;

    const [stakedLogs, closeLogs] = await Promise.all([
      getAllLogs(STAKED_TOPIC, fromBlock, head, budget),
      getAllLogs(CLOSE_TOPIC, fromBlock, head, budget),
    ]);
    if (!stakedLogs || !closeLogs) {
      return res.status(200).json({ error: 'Request budget exhausted before full history was read — retry or pass ?fromBlock=' });
    }

    // ── Parse events ──────────────────────────────────────────────────
    const meta = new Map<string, PositionMeta>();
    const stakes: Array<{ block: number; key: string }> = [];
    let firstStakeBlock = head;
    for (const log of stakedLogs) {
      if (log.data.length < 130) continue;
      const user = '0x' + log.topics[1].slice(26).toLowerCase();
      const amountWei = BigInt('0x' + log.data.slice(2, 66));
      const duration = BigInt('0x' + log.data.slice(66, 130));
      const block = parseInt(log.blockNumber, 16);
      const unlockBlock = block + Number(duration);
      const key = `${user}|${unlockBlock}|${amountWei.toString()}`;
      stakes.push({ block, key });
      if (!meta.has(key)) meta.set(key, { duration, unlockBlock, amountWei });
      if (block < firstStakeBlock) firstStakeBlock = block;
    }
    const closes: Array<{ block: number; key: string }> = [];
    for (const log of closeLogs) {
      if (log.data.length < 130) continue;
      const user = '0x' + log.topics[1].slice(26).toLowerCase();
      const amountWei = BigInt('0x' + log.data.slice(2, 66));
      const unlockBlock = Number(BigInt('0x' + log.data.slice(66, 130)));
      closes.push({ block: parseInt(log.blockNumber, 16), key: `${user}|${unlockBlock}|${amountWei.toString()}` });
    }
    stakes.sort((a, b) => a.block - b.block);
    closes.sort((a, b) => a.block - b.block);

    // ── Month-end boundaries (block estimated from head via 2s/block) ──
    const blockAt = (tsSec: number) => Math.max(0, Math.min(head, head - Math.round((headTs - tsSec) / BASE_BLOCK_SECONDS)));
    const firstTs = headTs - (head - firstStakeBlock) * BASE_BLOCK_SECONDS;
    const firstDate = new Date(firstTs * 1000);
    const boundaries: Array<{ month: string; atBlock: number; isCurrent: boolean }> = [];
    let y = firstDate.getUTCFullYear();
    let m = firstDate.getUTCMonth();
    const nowDate = new Date(headTs * 1000);
    const curY = nowDate.getUTCFullYear();
    const curM = nowDate.getUTCMonth();
    while (y < curY || (y === curY && m <= curM)) {
      const isCurrent = y === curY && m === curM;
      // snapshot at the END of the month (= start of next month), or `head` for the live month
      const endTs = Date.UTC(y, m + 1, 1) / 1000;
      boundaries.push({
        month: `${y}-${String(m + 1).padStart(2, '0')}`,
        atBlock: isCurrent ? head : blockAt(endTs),
        isCurrent,
      });
      m++; if (m > 11) { m = 0; y++; }
    }

    // ── Sweep events in block order, snapshotting at each boundary ─────
    const open = new Map<string, number>();
    let si = 0, ci = 0;
    const history: Array<Record<string, unknown>> = [];
    for (const b of boundaries) {
      while (si < stakes.length && stakes[si].block <= b.atBlock) {
        const k = stakes[si].key; open.set(k, (open.get(k) ?? 0) + 1); si++;
      }
      while (ci < closes.length && closes[ci].block <= b.atBlock) {
        const k = closes[ci].key; const n = open.get(k) ?? 0; if (n > 0) open.set(k, n - 1); ci++;
      }
      const snap = snapshot(open, meta, b.atBlock);
      const byTier: Record<string, number> = {};
      const lockedByTier: Record<string, number> = {};
      for (const t of snap.tiers) { byTier[t.tier] = t.total; lockedByTier[t.tier] = t.stillLocked; }
      history.push({
        month: b.month,
        atBlock: b.atBlock,
        partial: b.isCurrent,
        total: snap.total,
        locked: snap.locked,
        free: snap.free,
        byTier,
        lockedByTier,
      });
    }

    // Final sweep state == current (last boundary is head)
    const current = snapshot(open, meta, head);

    // Ground truth: LINGO actually held by the staking contract
    const balRes = await rpc<string>('eth_call', [{
      to: LINGO_TOKEN,
      data: '0x70a08231' + STAKING_CONTRACT.replace('0x', '').padStart(64, '0'),
    }, 'latest']);
    const onChainWei = balRes.ok && balRes.result && balRes.result !== '0x' ? BigInt(balRes.result) : null;

    // Any close event that didn't match an open position (should be 0)
    let closedUnmatched = 0;
    {
      const tmp = new Map<string, number>();
      for (const s of stakes) tmp.set(s.key, (tmp.get(s.key) ?? 0) + 1);
      for (const c of closes) {
        const n = tmp.get(c.key) ?? 0;
        if (n > 0) tmp.set(c.key, n - 1); else closedUnmatched++;
      }
    }

    return res.status(200).json({
      asOfBlock: head,
      requestsUsed: MAX_REQUESTS - budget.left,
      events: { staked: stakes.length, closed: closes.length, closedUnmatched },
      summary: { stillLocked: current.locked, flexibleOrUnlocked: current.free, totalOpen: current.total },
      tiers: current.tiers,
      history,
      reconciliation: onChainWei == null ? null : {
        onChainBalance: Math.round(toLingo(onChainWei)),
        computedOpen: current.total,
        deltaLingo: current.total - Math.round(toLingo(onChainWei)),
        note: 'delta ≈ 0 means the event model ties out to the contract balance',
      },
    });
  } catch (error) {
    return res.status(200).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
