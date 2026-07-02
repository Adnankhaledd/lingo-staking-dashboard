import type { VercelRequest, VercelResponse } from '@vercel/node';
import { timingSafeEqual } from 'node:crypto';

/**
 * /api/slack-stake-report — on-demand stake-source report via a Slack slash command.
 *
 * Slack setup (one-time, ~2 min):
 *   api.slack.com/apps → your app → Slash Commands → Create New Command:
 *     Command:      /stake-report
 *     Request URL:  https://lingo-staking-dashboard.vercel.app/api/slack-stake-report
 *     Usage hint:   [last 2 days | 48h | 3 weeks | may | 2026-05]
 *   Reinstall the app to the workspace if prompted.
 *   Optional hardening: set SLACK_VERIFICATION_TOKEN (app → Basic Information →
 *   Verification Token) in Vercel env so forged payloads are rejected.
 *
 * Flow: Slack POSTs the command here and requires an ack within 3 seconds, but
 * classification takes 10–40s. We ack immediately and keep working via
 * waitUntil() (@vercel/functions — keeps the invocation alive after the
 * response). If waitUntil is unavailable at runtime, we fall back to firing a
 * second invocation of this same endpoint (header x-stake-worker: 1) and
 * detaching. Either way the report is computed by paging
 * /api/backfill-stake-sources (the single source of truth for classification)
 * and posted to the command's response_url, landing in the channel where the
 * command was typed.
 *
 * Manual/test (GET): /api/slack-stake-report?text=last 2 days
 *   optional &post=1 to also post the result to SLACK_WEBHOOK_URL.
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
// Optional hardening: Slack app's Verification Token (Basic Information page).
const SLACK_VERIFICATION_TOKEN = process.env.SLACK_VERIFICATION_TOKEN || '';
// Self-calls must use the PUBLIC production domain — VERCEL_URL is behind
// deployment protection and returns an HTML login page (see monthly report).
const SELF_BASE = process.env.SELF_BASE_URL || 'https://lingo-staking-dashboard.vercel.app';

const MAX_DAYS = 190; // hard cap on requested range — bounds compute
const BUDGET_MS = 45_000; // paging budget — leaves headroom to post before maxDuration

const USAGE = [
  '*Usage:* `/stake-report [period]`',
  'Examples: `last 2 days` · `48h` · `3 weeks` · `may` · `2026-05` · `2026-05-15` · `yesterday` · `today`',
  `Default period: last 7 days (max ${MAX_DAYS} days). Counts stakes ≥10,000 LINGO.`,
].join('\n');

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

// ─── Period parsing ─────────────────────────────────────────────────────

const WORD_NUMS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

interface Period { fromTs: number; toTs: number; label: string }

function utcMidnightSec(sec: number): number {
  const d = new Date(sec * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}

function monthLabel(i: number): string {
  return MONTHS[i][0].toUpperCase() + MONTHS[i].slice(1);
}

/** Parse a free-text period ("last 2 days", "48h", "may", "2026-05", …). */
function parsePeriod(raw: string, nowSec: number): Period {
  const text = (raw || '')
    .toLowerCase()
    // compound word numbers first: "twenty-one" / "twenty one" → "21"
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s]+(one|two|three|four|five|six|seven|eight|nine))?\b/g,
      (_, t: string, o: string | undefined) => String(TENS[t] + (o ? parseInt(WORD_NUMS[o], 10) : 0)))
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, m => WORD_NUMS[m])
    .trim();

  // Full ISO date: "2026-05-15" → that single UTC day
  const ymd = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (ymd) {
    const y = parseInt(ymd[1], 10);
    const m = parseInt(ymd[2], 10);
    const d = parseInt(ymd[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const fromTs = Date.UTC(y, m - 1, d) / 1000;
      if (fromTs < nowSec) {
        const toTs = Math.min(fromTs + 86_400, nowSec);
        return { fromTs, toTs, label: `${monthLabel(m - 1)} ${d}, ${y} (UTC)` };
      }
    }
  }

  // Explicit calendar month: "2026-05" (negative lookahead so a malformed
  // full date can't be misread as a month)
  const ym = text.match(/\b(\d{4})-(\d{1,2})(?!-\d)\b/);
  if (ym) {
    const y = parseInt(ym[1], 10);
    const m = parseInt(ym[2], 10);
    if (m >= 1 && m <= 12) {
      const fromTs = Date.UTC(y, m - 1, 1) / 1000;
      if (fromTs < nowSec) {
        const toTs = Math.min(Date.UTC(y, m, 1) / 1000, nowSec);
        return { fromTs, toTs, label: `${monthLabel(m - 1)} ${y}` };
      }
    }
  }

  if (/\btoday\b/.test(text)) {
    return { fromTs: utcMidnightSec(nowSec), toTs: nowSec, label: 'today (UTC)' };
  }
  if (/\byesterday\b/.test(text)) {
    const mid = utcMidnightSec(nowSec);
    return { fromTs: mid - 86_400, toTs: mid, label: 'yesterday (UTC)' };
  }

  // Month by name, optional year: "may", "may 2025"
  for (let i = 0; i < 12; i++) {
    const m = text.match(new RegExp(`\\b${MONTHS[i]}\\b(?:\\s+(\\d{4}))?`));
    if (!m) continue;
    const now = new Date(nowSec * 1000);
    let y = m[1] ? parseInt(m[1], 10) : now.getUTCFullYear();
    if (!m[1] && i > now.getUTCMonth()) y -= 1; // "december" said in June → last December
    const fromTs = Date.UTC(y, i, 1) / 1000;
    if (fromTs >= nowSec) continue; // future month — ignore, fall through
    const monthEnd = Date.UTC(y, i + 1, 1) / 1000;
    const toTs = Math.min(monthEnd, nowSec);
    const mtd = toTs === nowSec && monthEnd > nowSec;
    return { fromTs, toTs, label: `${monthLabel(i)} ${y}${mtd ? ' (month to date)' : ''}` };
  }

  // Relative periods — units accumulate so "1 week and 2 days" = 9 days.
  let hours = 0;
  const hm = text.match(/(\d+)\s*(?:hours?|hrs?|h)\b/);
  if (hm) hours += parseInt(hm[1], 10);
  const dm = text.match(/(\d+)\s*(?:days?|d)\b/);
  if (dm) hours += parseInt(dm[1], 10) * 24;
  const wm = text.match(/(\d+)\s*(?:weeks?|wks?|w)\b/);
  if (wm) hours += parseInt(wm[1], 10) * 168;
  const mom = text.match(/(\d+)\s*(?:months?|mos?|mo)\b/);
  if (mom) hours += parseInt(mom[1], 10) * 720;
  if (!hours) {
    if (/\bweek\b/.test(text)) hours = 168;
    else if (/\bmonth\b/.test(text)) hours = 720;
    else if (/\bday\b/.test(text)) hours = 24;
  }

  let note = '';
  if (!hours || !Number.isFinite(hours)) { hours = 168; note = ' (default)'; }
  if (hours > MAX_DAYS * 24) { hours = MAX_DAYS * 24; note = ` (capped at ${MAX_DAYS} days)`; }

  const label = hours % 24 === 0
    ? `the last ${hours / 24} day${hours === 24 ? '' : 's'}`
    : `the last ${hours} hours`;
  return { fromTs: nowSec - hours * 3600, toTs: nowSec, label: label + note };
}

