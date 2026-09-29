import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list } from '@vercel/blob';

/**
 * /api/staking-metrics — every chart on the /v2 dashboard, computed from
 * on-chain events alone. Replaces the Dune queries, which stopped refreshing.
 *
 * The staking contract emits exactly two events:
 *   Staked(user, amount, duration)    opens a position unlocking at block + duration
 *   Close(user, amount, unlockBlock)  closes that exact position
 * Every close matches an open position (0 unmatched across the whole history),
 * so replaying both in block order reconstructs every wallet's staked balance
 * at any moment — exactly, and reconciled against the contract's real LINGO
 * balance. Durations are in BLOCKS: 15,552,000 blocks × 2s = 12 months.
 *
 * COST. One rebuild reads the full history (~60 eth_getLogs pages plus a few
 * calls, ~10s). It runs once a day from cron. Page views are served the stored
 * snapshot and never touch Alchemy, so the cost does not grow with traffic.
 *
 *   GET              latest snapshot. Rebuilt inline only when none exists, or
 *                    when the cron has missed for STALE_AFTER_MS.
 *   GET ?rebuild=1   (cron/admin) force a rebuild — at most once per
 *                    REBUILD_MIN_AGE_MS, so it cannot be used to burn credits.
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const PRICES_URL = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/by-address`;
const HIST_PRICES_URL = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/historical`;
const CRON_SECRET = process.env.CRON_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '0x9aF8C0dac726CcEE2BFd6c0f3E21f320d42398AC').toLowerCase();
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';

// keccak256("Staked(address,uint256,uint256)")
const STAKED_TOPIC = '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90';
// The contract's only other event: (user indexed, uint256 amount, uint256 unlockBlock).
const CLOSE_TOPIC = '0x7fc4727e062e336010f2c282598ef5f14facb3de68cf8195c2f23e1454b2b74e';

// Display snapshot, overwritten once a day. Deliberately a single key: unlike
// the alert jobs' dedupe state (see api/lingo-buys.ts), nothing here decides
// what to post, so a read that lags an overwrite by a minute only shows
// yesterday's numbers briefly. cacheControlMaxAge caps how long that can last.
const SNAPSHOT_KEY = 'staking-metrics-v1.json';
// Bump when the snapshot shape changes: a stored snapshot of another version
// is treated as missing, so the next request rebuilds instead of serving a
// shape the page no longer reads.
const SNAPSHOT_VERSION = 2;
const MAX_REQUESTS = 160;
const LOG_PAGE_LIMIT = 9500;
const BLOCK_SECONDS = 2;            // Base block time — fixed by the protocol
const DAY = 86_400;
const REBUILD_MIN_AGE_MS = 2 * 60 * 60 * 1000;
const STALE_AFTER_MS = 30 * 60 * 60 * 1000;
const TOP_STAKERS = 100;
const PRICE_CHUNK_DAYS = 360;       // the historical endpoint allows 1 year at 1d

// ─── Classification ──────────────────────────────────────────────────────

export type Bucket = 'flexible' | '3mo' | '6mo' | '12mo' | 'other';
const BUCKETS: Bucket[] = ['flexible', '3mo', '6mo', '12mo', 'other'];
const BUCKET_BY_DURATION: Record<string, Bucket> = {
  '0': 'flexible', '3888000': '3mo', '7776000': '6mo', '15552000': '12mo',
};
/** 1-month, 24-month and odd promo/test durations are too small to chart on their own. */
const bucketOf = (duration: string): Bucket => BUCKET_BY_DURATION[duration] ?? 'other';

// Same labels as api/stake-lock-breakdown.ts, so LockBreakdownCard renders unchanged.
const DURATION_LABELS: Record<string, string> = {
  '0': 'Flexible', '1296000': '1 Month', '3888000': '3 Months',
  '7776000': '6 Months', '15552000': '12 Months', '30283200': '24 Months',
};
function labelOf(duration: string): string {
  const known = DURATION_LABELS[duration];
  if (known) return known;
  const days = Number(duration) * BLOCK_SECONDS / DAY;
  return days > 0 ? `${days < 1 ? days.toFixed(1) : days.toFixed(0)}d (other)` : 'Flexible';
}

