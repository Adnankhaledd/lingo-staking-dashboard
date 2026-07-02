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

// ─── Top stakers rank-change tracking ──────────────────────────────────────
// We persist a 2-slot snapshot in a separate blob:
//   current  = ranks from the most recent Dune execution we've observed
//   previous = ranks from the Dune execution before that (the comparison baseline)
//
// The snapshot is rotated ONLY when Dune's executedAt changes — i.e. the
// underlying query was actually re-run. This means cron can run as often as
// it likes between Dune updates without erasing the comparison baseline. If
// the user re-runs the Dune query weekly, deltas will reflect week-over-week
// movement.
const TOP_STAKERS_QUERY_ID = '6919472';
const TOP_STAKERS_SNAPSHOT_FILENAME = 'top-stakers-snapshot.json';

interface TopStakersSlot {
  ranks: Record<string, number>; // lowercased wallet → rank
  dataExecutedAt: string | null; // executedAt of the Dune run this slot represents
}

interface TopStakersSnapshot {
  current: TopStakersSlot;
  previous: TopStakersSlot | null;
  snapshotAt: string; // when this snapshot file was last written
}

function normalizeWallet(w: string): string {
  return (w || '').replace(/^0x0+/, '0x').toLowerCase();
}

function ranksFromRows(rows: Array<Record<string, unknown>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const wallet = normalizeWallet(String(row.wallet ?? ''));
    if (wallet) out[wallet] = Number(row.rank);
  }
  return out;
}

