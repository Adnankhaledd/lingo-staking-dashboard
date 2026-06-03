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

// ─── Project migration (May 2026) ────────────────────────────────────
// We migrated to a new Mixpanel project on EU. The OLD project produced
// data up to 2026-05-31; the NEW project starts producing data on
// 2026-06-01. We freeze the last good blob from the old project as
// `mixpanel-data-legacy.json` and on every refresh splice it together
// with new-project data on the date cutoff. The dashboard reads from
// `mixpanel-data.json` as before — it has no idea a migration happened.

const MIXPANEL_API_SECRET = process.env.MIXPANEL_API_SECRET_NEW
  || process.env.MIXPANEL_API_SECRET
  || '010125f09fef119ad08d0eb062be12b6';
const PROJECT_ID = '4022491'; // NEW project — used for all new queries
const CUTOFF_DATE = '2026-06-01'; // legacy < CUTOFF, new >= CUTOFF

const BLOB_FILENAME = 'mixpanel-data.json';
const LEGACY_BLOB_FILENAME = 'mixpanel-data-legacy.json';

// ─── Helpers ──────────────────────────────────────────────────────────

const AUTH_HEADER = `Basic ${Buffer.from(MIXPANEL_API_SECRET + ':').toString('base64')}`;
const MIXPANEL_HEADERS = { 'Accept': 'application/json', 'Authorization': AUTH_HEADER };

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

async function mixpanelGet(url: string): Promise<unknown> {
  const res = await fetch(url, { method: 'GET', headers: MIXPANEL_HEADERS });
  if (!res.ok) throw new Error(`Mixpanel HTTP ${res.status}`);
  return res.json();
}

// ─── Individual fetchers (sequential to avoid rate limits) ───────────
// Every query is clamped to CUTOFF_DATE so we never re-fetch data the
// new project doesn't have. The legacy blob fills in dates before that.

/** Latest of two YYYY-MM-DD strings (string compare works for ISO dates). */
function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * Active-users counts via JQL. Mixpanel's /events API can't truly dedupe
 * unique users across multiple events (it gives unique-per-event), so we
 * bucket events by (bucketKey, distinct_id), null-reduce to dedupe, then
 * count per bucket. bucketKey is a JS function body returned as a string.
 *
 * Returns a `{ date: count }` map.
 */
async function fetchActiveUsersByBucket(
  fromDate: string,
  toDate: string,
  bucketKeyExpr: string
): Promise<Record<string, number>> {
  const script = `
function main() {
  return Events({
    from_date: ${JSON.stringify(fromDate)},
    to_date: ${JSON.stringify(toDate)}
  })
  .groupBy(
    [
      function(event) { ${bucketKeyExpr} },
      "distinct_id"
    ],
    mixpanel.reducer.null()
  )
  .groupBy(["key.0"], mixpanel.reducer.count());
}`.trim();

  const body = new URLSearchParams();
  body.append('project_id', PROJECT_ID);
  body.append('script', script);

  const res = await fetch('https://eu.mixpanel.com/api/2.0/jql', {
    method: 'POST',
    headers: { ...MIXPANEL_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Mixpanel JQL HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ key: [string]; value: number }>;

  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r && Array.isArray(r.key) && typeof r.key[0] === 'string') {
      out[r.key[0]] = Number(r.value) || 0;
    }
  }
  return out;
}

async function fetchDAU() {
  // Per-day bucket: YYYY-MM-DD
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const fromDate = maxDate(toDateStr(thirtyDaysAgo), CUTOFF_DATE);
  const toDate = toDateStr(today);

  const series = await fetchActiveUsersByBucket(
    fromDate,
    toDate,
    'return new Date(event.time).toISOString().slice(0, 10);'
  );

  return {
    series: { 'A. DAU': series },
    date_range: { from_date: fromDate, to_date: toDate },
  };
}

async function fetchWAU() {
  // Per-week bucket: Monday-anchored YYYY-MM-DD (matches Mixpanel "unit=week")
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 56); // ~8 weeks

  const fromDate = maxDate(toDateStr(from), CUTOFF_DATE);
  const toDate = toDateStr(today);

  const values = await fetchActiveUsersByBucket(
    fromDate,
    toDate,
    `var d = new Date(event.time);
     var day = d.getUTCDay();
     var diff = (day === 0 ? -6 : 1 - day);
     d.setUTCDate(d.getUTCDate() + diff);
     return d.toISOString().slice(0, 10);`
  );

  // Reshape to the dashboard's expected events-API shape with "Wallet Connected" key.
  // The key name is preserved for backward compatibility with the existing parser
  // (transformWAUData reads data.values['Wallet Connected']) — the numbers it now
  // contains are unique active users across ALL events, not wallet connects.
  return { data: { values: { 'Wallet Connected': values } } };
}