// Membership tiers, exclusive bands (same cut-offs as the app and TierGrowthTable).
export type Tier = 'below' | 'member' | 'holder' | 'elite' | 'legend';
const TIERS: Tier[] = ['below', 'member', 'holder', 'elite', 'legend'];
function tierOf(usd: number): Tier {
  if (usd >= 2500) return 'legend';
  if (usd >= 1000) return 'elite';
  if (usd >= 250) return 'holder';
  if (usd >= 100) return 'member';
  return 'below';
}

const WEI = 10n ** 18n;
const toLingo = (w: bigint) => Number(w / WEI) + Number(w % WEI) / 1e18;
const round = (n: number) => Math.round(n);
const dayOf = (ts: number) => Math.floor(ts / DAY);
const isoDay = (day: number) => new Date(day * DAY * 1000).toISOString().slice(0, 10);
const monthOfDay = (day: number) => isoDay(day).slice(0, 7);
function nextMonthStartTs(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return Date.UTC(y, m, 1) / 1000;   // m is 1-based, so this is the NEXT month
}

// ─── Snapshot shape ──────────────────────────────────────────────────────

export interface DailyRow {
  day: string;                  // YYYY-MM-DD (UTC)
  total_staked: number;         // open balance at end of day
  change_from_yesterday: number;
  change_pct: number | null;
  staked: number;               // new stakes that day
  unstaked: number;             // withdrawals that day
  active_stakers: number;       // wallets with a non-zero balance at end of day
}

export interface MonthlyRow {
  month: string;                // YYYY-MM
  partial: boolean;             // the current, unfinished month
  price: number | null;         // LINGO/USD used for this month's tier split
  endTotal: number;             // open balance at month end
  endLocked: number;            // of which still time-locked
  activeStakers: number;
  staked: Record<Bucket, number> & { total: number };
  stakeEvents: number;
  uniqueStakers: number;
  unstaked: number;
  unstakeEvents: number;
  newWallets: number;           // first-ever stake this month
  newLingo: number;             // everything new wallets staked in their first month
  firstStakeLingo: number;      // just their first stake (matches the old Dune definition)
  returningWallets: number;     // staked this month, first staked in an earlier month
  returningLingo: number;
  newWalletTiers: Record<Tier, number>;    // new wallets by first-month stake value
  lockedByBucket: Record<Bucket, number>;  // month-end, still time-locked
  totalByBucket: Record<Bucket, number>;   // month-end, locked + unlocked
  tiers: Record<Tier, number>;             // active stakers, valued at that month-end's price
  tiersNow: Record<Tier, number>;          // same balances, valued at today's price
}

export interface CohortRow {
  month: string;                // first-stake month
  size: number;
  neverUnstaked: number;        // as of now
  partial: number;
  exited: number;
  retainedPct: number;
  /** Still-staked wallets at each month end from the cohort month onward. */
  curve: number[];
}

export interface Snapshot {
  version: number;
  generatedAt: string;
  asOfBlock: number;
  asOfTs: number;
  requests: Record<string, number>;
  source: { stakedEvents: number; closeEvents: number; closedUnmatched: number; timestampsEstimated: number };
  price: { live: number | null; firstDay: string | null; days: number };
  reconciliation: { onChainBalance: number; computedOpen: number; deltaLingo: number } | null;
  current: {
    totalStaked: number; locked: number; unlocked: number; activeStakers: number;
    byBucket: Record<Bucket, { locked: number; total: number }>;
    tiers: Record<Tier, number>;
  };
  daily: DailyRow[];
  monthly: MonthlyRow[];
  cohorts: CohortRow[];
  topStakers: Array<{ address: string; staked: number; locked: number; usd: number | null; positions: number; firstStake: string }>;
  /** Same shape as /api/stake-lock-breakdown, so LockBreakdownCard can render it. */
  lockBreakdown: {
    asOfBlock: number;
    summary: { stillLocked: number; flexibleOrUnlocked: number; totalOpen: number };
    tiers: Array<{ tier: string; durationBlocks: string; stillLocked: number; unlockedOrFlexible: number; total: number; positions: number }>;
    history: Array<{ month: string; atBlock: number; partial: boolean; total: number; locked: number; free: number; byTier: Record<string, number>; lockedByTier: Record<string, number> }>;
    reconciliation: { onChainBalance: number; computedOpen: number; deltaLingo: number; note: string } | null;
    events: { staked: number; closed: number; closedUnmatched: number };
  };
}

