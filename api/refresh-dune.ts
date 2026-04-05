import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list } from '@vercel/blob';

// Inline blob helper — direct URL fetch with list() fallback
async function fetchBlobJson<T = unknown>(pathname: string): Promise<T | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const match = token.match(/^vercel_blob_rw_([^_]+)_/);
  if (match) {
    try {
      const res = await fetch(`https://${match[1]}.public.blob.vercel-storage.com/${pathname}?t=${Date.now()}`);
      if (res.ok) return (await res.json()) as T;
    } catch { /* fall through */ }
  }
  try {
    const { blobs } = await list({ prefix: pathname });
    if (blobs.length === 0) return null;
    const res = await fetch(`${blobs[blobs.length - 1].url}?t=${Date.now()}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

const DUNE_API_KEY = process.env.DUNE_API_KEY || process.env.VITE_DUNE_API_KEY || '';
const DUNE_API_BASE = 'https://api.dune.com/api/v1';

const BLOB_FILENAME = 'dune-data.json';

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
  '6738028': 1000, // MONTHLY_NEW_RETURNING
  '6738074': 50,   // STAKING_TIERS_BY_LOCK
  '6749292': 1000, // MONTHLY_LINGO_BY_LOCK
  '6749507': 1000, // COMMUNITY_REWARDS
  '6760287': 1000, // BUY_PRESSURE
  '6770827': 1000, // STAKER_TIERS_WEEKLY
  '6511860': 10,   // LOCK_DISTRIBUTION
  '6802863': 1000, // WEEKLY_LOCK_BREAKDOWN
  '6828788': 1000, // WEEKLY_CLAIM_SUMMARY
  '6828804': 1000, // WEEKLY_CLAIMS_BY_SOURCE
  '6828795': 100,  // TOP_CLAIMERS
  '6952270': 1000, // CARDS_BUY_PRESSURE
  '6952283': 1000, // FUN_BUY_PRESSURE
};

interface QueryResult {
  rows: unknown[];
  executedAt: string | null;
  error: string | null;
}

interface BlobPayload {
  queries: Record<string, QueryResult>;
  refreshedAt: string;
  queryCount: number;
  successCount: number;
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

// Read existing blob data for merge — uses direct URL fetch (zero Blob ops)
async function getExistingBlobData(): Promise<BlobPayload | null> {
  return fetchBlobJson<BlobPayload>(BLOB_FILENAME);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS for admin page
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Password');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const requestPassword = req.headers['x-admin-password'] as string;

  const isCronAuth = !cronSecret ||
    authHeader === `Bearer ${cronSecret}` ||
    req.headers['x-vercel-cron'] === '1';
  const isAdminAuth = adminPassword && requestPassword === adminPassword;

  if (!isCronAuth && !isAdminAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!DUNE_API_KEY) {
    return res.status(500).json({ error: 'DUNE_API_KEY not configured' });
  }

  console.log('Starting Dune data refresh...');

  // Read existing blob data first for merge
  const existingData = await getExistingBlobData();
  console.log(`Existing blob: ${existingData ? `${existingData.successCount} queries from ${existingData.refreshedAt}` : 'none'}`);

  // Fetch all query results in parallel
  const entries = Object.entries(QUERIES);
  const results = await Promise.all(
    entries.map(async ([queryId, limit]) => {
      const result = await fetchQueryResults(queryId, limit);
      return [queryId, result] as const;
    })
  );

  let newSuccessCount = 0;
  const newQueryData: Record<string, QueryResult> = {};
  for (const [queryId, result] of results) {
    newQueryData[queryId] = result;
    if (!result.error && result.rows.length > 0) newSuccessCount++;
  }

  // If ALL queries failed, don't overwrite existing good data
  if (newSuccessCount === 0 && existingData && existingData.successCount > 0) {
    console.log('All queries failed — keeping existing blob data intact');
    return res.status(200).json({
      message: `All ${entries.length} queries failed. Keeping existing data (${existingData.successCount} queries from ${existingData.refreshedAt}).`,
      kept: true,
      refreshedAt: existingData.refreshedAt,
    });
  }

  // Merge: use new data if succeeded, keep old if failed
  const mergedQueries: Record<string, QueryResult> = {};
  let mergedSuccessCount = 0;

  for (const queryId of Object.keys(QUERIES)) {
    const newResult = newQueryData[queryId];
    const existingResult = existingData?.queries?.[queryId];

    if (newResult && !newResult.error && newResult.rows.length > 0) {
      mergedQueries[queryId] = newResult;
      mergedSuccessCount++;
    } else if (existingResult && !existingResult.error && existingResult.rows.length > 0) {
      mergedQueries[queryId] = existingResult;
      mergedSuccessCount++;
      console.log(`Query ${queryId} failed, keeping existing data`);
    } else {
      mergedQueries[queryId] = newResult || { rows: [], executedAt: null, error: 'No data' };
    }
  }

  const payload: BlobPayload = {
    queries: mergedQueries,
    refreshedAt: new Date().toISOString(),
    queryCount: entries.length,
    successCount: mergedSuccessCount,
  };

  // Write directly — allowOverwrite replaces the existing blob (no list+del needed)
  try {
    const blob = await put(BLOB_FILENAME, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });

    console.log(`Blob written: ${blob.url}`);
    console.log(`Result: ${newSuccessCount} new + ${mergedSuccessCount - newSuccessCount} kept = ${mergedSuccessCount}/${entries.length} total`);

    return res.status(200).json({
      message: `Refreshed ${newSuccessCount}/${entries.length} queries (${mergedSuccessCount} total with kept data)`,
      blobUrl: blob.url,
      refreshedAt: payload.refreshedAt,
      newSuccessCount,
      totalSuccessCount: mergedSuccessCount,
    });
  } catch (error) {
    console.error('Failed to upload blob:', error);
    return res.status(500).json({
      error: 'Failed to store data',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
