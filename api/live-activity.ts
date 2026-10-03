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
const WINDOWS_BLOCKS = [129_600, 1_209_600];   // ~3 days, ~28 days (2s blocks)

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

// Exact block values from the staking contract (Base = 2 sec/block)
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
  // Fallback: approximate from block count (2 sec/block)
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

function toEvent(log: RawLog, headTs: number, head: number): StakingEvent {
  const amount = toLingo(BigInt('0x' + log.data.slice(2, 66)));
  const duration = BigInt('0x' + log.data.slice(66, 130));
  const block = parseInt(log.blockNumber, 16);
  const ts = log.blockTimestamp ? parseInt(log.blockTimestamp, 16) : headTs - (head - block) * 2;
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
    const headTs = Math.floor(Date.now() / 1000);

    let events: StakingEvent[] = [];
    for (const [i, span] of WINDOWS_BLOCKS.entries()) {
      let logs: RawLog[];
      try {
        logs = await rpc<RawLog[]>('eth_getLogs', [{
          address: STAKING_CONTRACT,
          topics: [STAKED_EVENT_TOPIC],
          fromBlock: '0x' + Math.max(0, head - span).toString(16),
          toBlock: headHex,
        }]);
      } catch (e) {
        // A failed wider look-back keeps what the narrower one already found.
        if (i > 0) break;
        throw e;
      }
      events = logs
        .filter(l => l.data.length >= 130 && l.topics.length >= 2)
        .map(l => ({ l, e: toEvent(l, headTs, head) }))
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