// ─── Pure computation (exported for tests) ───────────────────────────────

export interface StakeEvent { block: number; logIndex: number; ts: number; user: string; amount: bigint; duration: string }
export interface CloseEvent { block: number; logIndex: number; ts: number; user: string; amount: bigint; unlockBlock: number }

export interface ComputeInput {
  stakes: StakeEvent[];
  closes: CloseEvent[];
  head: number;
  headTs: number;
  /** [dayStartTs, usd], any order. */
  dailyPrices: Array<[number, number]>;
  livePrice: number | null;
  onChainWei: bigint | null;
  timestampsEstimated?: number;
  requests?: Record<string, number>;
}

interface Position { n: number; amount: bigint; duration: string; unlockTs: number; user: string }

interface Flow {
  staked: Record<Bucket, bigint>;
  stakeEvents: number;
  stakers: Set<string>;
  unstaked: bigint;
  unstakeEvents: number;
  newWallets: number;
  newLingo: bigint;
  firstStakeLingo: bigint;
  returning: Set<string>;
  returningLingo: bigint;
  newWalletUsd: Map<string, number>;
}

const zeroBuckets = <T>(v: () => T) => Object.fromEntries(BUCKETS.map(b => [b, v()])) as Record<Bucket, T>;
const zeroTiers = () => Object.fromEntries(TIERS.map(t => [t, 0])) as Record<Tier, number>;

