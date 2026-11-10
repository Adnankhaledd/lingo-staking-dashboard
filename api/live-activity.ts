import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/live-activity — the latest stakes of 10k+ LINGO, for the live feed.
 *
 * Read straight from the staking contract's Staked(user, amount, duration)
 * events: one eth_getLogs gives the staker, amount, lock and tx for every
 * stake, so nothing else is needed. The previous version re-read the
 * contract's lock list (~18 eth_calls) and up to 20 full transaction
 * receipts on every refresh just to recover the lock length the event
 * already carries — ~1,050 CU per refresh, ~60k CU an hour whenever anyone
 * had the page open. This is ~70 CU per refresh.
 *
 * `wallet` is the staker the event records. For stakes placed on a user's
 * behalf (the buy-direct flow) that is the user, not the operator wallet that
 * moved the tokens — which is what the old transfer-based feed showed.
 */

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const MIN_AMOUNT = 10_000;
const MAX_EVENTS = 20;
// keccak256("Staked(address,uint256,uint256)")
const STAKED_EVENT_TOPIC = '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90';
// Look back this far first, then further only if it held too few stakes.
const WINDOWS_SECONDS = [3 * 86_400, 28 * 86_400];

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

interface StakingEvent {
  type: 'stake';
  wallet: string;
  amount: number;
  txHash: string;
  timestamp: string;
  blockNum: string;
  lockDuration: string | null;
}

interface RawLog { topics: string[]; data: string; blockNumber: string; blockTimestamp?: string; transactionHash: string; logIndex: string }

// The staking contract's lock options, by the names the app gives them. Lock
// lengths are block counts set when Base made a block every 2s; since the
// 200ms switch they elapse 10× faster (a "12 Months" lock now ends in ~36 days).
const KNOWN_DURATIONS: Record<string, string> = {
  '0': 'Flexible',
  '1296000': '1 Month',
  '3888000': '3 Months',
  '7776000': '6 Months',
  '15552000': '12 Months',
  '30283200': '24 Months',
};

function durationToLabel(val: bigint): string {
  const known = KNOWN_DURATIONS[val.toString()];
  if (known) return known;
  // Fallback: name it as the 2s-era option it was designed as
  const months = Math.round(Number(val) * 2 / 86_400 / 30);
  return months > 0 ? `${months} Months` : 'Flexible';
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message ?? 'RPC error');
  return data.result as T;
}

const WEI = 10n ** 18n;
const toLingo = (w: bigint) => Number(w / WEI) + Number(w % WEI) / 1e18;

function toEvent(log: RawLog): StakingEvent {
  const amount = toLingo(BigInt('0x' + log.data.slice(2, 66)));
  const duration = BigInt('0x' + log.data.slice(66, 130));
  const block = parseInt(log.blockNumber, 16);
  const ts = log.blockTimestamp ? parseInt(log.blockTimestamp, 16) : blockToTs(block);
  return {
    type: 'stake',
    wallet: '0x' + log.topics[1].slice(26).toLowerCase(),
    amount,
    txHash: log.transactionHash,
    timestamp: new Date(ts * 1000).toISOString(),
    blockNum: log.blockNumber,
    lockDuration: durationToLabel(duration),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // The feed tolerates a two-minute delay; every cache hit is a call not made.
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!ALCHEMY_API_KEY || !STAKING_CONTRACT) {
    return res.status(200).json({ events: [], configured: false });
  }

  try {
    const headHex = await rpc<string>('eth_blockNumber', []);
    const head = parseInt(headHex, 16);
    const headTs = blockToTs(head);

    let events: StakingEvent[] = [];
    for (const [i, span] of WINDOWS_SECONDS.entries()) {
      let logs: RawLog[];
      try {
        logs = await rpc<RawLog[]>('eth_getLogs', [{
          address: STAKING_CONTRACT,
          topics: [STAKED_EVENT_TOPIC],
          fromBlock: '0x' + Math.min(head, tsToBlock(headTs - span)).toString(16),
          toBlock: headHex,
        }]);
      } catch (e) {
        // A failed wider look-back keeps what the narrower one already found.
        if (i > 0) break;
        throw e;
      }
      events = logs
        .filter(l => l.data.length >= 130 && l.topics.length >= 2)
        .map(l => ({ l, e: toEvent(l) }))
        .filter(({ e }) => e.amount >= MIN_AMOUNT)
        .sort((a, b) => parseInt(b.l.blockNumber, 16) - parseInt(a.l.blockNumber, 16)
          || parseInt(b.l.logIndex, 16) - parseInt(a.l.logIndex, 16))
        .map(({ e }) => e)
        .slice(0, MAX_EVENTS);
      if (events.length >= MAX_EVENTS) break;
    }

    return res.status(200).json({ events, configured: true });
  } catch (error) {
    return res.status(200).json({
      events: [],
      configured: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
