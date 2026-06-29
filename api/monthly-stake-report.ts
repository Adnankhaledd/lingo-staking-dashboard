import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/monthly-stake-report — posts a Slack-only digest of the PREVIOUS calendar
 * month's stakes (≥10k LINGO) broken down by source (bought / claimed / etc.).
 *
 * Runs via Vercel cron on the 1st of each month (see vercel.json). Reuses the
 * classifier in /api/backfill-stake-sources by calling it internally and paging
 * through the whole month, then posts ONE aggregate Slack message — so the
 * classification logic lives in exactly one place.
 *
 * Manual test: /api/monthly-stake-report?password=ADMIN_PASSWORD
 *   optional &month=2026-05 to report a specific month.
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const SOURCE_ORDER = ['bought', 'transferred_bought_upstream', 'claimed', 'restaked', 'transferred', 'internal', 'preheld', 'unknown'];
const SOURCE_LABELS: Record<string, string> = {
  bought: '🛒 Bought on DEX',
  transferred_bought_upstream: '🛒 Transferred (bought upstream)',
  claimed: '🎁 Claimed',
  restaked: '🔁 Unstaked & re-staked',
  transferred: '↔️ Transferred in',
  internal: '🏦 From project wallet',
  preheld: '⏳ Pre-held balance',
  unknown: '❔ Source unknown',
};

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return (data.result ?? null) as T | null;
  } catch {
    return null;
  }
}

/** Estimate the block for a unix-seconds timestamp from the latest block (Base ~2s/block). */
async function blockRangeForMonth(prevStartSec: number, thisStartSec: number): Promise<{ fromBlock: number; toBlock: number } | null> {
  const latestHex = await rpc<string>('eth_blockNumber', []);
  if (!latestHex) return null;
  const latest = parseInt(latestHex, 16);
  const blk = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [latestHex, false]);
  if (!blk) return null;
  const latestTs = parseInt(blk.timestamp, 16);
  const est = (ts: number) => Math.max(0, latest - Math.round((latestTs - ts) / 2));
  return { fromBlock: est(prevStartSec), toBlock: Math.max(0, est(thisStartSec) - 1) };
}

interface BackfillPage {
  summary?: Record<string, { count: number; lingo: number }>;
  hasMore?: boolean;
  nextBeforeBlock?: number | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Auth: cron or admin (password via header or query for manual runs)
  const isCron = !CRON_SECRET || req.headers.authorization === `Bearer ${CRON_SECRET}` || req.headers['x-vercel-cron'] === '1';
  const pw = (req.headers['x-admin-password'] as string | undefined) ?? (req.query.password as string | undefined);
  const isAdmin = ADMIN_PASSWORD && pw === ADMIN_PASSWORD;
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });

  if (!ALCHEMY_API_KEY || !SLACK_WEBHOOK_URL) {
    return res.status(200).json({
      message: 'Not configured',
      missing: [!ALCHEMY_API_KEY && 'ALCHEMY_API_KEY', !SLACK_WEBHOOK_URL && 'SLACK_WEBHOOK_URL'].filter(Boolean),
    });
  }

  try {
    // Which month to report — default = previous calendar month (UTC).
    const now = new Date();
    let year = now.getUTCFullYear();
    let monthIdx = now.getUTCMonth() - 1; // previous month
    const monthParam = req.query.month as string | undefined; // "YYYY-MM"
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const [yy, mm] = monthParam.split('-').map(Number);
      year = yy; monthIdx = mm - 1;
    }
    // Normalize (handles January → previous December)
    const start = new Date(Date.UTC(year, monthIdx, 1));
    const end = new Date(Date.UTC(year, monthIdx + 1, 1));
    const prevStartSec = Math.floor(start.getTime() / 1000);
    const thisStartSec = Math.floor(end.getTime() / 1000);
    const monthLabel = `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCFullYear()}`;

    const range = await blockRangeForMonth(prevStartSec, thisStartSec);
    if (!range) return res.status(200).json({ error: 'Could not resolve block range' });

    // Page through the month via the backfill endpoint (single classifier source).
    // NOTE: use the PUBLIC production domain, not VERCEL_URL — the deployment-
    // specific URL is behind Vercel deployment protection and returns an HTML
    // login page (not JSON) to server-side self-calls. Override via SELF_BASE_URL.
    const base = process.env.SELF_BASE_URL || 'https://lingo-staking-dashboard.vercel.app';
    const headers: Record<string, string> = {};
    if (ADMIN_PASSWORD) headers['X-Admin-Password'] = ADMIN_PASSWORD;
    if (CRON_SECRET) headers['Authorization'] = `Bearer ${CRON_SECRET}`;

    const totals: Record<string, { count: number; lingo: number }> = {};
    let cursor = range.toBlock;
    let pages = 0;
    let totalCount = 0;
    let totalLingo = 0;

    while (pages < 12) {
      pages++;
      const url = `${base}/api/backfill-stake-sources?fromBlock=${range.fromBlock}&beforeBlock=${cursor}&limit=200&format=json`;
      const r = await fetch(url, { headers });
      if (!r.ok) break;
      let page: BackfillPage;
      try {
        page = (await r.json()) as BackfillPage;
      } catch {
        // Non-JSON (e.g. an auth/HTML page) — stop paging rather than crash.
        break;
      }
      for (const [src, v] of Object.entries(page.summary ?? {})) {
        const t = totals[src] ?? { count: 0, lingo: 0 };
        t.count += v.count; t.lingo += v.lingo;
        totals[src] = t;
        totalCount += v.count; totalLingo += v.lingo;
      }
      if (!page.hasMore || page.nextBeforeBlock == null) break;
      cursor = page.nextBeforeBlock;
    }

    // Build the Slack message
    const denom = totalCount || 1;
    const lines = SOURCE_ORDER
      .filter(src => totals[src])
      .map(src => {
        const v = totals[src];
        return `${SOURCE_LABELS[src] ?? src}: *${v.count}* (${Math.round((v.count / denom) * 100)}%) · ${Math.round(v.lingo).toLocaleString()} LINGO`;
      });

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `📊 Stake Sources — ${monthLabel}`, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `Stakes ≥10,000 LINGO, by where the staked LINGO came from:` } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || '_No stakes ≥10k LINGO last month_' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Total: *${totalCount}* stakes · ${Math.round(totalLingo).toLocaleString()} LINGO${pages >= 12 ? ' · (capped)' : ''}` }] },
    ];

    const slackRes = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Stake sources for ${monthLabel}: ${totalCount} stakes`, blocks }),
    });

    return res.status(200).json({
      month: monthLabel,
      range,
      pages,
      totalCount,
      totalLingo: Math.round(totalLingo),
      summary: totals,
      slackPosted: slackRes.ok,
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
