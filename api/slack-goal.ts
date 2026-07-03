import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list } from '@vercel/blob';
import { timingSafeEqual } from 'node:crypto';

/**
 * /api/slack-goal — a Slack `/goal` command that sets a staking goal and tracks
 * progress toward it with a countdown.
 *
 * Slack setup: api.slack.com/apps → your app → Slash Commands → Create:
 *   Command:      /goal
 *   Request URL:  https://lingo-staking-dashboard.vercel.app/api/slack-goal
 *   Usage hint:   [30m in 7 days | +3m in 1 week | status | clear]
 *
 * Usage:
 *   /goal 30m in 7 days   → target 30M total staked within 7 days
 *   /goal +3m in 1 week   → stake 3M MORE within a week (a gain target)
 *   /goal 80m by 2026-08-01
 *   /goal                 → show current progress
 *   /goal clear           → remove the active goal
 *
 * Progress uses the live on-chain staked balance (the staking contract's LINGO
 * balance). A daily cron (?cron=1) posts a progress update and fires a 🎉 when
 * the goal is hit / a final result when the deadline passes.
 *
 * Setting/reading a goal is one Alchemy call (~fast), so we respond to Slack
 * synchronously — no waitUntil/worker dance needed.
 */

export const config = { maxDuration: 30 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const LINGO_DECIMALS = 18;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const SLACK_VERIFICATION_TOKEN = process.env.SLACK_VERIFICATION_TOKEN || '';
const BLOB_KEY = 'stake-goal.json';
const MAX_DAYS = 365;

const USAGE = [
  '*Usage:* `/goal [amount] in [duration]`',
  '`/goal 30m in 7 days` — reach 30M total staked within 7 days',
  '`/goal +3m in 1 week` — stake 3M *more* within a week',
  '`/goal 80m by 2026-08-01` · `/goal` (progress) · `/goal clear`',
].join('\n');

// ─── Persistence ────────────────────────────────────────────────────────

interface Goal {
  type: 'total' | 'gain';
  targetAmount: number;   // for 'total': the absolute target; for 'gain': the +amount
  baseline: number;       // total staked at creation
  neededGain: number;     // LINGO still needed at creation (targetAmount for gain; target-baseline for total)
  createdAt: string;
  deadline: string;
  createdBy?: string;
  durationLabel: string;
  celebrated?: boolean;   // 🎉 already posted
  closed?: boolean;       // final (deadline) result already posted
}

async function fetchBlobJson<T = unknown>(pathname: string): Promise<T | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const match = token.match(/^vercel_blob_rw_([^_]+)_/);
  if (match) {
    try {
      const res = await fetch(`https://${match[1]}.public.blob.vercel-storage.com/${pathname}?t=${Date.now()}`);
      if (res.ok) return (await res.json()) as T;
      if (res.status === 404) return null;
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

async function saveGoal(goal: Goal | null): Promise<void> {
  await put(BLOB_KEY, JSON.stringify(goal ?? {}), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

async function loadGoal(): Promise<Goal | null> {
  const g = await fetchBlobJson<Partial<Goal>>(BLOB_KEY);
  if (!g || typeof g.targetAmount !== 'number' || !g.deadline) return null;
  return g as Goal;
}

// ─── Chain ──────────────────────────────────────────────────────────────

async function getTotalStaked(): Promise<number | null> {
  if (!ALCHEMY_API_KEY || !STAKING_CONTRACT) return null;
  try {
    const res = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances', params: [STAKING_CONTRACT, [LINGO_TOKEN]] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const bal = data.result?.tokenBalances?.[0]?.tokenBalance;
    if (!bal || bal === '0x') return 0;
    return Number(BigInt(bal) / BigInt(10) ** BigInt(LINGO_DECIMALS));
  } catch {
    return null;
  }
}

// ─── Parsing ────────────────────────────────────────────────────────────

const WORD_NUMS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Remove duration/date expressions so their numbers can't be misread as the
 *  amount (e.g. "in 7 days" must not yield a 7-LINGO goal). Amounts like "3m"
 *  / "80m" survive because the ERC-20 million suffix isn't a time unit. */
function stripForAmount(t: string): string {
  return t
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|mo)\b/gi, ' ')
    .replace(/\b(?:in|within|over|by|for)\b/gi, ' ');
}

/** Parse "30m", "1.5m", "500k", "2b", "30,000,000", "+3m" → { amount, isGain }. */
function parseAmount(text: string): { amount: number; isGain: boolean } | null {
  const gainKeyword = /(^|\s)(\+|add|gain|more|another|extra)\b/.test(text);
  const m = stripForAmount(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kmb])?\b/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const suffix = (m[2] || '').toLowerCase();
  if (suffix === 'k') n *= 1e3;
  else if (suffix === 'm') n *= 1e6;
  else if (suffix === 'b') n *= 1e9;
  if (!Number.isFinite(n) || n <= 0) return null;
  return { amount: Math.round(n), isGain: gainKeyword || /\+\s*\d/.test(text) };
}

/** Parse a deadline from "in 7 days", "1 week", "48h", "by 2026-08-01". Returns ms epoch. */
function parseDeadline(text: string, nowMs: number): { deadline: number; label: string } {
  // Absolute date: "by 2026-08-01" / bare YYYY-MM-DD
  const ymd = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (ymd) {
    const y = +ymd[1], mo = +ymd[2], d = +ymd[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const dl = Date.UTC(y, mo - 1, d, 23, 59, 59);
      if (dl > nowMs) {
        const days = Math.max(1, Math.round((dl - nowMs) / 86_400_000));
        return { deadline: Math.min(dl, nowMs + MAX_DAYS * 86_400_000), label: `by ${ymd[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} (${days}d)` };
      }
    }
  }

  const norm = text
    .toLowerCase()
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s]+(one|two|three|four|five|six|seven|eight|nine))?\b/g,
      (_, t: string, o: string | undefined) => String(TENS[t] + (o ? parseInt(WORD_NUMS[o], 10) : 0)))
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, w => WORD_NUMS[w]);

  let hours = 0;
  const hm = norm.match(/(\d+)\s*(?:hours?|hrs?|h)\b/);
  if (hm) hours += +hm[1];
  const dm = norm.match(/(\d+)\s*(?:days?|d)\b/);
  if (dm) hours += +dm[1] * 24;
  const wm = norm.match(/(\d+)\s*(?:weeks?|wks?|w)\b/);
  if (wm) hours += +wm[1] * 168;
  const mm = norm.match(/(\d+)\s*(?:months?|mos?|mo)\b/);
  if (mm) hours += +mm[1] * 720;
  if (!hours) {
    if (/\bweek\b/.test(norm)) hours = 168;
    else if (/\bmonth\b/.test(norm)) hours = 720;
    else if (/\bday\b/.test(norm)) hours = 24;
  }
  if (!hours) hours = 168; // default 7 days
  if (hours > MAX_DAYS * 24) hours = MAX_DAYS * 24;

  const days = hours / 24;
  const label = hours % 24 === 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `in ${hours}h`;
  return { deadline: nowMs + hours * 3_600_000, label };
}