export function computeMetrics(input: ComputeInput): Snapshot {
  const { head, headTs, livePrice, onChainWei } = input;

  // ── Price lookup by UTC day, forward-filled ──
  const priceByDay = new Map<number, number>();
  for (const [ts, usd] of input.dailyPrices) priceByDay.set(dayOf(ts), usd);
  const priceDays = [...priceByDay.keys()].sort((a, b) => a - b);
  const priceAt = (day: number): number | null => {
    if (!priceDays.length) return null;
    if (priceByDay.has(day)) return priceByDay.get(day)!;
    // nearest earlier day, else the first known day
    let lo = 0, hi = priceDays.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (priceDays[mid] <= day) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return priceByDay.get(priceDays[best >= 0 ? best : 0]) ?? null;
  };
  const todayDay = dayOf(headTs);
  const currentPrice = livePrice ?? priceAt(todayDay);

  // ── One chronological stream ──
  type Ev = { block: number; logIndex: number; ts: number; user: string; amount: bigint; close: boolean; duration: string; unlockBlock: number };
  const events: Ev[] = [];
  for (const s of input.stakes) {
    events.push({ ...s, close: false, unlockBlock: s.block + Number(s.duration) });
  }
  for (const c of input.closes) events.push({ ...c, close: true, duration: '' });
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

  const positions = new Map<string, Position>();
  const balance = new Map<string, bigint>();          // only wallets with a non-zero balance
  const firstStake = new Map<string, { month: string; ts: number }>();
  const everClosed = new Set<string>();
  let totalOpen = 0n;
  let closedUnmatched = 0;

  const flows = new Map<string, Flow>();
  const flowOf = (month: string): Flow => {
    let f = flows.get(month);
    if (!f) {
      f = {
        staked: zeroBuckets(() => 0n), stakeEvents: 0, stakers: new Set(),
        unstaked: 0n, unstakeEvents: 0, newWallets: 0, newLingo: 0n, firstStakeLingo: 0n,
        returning: new Set(), returningLingo: 0n, newWalletUsd: new Map(),
      };
      flows.set(month, f);
    }
    return f;
  };

  const daily: DailyRow[] = [];
  let dayStaked = 0n, dayUnstaked = 0n;
  const monthEnds: Array<{ month: string; partial: boolean; atTs: number; price: number | null;
    total: bigint; locked: bigint; byLabel: Map<string, { locked: bigint; total: bigint; positions: number }>;
    active: number; tiers: Record<Tier, number>; tiersNow: Record<Tier, number>; cohortActive: Map<string, number> }> = [];

  /** Everything that depends on the state at one instant: lock status, tiers, cohort survival. */
  const snapshotAt = (month: string, atTs: number, partial: boolean) => {
    const price = partial ? currentPrice : priceAt(dayOf(atTs - 1));
    const byLabel = new Map<string, { locked: bigint; total: bigint; positions: number }>();
    let locked = 0n;
    for (const p of positions.values()) {
      const amt = p.amount * BigInt(p.n);
      let e = byLabel.get(p.duration);
      if (!e) { e = { locked: 0n, total: 0n, positions: 0 }; byLabel.set(p.duration, e); }
      e.total += amt;
      e.positions += p.n;
      // Flexible is never locked; everything else is locked until its unlock time.
      if (p.duration !== '0' && p.unlockTs > atTs) { e.locked += amt; locked += amt; }
    }
    const tiers = zeroTiers();
    const tiersNow = zeroTiers();
    const cohortActive = new Map<string, number>();
    for (const [user, bal] of balance) {
      const lingo = toLingo(bal);
      if (price != null) tiers[tierOf(lingo * price)]++;
      if (currentPrice != null) tiersNow[tierOf(lingo * currentPrice)]++;
      const c = firstStake.get(user)!.month;
      cohortActive.set(c, (cohortActive.get(c) ?? 0) + 1);
    }
    monthEnds.push({ month, partial, atTs, price, total: totalOpen, locked, byLabel, active: balance.size, tiers, tiersNow, cohortActive });
  };

  const closeDay = (day: number) => {
    const prev = daily[daily.length - 1];
    const total = round(toLingo(totalOpen));
    daily.push({
      day: isoDay(day),
      total_staked: total,
      change_from_yesterday: prev ? total - prev.total_staked : total,
      change_pct: prev && prev.total_staked > 0 ? Math.round(((total - prev.total_staked) / prev.total_staked) * 10_000) / 100 : null,
      staked: round(toLingo(dayStaked)),
      unstaked: round(toLingo(dayUnstaked)),
      active_stakers: balance.size,
    });
    dayStaked = 0n; dayUnstaked = 0n;
    const month = monthOfDay(day);
    // Last day of a finished month → take the month-end snapshot. The live
    // month is snapshotted once, at the head, after the sweep.
    if (day !== todayDay && monthOfDay(day + 1) !== month) snapshotAt(month, (day + 1) * DAY, false);
  };

  let curDay = events.length ? dayOf(events[0].ts) : todayDay;
  for (const ev of events) {
    const d = dayOf(ev.ts);
    while (curDay < d) closeDay(curDay++);

    const month = monthOfDay(d);
    const f = flowOf(month);
    if (!ev.close) {
      const bucket = bucketOf(ev.duration);
      f.staked[bucket] += ev.amount;
      f.stakeEvents++;
      f.stakers.add(ev.user);

      let first = firstStake.get(ev.user);
      if (!first) {
        first = { month, ts: ev.ts };
        firstStake.set(ev.user, first);
        f.newWallets++;
        f.firstStakeLingo += ev.amount;
      }
      if (first.month === month) {
        f.newLingo += ev.amount;
        const p = priceAt(d);
        if (p != null) f.newWalletUsd.set(ev.user, (f.newWalletUsd.get(ev.user) ?? 0) + toLingo(ev.amount) * p);
      } else {
        f.returning.add(ev.user);
        f.returningLingo += ev.amount;
      }

      const key = `${ev.user}|${ev.unlockBlock}|${ev.amount}`;
      const pos = positions.get(key);
      if (pos) pos.n++;
      else positions.set(key, { n: 1, amount: ev.amount, duration: ev.duration, unlockTs: ev.ts + Number(ev.duration) * BLOCK_SECONDS, user: ev.user });
      balance.set(ev.user, (balance.get(ev.user) ?? 0n) + ev.amount);
      totalOpen += ev.amount;
      dayStaked += ev.amount;
    } else {
      f.unstaked += ev.amount;
      f.unstakeEvents++;
      const key = `${ev.user}|${ev.unlockBlock}|${ev.amount}`;
      const pos = positions.get(key);
      // A close that matches nothing is counted and otherwise ignored, exactly
      // as the reconciliation expects. It has never happened on this contract.
      if (!pos) { closedUnmatched++; continue; }
      if (--pos.n === 0) positions.delete(key);
      const bal = (balance.get(ev.user) ?? 0n) - ev.amount;
      if (bal > 0n) balance.set(ev.user, bal); else balance.delete(ev.user);
      everClosed.add(ev.user);
      totalOpen -= ev.amount;
      dayUnstaked += ev.amount;
    }
  }
  while (curDay <= todayDay) closeDay(curDay++);
  snapshotAt(monthOfDay(todayDay), headTs, true);

  // ── Monthly rows ──
  const monthKeys = [...new Set([...flows.keys(), ...monthEnds.map(m => m.month)])].sort();
  const endByMonth = new Map(monthEnds.map(m => [m.month, m]));
  const monthly: MonthlyRow[] = monthKeys.map(month => {
    const f = flowOf(month);
    const e = endByMonth.get(month);
    const lockedByBucket = zeroBuckets(() => 0);
    const totalByBucket = zeroBuckets(() => 0);
    if (e) {
      for (const [dur, v] of e.byLabel) {
        const b = bucketOf(dur);
        lockedByBucket[b] += toLingo(v.locked);
        totalByBucket[b] += toLingo(v.total);
      }
    }
    const staked = zeroBuckets(() => 0) as Record<Bucket, number> & { total: number };
    let stakedTotal = 0;
    for (const b of BUCKETS) { staked[b] = round(toLingo(f.staked[b])); stakedTotal += toLingo(f.staked[b]); }
    staked.total = round(stakedTotal);
    const newWalletTiers = zeroTiers();
    for (const usd of f.newWalletUsd.values()) newWalletTiers[tierOf(usd)]++;
    return {
      month,
      partial: e?.partial ?? false,
      price: e?.price ?? null,
      endTotal: e ? round(toLingo(e.total)) : 0,
      endLocked: e ? round(toLingo(e.locked)) : 0,
      activeStakers: e?.active ?? 0,
      staked,
      stakeEvents: f.stakeEvents,
      uniqueStakers: f.stakers.size,
      unstaked: round(toLingo(f.unstaked)),
      unstakeEvents: f.unstakeEvents,
      newWallets: f.newWallets,
      newLingo: round(toLingo(f.newLingo)),
      firstStakeLingo: round(toLingo(f.firstStakeLingo)),
      returningWallets: f.returning.size,
      returningLingo: round(toLingo(f.returningLingo)),
      newWalletTiers,
      lockedByBucket: Object.fromEntries(BUCKETS.map(b => [b, round(lockedByBucket[b])])) as Record<Bucket, number>,
      totalByBucket: Object.fromEntries(BUCKETS.map(b => [b, round(totalByBucket[b])])) as Record<Bucket, number>,
      tiers: e?.tiers ?? zeroTiers(),
      tiersNow: e?.tiersNow ?? zeroTiers(),
    };
  });

  // ── Cohorts: first-stake month → where those wallets stand now ──
  const cohortMap = new Map<string, { size: number; never: number; partial: number; exited: number }>();
  for (const [user, first] of firstStake) {
    let c = cohortMap.get(first.month);
    if (!c) { c = { size: 0, never: 0, partial: 0, exited: 0 }; cohortMap.set(first.month, c); }
    c.size++;
    if (!balance.has(user)) c.exited++;
    else if (everClosed.has(user)) c.partial++;
    else c.never++;
  }
  const cohorts: CohortRow[] = [...cohortMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, c]) => ({
    month,
    size: c.size,
    neverUnstaked: c.never,
    partial: c.partial,
    exited: c.exited,
    retainedPct: c.size ? Math.round(((c.never + c.partial) / c.size) * 1000) / 10 : 0,
    curve: monthEnds.filter(m => m.month >= month).map(m => m.cohortActive.get(month) ?? 0),
  }));

  // ── Current state (the last snapshot is the head) ──
  const now = monthEnds[monthEnds.length - 1];
  const byBucket = zeroBuckets(() => ({ locked: 0, total: 0 }));
  for (const [dur, v] of now.byLabel) {
    const b = bucketOf(dur);
    byBucket[b].locked += toLingo(v.locked);
    byBucket[b].total += toLingo(v.total);
  }
  for (const b of BUCKETS) { byBucket[b].locked = round(byBucket[b].locked); byBucket[b].total = round(byBucket[b].total); }

  const totalNow = round(toLingo(totalOpen));
  const lockedNow = round(toLingo(now.locked));
  const reconciliation = onChainWei == null ? null : {
    onChainBalance: round(toLingo(onChainWei)),
    computedOpen: totalNow,
    deltaLingo: totalNow - round(toLingo(onChainWei)),
  };

  // ── Top stakers ──
  const lockedByUser = new Map<string, bigint>();
  const positionsByUser = new Map<string, number>();
  for (const p of positions.values()) {
    positionsByUser.set(p.user, (positionsByUser.get(p.user) ?? 0) + p.n);
    if (p.duration !== '0' && p.unlockTs > headTs) lockedByUser.set(p.user, (lockedByUser.get(p.user) ?? 0n) + p.amount * BigInt(p.n));
  }
  const topStakers = [...balance.entries()]
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .slice(0, TOP_STAKERS)
    .map(([address, bal]) => {
      const staked = toLingo(bal);
      return {
        address,
        staked: round(staked),
        locked: round(toLingo(lockedByUser.get(address) ?? 0n)),
        usd: currentPrice != null ? round(staked * currentPrice) : null,
        positions: positionsByUser.get(address) ?? 0,
        firstStake: isoDay(dayOf(firstStake.get(address)!.ts)),
      };
    });

  // ── LockBreakdownCard-compatible block ──
  const blockAtTs = (ts: number) => Math.max(0, Math.min(head, head - Math.round((headTs - ts) / BLOCK_SECONDS)));
  const lbTiers = [...now.byLabel.entries()]
    .sort((a, b) => Number(BigInt(a[0]) - BigInt(b[0])))
    .map(([dur, v]) => ({
      tier: labelOf(dur),
      durationBlocks: dur,
      stillLocked: round(toLingo(v.locked)),
      unlockedOrFlexible: round(toLingo(v.total - v.locked)),
      total: round(toLingo(v.total)),
      positions: v.positions,
    }));
  const lbHistory = monthEnds.map(m => {
    const byTier: Record<string, number> = {};
    const lockedByTier: Record<string, number> = {};
    for (const [dur, v] of m.byLabel) {
      const label = labelOf(dur);
      byTier[label] = (byTier[label] ?? 0) + round(toLingo(v.total));
      lockedByTier[label] = (lockedByTier[label] ?? 0) + round(toLingo(v.locked));
    }
    const total = round(toLingo(m.total));
    const locked = round(toLingo(m.locked));
    return { month: m.month, atBlock: blockAtTs(m.atTs), partial: m.partial, total, locked, free: total - locked, byTier, lockedByTier };
  });

  return {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date(headTs * 1000).toISOString(),
    asOfBlock: head,
    asOfTs: headTs,
    requests: input.requests ?? {},
    source: {
      stakedEvents: input.stakes.length,
      closeEvents: input.closes.length,
      closedUnmatched,
      timestampsEstimated: input.timestampsEstimated ?? 0,
    },
    price: { live: livePrice, firstDay: priceDays.length ? isoDay(priceDays[0]) : null, days: priceDays.length },
    reconciliation,
    current: {
      totalStaked: totalNow,
      locked: lockedNow,
      unlocked: totalNow - lockedNow,
      activeStakers: balance.size,
      byBucket,
      tiers: now.tiers,
    },
    daily,
    monthly,
    cohorts,
    topStakers,
    lockBreakdown: {
      asOfBlock: head,
      summary: { stillLocked: lockedNow, flexibleOrUnlocked: totalNow - lockedNow, totalOpen: totalNow },
      tiers: lbTiers,
      history: lbHistory,
      reconciliation: reconciliation && { ...reconciliation, note: 'delta ≈ 0 means the event model ties out to the contract balance' },
      events: { staked: input.stakes.length, closed: input.closes.length, closedUnmatched },
    },
  };
}