async function fetchMAU() {
  // Per-month bucket: first-of-month YYYY-MM-01
  const today = new Date();
  const lastMonth = new Date(today);
  lastMonth.setDate(lastMonth.getDate() - 30);

  const fromDate = maxDate(toDateStr(lastMonth), CUTOFF_DATE);
  const toDate = toDateStr(today);

  const values = await fetchActiveUsersByBucket(
    fromDate,
    toDate,
    `return new Date(event.time).toISOString().slice(0, 7) + '-01';`
  );

  return { data: { values: { 'Wallet Connected': values } } };
}

async function fetchEngagement(unit: 'week' | 'month', daysBack: number) {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - daysBack);

  // Use yesterday as to_date so Mixpanel doesn't create a partial
  // current-week or current-month bucket (the cron runs daily at 06:05 UTC)
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const events = ['Asteroid Smashed', 'Raffle Ticket Purchased', 'Task Completed'];
  const baseParams = {
    project_id: PROJECT_ID,
    event: JSON.stringify(events),
    unit,
    from_date: maxDate(toDateStr(from), CUTOFF_DATE),
    to_date: toDateStr(yesterday),
  };

  // Sequential: totals first, then unique — avoids rate limiting
  const totals = await mixpanelGet(
    `https://eu.mixpanel.com/api/2.0/events?${new URLSearchParams({ ...baseParams, type: 'general' })}`
  );
  const unique = await mixpanelGet(
    `https://eu.mixpanel.com/api/2.0/events?${new URLSearchParams({ ...baseParams, type: 'unique' })}`
  );

  return { totals, unique };
}

// ─── Blob helpers ─────────────────────────────────────────────────────

interface MixpanelBlobPayload {
  dau: unknown;
  wau: unknown;
  mau: unknown;
  weeklyEngagement: unknown;
  monthlyEngagement: unknown;
  errors?: Record<string, string>;
  refreshedAt: string;
}

// Read existing blob data for merge — uses direct URL fetch (zero Blob ops)
async function getExistingBlobData(): Promise<MixpanelBlobPayload | null> {
  return fetchBlobJson<MixpanelBlobPayload>(BLOB_FILENAME);
}

async function getLegacyBlobData(): Promise<MixpanelBlobPayload | null> {
  return fetchBlobJson<MixpanelBlobPayload>(LEGACY_BLOB_FILENAME);
}

// ─── Legacy splice helpers ────────────────────────────────────────────
// All Mixpanel date-bucketed responses look like `{ <date_key>: number }`
// somewhere inside the payload. We keep entries with dateKey < CUTOFF_DATE
// from the legacy snapshot and overlay entries with dateKey >= CUTOFF_DATE
// from the freshly-fetched new-project response.

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Merge two `{ dateKey: count }` maps with a cutoff date. */
function spliceDateSeries(
  legacy: Record<string, number> | undefined,
  fresh: Record<string, number> | undefined,
  cutoff: string
): Record<string, number> {
  const out: Record<string, number> = {};
  if (legacy) {
    for (const [date, val] of Object.entries(legacy)) {
      const day = date.split(/[T\s]/)[0];
      if (day < cutoff) out[date] = val;
    }
  }
  if (fresh) {
    for (const [date, val] of Object.entries(fresh)) {
      const day = date.split(/[T\s]/)[0];
      if (day >= cutoff) out[date] = val;
    }
  }
  return out;
}

/** Merge a DAU insights-shaped response. */
function spliceDAU(legacy: unknown, fresh: unknown): unknown {
  const legacySeries = isObject(legacy) && isObject(legacy.series)
    ? (legacy.series['A. DAU'] as Record<string, number> | undefined)
    : undefined;
  const freshSeries = isObject(fresh) && isObject(fresh.series)
    ? (fresh.series['A. DAU'] as Record<string, number> | undefined)
    : undefined;
  return {
    series: { 'A. DAU': spliceDateSeries(legacySeries, freshSeries, CUTOFF_DATE) },
    date_range: isObject(fresh) ? fresh.date_range : null,
  };
}

/** Merge an events-API response: `{ data: { values: { [event]: { [date]: n } } } }`. */
function spliceEvents(legacy: unknown, fresh: unknown): unknown {
  const legacyValues = isObject(legacy) && isObject(legacy.data) && isObject(legacy.data.values)
    ? (legacy.data.values as Record<string, Record<string, number>>)
    : {};
  const freshValues = isObject(fresh) && isObject(fresh.data) && isObject(fresh.data.values)
    ? (fresh.data.values as Record<string, Record<string, number>>)
    : {};

  const eventNames = new Set<string>([...Object.keys(legacyValues), ...Object.keys(freshValues)]);
  const merged: Record<string, Record<string, number>> = {};
  for (const ev of eventNames) {
    merged[ev] = spliceDateSeries(legacyValues[ev], freshValues[ev], CUTOFF_DATE);
  }
  return { data: { values: merged } };
}