// ─── Chain + self-call helpers ──────────────────────────────────────────

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

/** Estimate block numbers for the period from the latest block (Base ~2s/block). */
async function resolveBlocks(p: Period): Promise<{ fromBlock: number; toBlock: number } | null> {
  const latestHex = await rpc<string>('eth_blockNumber', []);
  if (!latestHex) return null;
  const latest = parseInt(latestHex, 16);
  const blk = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [latestHex, false]);
  if (!blk) return null;
  const latestTs = parseInt(blk.timestamp, 16);
  const est = (ts: number) => Math.max(0, latest - Math.round((latestTs - ts) / 2));
  const toBlock = Math.min(latest, est(p.toTs));
  const fromBlock = Math.min(toBlock, est(p.fromTs));
  return { fromBlock, toBlock };
}

function selfHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (ADMIN_PASSWORD) h['X-Admin-Password'] = ADMIN_PASSWORD;
  if (CRON_SECRET) h['Authorization'] = `Bearer ${CRON_SECRET}`;
  return h;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function postToUrl(url: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Report building ────────────────────────────────────────────────────

interface BackfillPage {
  summary?: Record<string, { count: number; lingo: number }>;
  hasMore?: boolean;
  nextBeforeBlock?: number | null;
}

interface ReportResult {
  period: Period;
  range: { fromBlock: number; toBlock: number };
  totals: Record<string, { count: number; lingo: number }>;
  totalCount: number;
  totalLingo: number;
  pages: number;
  partial: boolean;
}

async function runReport(text: string): Promise<ReportResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const period = parsePeriod(text, nowSec);
  const range = await resolveBlocks(period);
  if (!range) throw new Error('Could not resolve block range (RPC unavailable)');

  const totals: Record<string, { count: number; lingo: number }> = {};
  let cursor = range.toBlock;
  let pages = 0;
  let totalCount = 0;
  let totalLingo = 0;
  let more = true;
  let partial = false;
  const startMs = Date.now();

  while (more && pages < 12) {
    // Keep every page fetch inside the time budget so we always have room to
    // post the (possibly partial) report before the function's maxDuration.
    const remaining = BUDGET_MS - (Date.now() - startMs);
    if (remaining < 3_000) { partial = true; break; }
    pages++;
    const url = `${SELF_BASE}/api/backfill-stake-sources?fromBlock=${range.fromBlock}&beforeBlock=${cursor}&limit=200&format=json`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(remaining, 20_000));
    let r: Response;
    try {
      r = await fetch(url, { headers: selfHeaders(), signal: ctl.signal });
    } catch {
      partial = true;
      break;
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) { partial = true; break; }
    let page: BackfillPage;
    try { page = (await r.json()) as BackfillPage; } catch { partial = true; break; }
    for (const [src, v] of Object.entries(page.summary ?? {})) {
      const t = totals[src] ?? { count: 0, lingo: 0 };
      t.count += v.count;
      t.lingo += v.lingo;
      totals[src] = t;
      totalCount += v.count;
      totalLingo += v.lingo;
    }
    more = !!(page.hasMore && page.nextBeforeBlock != null);
    if (more) cursor = page.nextBeforeBlock as number;
  }
  if (more) partial = true; // ran out of pages/time with blocks left unscanned

  return { period, range, totals, totalCount, totalLingo, pages, partial };
}

