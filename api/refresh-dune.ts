import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put } from '@vercel/blob';

const DUNE_API_KEY = process.env.DUNE_API_KEY || process.env.VITE_DUNE_API_KEY || '';
const DUNE_API_BASE = 'https://api.dune.com/api/v1';

// All queries with their limits
const QUERIES: Record<string, number> = {
  '6590984': 1000, // TOTAL_STAKED_TREND
  '6534908': 1000, // WEEKLY_STATS
  '6535206': 1000, // WEEKLY_NEW_STAKERS
  '6528806': 1000, // COHORT_RETENTION
  '6632385': 50,   // TOP_STAKERS
  '6288543': 1000, // TRADING_FEES
  '6606898': 1000, // APY_CLAIMS
  '6535334': 1000, // MONTHLY_STAKING_FLOW
  '6693660': 1000, // WEEKLY_STAKES
  '6693715': 1000, // LP_FEES
  '6708293': 1000, // MEMBERSHIP_TIERS
};

interface QueryResult {
  rows: unknown[];
  executedAt: string | null;
  error: string | null;
}

async function fetchQueryResults(queryId: string, limit: number): Promise<QueryResult> {
  try {
    const response = await fetch(
      `${DUNE_API_BASE}/query/${queryId}/results?limit=${limit}`,
      { headers: { 'X-Dune-API-Key': DUNE_API_KEY } }
    );

    if (!response.ok) {
      return { rows: [], executedAt: null, error: `HTTP ${response.status}` };
    }

    const result = await response.json();

    if (!result.is_execution_finished || result.state === 'QUERY_STATE_FAILED') {
      return { rows: [], executedAt: null, error: result.error || 'Query not finished' };
    }

    return {
      rows: result.result?.rows ?? [],
      executedAt: result.execution_ended_at ?? null,
      error: null,
    };
  } catch (error) {
    return {
      rows: [],
      executedAt: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret or allow manual trigger
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  const isAuthorized = !cronSecret ||
    authHeader === `Bearer ${cronSecret}` ||
    req.headers['x-vercel-cron'] === '1';

  if (!isAuthorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!DUNE_API_KEY) {
    return res.status(500).json({ error: 'DUNE_API_KEY not configured' });
  }

  console.log('Starting Dune data refresh...');

  // Fetch all query results in parallel
  const entries = Object.entries(QUERIES);
  const results = await Promise.all(
    entries.map(async ([queryId, limit]) => {
      const result = await fetchQueryResults(queryId, limit);
      return [queryId, result] as const;
    })
  );

  const queryData: Record<string, QueryResult> = {};
  let successCount = 0;
  for (const [queryId, result] of results) {
    queryData[queryId] = result;
    if (!result.error && result.rows.length > 0) successCount++;
  }

  const payload = {
    queries: queryData,
    refreshedAt: new Date().toISOString(),
    queryCount: entries.length,
    successCount,
  };

  // Upload to Vercel Blob
  try {
    const blob = await put('dune-data.json', JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    });

    console.log(`Dune refresh complete: ${successCount}/${entries.length} queries. Blob: ${blob.url}`);

    return res.status(200).json({
      message: `Refreshed ${successCount}/${entries.length} Dune queries`,
      blobUrl: blob.url,
      refreshedAt: payload.refreshedAt,
    });
  } catch (error) {
    console.error('Failed to upload blob:', error);
    return res.status(500).json({
      error: 'Failed to store data',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