// ─── Chain + prices ──────────────────────────────────────────────────────

interface RawLog { topics: string[]; data: string; blockNumber: string; logIndex: string; blockTimestamp?: string }

class Budget {
  left = MAX_REQUESTS;
  used: Record<string, number> = {};
  take(method: string): boolean {
    if (this.left <= 0) return false;
    this.left--;
    this.used[method] = (this.used[method] ?? 0) + 1;
    return true;
  }
}

async function rpc<T>(method: string, params: unknown[], budget: Budget): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  if (!budget.take(method)) return { ok: false, error: 'request budget exhausted' };
  try {
    const res = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.error) return { ok: false, error: JSON.stringify(data.error).slice(0, 200) };
    return { ok: true, result: data.result as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'fetch failed' };
  }
}

/** Every log for a topic, splitting the range on error or a full page. */
async function getAllLogs(topic: string, from: number, to: number, budget: Budget): Promise<RawLog[] | null> {
  const out: RawLog[] = [];
  const stack: Array<[number, number]> = [[from, to]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (lo > hi) continue;
    const r = await rpc<RawLog[]>('eth_getLogs', [{
      address: STAKING_CONTRACT,
      topics: [topic],
      fromBlock: '0x' + lo.toString(16),
      toBlock: '0x' + hi.toString(16),
    }], budget);
    if (!r.ok && r.error === 'request budget exhausted') return null;
    if (!r.ok || (r.result?.length ?? 0) >= LOG_PAGE_LIMIT) {
      if (lo === hi) { if (!r.ok) return null; out.push(...(r.result ?? [])); continue; }
      const mid = Math.floor((lo + hi) / 2);
      stack.push([mid + 1, hi], [lo, mid]);
      continue;
    }
    out.push(...r.result);
  }
  return out;
}

