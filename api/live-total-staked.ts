import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const LINGO_DECIMALS = 18;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // 5-minute CDN cache — only 1 Alchemy call per 5 min
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!ALCHEMY_API_KEY || !STAKING_CONTRACT) {
    return res.status(200).json({ totalStaked: null, configured: false });
  }

  try {
    // Single API call: get LINGO token balance of the staking contract
    const response = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getTokenBalances',
        params: [STAKING_CONTRACT, [LINGO_TOKEN]],
      }),
    });

    if (!response.ok) {
      return res.status(200).json({ totalStaked: null, configured: true, error: `HTTP ${response.status}` });
    }

    const data = await response.json();
    const tokenBalance = data.result?.tokenBalances?.[0]?.tokenBalance;

    if (!tokenBalance || tokenBalance === '0x') {
      return res.status(200).json({ totalStaked: 0, configured: true });
    }

    // Convert hex → whole tokens (BigInt for precision with 18 decimals)
    const rawBalance = BigInt(tokenBalance);
    const divisor = BigInt(10 ** LINGO_DECIMALS);
    const totalStaked = Number(rawBalance / divisor);

    return res.status(200).json({ totalStaked, configured: true });
  } catch (error) {
    return res.status(200).json({
      totalStaked: null,
      configured: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
