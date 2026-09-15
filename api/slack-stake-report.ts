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
 *
 * The same endpoint also serves /stake-breakdown — a per-day (or per-week)
 * breakdown of one funding type, e.g. `/stake-breakdown dex last 7 days`.
 * Register it in Slack with the same Request URL; until then the identical
 * output is available as `/stake-report dex daily last 7 days`.
 * GET test: ?text=dex daily last 7 days
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
  `Default period: last 7 days (max ${MAX_DAYS} days). Counts stakes worth ≥$100 at the time.`,
  'For a per-day breakdown of one type, see `/stake-breakdown help`.',
].join('\n');

const MAX_DAILY_BUCKETS = 62; // beyond this a daily list is unreadable in Slack → weekly

const BREAKDOWN_USAGE = [
  '*Usage:* `/stake-breakdown [type] [daily|weekly] [period]`',
  'Types: `dex` · `cex` · `buys` (all purchases) · `bridge` · `apy` · `vesting` · `claims` (all claims) · `reward` · `restake` · `transfer` · `internal` · `preheld` · `unknown` — combine them (`dex cex`), or leave out for every source.',
  'Examples: `dex last 7 days` · `apy weekly last 2 months` · `buys may` · `restake 48h` · `dex 2026-08`',
  `Daily by default; switches to weekly past ${MAX_DAILY_BUCKETS} days. A stake funded from several sources counts toward each type by its share of the funding.`,
  'Same output via `/stake-report dex daily last 7 days`.',
].join('\n');

const SOURCE_ORDER = [
  'bought', 'bought_cex', 'transferred_bought_upstream', 'bridged',
  'claimed_apy', 'claimed_vesting', 'claimed',
  'reward', 'restaked', 'transferred', 'internal', 'preheld', 'unknown',
];

/** Compact USD, e.g. $1.2M / $340K / $912. */
function fmtUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '$0';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

const SOURCE_LABELS: Record<string, string> = {
  bought: '🛒 Bought on DEX',
  bought_cex: '🏦 Bought on exchange',
  bridged: '🌉 Bridged in',
  transferred_bought_upstream: '🛒 Transferred (bought upstream)',
  claimed_apy: '📈 APY reward claim',
  claimed_vesting: '⏳ Vesting claim',
  claimed: '🎁 Claimed (other)',
  reward: '💸 Reward payout',
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

interface Period { fromTs: number; toTs: number; label: string; relative?: boolean }

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
  return { fromTs: nowSec - hours * 3600, toTs: nowSec, label: label + note, relative: true };
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

interface BackfillRow {
  source: string;
  amount: number;
  amountUsd: number | null;
  blockNumber: number;
  timestamp?: number | null;
  mix?: Array<{ source: string; lingo: number; pct: number }>;
}

interface BackfillPage {
  rows?: BackfillRow[];
  summary?: Record<string, { count: number; lingo: number; usd?: number }>;
  pricingBasis?: string;
  hasMore?: boolean;
  nextBeforeBlock?: number | null;
}

interface ReportResult {
  period: Period;
  range: { fromBlock: number; toBlock: number };
  totals: Record<string, { count: number; lingo: number; usd: number }>;
  totalCount: number;
  totalLingo: number;
  totalUsd: number;
  pricingBasis: string;
  pages: number;
  partial: boolean;
  rows: BackfillRow[];
  /** Oldest block the scan reached — range.fromBlock unless it was cut short. */
  coveredFromBlock: number;
}

async function runReport(text: string): Promise<ReportResult> {
  return fetchReport(parsePeriod(text, Math.floor(Date.now() / 1000)));
}

/** Page the classifier across `period`, keeping per-source totals AND every row. */
async function fetchReport(period: Period): Promise<ReportResult> {
  const range = await resolveBlocks(period);
  if (!range) throw new Error('Could not resolve block range (RPC unavailable)');

  const totals: Record<string, { count: number; lingo: number; usd: number }> = {};
  let cursor = range.toBlock;
  let pages = 0;
  let totalCount = 0;
  let totalLingo = 0;
  let totalUsd = 0;
  let pricingBasis = '';
  const rows: BackfillRow[] = [];
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
    if (page.pricingBasis) pricingBasis = page.pricingBasis;
    if (Array.isArray(page.rows)) rows.push(...page.rows);
    for (const [src, v] of Object.entries(page.summary ?? {})) {
      const t = totals[src] ?? { count: 0, lingo: 0, usd: 0 };
      t.count += v.count;
      t.lingo += v.lingo;
      t.usd += v.usd ?? 0;
      totals[src] = t;
      totalCount += v.count;
      totalLingo += v.lingo;
      totalUsd += v.usd ?? 0;
    }
    more = !!(page.hasMore && page.nextBeforeBlock != null);
    if (more) cursor = page.nextBeforeBlock as number;
  }
  if (more) partial = true; // ran out of pages/time with blocks left unscanned

  return {
    period, range, totals, totalCount, totalLingo, totalUsd, pricingBasis, pages, partial, rows,
    coveredFromBlock: more ? cursor + 1 : range.fromBlock,
  };
}

