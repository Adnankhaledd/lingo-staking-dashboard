import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/mixpanel-debug — diagnostic endpoint.
 *
 * Runs a single JQL query against the new Mixpanel project that returns
 * BOTH the total event count AND the unique-distinct_id count for each
 * of the last 14 days. If `uniqueUsers` < `totalEvents` for any day,
 * the dedup is working correctly. If they're equal, something is wrong.
 *
 * Cached for 5 minutes. No auth required for read.
 */

const MIXPANEL_API_SECRET = process.env.MIXPANEL_API_SECRET_NEW
  || process.env.MIXPANEL_API_SECRET
  || '010125f09fef119ad08d0eb062be12b6';
const PROJECT_ID = '4518653';

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 14);
  const fromDate = toDateStr(from);
  const toDate = toDateStr(today);

  // Two separate JQL scripts — combining inside a single JQL pipeline is
  // brittle because .groupBy returns a JQL pipeline (not a real Array)
  // and .concat() etc don't exist on it. Running them in parallel and
  // merging in Node is cleaner.
  const dayKeyFn = 'function(event) { return new Date(event.time).toISOString().slice(0, 10); }';
  const distinctIdFn = 'function(event) { return event.distinct_id; }';

  const totalEventsScript = `
function main() {
  return Events({from_date: ${JSON.stringify(fromDate)}, to_date: ${JSON.stringify(toDate)}})
    .groupBy([${dayKeyFn}], mixpanel.reducer.count());
}`.trim();

  const uniqueUsersScript = `
function main() {
  return Events({from_date: ${JSON.stringify(fromDate)}, to_date: ${JSON.stringify(toDate)}})
    .groupBy([${dayKeyFn}, ${distinctIdFn}], mixpanel.reducer.null())
    .groupBy(["key.0"], mixpanel.reducer.count());
}`.trim();

  const auth = `Basic ${Buffer.from(MIXPANEL_API_SECRET + ':').toString('base64')}`;

  async function runJql(script: string): Promise<{ ok: true; rows: Array<{ key: [string]; value: number }> } | { ok: false; error: string; rawText: string }> {
    const body = new URLSearchParams();
    body.append('project_id', PROJECT_ID);
    body.append('script', script);
    const r = await fetch('https://eu.mixpanel.com/api/2.0/jql', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status}`, rawText: (await r.text()).slice(0, 500) };
    }
    return { ok: true, rows: await r.json() as Array<{ key: [string]; value: number }> };
  }

  try {
    const [totalRes, uniqueRes] = await Promise.all([
      runJql(totalEventsScript),
      runJql(uniqueUsersScript),
    ]);

    if (!totalRes.ok) {
      return res.status(200).json({ projectId: PROJECT_ID, fromDate, toDate, stage: 'totalEvents', ...totalRes });
    }
    if (!uniqueRes.ok) {
      return res.status(200).json({ projectId: PROJECT_ID, fromDate, toDate, stage: 'uniqueUsers', ...uniqueRes });
    }

    const byDay: Record<string, { totalEvents?: number; uniqueUsers?: number }> = {};
    for (const row of totalRes.rows) {
      if (row?.key?.[0]) byDay[row.key[0]] = { ...(byDay[row.key[0]] ?? {}), totalEvents: row.value };
    }
    for (const row of uniqueRes.rows) {
      if (row?.key?.[0]) byDay[row.key[0]] = { ...(byDay[row.key[0]] ?? {}), uniqueUsers: row.value };
    }

    const series = Object.entries(byDay)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => {
        const total = v.totalEvents ?? 0;
        const users = v.uniqueUsers ?? 0;
        return {
          day,
          totalEvents: total,
          uniqueUsers: users,
          eventsPerUser: users > 0 ? +(total / users).toFixed(2) : 0,
          dedupRatio: total > 0 ? +(users / total).toFixed(4) : 0,
        };
      });

    return res.status(200).json({
      projectId: PROJECT_ID,
      fromDate, toDate,
      explainer: 'If uniqueUsers < totalEvents (and eventsPerUser > 1), dedup is working. Equal numbers mean dedup is broken.',
      series,
    });
  } catch (error) {
    return res.status(200).json({
      projectId: PROJECT_ID,
      fromDate, toDate,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
