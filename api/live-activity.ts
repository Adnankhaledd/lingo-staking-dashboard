import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

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
}

async function getTransfers(direction: 'to' | 'from'): Promise<AlchemyTransfer[]> {
  const params: Record<string, unknown> = {
    contractAddresses: [LINGO_TOKEN],
    category: ['erc20'],
    maxCount: '0x14',
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!ALCHEMY_API_KEY || !STAKING_CONTRACT) {
    return res.status(200).json({ events: [], configured: false });
  }

  try {
    const [stakes, unstakes] = await Promise.all([
      getTransfers('to'),
      getTransfers('from'),
    ]);

    const events: StakingEvent[] = [
      ...stakes.map(t => ({
        type: 'stake' as const,
        wallet: t.from,
        amount: t.value ?? 0,
        txHash: t.hash,
        timestamp: t.metadata?.blockTimestamp || '',
        blockNum: t.blockNum,
      })),
      ...unstakes.map(t => ({
        type: 'unstake' as const,
        wallet: t.to,
        amount: t.value ?? 0,
        txHash: t.hash,
        timestamp: t.metadata?.blockTimestamp || '',
        blockNum: t.blockNum,
      })),
    ]
      .sort((a, b) => parseInt(b.blockNum, 16) - parseInt(a.blockNum, 16))
      .slice(0, 30);

    return res.status(200).json({ events, configured: true });
  } catch (error) {
    return res.status(200).json({
      events: [],
      configured: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
