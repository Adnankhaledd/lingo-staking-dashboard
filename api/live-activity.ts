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
  type: 'stake';
  wallet: string;
  amount: number;
  txHash: string;
  timestamp: string;
  blockNum: string;
}

async function getStakes(): Promise<AlchemyTransfer[]> {
  const response = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [{
        contractAddresses: [LINGO_TOKEN],
        category: ['erc20'],
        toAddress: STAKING_CONTRACT,
        maxCount: '0x32',
        order: 'desc',
        withMetadata: true,
      }],
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

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!ALCHEMY_API_KEY || !STAKING_CONTRACT) {
    return res.status(200).json({ events: [], configured: false });
  }

  try {
    // 1 API call: stakes only (transfers TO the staking contract)
    const stakes = await getStakes();

    const events: StakingEvent[] = stakes
      .map(t => ({
        type: 'stake' as const,
        wallet: t.from,
        amount: t.value ?? 0,
        txHash: t.hash,
        timestamp: t.metadata?.blockTimestamp || '',
        blockNum: t.blockNum,
      }))
      .filter(e => e.amount >= MIN_AMOUNT)
      .slice(0, 20);

    return res.status(200).json({ events, configured: true });
  } catch (error) {
    return res.status(200).json({
      events: [],
      configured: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