async function getDailyPrices(startTs: number, endTs: number, budget: Budget): Promise<Array<[number, number]>> {
  const out: Array<[number, number]> = [];
  for (let from = startTs; from <= endTs; from += PRICE_CHUNK_DAYS * DAY) {
    const to = Math.min(endTs, from + PRICE_CHUNK_DAYS * DAY);
    if (!budget.take('prices_historical')) break;
    try {
      const res = await fetch(HIST_PRICES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          network: 'base-mainnet', address: LINGO_TOKEN,
          startTime: new Date(from * 1000).toISOString(),
          endTime: new Date(to * 1000).toISOString(),
          interval: '1d',
        }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      for (const d of json?.data ?? []) {
        const v = Number(d?.value);
        const t = Date.parse(d?.timestamp ?? '');
        if (Number.isFinite(v) && v > 0 && Number.isFinite(t)) out.push([Math.floor(t / 1000), v]);
      }
    } catch { /* a missing chunk only leaves those days forward-filled */ }
  }
  return out;
}

async function getLivePrice(budget: Budget): Promise<number | null> {
  if (!budget.take('prices_live')) return null;
  try {
    const res = await fetch(PRICES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [{ network: 'base-mainnet', address: LINGO_TOKEN }] }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const usd = (json?.data?.[0]?.prices ?? []).find((p: { currency?: string }) => p?.currency === 'usd');
    const price = Number(usd?.value);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch { return null; }
}

async function rebuild(): Promise<Snapshot> {
  const budget = new Budget();
  const headRes = await rpc<string>('eth_blockNumber', [], budget);
  if (!headRes.ok) throw new Error(`head: ${headRes.error}`);
  const head = parseInt(headRes.result, 16);
  const headBlock = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [headRes.result, false], budget);
  const headTs = headBlock.ok ? parseInt(headBlock.result.timestamp, 16) : Math.floor(Date.now() / 1000);

  const [stakedLogs, closeLogs] = await Promise.all([
    getAllLogs(STAKED_TOPIC, 0, head, budget),
    getAllLogs(CLOSE_TOPIC, 0, head, budget),
  ]);
  if (!stakedLogs || !closeLogs) throw new Error('Request budget exhausted before the full history was read');

  // Alchemy returns blockTimestamp on every log; estimate from the head only if absent.
  let estimated = 0;
  const tsOf = (log: RawLog) => {
    if (log.blockTimestamp) return parseInt(log.blockTimestamp, 16);
    estimated++;
    return headTs - (head - parseInt(log.blockNumber, 16)) * BLOCK_SECONDS;
  };
  const stakes: StakeEvent[] = [];
  for (const log of stakedLogs) {
    if (log.data.length < 130) continue;
    stakes.push({
      block: parseInt(log.blockNumber, 16),
      logIndex: parseInt(log.logIndex, 16),
      ts: tsOf(log),
      user: '0x' + log.topics[1].slice(26).toLowerCase(),
      amount: BigInt('0x' + log.data.slice(2, 66)),
      duration: BigInt('0x' + log.data.slice(66, 130)).toString(),
    });
  }
  const closes: CloseEvent[] = [];
  for (const log of closeLogs) {
    if (log.data.length < 130) continue;
    closes.push({
      block: parseInt(log.blockNumber, 16),
      logIndex: parseInt(log.logIndex, 16),
      ts: tsOf(log),
      user: '0x' + log.topics[1].slice(26).toLowerCase(),
      amount: BigInt('0x' + log.data.slice(2, 66)),
      unlockBlock: Number(BigInt('0x' + log.data.slice(66, 130))),
    });
  }

  const firstTs = stakes.reduce((m, s) => Math.min(m, s.ts), headTs);
  const [dailyPrices, livePrice, balRes] = await Promise.all([
    getDailyPrices(dayOf(firstTs) * DAY, headTs, budget),
    getLivePrice(budget),
    rpc<string>('eth_call', [{
      to: LINGO_TOKEN,
      data: '0x70a08231' + STAKING_CONTRACT.replace('0x', '').padStart(64, '0'),
    }, 'latest'], budget),
  ]);
  const onChainWei = balRes.ok && balRes.result && balRes.result !== '0x' ? BigInt(balRes.result) : null;

  return computeMetrics({
    stakes, closes, head, headTs, dailyPrices, livePrice, onChainWei,
    timestampsEstimated: estimated,
    requests: budget.used,
  });
}

