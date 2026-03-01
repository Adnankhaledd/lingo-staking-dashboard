import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list, del } from '@vercel/blob';

const MIXPANEL_API_SECRET = process.env.MIXPANEL_API_SECRET || '010125f09fef119ad08d0eb062be12b6';
const PROJECT_ID = '3623820';
const REPORT_ID = '75454495';

const BLOB_FILENAME = 'mixpanel-data.json';

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

async function fetchDAU() {
  return mixpanelGet(
    `https://eu.mixpanel.com/api/2.0/insights?project_id=${PROJECT_ID}&bookmark_id=${REPORT_ID}`
  );
}

async function fetchWAU() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 56); // ~8 weeks for trend chart

  const params = new URLSearchParams({
    project_id: PROJECT_ID,
    event: JSON.stringify(['Wallet Connected']),
    type: 'unique',
    unit: 'week',
    from_date: toDateStr(from),
    to_date: toDateStr(today),
  });

  return mixpanelGet(`https://eu.mixpanel.com/api/2.0/events?${params}`);
}

async function fetchMAU() {
  const today = new Date();
  const lastMonth = new Date(today);
  lastMonth.setDate(lastMonth.getDate() - 30);

  const params = new URLSearchParams({
    project_id: PROJECT_ID,
    event: JSON.stringify(['Wallet Connected']),
    type: 'unique',
    unit: 'month',
    from_date: toDateStr(lastMonth),
    to_date: toDateStr(today),
  });

  return mixpanelGet(`https://eu.mixpanel.com/api/2.0/events?${params}`);
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
    from_date: toDateStr(from),
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

async function getExistingBlobData(): Promise<MixpanelBlobPayload | null> {
  try {
    const { blobs } = await list({ prefix: BLOB_FILENAME });
    if (blobs.length === 0) return null;

    const latestBlob = blobs[blobs.length - 1];
    const response = await fetch(latestBlob.url);
    if (!response.ok) return null;

    return await response.json() as MixpanelBlobPayload;
  } catch {
    return null;
  }
}

async function deleteExistingBlobs(): Promise<void> {
  try {
    const { blobs } = await list({ prefix: BLOB_FILENAME });
    if (blobs.length > 0) {
      await del(blobs.map(b => b.url));
      console.log(`Deleted ${blobs.length} existing Mixpanel blob(s)`);
    }
  } catch (err) {
    console.warn('Failed to delete old Mixpanel blobs:', err);
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

  // Fetch existing blob for fallback
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

  // Merge: use new data if succeeded, keep old if failed
  const payload: MixpanelBlobPayload = {
    dau: dau ?? existingData?.dau ?? null,
    wau: wau ?? existingData?.wau ?? null,
    mau: mau ?? existingData?.mau ?? null,
    weeklyEngagement: weeklyEngagement ?? existingData?.weeklyEngagement ?? null,
    monthlyEngagement: monthlyEngagement ?? existingData?.monthlyEngagement ?? null,
    errors: errorCount > 0 ? errors : undefined,
    refreshedAt: new Date().toISOString(),
  };

  // Write to blob
  try {
    await deleteExistingBlobs();

    const blob = await put(BLOB_FILENAME, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
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