// ─── Formatting ─────────────────────────────────────────────────────────

function fmtLingo(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toString();
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'time up';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function progressBar(frac: number, width = 14): string {
  const f = Math.max(0, Math.min(1, frac));
  const filled = Math.round(f * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

interface Progress {
  current: number;
  gained: number;
  neededGain: number;
  remaining: number;
  progressFrac: number;
  elapsedFrac: number;
  timeLeftMs: number;
  reached: boolean;
  expired: boolean;
  onPace: boolean;
  projectedGain: number;
  willHit: boolean;
}

function computeProgress(goal: Goal, current: number, nowMs: number): Progress {
  const created = Date.parse(goal.createdAt);
  const deadline = Date.parse(goal.deadline);
  const gained = current - goal.baseline;
  const neededGain = Math.max(0, goal.neededGain);
  const remaining = Math.max(0, neededGain - gained);
  const progressFrac = neededGain > 0 ? gained / neededGain : 1;
  const span = Math.max(1, deadline - created);
  const elapsedFrac = Math.max(0, Math.min(1, (nowMs - created) / span));
  const projectedGain = elapsedFrac > 0.02 ? gained / elapsedFrac : gained;
  return {
    current,
    gained,
    neededGain,
    remaining,
    progressFrac,
    elapsedFrac,
    timeLeftMs: deadline - nowMs,
    reached: gained >= neededGain,
    expired: nowMs >= deadline,
    onPace: progressFrac >= elapsedFrac,
    projectedGain,
    willHit: projectedGain >= neededGain,
  };
}

function goalTitle(goal: Goal): string {
  return goal.type === 'gain'
    ? `+${fmtLingo(goal.targetAmount)} LINGO staked`
    : `${fmtLingo(goal.targetAmount)} LINGO total staked`;
}

function buildGoalBlocks(goal: Goal, p: Progress, opts: { finalResult?: boolean } = {}): unknown[] {
  const pct = Math.round(Math.max(0, Math.min(1, p.progressFrac)) * 100);
  const overshoot = p.progressFrac > 1 ? ` (${Math.round(p.progressFrac * 100)}%)` : '';

  let statusLine: string;
  if (p.reached) {
    statusLine = '🎉 *Goal reached!*';
  } else if (opts.finalResult || p.expired) {
    statusLine = `⏰ *Time's up* — reached ${pct}% of the goal.`;
  } else if (p.onPace || p.willHit) {
    statusLine = p.progressFrac > p.elapsedFrac + 0.1 ? '🚀 *Ahead of pace*' : '✅ *On pace*';
  } else {
    statusLine = '⚠️ *Behind pace*';
  }

  const paceHint = (!p.reached && !p.expired)
    ? `\nAt the current rate you'll add ~*${fmtLingo(p.projectedGain)}* by the deadline (goal: ${fmtLingo(p.neededGain)}).`
    : '';

  const detail = [
    `*Progress:* \`${progressBar(p.progressFrac)}\` ${pct}%${overshoot}`,
    `*Staked toward goal:* ${fmtLingo(p.gained)} of ${fmtLingo(p.neededGain)}` + (p.reached ? '' : ` · *${fmtLingo(p.remaining)} to go*`),
    `*Live total staked:* ${Math.round(p.current).toLocaleString()} LINGO`,
    p.expired ? '*Deadline:* passed' : `*Time left:* ⏳ ${fmtCountdown(p.timeLeftMs)}`,
  ].join('\n');

  return [
    { type: 'header', text: { type: 'plain_text', text: `🎯 Staking Goal — ${goalTitle(goal)}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `${statusLine} ${goal.durationLabel}${paceHint}` } },
    { type: 'section', text: { type: 'mrkdwn', text: detail } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Goal set by ${goal.createdBy ? `<@${goal.createdBy}>` : 'someone'} · deadline ${new Date(goal.deadline).toUTCString().replace(':00 GMT', ' UTC')}` }] },
  ];
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function postToUrl(url: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return res.ok;
  } catch { return false; }
}

// ─── Handler ────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const isCron = !CRON_SECRET || req.headers.authorization === `Bearer ${CRON_SECRET}`;
  const pw = (req.headers['x-admin-password'] as string | undefined) ?? (req.query.password as string | undefined);
  const isAdmin = ADMIN_PASSWORD && pw === ADMIN_PASSWORD;

  // ── CRON / GET: post a scheduled progress update ────────────────────────
  if (req.method === 'GET' || req.query.cron === '1') {
    if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    const goal = await loadGoal();
    if (!goal) return res.status(200).json({ message: 'No active goal' });
    const current = await getTotalStaked();
    if (current == null) return res.status(200).json({ error: 'Could not read staked balance' });
    const now = Date.now();
    const p = computeProgress(goal, current, now);

    // Transition handling: celebrate once, close once.
    if (p.reached && !goal.celebrated) {
      goal.celebrated = true;
      await saveGoal(goal);
      if (SLACK_WEBHOOK_URL) await postToUrl(SLACK_WEBHOOK_URL, { text: '🎉 Staking goal reached!', blocks: buildGoalBlocks(goal, p) });
      return res.status(200).json({ posted: 'reached', progress: p });
    }
    if (p.expired && !goal.closed) {
      goal.closed = true;
      await saveGoal(goal);
      if (SLACK_WEBHOOK_URL) await postToUrl(SLACK_WEBHOOK_URL, { text: "⏰ Staking goal deadline reached", blocks: buildGoalBlocks(goal, p, { finalResult: true }) });
      return res.status(200).json({ posted: 'final', progress: p });
    }
    if (p.expired || p.reached) return res.status(200).json({ message: 'Goal already closed/celebrated' });
    // Regular daily progress
    if (SLACK_WEBHOOK_URL) await postToUrl(SLACK_WEBHOOK_URL, { text: `Staking goal: ${Math.round(p.progressFrac * 100)}% · ${fmtCountdown(p.timeLeftMs)} left`, blocks: buildGoalBlocks(goal, p) });
    return res.status(200).json({ posted: 'progress', progress: p });
  }

  // ── POST: Slack slash command ───────────────────────────────────────────
  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, string>;
    if (body.ssl_check) return res.status(200).send('ok');
    if (SLACK_VERIFICATION_TOKEN && !safeEqual(body.token ?? '', SLACK_VERIFICATION_TOKEN)) {
      return res.status(401).json({ error: 'Bad verification token' });
    }
    const text = (body.text ?? '').trim();

    if (/^\s*help\s*$/i.test(text)) {
      return res.status(200).json({ response_type: 'ephemeral', text: USAGE });
    }

    // Clear
    if (/^(clear|reset|cancel|stop|remove)\b/i.test(text)) {
      await saveGoal(null);
      return res.status(200).json({ response_type: 'in_channel', text: '🗑️ Staking goal cleared.' });
    }

    // Status (no args / "status")
    if (text === '' || /^status\b/i.test(text)) {
      const goal = await loadGoal();
      if (!goal) return res.status(200).json({ response_type: 'ephemeral', text: `No active goal. Set one:\n${USAGE}` });
      const current = await getTotalStaked();
      if (current == null) return res.status(200).json({ response_type: 'ephemeral', text: '⚠️ Could not read the live staked balance right now — try again.' });
      const p = computeProgress(goal, current, Date.now());
      return res.status(200).json({ response_type: 'in_channel', blocks: buildGoalBlocks(goal, p), text: `Staking goal: ${Math.round(p.progressFrac * 100)}%` });
    }

    // Set a new goal
    const parsedAmount = parseAmount(text);
    if (!parsedAmount) {
      return res.status(200).json({ response_type: 'ephemeral', text: `Couldn't read an amount from "${text}".\n${USAGE}` });
    }
    const current = await getTotalStaked();
    if (current == null) {
      return res.status(200).json({ response_type: 'ephemeral', text: '⚠️ Could not read the live staked balance to anchor the goal — try again shortly.' });
    }
    const nowMs = Date.now();
    const { deadline, label } = parseDeadline(text, nowMs);

    // Decide total vs gain. Explicit "+"/gain word forces gain. Otherwise an
    // absolute target at/below the current balance is nonsensical → treat as gain.
    const isGain = parsedAmount.isGain || parsedAmount.amount <= current;
    const type: Goal['type'] = isGain ? 'gain' : 'total';
    const neededGain = isGain ? parsedAmount.amount : parsedAmount.amount - current;

    const goal: Goal = {
      type,
      targetAmount: parsedAmount.amount,
      baseline: current,
      neededGain,
      createdAt: new Date(nowMs).toISOString(),
      deadline: new Date(deadline).toISOString(),
      createdBy: body.user_id,
      durationLabel: label,
    };
    await saveGoal(goal);
    const p = computeProgress(goal, current, nowMs);
    return res.status(200).json({ response_type: 'in_channel', blocks: buildGoalBlocks(goal, p), text: `🎯 New staking goal: ${goalTitle(goal)} ${label}` });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
