import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list, del } from '@vercel/blob';

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

// Read existing blob data for merge
async function getExistingBlobData(): Promise<BlobPayload | null> {
  try {
    const { blobs } = await list({ prefix: BLOB_FILENAME });
    if (blobs.length === 0) return null;

    // Fetch the most recent blob
    const latestBlob = blobs[blobs.length - 1];
    const response = await fetch(latestBlob.url);
    if (!response.ok) return null;

    return await response.json() as BlobPayload;
  } catch {
    return null;
  }
}

// Delete all existing blobs with this filename to avoid duplicates
async function deleteExistingBlobs(): Promise<void> {
  try {
    const { blobs } = await list({ prefix: BLOB_FILENAME });
    if (blobs.length > 0) {
      await del(blobs.map(b => b.url));
      console.log(`Deleted ${blobs.length} existing blob(s)`);
    }
  } catch (err) {
    console.warn('Failed to delete old blobs:', err);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  // Delete old blobs first, then write fresh
  try {
    await deleteExistingBlobs();

    const blob = await put(BLOB_FILENAME, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
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