function buildBlocks(rep: ReportResult, userId?: string): unknown[] {
  const denom = rep.totalCount || 1;
  const lines = SOURCE_ORDER
    .filter(src => rep.totals[src])
    .map(src => {
      const v = rep.totals[src];
      return `${SOURCE_LABELS[src] ?? src}: *${v.count}* (${Math.round((v.count / denom) * 100)}%) · ${Math.round(v.lingo).toLocaleString()} LINGO`;
    });

  const contextBits = [
    `Total: *${rep.totalCount}* stakes · ${Math.round(rep.totalLingo).toLocaleString()} LINGO`,
    `blocks ${rep.range.fromBlock.toLocaleString()}–${rep.range.toBlock.toLocaleString()}`,
  ];
  if (userId) contextBits.push(`requested by <@${userId}>`);
  if (rep.partial) contextBits.push('⚠️ partial — range too large, narrow the period');

  return [
    { type: 'header', text: { type: 'plain_text', text: `📊 Stake Sources — ${rep.period.label}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: 'Stakes ≥10,000 LINGO, by where the staked LINGO came from:' } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || `_No stakes ≥10k LINGO in ${rep.period.label}_` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: contextBits.join(' · ') }] },
  ];
}

/** Compute the report and deliver it to `dest` (response_url or webhook). */
async function computeAndPost(text: string, dest: string, userId?: string): Promise<void> {
  try {
    const rep = await runReport(text);
    await postToUrl(dest, {
      response_type: 'in_channel',
      text: `Stake sources for ${rep.period.label}: ${rep.totalCount} stakes`,
      blocks: buildBlocks(rep, userId),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    await postToUrl(dest, { response_type: 'ephemeral', text: `⚠️ Stake report failed: ${msg}` });
  }
}

// ─── Handler ────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // When CRON_SECRET is set, Vercel cron sends it as a Bearer token automatically.
  // (The spoofable x-vercel-cron header is deliberately NOT trusted.)
  const isCron = !CRON_SECRET || req.headers.authorization === `Bearer ${CRON_SECRET}`;
  const pw = (req.headers['x-admin-password'] as string | undefined)
    ?? (req.query.password as string | undefined);
  const isAdmin = ADMIN_PASSWORD && pw === ADMIN_PASSWORD;

  // ── WORKER branch: fallback second invocation doing the heavy lifting ──
  if (req.method === 'POST' && req.headers['x-stake-worker'] === '1') {
    if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    const body = (req.body ?? {}) as { text?: string; response_url?: string; user_id?: string };
    const dest = body.response_url && /^https:\/\/hooks\.slack\.com\//.test(body.response_url)
      ? body.response_url
      : SLACK_WEBHOOK_URL;
    if (!dest) return res.status(200).json({ error: 'No destination (response_url or SLACK_WEBHOOK_URL)' });
    await computeAndPost(body.text ?? '', dest, body.user_id);
    return res.status(200).json({ ok: true });
  }

  // ── ACK branch: Slack slash command ────────────────────────────────────
  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, string>;
    if (body.ssl_check) return res.status(200).send('ok');
    if (SLACK_VERIFICATION_TOKEN && !safeEqual(body.token ?? '', SLACK_VERIFICATION_TOKEN)) {
      return res.status(401).json({ error: 'Bad verification token' });
    }
    const responseUrl = body.response_url;
    if (!responseUrl || !/^https:\/\/hooks\.slack\.com\//.test(responseUrl)) {
      return res.status(400).json({ error: 'Expected a Slack slash-command payload (missing response_url)' });
    }
    const text = body.text ?? '';
    if (/^\s*help\s*$/i.test(text)) {
      return res.status(200).json({ response_type: 'ephemeral', text: USAGE });
    }
    const period = parsePeriod(text, Math.floor(Date.now() / 1000));

    // Preferred: keep THIS invocation alive past the ack with waitUntil().
    let scheduled = false;
    try {
      const mod = await import('@vercel/functions');
      if (typeof mod.waitUntil === 'function') {
        const work = computeAndPost(text, responseUrl, body.user_id);
        try {
          mod.waitUntil(work);
          scheduled = true;
        } catch {
          // work has already started — don't double-fire the fallback.
          scheduled = true;
        }
      }
    } catch { /* package unavailable at runtime — use the fallback below */ }

    // Fallback: fire a second invocation of this endpoint and detach. Vercel's
    // router accepts the request as soon as it's sent; aborting our client
    // side does not cancel that invocation.
    if (!scheduled) {
      let spawnError: string | null = null;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1_200);
      try {
        const r = await fetch(`${SELF_BASE}/api/slack-stake-report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-stake-worker': '1', ...selfHeaders() },
          body: JSON.stringify({ text, response_url: responseUrl, user_id: body.user_id }),
          signal: ctl.signal,
        });
        // A response within the window is either a fast success or a spawn failure.
        if (!r.ok) {
          spawnError = `worker returned HTTP ${r.status}`;
          console.error('stake-report spawn failed:', r.status, (await r.text().catch(() => '')).slice(0, 200));
        }
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          spawnError = err instanceof Error ? err.message : 'unknown error';
          console.error('stake-report spawn failed:', err);
        }
      } finally {
        clearTimeout(timer);
      }
      if (spawnError) {
        return res.status(200).json({
          response_type: 'ephemeral',
          text: `⚠️ Could not start the stake report (${spawnError}).`,
        });
      }
    }

    return res.status(200).json({
      response_type: 'ephemeral',
      text: `⏳ Computing stake sources for ${period.label} — the report will post here shortly.`,
    });
  }

  // ── GET: manual/test mode ───────────────────────────────────────────────
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const text = typeof req.query.text === 'string' ? req.query.text : '';
  try {
    const rep = await runReport(text);
    let slackPosted = false;
    if (req.query.post === '1' && SLACK_WEBHOOK_URL) {
      slackPosted = await postToUrl(SLACK_WEBHOOK_URL, {
        text: `Stake sources for ${rep.period.label}: ${rep.totalCount} stakes`,
        blocks: buildBlocks(rep),
      });
    }
    return res.status(200).json({
      label: rep.period.label,
      range: rep.range,
      pages: rep.pages,
      partial: rep.partial,
      totalCount: rep.totalCount,
      totalLingo: Math.round(rep.totalLingo),
      summary: rep.totals,
      slackPosted,
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