function buildBlocks(rep: ReportResult, userId?: string): unknown[] {
  const denom = rep.totalCount || 1;
  const lines = SOURCE_ORDER
    .filter(src => rep.totals[src])
    .map(src => {
      const v = rep.totals[src];
      const usd = v.usd > 0 ? ` · ${fmtUsd(v.usd)}` : '';
      return `${SOURCE_LABELS[src] ?? src}: *${v.count}* (${Math.round((v.count / denom) * 100)}%) · ${Math.round(v.lingo).toLocaleString()} LINGO${usd}`;
    });

  const contextBits = [
    `Total: *${rep.totalCount}* stakes · ${Math.round(rep.totalLingo).toLocaleString()} LINGO${rep.totalUsd > 0 ? ` · ${fmtUsd(rep.totalUsd)}` : ''}`,
    `blocks ${rep.range.fromBlock.toLocaleString()}–${rep.range.toBlock.toLocaleString()}`,
  ];
  if (userId) contextBits.push(`requested by <@${userId}>`);
  if (rep.partial) contextBits.push('⚠️ partial — range too large, narrow the period');

  return [
    { type: 'header', text: { type: 'plain_text', text: `📊 Stake Sources — ${rep.period.label}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `Stakes ≥ ${rep.pricingBasis || '$100'}, by where the staked LINGO came from _(USD valued at each stake's own date)_:` } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || `_No qualifying stakes in ${rep.period.label}_` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: contextBits.join(' · ') }] },
  ];
}

// ─── Breakdown mode (/stake-breakdown) ─────────────────────────────────

/**
 * Words that select funding types. `generic` entries (buys / claims) only
 * apply when no more specific word from the same family was typed, so
 * "dex buys" means DEX only and "apy claims" means APY only.
 */
const TYPE_ALIASES: Array<{ words: string[]; sources: string[]; label: string; generic?: boolean }> = [
  { words: ['dex'], sources: ['bought'], label: 'DEX buys' },
  { words: ['cex', 'exchange', 'exchanges'], sources: ['bought_cex'], label: 'Exchange buys' },
  { words: ['upstream'], sources: ['transferred_bought_upstream'], label: 'Bought upstream' },
  { words: ['buys', 'buy', 'bought', 'purchases', 'purchase'], sources: ['bought', 'bought_cex', 'transferred_bought_upstream'], label: 'All buys', generic: true },
  { words: ['bridge', 'bridged', 'bridges'], sources: ['bridged'], label: 'Bridged in' },
  { words: ['apy'], sources: ['claimed_apy'], label: 'APY claims' },
  { words: ['vesting'], sources: ['claimed_vesting'], label: 'Vesting claims' },
  { words: ['claims', 'claim', 'claimed'], sources: ['claimed_apy', 'claimed_vesting', 'claimed'], label: 'All claims', generic: true },
  { words: ['reward', 'rewards'], sources: ['reward'], label: 'Reward payouts' },
  { words: ['restake', 'restakes', 'restaked', 'unstake', 'unstaked'], sources: ['restaked'], label: 'Re-stakes' },
  { words: ['transfer', 'transfers', 'transferred', 'wallet'], sources: ['transferred'], label: 'Wallet transfers' },
  { words: ['internal', 'project'], sources: ['internal'], label: 'Project wallets' },
  { words: ['preheld', 'held'], sources: ['preheld'], label: 'Pre-held' },
  { words: ['unknown'], sources: ['unknown'], label: 'Unknown source' },
];

type Granularity = 'day' | 'week';

interface BreakdownSpec {
  sources: Set<string> | null; // null = every source
  typeLabel: string;
  gran: Granularity;
  period: Period;
  note: string;
}

function isBreakdownRequest(command: string | undefined, text: string): boolean {
  return /stake-breakdown/i.test(command ?? '') || /\b(daily|weekly|breakdown)\b/i.test(text);
}

function mondayMidnightSec(sec: number): number {
  const d = new Date(sec * 1000);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff) / 1000;
}

function parseBreakdown(raw: string, nowSec: number): BreakdownSpec {
  let text = (raw || '').toLowerCase();

  let gran: Granularity = /\b(weekly|week\s+by\s+week|(?:per|by|each)\s+week)\b/.test(text) ? 'week' : 'day';
  // Strip granularity phrases BEFORE period parsing — "per week" would
  // otherwise be read as a one-week period.
  text = text.replace(/\b(daily|weekly|breakdown|day\s+by\s+day|week\s+by\s+week|(?:per|by|each)\s+(?:day|week))\b/g, ' ');

  const tokens = new Set(text.split(/[^a-z]+/).filter(Boolean));
  const picked: typeof TYPE_ALIASES = [];
  const chosen = new Set<string>();
  for (const a of TYPE_ALIASES) {
    if (a.generic || !a.words.some(w => tokens.has(w))) continue;
    picked.push(a);
    a.sources.forEach(src => chosen.add(src));
  }
  for (const a of TYPE_ALIASES) {
    if (!a.generic || !a.words.some(w => tokens.has(w))) continue;
    if (a.sources.some(src => chosen.has(src))) continue; // a specific word already narrowed this family
    picked.push(a);
    a.sources.forEach(src => chosen.add(src));
  }

  // Remove type words so they can never leak into the period parser.
  const typeWords = TYPE_ALIASES.flatMap(a => a.words).concat(['all', 'stakes', 'stake', 'of', 'from']);
  text = text.replace(new RegExp(`\\b(${typeWords.join('|')})\\b`, 'g'), ' ');

  let period = parsePeriod(text, nowSec);
  let note = '';
  if (gran === 'day' && (period.toTs - period.fromTs) / 86_400 > MAX_DAILY_BUCKETS) {
    gran = 'week';
    note = `switched to weekly — over ${MAX_DAILY_BUCKETS} days is too long to list day by day`;
  }

  // A rolling window ("last 7 days") starts mid-day. Extend its start BACK
  // to that bucket's boundary so the first bucket is whole too, and say so in
  // the label. Never snap forward — that silently drops data (at 00:05 UTC
  // "last 24h" would shrink to five minutes). Calendar periods (a month, a
  // date) are left exactly as requested; a partial first week is flagged.
  if (period.relative) {
    const s0 = (gran === 'day' ? utcMidnightSec : mondayMidnightSec)(period.fromTs);
    if (s0 < period.fromTs) {
      const since = new Date(s0 * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
      period = { ...period, fromTs: s0, label: `${period.label}, from ${since}` };
    }
  }

  return {
    sources: picked.length ? chosen : null,
    typeLabel: picked.length ? picked.map(a => a.label).join(' + ') : 'All sources',
    gran,
    period,
    note,
  };
}

interface Bucket {
  start: number;
  end: number;
  label: string;
  flag: string;                        // '', '(so far)', '(partial)'
  scan: 'full' | 'partial' | 'none';  // how much of it a cut-short scan reached
  count: number;   // stakes funded MAINLY (≥50%) by the selected types
  partly: number;  // stakes where the selected types were a minor share
  lingo: number;   // share-weighted LINGO
  usd: number;     // share-weighted USD at each stake's own date
  bySource: Record<string, number>;
}

function makeBuckets(p: Period, gran: Granularity, nowSec: number): Bucket[] {
  const unit = gran === 'day' ? 86_400 : 7 * 86_400;
  let start = gran === 'day' ? utcMidnightSec(p.fromTs) : mondayMidnightSec(p.fromTs);
  const out: Bucket[] = [];
  while (start < p.toTs && out.length < 400) {
    const end = start + unit;
    const d = new Date(start * 1000);
    const label = gran === 'day'
      ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit', timeZone: 'UTC' })
      : 'wk of ' + d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
    const flag = end > p.toTs
      ? (p.toTs >= nowSec - 300 ? '(so far)' : '(partial)')
      : start < p.fromTs ? '(partial)' : '';
    out.push({ start, end, label, flag, scan: 'full', count: 0, partly: 0, lingo: 0, usd: 0, bySource: {} });
    start = end;
  }
  return out;
}

/** Share of a stake's funding that came from the selected sources (0–1). */
function fundingShare(row: BackfillRow, sources: Set<string> | null): number {
  if (!sources) return 1;
  const mix = row.mix ?? [];
  const mixTotal = mix.reduce((sum, m) => sum + (m.lingo > 0 ? m.lingo : 0), 0);
  if (mix.length && mixTotal > 0) {
    return mix.reduce((sum, m) => sum + (sources.has(m.source) && m.lingo > 0 ? m.lingo : 0), 0) / mixTotal;
  }
  return sources.has(row.source) ? 1 : 0;
}

// Below MIN_SHARE a part rounds to 0% — the classifier doesn't show it either,
// and counting it would fill reward/transfer breakdowns with phantom stakes
// (a small reward landing after a big unstake is one of the commonest shapes).
const MIN_SHARE = 0.005;
const MAIN_SHARE = 0.5;

/** Short, unique tags for the all-sources split — several source emoji collide. */
const SOURCE_TAGS: Record<string, string> = {
  bought: 'DEX', bought_cex: 'CEX', transferred_bought_upstream: 'upstream buy', bridged: 'bridge',
  claimed_apy: 'APY', claimed_vesting: 'vesting', claimed: 'claim', reward: 'reward',
  restaked: 'restake', transferred: 'transfer', internal: 'project', preheld: 'pre-held', unknown: 'unknown',
};

interface BreakdownResult {
  spec: BreakdownSpec;
  rep: ReportResult;
  buckets: Bucket[];
  totalCount: number;
  totalPartly: number;
  totalMixed: number;
  totalLingo: number;
  totalUsd: number;
  unpriced: number;
  coveredFromTs: number;
}

async function runBreakdown(text: string): Promise<BreakdownResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const spec = parseBreakdown(text, nowSec);
  const rep = await fetchReport(spec.period);
  const buckets = makeBuckets(spec.period, spec.gran, nowSec);
  const unit = spec.gran === 'day' ? 86_400 : 7 * 86_400;
  const origin = buckets.length ? buckets[0].start : spec.period.fromTs;
  const { fromBlock, toBlock } = rep.range;
  const { fromTs, toTs } = spec.period;
  const blockToTs = (b: number) => fromTs + ((b - fromBlock) / Math.max(1, toBlock - fromBlock)) * (toTs - fromTs);

  // A scan cut short by the page/time budget never reached the oldest blocks.
  // Those buckets must not look like quiet days.
  const coveredFromTs = rep.partial ? Math.max(fromTs, blockToTs(rep.coveredFromBlock)) : fromTs;
  for (const b of buckets) b.scan = b.end <= coveredFromTs ? 'none' : b.start < coveredFromTs ? 'partial' : 'full';

  let totalCount = 0, totalPartly = 0, totalMixed = 0, totalLingo = 0, totalUsd = 0, unpriced = 0;
  for (const row of rep.rows) {
    const share = fundingShare(row, spec.sources);
    if (share < MIN_SHARE) continue;
    // Rows carry their block timestamp; if one ever doesn't, place it by block.
    const ts = row.timestamp ?? blockToTs(row.blockNumber);
    if (ts < fromTs || ts >= toTs) continue; // block-range estimate spilled over the edge
    const b = buckets[Math.floor((ts - origin) / unit)];
    if (!b) continue;

    const lingo = row.amount * share;
    const usd = (row.amountUsd ?? 0) * share;
    b.lingo += lingo; b.usd += usd; totalLingo += lingo; totalUsd += usd;
    if (share >= MAIN_SHARE) { b.count++; totalCount++; } else { b.partly++; totalPartly++; }
    if (share < 1 - MIN_SHARE) totalMixed++;
    if (row.amountUsd == null) unpriced++;

    if (!spec.sources) {
      const mix = row.mix ?? [];
      const mixTotal = mix.reduce((sum, m) => sum + (m.lingo > 0 ? m.lingo : 0), 0);
      if (mix.length && mixTotal > 0) {
        for (const m of mix) if (m.lingo > 0) b.bySource[m.source] = (b.bySource[m.source] ?? 0) + row.amount * (m.lingo / mixTotal);
      } else {
        b.bySource[row.source] = (b.bySource[row.source] ?? 0) + row.amount;
      }
    }
  }
  return { spec, rep, buckets, totalCount, totalPartly, totalMixed, totalLingo, totalUsd, unpriced, coveredFromTs };
}

function fmtLingo(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Math.round(v).toLocaleString();
}

/** Per-day figures are small — "$1K" would hide the difference between $0.6K and $1.4K. */
function fmtUsdFine(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '$0';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

function buildBreakdownBlocks(r: BreakdownResult, userId?: string): unknown[] {
  const { spec, rep, buckets } = r;
  const max = Math.max(0, ...buckets.filter(b => b.scan !== 'none').map(b => b.lingo));
  const width = Math.max(...buckets.map(b => b.label.length));
  const unitWord = spec.gran === 'day' ? 'day' : 'week';

  const lines = buckets.map(b => {
    if (b.scan === 'none') return `\`${b.label.padEnd(width)} ${'·'.repeat(10)}\` _not scanned_`;
    const filled = max > 0 ? Math.round((b.lingo / max) * 10) : 0;
    const head = `\`${b.label.padEnd(width)} ${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\``;
    const flags = [b.flag, b.scan === 'partial' ? '(partly scanned)' : ''].filter(Boolean).join(' ');
    const flag = flags ? ` _${flags}_` : '';
    if (!b.count && !b.partly) return `${head} —${flag}`;
    let line = `${head} *${b.count}* stake${b.count === 1 ? '' : 's'}`;
    if (b.partly) line += ` (+${b.partly} partly)`;
    line += ` · ${fmtLingo(b.lingo)} LINGO`;
    if (b.usd > 0) line += ` · ${fmtUsdFine(b.usd)}`;
    if (!spec.sources) {
      const total = Object.values(b.bySource).reduce((sum, v) => sum + v, 0) || 1;
      const top = Object.entries(b.bySource).sort((x, y) => y[1] - x[1]).slice(0, 3)
        .map(([src, v]) => `${SOURCE_TAGS[src] ?? src} ${Math.round((v / total) * 100)}%`);
      if (top.length) line += ` — ${top.join(' · ')}`;
    }
    return line + flag;
  });

  // Slack caps a section's text at 3000 chars — split the list across sections.
  const sections: unknown[] = [];
  let chunk = '';
  for (const line of lines) {
    if (chunk && chunk.length + line.length + 1 > 2_900) {
      sections.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
      chunk = '';
    }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) sections.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });

  // Average and best use ONLY buckets that are complete and fully scanned, so
  // the numerator and denominator always cover the same span.
  const complete = buckets.filter(b => !b.flag && b.scan === 'full');
  const summary = [
    `Total: *${r.totalCount}* stakes${r.totalPartly ? ` (+${r.totalPartly} partly)` : ''} · ${fmtLingo(r.totalLingo)} LINGO${r.totalUsd > 0 ? ` · ${fmtUsdFine(r.totalUsd)}` : ''}`,
  ];
  if (complete.length) {
    const avg = complete.reduce((sum, b) => sum + b.usd, 0) / complete.length;
    summary.push(`avg ${fmtUsdFine(avg)}/${unitWord} over ${complete.length} full ${unitWord}${complete.length === 1 ? '' : 's'}`);
    const best = complete.reduce((x, y) => (y.usd > x.usd || (y.usd === x.usd && y.lingo > x.lingo) ? y : x));
    if (best.lingo > 0) summary.push(`best ${unitWord}: ${best.label} (${best.usd > 0 ? fmtUsdFine(best.usd) : fmtLingo(best.lingo) + ' LINGO'})`);
  }

  const notes: string[] = [];
  if (spec.sources && r.totalMixed) {
    notes.push(`LINGO/USD count only the ${spec.typeLabel} share of mixed-funding stakes${r.totalPartly ? '; "partly" = under half of that stake\'s funding' : ''}`);
  }
  if (r.unpriced) notes.push(`${r.unpriced} stake${r.unpriced === 1 ? '' : 's'} had no price — counted in LINGO only`);
  if (spec.note) notes.push(spec.note);
  if (rep.partial) {
    const reached = new Date(r.coveredFromTs * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    notes.push(`⚠️ scan stopped early — nothing before ${reached} was scanned; narrow the period for full coverage`);
  }
  if (userId) notes.push(`requested by <@${userId}>`);

  return [
    { type: 'header', text: { type: 'plain_text', text: `📊 ${spec.typeLabel} — ${spec.gran === 'day' ? 'daily' : 'weekly'} breakdown`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `Stakes ≥ ${rep.pricingBasis || '$100'} · *${spec.period.label}* · UTC ${unitWord}s _(USD at each stake's own date)_` } },
    ...sections,
    { type: 'context', elements: [{ type: 'mrkdwn', text: summary.join(' · ') }] },
    ...(notes.length ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: notes.join(' · ') }] }] : []),
  ];
}

