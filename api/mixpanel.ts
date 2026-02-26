import type { VercelRequest, VercelResponse } from '@vercel/node';

const MIXPANEL_API_SECRET = process.env.MIXPANEL_API_SECRET || '010125f09fef119ad08d0eb062be12b6';
const PROJECT_ID = '3623820';
const REPORT_ID = '75454495';

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
  const lastWeek = new Date(today);
  lastWeek.setDate(lastWeek.getDate() - 7);

  const params = new URLSearchParams({
    project_id: PROJECT_ID,
    event: JSON.stringify(['Wallet Connected']),
    type: 'unique',
    unit: 'week',
    from_date: toDateStr(lastWeek),
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

  const events = ['Asteroid Smashed', 'Raffle Ticket Purchased', 'Reward Claimed'];
  const baseParams = {
    project_id: PROJECT_ID,
    event: JSON.stringify(events),
    unit,
    from_date: toDateStr(from),
    to_date: toDateStr(today),
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

// ─── Handler ─────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { type } = req.query;

  try {
    // ─── Consolidated endpoint: one call, all data, no rate limits ────
    if (type === 'all') {
      const errors: Record<string, string> = {};

      // Fetch everything SEQUENTIALLY to avoid Mixpanel rate limits.
      // Each call completes before the next starts.
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
      try { weeklyEngagement = await fetchEngagement('week', 14); } catch (e) {
        errors.weeklyEngagement = e instanceof Error ? e.message : 'Failed';
      }

      let monthlyEngagement = null;
      try { monthlyEngagement = await fetchEngagement('month', 60); } catch (e) {
        errors.monthlyEngagement = e instanceof Error ? e.message : 'Failed';
      }

      // Cache at CDN for 2 minutes to reduce Mixpanel API hits
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

      return res.status(200).json({
        dau,
        wau,
        mau,
        weeklyEngagement,
        monthlyEngagement,
        errors: Object.keys(errors).length > 0 ? errors : undefined,
        fetchedAt: new Date().toISOString(),
      });
    }

    // ─── Legacy individual endpoints (kept for backward compat) ──────

    let data;

    if (type === 'dau') {
      data = await fetchDAU();
    } else if (type === 'wau') {
      data = await fetchWAU();
    } else if (type === 'mau') {
      data = await fetchMAU();
    } else if (type === 'weekly_engagement') {
      data = await fetchEngagement('week', 14);
    } else if (type === 'monthly_engagement') {
      data = await fetchEngagement('month', 60);
    } else {
      return res.status(400).json({ error: 'Invalid type. Use: all, dau, wau, mau, weekly_engagement, or monthly_engagement' });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('Mixpanel API error:', error);
    return res.status(500).json({ error: 'Failed to fetch Mixpanel data' });
  }
}