/** Merge an engagement payload (totals + unique each in events-API shape). */
function spliceEngagement(legacy: unknown, fresh: unknown): unknown {
  const lg = isObject(legacy) ? legacy : {};
  const fr = isObject(fresh) ? fresh : {};
  return {
    totals: spliceEvents(lg.totals, fr.totals),
    unique: spliceEvents(lg.unique, fr.unique),
  };
}

/**
 * Snapshot the current production blob to the legacy slot if no legacy blob
 * exists yet. Runs at most once — subsequent refreshes leave it alone, so the
 * frozen pre-cutoff data is never overwritten by accident.
 */
async function ensureLegacySnapshot(): Promise<MixpanelBlobPayload | null> {
  const existingLegacy = await getLegacyBlobData();
  if (existingLegacy) return existingLegacy;

  const current = await getExistingBlobData();
  if (!current) {
    console.log('No current blob to snapshot as legacy — starting fresh');
    return null;
  }

  try {
    await put(LEGACY_BLOB_FILENAME, JSON.stringify(current), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: 'application/json',
    });
    console.log(`Snapshotted current blob to ${LEGACY_BLOB_FILENAME} (frozen reference for dates < ${CUTOFF_DATE})`);
    return current;
  } catch (err) {
    console.warn('Failed to write legacy snapshot:', err);
    return current;
  }
}

// ─── Handler ─────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Password');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Auth: cron or admin password
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

  console.log('Starting Mixpanel data refresh...');

  // Snapshot the current blob as the legacy reference on the very first run
  // after this code lands — we'll splice anything < CUTOFF_DATE from it
  // forever after. Existing data is also the fallback if a fetch fails.
  const legacyData = await ensureLegacySnapshot();
  const existingData = await getExistingBlobData();

  // Fetch everything SEQUENTIALLY to avoid rate limits
  const errors: Record<string, string> = {};

  let dau = null;
  try { dau = await fetchDAU(); } catch (e) {
    errors.dau = e instanceof Error ? e.message : 'Failed';
  }

  let wau = null;
  try { wau = await fetchWAU(); } catch (e) {
    errors.wau = e instanceof Error ? e.message : 'Failed';
  }

  let mau = null;
  try { mau = await fetchMAU(); } catch (e) {
    errors.mau = e instanceof Error ? e.message : 'Failed';
  }

  let weeklyEngagement = null;
  try { weeklyEngagement = await fetchEngagement('week', 21); } catch (e) {
    errors.weeklyEngagement = e instanceof Error ? e.message : 'Failed';
  }

  let monthlyEngagement = null;
  try { monthlyEngagement = await fetchEngagement('month', 90); } catch (e) {
    errors.monthlyEngagement = e instanceof Error ? e.message : 'Failed';
  }

  const errorCount = Object.keys(errors).length;
  const successCount = 5 - errorCount;

  // If all failed and we have existing data, keep it
  if (successCount === 0 && existingData) {
    console.log('All Mixpanel fetches failed — keeping existing blob data');
    return res.status(200).json({
      message: `All 5 fetches failed. Keeping existing data from ${existingData.refreshedAt}.`,
      kept: true,
      refreshedAt: existingData.refreshedAt,
    });
  }

  // First, choose the "new project" payload per metric: prefer the fresh
  // fetch, fall back to whatever was already in the current blob (which
  // was itself a splice of legacy + previous fresh).
  const newProject = {
    dau: dau ?? existingData?.dau ?? null,
    wau: wau ?? existingData?.wau ?? null,
    mau: mau ?? existingData?.mau ?? null,
    weeklyEngagement: weeklyEngagement ?? existingData?.weeklyEngagement ?? null,
    monthlyEngagement: monthlyEngagement ?? existingData?.monthlyEngagement ?? null,
  };

  // Splice legacy (< CUTOFF_DATE) with new-project data (>= CUTOFF_DATE).
  // If there's no legacy blob (first-ever deploy), this just passes through
  // the new-project data unchanged.
  const payload: MixpanelBlobPayload = {
    dau: spliceDAU(legacyData?.dau, newProject.dau),
    wau: spliceEvents(legacyData?.wau, newProject.wau),
    mau: spliceEvents(legacyData?.mau, newProject.mau),
    weeklyEngagement: spliceEngagement(legacyData?.weeklyEngagement, newProject.weeklyEngagement),
    monthlyEngagement: spliceEngagement(legacyData?.monthlyEngagement, newProject.monthlyEngagement),
    errors: errorCount > 0 ? errors : undefined,
    refreshedAt: new Date().toISOString(),
  };

  // Write to blob
  try {
    const blob = await put(BLOB_FILENAME, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });

    console.log(`Mixpanel blob written: ${blob.url}`);
    console.log(`Result: ${successCount}/5 fetches succeeded`);

    return res.status(200).json({
      message: `Refreshed ${successCount}/5 Mixpanel data sources`,
      blobUrl: blob.url,
      refreshedAt: payload.refreshedAt,
      successCount,
      errors: errorCount > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Failed to upload Mixpanel blob:', error);
    return res.status(500).json({
      error: 'Failed to store Mixpanel data',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