// All queries with their limits
const QUERIES: Record<string, number> = {
  '6590984': 1000, // TOTAL_STAKED_TREND
  '6534908': 1000, // WEEKLY_STATS
  '6535206': 1000, // WEEKLY_NEW_STAKERS
  '6528806': 1000, // COHORT_RETENTION
  '6919472': 300,  // TOP_STAKERS — match the query ID used in useDuneQuery.ts and fetch all rows
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
  '6952297': 1000, // PENGU_BUY_PRESSURE
  '6963980': 1000, // DECUBATE_WEEKLY_CLAIMS
  '6981059': 1000, // DECUBATE_APY_CLAIMERS
  '6991693': 1000, // DECUBATE_CLAIM_FEED
  '6828894': 50,   // CLAIMS_BY_TYPE
  '7320190': 1000, // STAKE_DAILY_BREAKDOWN
  '7340503': 1000, // STAKER_LTV
  '7340695': 1000, // FEE_WALLET_INFLOW
  '7350883': 50,   // LTV_BY_THRESHOLD
  '7350966': 50,   // LTV_BY_FIRST_DEPOSIT_TIER
  '7340511': 50,   // GROWTH_TIER_DISTRIBUTION
  '7411888': 100,  // NEW_LARGE_STAKERS
  '7432116': 1,    // STAKERS_BY_USD_THRESHOLD (single-row snapshot)
  '7568254': 100,  // MONTHLY_TIER_GROWTH
  '7708413': 100,  // CLAIMS_HOLD_BREAKDOWN
  '7866579': 50,   // TOP100_MONTHLY_STAKED
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

  // When CRON_SECRET is set, Vercel cron sends it as a Bearer token automatically.
  // (The spoofable x-vercel-cron header is deliberately not trusted.)
  const isCronAuth = !cronSecret ||
    authHeader === `Bearer ${cronSecret}`;
  const isAdminAuth = adminPassword && requestPassword === adminPassword;

  if (!isCronAuth && !isAdminAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!DUNE_API_KEY) {
    return res.status(500).json({ error: 'DUNE_API_KEY not configured' });
  }

  // Optional partial refresh: if the request body contains a non-empty
  // queryIds array, only those queries are pulled from Dune. Everything else
  // in the blob is left untouched. Useful for page-scoped refresh buttons.
  let requestedIds: string[] | null = null;
  try {
    const body = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {};
    if (Array.isArray(body.queryIds) && body.queryIds.length > 0) {
      const set = new Set(body.queryIds.map(String));
      requestedIds = Object.keys(QUERIES).filter(id => set.has(id));
      if (requestedIds.length === 0) {
        return res.status(400).json({ error: 'queryIds provided but none match the known query set' });
      }
    }
  } catch { /* fall through to full refresh */ }

  console.log(`Starting Dune data refresh${requestedIds ? ` (scoped to ${requestedIds.length} queries: ${requestedIds.join(', ')})` : ' (all queries)'}...`);

  // Read existing blob data first for merge
  const existingData = await getExistingBlobData();
  console.log(`Existing blob: ${existingData ? `${existingData.successCount} queries from ${existingData.refreshedAt}` : 'none'}`);

  // Fetch the requested queries in parallel; if no filter, all of them.
  const entries = requestedIds
    ? (Object.entries(QUERIES).filter(([id]) => requestedIds!.includes(id)) as Array<[string, number]>)
    : Object.entries(QUERIES);
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

  // ── Annotate Top Stakers rows with rank-change vs previous Dune execution ─
  const topStakersResult = mergedQueries[TOP_STAKERS_QUERY_ID];
  if (topStakersResult && topStakersResult.rows.length > 0) {
    const newRows = topStakersResult.rows as Array<Record<string, unknown>>;
    const newExecutedAt = topStakersResult.executedAt;
    const newRanks = ranksFromRows(newRows);

    const rawSnapshot = await fetchBlobJson<unknown>(TOP_STAKERS_SNAPSHOT_FILENAME);
    // Validate shape: we changed the file format, so an older snapshot from
    // a previous deploy won't match. Treat it as missing → triggers re-init.
    const existingSnapshot: TopStakersSnapshot | null =
      rawSnapshot &&
      typeof rawSnapshot === 'object' &&
      'current' in rawSnapshot &&
      (rawSnapshot as TopStakersSnapshot).current &&
      typeof (rawSnapshot as TopStakersSnapshot).current === 'object'
        ? (rawSnapshot as TopStakersSnapshot)
        : null;

    // Decide whether the underlying Dune data has actually changed since the
    // snapshot was last updated. If yes, rotate: previous = old current, current = new.
    let snapshotToWrite: TopStakersSnapshot;
    let comparisonSlot: TopStakersSlot | null;
    if (!existingSnapshot) {
      // First ever run — seed current with what we just got. No baseline yet.
      snapshotToWrite = {
        current: { ranks: newRanks, dataExecutedAt: newExecutedAt },
        previous: null,
        snapshotAt: new Date().toISOString(),
      };
      comparisonSlot = null;
      console.log('Top-stakers snapshot initialized (no comparison baseline yet)');
    } else if (
      newExecutedAt &&
      newExecutedAt !== existingSnapshot.current.dataExecutedAt
    ) {
      // Dune query was re-run since our last observation — promote current to
      // previous and store the new ranks as current.
      snapshotToWrite = {
        current: { ranks: newRanks, dataExecutedAt: newExecutedAt },
        previous: existingSnapshot.current,
        snapshotAt: new Date().toISOString(),
      };
      comparisonSlot = existingSnapshot.current;
      console.log(
        `Top-stakers Dune executedAt changed (${existingSnapshot.current.dataExecutedAt} → ${newExecutedAt}); rotated snapshot`
      );
    } else {
      // Same Dune execution as last time — keep snapshot as-is, deltas continue
      // to reflect the change vs the prior run.
      snapshotToWrite = existingSnapshot;
      comparisonSlot = existingSnapshot.previous;
    }

    const baselineRanks = comparisonSlot?.ranks ?? {};
    const baselineExecutedAt = comparisonSlot?.dataExecutedAt ?? null;
    const annotatedRows = newRows.map(row => {
      const wallet = normalizeWallet(String(row.wallet ?? ''));
      const newRank = Number(row.rank);
      const previousRank = baselineRanks[wallet];
      // delta > 0 means moved up (smaller rank number). delta < 0 = moved down.
      const rankDelta = previousRank ? previousRank - newRank : null;
      return {
        ...row,
        previousRank: previousRank ?? null,
        rankDelta,
        previousSnapshotAt: baselineExecutedAt,
      };
    });
    mergedQueries[TOP_STAKERS_QUERY_ID] = {
      ...topStakersResult,
      rows: annotatedRows,
    };

    // Persist the (possibly rotated) snapshot
    if (snapshotToWrite !== existingSnapshot) {
      try {
        await put(TOP_STAKERS_SNAPSHOT_FILENAME, JSON.stringify(snapshotToWrite), {
          access: 'public',
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: 'application/json',
        });
      } catch (err) {
        console.warn('Failed to write top-stakers snapshot:', err);
      }
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