// ─── Snapshot storage ────────────────────────────────────────────────────

async function readSnapshot(): Promise<{ data: Snapshot | null; error: boolean }> {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const match = token.match(/^vercel_blob_rw_([^_]+)_/);
  if (match) {
    try {
      const res = await fetch(`https://${match[1]}.public.blob.vercel-storage.com/${SNAPSHOT_KEY}`);
      if (res.ok) return { data: (await res.json()) as Snapshot, error: false };
      if (res.status === 404) return { data: null, error: false };
    } catch { /* fall through to list() */ }
  }
  try {
    const { blobs } = await list({ prefix: SNAPSHOT_KEY });
    if (blobs.length === 0) return { data: null, error: false };
    const res = await fetch(blobs[0].url);
    if (!res.ok) return { data: null, error: true };
    return { data: (await res.json()) as Snapshot, error: false };
  } catch {
    return { data: null, error: !token ? false : true };
  }
}

async function saveSnapshot(s: Snapshot): Promise<boolean> {
  try {
    await put(SNAPSHOT_KEY, JSON.stringify(s), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json', cacheControlMaxAge: 60,
    });
    return true;
  } catch { return false; }
}

// ─── Handler ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ALCHEMY_API_KEY) return res.status(200).json({ configured: false, error: 'ALCHEMY_API_KEY not set' });

  const isCron = !CRON_SECRET || req.headers.authorization === `Bearer ${CRON_SECRET}`;
  const pw = (req.headers['x-admin-password'] as string | undefined) ?? (req.query.password as string | undefined);
  const isAdmin = !!ADMIN_PASSWORD && pw === ADMIN_PASSWORD;
  const wantsRebuild = req.query.rebuild === '1';
  if (wantsRebuild && !isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const stored = await readSnapshot();
    if (stored.error) {
      // Serving nothing beats rebuilding on every request during a Blob outage.
      return res.status(503).json({ error: 'Snapshot unreadable — try again shortly' });
    }
    const current = stored.data?.version === SNAPSHOT_VERSION ? stored.data : null;
    const ageMs = current ? Date.now() - Date.parse(current.generatedAt) : Infinity;
    const tooSoon = ageMs < REBUILD_MIN_AGE_MS;
    const needRebuild = !current || ageMs > STALE_AFTER_MS || (wantsRebuild && !tooSoon);

    if (!needRebuild && current) {
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
      return res.status(200).json({ ...current, served: 'stored', ...(wantsRebuild ? { rebuildSkipped: `last rebuild ${Math.round(ageMs / 60000)} min ago` } : {}) });
    }

    const t0 = Date.now();
    const snapshot = await rebuild();
    const saved = await saveSnapshot(snapshot);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json({ ...snapshot, served: 'rebuilt', stored: saved, buildMs: Date.now() - t0 });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
