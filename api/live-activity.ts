import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const MIN_AMOUNT = 10_000;

interface AlchemyTransfer {
  blockNum: string;
  hash: string;
  from: string;
  to: string;
  value: number | null;
  asset: string | null;
  metadata: { blockTimestamp: string };
}

interface StakingEvent {
  type: 'stake' | 'unstake';
  wallet: string;
  amount: number;
  txHash: string;
  timestamp: string;
  blockNum: string;
  lockDuration: string | null;
}

// Try to decode lock duration from the transaction input data.
// The staking contract likely has stake(uint256 amount, uint256/uint8 lockPeriod).
// We check the second parameter against known lock period patterns.
function decodeLockDuration(inputData: string): string | null {
  if (!inputData || inputData.length < 138) return null; // need selector + 2 params

  // Skip 0x (2) + selector (8) + first param/amount (64) = 74 chars
  const secondParam = inputData.slice(74, 138);
  const value = parseInt(secondParam, 16);

  // Seconds-based
  if (value === 7_776_000) return '3 Month';
  if (value === 15_552_000) return '6 Month';
  if (value === 31_536_000) return '12 Month';
  // Days-based
  if (value === 90) return '3 Month';
  if (value === 180) return '6 Month';
  if (value === 365) return '12 Month';
  // Months-based
  if (value === 3) return '3 Month';
  if (value === 6) return '6 Month';
  if (value === 12) return '12 Month';
  // Enum-based (1=3mo, 2=6mo, 3=12mo) — 3 already caught above
  if (value === 1) return '3 Month';
  if (value === 2) return '6 Month';
  // Flexible / no lock
  if (value === 0) return 'Flexible';

  return null;
}

async function getTransfers(direction: 'to' | 'from'): Promise<AlchemyTransfer[]> {
  const params: Record<string, unknown> = {
    contractAddresses: [LINGO_TOKEN],
    category: ['erc20'],
    maxCount: '0x32', // fetch 50 to have enough after 10K filter
    order: 'desc',
    withMetadata: true,
  };

  if (direction === 'to') {
    params.toAddress = STAKING_CONTRACT;
  } else {
    params.fromAddress = STAKING_CONTRACT;
  }

  const response = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [params],
    }),
  });

  if (!response.ok) return [];
  const data = await response.json();
  return data.result?.transfers ?? [];
}

// Batch-fetch transactions to decode lock duration (1 HTTP call for all)
async function fetchLockDurations(txHashes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (txHashes.length === 0) return map;

  const batchPayload = txHashes.map((hash, i) => ({
    jsonrpc: '2.0',
    id: i,
    method: 'eth_getTransactionByHash',
    params: [hash],
  }));

  const response = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batchPayload),
  });

  if (!response.ok) return map;

  const results = await response.json();
  for (const result of results) {
    const tx = result.result;
    if (tx?.input) {
      const duration = decodeLockDuration(tx.input);
      if (duration) map.set(tx.hash.toLowerCase(), duration);
    }
  }
  return map;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!ALCHEMY_API_KEY || !STAKING_CONTRACT) {
    return res.status(200).json({ events: [], configured: false });
  }

  try {
    // 2 API calls: stakes + unstakes
    const [stakes, unstakes] = await Promise.all([
      getTransfers('to'),
      getTransfers('from'),
    ]);

    // Build events, filter >= 10K LINGO
    let events: StakingEvent[] = [
      ...stakes.map(t => ({
        type: 'stake' as const,
        wallet: t.from,
        amount: t.value ?? 0,
        txHash: t.hash,
        timestamp: t.metadata?.blockTimestamp || '',
        blockNum: t.blockNum,
        lockDuration: null as string | null,
      })),
      ...unstakes.map(t => ({
        type: 'unstake' as const,
        wallet: t.to,
        amount: t.value ?? 0,
        txHash: t.hash,
        timestamp: t.metadata?.blockTimestamp || '',
        blockNum: t.blockNum,
        lockDuration: null as string | null,
      })),
    ]
      .filter(e => e.amount >= MIN_AMOUNT)
      .sort((a, b) => parseInt(b.blockNum, 16) - parseInt(a.blockNum, 16))
      .slice(0, 20);

    // 1 batch API call: decode lock duration for stake events
    const stakeHashes = events
      .filter(e => e.type === 'stake')
      .map(e => e.txHash);

    const lockDurations = await fetchLockDurations(stakeHashes);

    events = events.map(e => ({
      ...e,
      lockDuration: e.type === 'stake'
        ? lockDurations.get(e.txHash.toLowerCase()) ?? null
        : null,
    }));

    return res.status(200).json({ events, configured: true });
  } catch (error) {
    return res.status(200).json({
      events: [],
      configured: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
