import type { VercelRequest, VercelResponse } from '@vercel/node';

const DUNE_API_KEY = process.env.VITE_DUNE_API_KEY || 'vlRkLxRLCB6MzFyiLdVLyB4CZ25oPnNF';
const DUNE_API_BASE = 'https://api.dune.com/api/v1';

// All query IDs to refresh
const QUERY_IDS = [
  '6590984', // TOTAL_STAKED_TREND
  '6534908', // WEEKLY_STATS
  '6535206', // WEEKLY_NEW_STAKERS
  '6528806', // COHORT_RETENTION
  '6632385', // TOP_STAKERS
  '6288543', // TRADING_FEES
  '6606898', // APY_CLAIMS
  '6535334', // MONTHLY_STAKING_FLOW
  '6693660', // WEEKLY_STAKES
  '6693715', // LP_FEES
];

async function executeQuery(queryId: string): Promise<{ queryId: string; success: boolean; error?: string }> {
  try {
    const response = await fetch(`${DUNE_API_BASE}/query/${queryId}/execute`, {
      method: 'POST',
      headers: {
        'X-Dune-API-Key': DUNE_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { queryId, success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    return { queryId, success: true };
  } catch (error) {
    return {
      queryId,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret or allow manual trigger
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  // Allow if: no secret set, correct secret provided, or from Vercel cron
  const isAuthorized = !cronSecret ||
    authHeader === `Bearer ${cronSecret}` ||
    req.headers['x-vercel-cron'] === '1';

  if (!isAuthorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('Starting Dune query refresh...');

  // Execute all queries in parallel
  const results = await Promise.all(QUERY_IDS.map(executeQuery));

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success);

  console.log(`Dune refresh complete: ${successful}/${QUERY_IDS.length} queries executed`);

  if (failed.length > 0) {
    console.error('Failed queries:', failed);
  }

  return res.status(200).json({
    message: `Refreshed ${successful}/${QUERY_IDS.length} Dune queries`,
    results,
    timestamp: new Date().toISOString(),
  });
}