/** Compute the report and deliver it to `dest` (response_url or webhook). */
async function computeAndPost(text: string, dest: string, userId?: string, command?: string): Promise<void> {
  try {
    if (isBreakdownRequest(command, text)) {
      const r = await runBreakdown(text);
      await postToUrl(dest, {
        response_type: 'in_channel',
        text: `${r.spec.typeLabel} ${r.spec.gran === 'day' ? 'daily' : 'weekly'} breakdown for ${r.spec.period.label}: ${r.totalCount} stakes`,
        blocks: buildBreakdownBlocks(r, userId),
      });
      return;
    }
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
    const body = (req.body ?? {}) as { text?: string; response_url?: string; user_id?: string; command?: string };
    const dest = body.response_url && /^https:\/\/hooks\.slack\.com\//.test(body.response_url)
      ? body.response_url
      : SLACK_WEBHOOK_URL;
    if (!dest) return res.status(200).json({ error: 'No destination (response_url or SLACK_WEBHOOK_URL)' });
    await computeAndPost(body.text ?? '', dest, body.user_id, body.command);
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
    const breakdown = isBreakdownRequest(body.command, text);
    if (/^\s*help\s*$/i.test(text)) {
      return res.status(200).json({ response_type: 'ephemeral', text: breakdown ? BREAKDOWN_USAGE : USAGE });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const spec = breakdown ? parseBreakdown(text, nowSec) : null;
    const period = spec ? spec.period : parsePeriod(text, nowSec);

    // Preferred: keep THIS invocation alive past the ack with waitUntil().
    let scheduled = false;
    try {
      const mod = await import('@vercel/functions');
      if (typeof mod.waitUntil === 'function') {
        const work = computeAndPost(text, responseUrl, body.user_id, body.command);
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
          body: JSON.stringify({ text, response_url: responseUrl, user_id: body.user_id, command: body.command }),
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
      text: spec
        ? `⏳ Computing the ${spec.typeLabel} ${spec.gran === 'day' ? 'daily' : 'weekly'} breakdown for ${period.label} — it will post here shortly.`
        : `⏳ Computing stake sources for ${period.label} — the report will post here shortly.`,
    });
  }

  // ── GET: manual/test mode ───────────────────────────────────────────────
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const text = typeof req.query.text === 'string' ? req.query.text : '';
  const command = typeof req.query.command === 'string' ? req.query.command : undefined;
  if (isBreakdownRequest(command, text)) {
    try {
      const r = await runBreakdown(text);
      let slackPosted = false;
      if (req.query.post === '1' && SLACK_WEBHOOK_URL) {
        slackPosted = await postToUrl(SLACK_WEBHOOK_URL, {
          text: `${r.spec.typeLabel} breakdown for ${r.spec.period.label}`,
          blocks: buildBreakdownBlocks(r),
        });
      }
      return res.status(200).json({
        mode: 'breakdown',
        type: r.spec.typeLabel,
        sources: r.spec.sources ? [...r.spec.sources] : 'all',
        granularity: r.spec.gran,
        label: r.spec.period.label,
        fromTs: r.spec.period.fromTs,
        toTs: r.spec.period.toTs,
        note: r.spec.note || undefined,
        partial: r.rep.partial,
        pages: r.rep.pages,
        coveredFromTs: r.coveredFromTs,
        totals: { count: r.totalCount, partly: r.totalPartly, mixed: r.totalMixed, lingo: Math.round(r.totalLingo), usd: Math.round(r.totalUsd), unpriced: r.unpriced },
        buckets: r.buckets.map(b => ({ label: b.label, flag: b.flag || undefined, scan: b.scan, count: b.count, partly: b.partly, lingo: Math.round(b.lingo), usd: Math.round(b.usd) })),
        blocks: buildBreakdownBlocks(r),
        slackPosted,
      });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
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
