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
 * LOCK STATUS. Every "locked" figure the page shows (Locked KPI, lock-duration
 * charts, lock tiers, top stakers) treats a lock as ending when it was designed
 * to: stake time + duration × the block time it was sized for (2s; 200ms for
 * the ×10 re-sized options). Since Base's switch to 200ms blocks on 2026-11-05
 * the contract releases positions ~10× sooner, but the Lingo app keeps the
 * original lock terms, and so does this page. What the contract actually
 * allows is reported separately in `unlockSchedule` (API only, not shown).
 *
 * PRICES. Stakes are valued in USD (tiers) with the LINGO/WETH pool's daily
 * VWAP, read from the summary /api/pool-prices stores (its cron runs at 00:05,
 * this one at 00:10). Alchemy's LINGO price history disagreed with the pool by
 * 1.6–2.7× in Jan–Mar 2026, so it is asked only for days after the pool series
 * ends, or for every day if the series can't be read. The current month is
 * still valued at Alchemy's live price.
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
const POOL_PRICES_KEY = 'pool-prices-v1/summary.json';   // written by api/pool-prices.ts
const POOL_HOURLY_KEY = 'pool-prices-v1/hourly.json';     // same, hourly from Feb 2026
// Bump when the snapshot shape changes: a stored snapshot of another version
// is treated as missing, so the next request rebuilds instead of serving a
// shape the page no longer reads.
const SNAPSHOT_VERSION = 5;   // 3: Mythic tier · 4: tiers as the Lingo app computes them · 5: its exact rule (lock types, OTC boost)
const MAX_REQUESTS = 160;
const LOG_PAGE_LIMIT = 9500;
// Lock options were sized for 2s blocks: used only to name them and to say
// when a lock was meant to end. Real unlock times come from the block clock.
const DESIGN_SECONDS_PER_BLOCK = 2;
const DAY = 86_400;
const REBUILD_MIN_AGE_MS = 2 * 60 * 60 * 1000;
const STALE_AFTER_MS = 30 * 60 * 60 * 1000;
const TOP_STAKERS = 100;
const PRICE_CHUNK_DAYS = 360;       // the historical endpoint allows 1 year at 1d

// ── Base block clock ──
// Base made a block every 2s from genesis, and every 200ms from block
// 53,556,128 (2026-11-05 18:00:01 UTC). Convert between blocks and time with
// these, never with a fixed seconds-per-block. If Base changes block time
// again, add a segment here — and in every api/ file (they can't share code).
const BASE_CLOCK = [
  { block: 0, ts: 1_686_789_347, msPerBlock: 2_000 },
  { block: 53_556_127, ts: 1_793_901_601, msPerBlock: 200 },
] as const;
/** Timestamp (unix seconds) of a block, past or future. */
function blockToTs(block: number): number {
  let s: (typeof BASE_CLOCK)[number] = BASE_CLOCK[0];
  for (const seg of BASE_CLOCK) if (block >= seg.block) s = seg;
  return s.ts + Math.floor(((block - s.block) * s.msPerBlock) / 1000);
}
/** The block produced at (or just before) a unix-seconds time. */
function tsToBlock(ts: number): number {
  let s: (typeof BASE_CLOCK)[number] = BASE_CLOCK[0];
  for (const seg of BASE_CLOCK) if (ts >= seg.ts) s = seg;
  return Math.max(0, s.block + Math.floor(((ts - s.ts) * 1000) / s.msPerBlock));
}

// ─── Classification ──────────────────────────────────────────────────────

export type Bucket = 'flexible' | '3mo' | '6mo' | '12mo' | 'other';
const BUCKETS: Bucket[] = ['flexible', '3mo', '6mo', '12mo', 'other'];
// On 2026-11-10 (block 55,595,822) the owner re-sized every lock option ×10
// for 200ms blocks. Each new value is the same option as its 2s-era original.
const RESIZED_FOR_200MS: Record<string, string> = {
  '12960000': '1296000', '38880000': '3888000', '77760000': '7776000', '155520000': '15552000',
  '302832000': '30283200', '9936000': '993600', '4320000': '432000', '864000': '86400',
};
/** The 2s-era option a duration stands for: re-sized values map back to their original. */
const canonical = (duration: string) => RESIZED_FOR_200MS[duration] ?? duration;
const BUCKET_BY_DURATION: Record<string, Bucket> = {
  '0': 'flexible', '3888000': '3mo', '7776000': '6mo', '15552000': '12mo',
};
/** 1-month, 24-month and odd promo/test durations are too small to chart on their own. */
const bucketOf = (duration: string): Bucket => BUCKET_BY_DURATION[canonical(duration)] ?? 'other';

// Tier labels LockBreakdownCard expects. api/stake-lock-breakdown.ts serves this snapshot's lockBreakdown as-is.
const DURATION_LABELS: Record<string, string> = {
  '0': 'Flexible', '1296000': '1 Month', '3888000': '3 Months',
  '7776000': '6 Months', '15552000': '12 Months', '30283200': '24 Months',
};
/**
 * Seconds per block a lock length was sized for: 200ms for the re-sized
 * options (and anything past 30,283,200 blocks, the longest 2s option), else 2s.
 */
const designSecondsPerBlock = (duration: string) =>
  duration in RESIZED_FOR_200MS || Number(duration) > 30_283_200 ? 0.2 : DESIGN_SECONDS_PER_BLOCK;
function labelOf(raw: string): string {
  const duration = canonical(raw);
  const known = DURATION_LABELS[duration];
  if (known) return known;
  const days = Number(duration) * designSecondsPerBlock(duration) / DAY;
  return days > 0 ? `${days < 1 ? days.toFixed(1) : days.toFixed(0)}d (other)` : 'Flexible';
}

// Membership tiers, exclusive bands (same cut-offs as the app and TierGrowthTable).
// Mythic is the only one with a lock condition: at least $15k of the wallet's
// LINGO in a lock of 12 months or longer that is still running (as designed).
// A wallet that doesn't qualify falls to its band by total staked.
export type Tier = 'below' | 'member' | 'holder' | 'elite' | 'legend' | 'mythic';
const TIERS: Tier[] = ['below', 'member', 'holder', 'elite', 'legend', 'mythic'];
const MYTHIC_USD = 15_000;
/** A 12-month lock or longer (24 months), by its original option. */
const isYearLock = (duration: string) => duration !== '0' && Number(duration) * designSecondsPerBlock(duration) >= 360 * DAY;
/**
 * TIERS AS THE LINGO APP COMPUTES THEM — staking-api LingoTierService.calculateTier
 * and StakesService.getStakedUsdByLockEffectiveExcludePhantom (lingo-monorepo,
 * origin/dev 2026-11-14), checked against its production database. Tiers are
 * stake-only (the 60-day score is no longer used). Each open stake has a FIXED
 * USD value = amount × price, where price is:
 *   - staked before 2026-01-01:                   $0.01 (SCORES_AND_TIERS_PRE_CUTOFF_PRICE)
 *   - 2026-01-01 up to block 41,932,126 (Feb 9):  $0.010105 (what the app stored: its price feed was stuck)
 *   - after:                                      the market price when staked (the app stores
 *                                                 CoinGecko's; here the pool's hourly VWAP)
 * × 1.25 for OTC purchases staked Sep 29 – Oct 10 or Oct 26 18:00 – Nov 9 18:00, 2026.
 * A tier counts only stakes whose lock option is long enough (by lock type, even
 * after the lock has run out): Member/Holder/Elite 3 months+, Legend 6 months+,
 * Mythic 12 months. Flexible, 1-month, promo and 24-month stakes count for no tier
 * (the app maps 30,283,200 blocks to noLock). Free-box stakes are app-only.
 */
const APP_FLAT_UNTIL_TS = 1_767_225_600;          // 2026-01-01T00:00:00Z
const APP_FLAT_PRICE = 0.01;
const APP_FROZEN_UNTIL_BLOCK = 41_932_126;
const APP_FROZEN_PRICE = 0.010105;
const OTC_BOOST = 1.25;
// The boost windows have closed, so the boosted stakes are a fixed set: the app's
// otc_purchases.stake_hash in those windows (first 16 hex digits, unique among all stakes).
const OTC_BOOSTED_TX_PREFIXES = new Set([
  'e6bc12290b21749b', '3d521a5c1e11958c', 'cdd7dd140305d618', '27a0b71c9b9daac8', 'e278014bf5f1426d', '1351ff7a8ab3a1b2', '12054ff041247907', '5d9e3a6f6e455cf3',
  '863e24692fb2b90b', 'e53d39ac0db3a222', '9589afd41aec4831', 'dd2585462c8eb19a', '383bb533be883560', '9053bd6526dd33d1', '818517e452610211', '7ba9d028dffff363',
  '14216164725516d2', '801be412cd591ccc', '13e4c4ade80425c4', 'd79f3c6745be79a0', '19484264e6c4ab71', '205220f0e6b3b132', '440f55904a5aded4', 'e04d07efd3122532',
  'fa4a3234b2865673', '02d9ba5c23c775b8', '3f9247113bfce03b', '8a0714c308d356cc', '4d292cd136d5144f', '92721ddc89766600', 'fca5b24960aef355', 'e59fde4eef670636',
  'b30e8563a6e0fb2a', 'b6a425196666a929', '2f00a2a957fe9aaf', '1b4e0dc426f42e52', '2f4839b8d678a83c', '79af7375005fd1d4', '95ceec7f151f422e', '83787c3c8e57e42e',
  '9e46314d3d3a22a7', 'cc56d14760ccb394', '13266944d393b5d2', 'b9155645f52b4872', 'db4a1b4aadf6a89b', 'bdb8332fa4833d3b', '75d5720a449638ae', '87bd85edae4c8c84',
  '7df691102bbc902e', '82848c31f6172170', '99b0346b8503b581', '1a595201944c50e7', '224496ed1303426c', '41a2569c2ab9bd3d', 'e52bc8a63d7ae5c6', '703d3e81b4281ca5',
  '9a1dd82058ed0bfa', 'd6a449ae5efa6e6f', 'e832831ecfda1bd8', 'bbab9c7b5b3f4905', '10883231c012fcc4', '306ab96b2b999226', '7fb1ce0a4e86e4cf', '5ce3cb0366dd7262',
  '26f4d53be8430df4', '59d820a7abe5ffe6', '5e86d1b5d067760d', '51a75638f9c21198', 'c07b98db6b425b1b', '0539f34ea66ae7f1', '28fd13c1403be051', '7230e86645968c03',
  '8e0cb2a9feb0b113', 'a048f285ab5d397a', 'd38a4bb912528123', 'd3c197f1b5a4185c', '984f461cec91543e', '58afe7cf2633c267', '60f8c15a44e4706a', 'bf25d7addc1200f1',
  'ca8ab511d6971183', 'bd841e1dc699156b', '8776424454cd9502', '386c5f5ae6061cad', '3c919e75e641c2cf', 'fa6b02bf1b393be3', 'c5ee7a265dc31697', 'd5fea5d73071e088',
  '2f45df5161262009', 'd9cccd6a428919f2', '39932f4b7ae52310', '9db84c07591e3213', '847ce482226de889', '007d304ea4b9eb3d', '2d8dc43c7d7f29b0', 'aa35c8260721a00c',
  '1c8b732859932cc5', '0dedcabc65f8733b', '8dd17f49026500ea', 'b215f2b20f669a89', 'ac5dbb65283e72d1', 'cf50bab3478b9f22', 'add74c24383e8215', '5476e5a1e9204129',
  '6e97600c54825629', '19f6663d2ce22386', 'e590aa33015b48a6', '24b3507fa4b5b904', '0ef7c7e2fe10c4bf', 'c688852f9fff862e', '30ad60dc63a3accc', '571fa956d2fb758d',
  'ff83ece01e52f176', 'a807e3311a471ddb', '1ce2129cdf028c44', 'e59d610ee5f386b3', '1f738e90f1e9dfdf', 'e18d21db7a9b9ced', '8655d4331f6dc87a', 'a8c3dd45fb47f653',
  'fe96c080ba3ce9fe', '7de34a44135de3b2', '9061e53731339802', '41fbbf64a479c7da', '13257c39ce61d917', 'e0d7bc2a946fa424', '12b6489d18cb7617', '972117d1440c449f',
  'f66543b2b563cfe3', 'a15a3e3b5d609822', '9243067b54e453e3', '8d235abb221749f5', '28571029b98f22a1', 'b8a8588e7388d062', 'f322df3c14cb9e4a', '85bccf570fbfa8a3',
  '98698f831800c922', 'a988c95850c8c8fd', 'c5818232aaa9fa56', '8b8bfeb59683b405', '7b82db811cb92385', '33e07686ff250b9a', 'a82f246ed3679bcc', '05748b05a81cda1f',
  'ed238779ea1fed5d', '43af50e65efac636', 'efb744a210ab6279', 'e3d0c9dcebb431e7', 'b27842fda87319bb', '1aa1cdc1f11650c3', 'e6f5aee468950e74', '9c54737ff6d7cb56',
  'b807cb94117033c3', '0099af37229dc29f', 'aa4993c35049c2ff', '3f62f08388d2915c', '29c65a006eece5d8', 'd4df72320870a3ae', 'a00571935960347e', 'b841ab0bb2766319',
  'c74b79c809ca07a8', 'd889cf66c1dd0a04', '2b4ff4a4f23489bf', 'aa6b9c1b559aab3c', '51de4e2a04853f21', '04a48a92552526b8', '317bc70343dd2bcd', '421756e28cee9dfc',
  'f13f7811b5a10141', '12ce185b238f5169', 'd75062b1d06d722a', '313386829dca25c7', '96489f1268e7bfca', '46bfa1420c50fc48', '67794588b17c65e1', '2c1b6696a1c6772e',
  '47587d54ad68d00b', 'ad43a6840a18d4a6', 'e95a5953415efbe2', 'a4e0a15405edb15b', 'b4a6c5d3a1f0e96e', '056a1afdd04a3027', '8117ed014e2b0ad6', '4dadbe8cdf2dda2b',
  'c23db038ef38809f', '6fb8920d376ed541', 'f98861231f180aa1', '08e30448e8f1b953', 'f400c0d3c79bdfa9', '5120c193821b5c76', '10519332edc3a5e0', '787da5260c16cf63',
  'c4dc4cc97536bdb9', '352e08b4207c8fea', '5ff1be796a4ee402', '41dbc36fd4b04863', '97e787e9d4d812c3', '88f4a33ffc4b0ed1', '4ac82807dde145c5', 'a075dba7c17e5fb9',
  '488a2e5bf403b094', 'f4fdb9bf8110d8ac', 'f6fd58450051aefe', '18017c442dc27b10', '1e3e5c5199967156', '1994fb65a7871230', '0a996f3c2e017c3b', 'ff1e78c29ab29e48',
  'e5a08ebe2ae63ce1', '1eedd64b9243219e', '89ee417598bd69ff', '85f14550c6f90e25',
]);
/** The app's lock type for an on-chain duration (its stakes.power_boost_config, re-sized ×10 included). */
const APP_LOCK_MONTHS: Record<string, 3 | 6 | 12> = {
  '3888000': 3, '38880000': 3, '7776000': 6, '77760000': 6, '15552000': 12, '155520000': 12,
};
/** Qualifying USD per tier's lock requirement: stakes with 3+, 6+ and 12-month locks. */
interface AppStake { m3: number; m6: number; m12: number }
const zeroAppStake = (): AppStake => ({ m3: 0, m6: 0, m12: 0 });
function addAppStake(into: AppStake, months: 0 | 3 | 6 | 12, usd: number) {
  if (months >= 3) into.m3 += usd;
  if (months >= 6) into.m6 += usd;
  if (months >= 12) into.m12 += usd;
}
/** The app sums exact decimals; round so a float residue can't drop a wallet below a line. */
const cents6 = (x: number) => Math.round(x * 1e6) / 1e6;
function appTierOf(s: AppStake | undefined): Tier {
  if (!s) return 'below';
  if (cents6(s.m12) >= MYTHIC_USD) return 'mythic';
  if (cents6(s.m6) >= 2500) return 'legend';
  const m3 = cents6(s.m3);
  if (m3 >= 1000) return 'elite';
  if (m3 >= 250) return 'holder';
  if (m3 >= 100) return 'member';
  return 'below';
}

function tierOf(usd: number, yearLockedUsd = 0): Tier {
  if (yearLockedUsd >= MYTHIC_USD) return 'mythic';
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
  newWalletTiersApp: Record<Tier, number>; // same, valued as the Lingo app does (see tierOf)
  lockedByBucket: Record<Bucket, number>;  // month-end, still time-locked
  totalByBucket: Record<Bucket, number>;   // month-end, locked + unlocked
  tiers: Record<Tier, number>;             // active stakers, valued at that month-end's price
  tiersNow: Record<Tier, number>;          // same balances, valued at today's price
  tiersApp: Record<Tier, number>;          // as the Lingo app computes them (see tierOf)
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
  /** poolThrough: last day the pool series covered; alchemyDays: days priced from Alchemy's feed instead. */
  price: { live: number | null; firstDay: string | null; days: number; poolThrough: string | null; alchemyDays: number };
  reconciliation: { onChainBalance: number; computedOpen: number; deltaLingo: number } | null;
  current: {
    totalStaked: number; locked: number; unlocked: number; activeStakers: number;
    byBucket: Record<Bucket, { locked: number; total: number }>;
    tiers: Record<Tier, number>;
    tiersApp: Record<Tier, number>;
    /** Wallets in each app tier right now (Member and up), for checking against the app. */
    appTierWallets: Partial<Record<Tier, string[]>>;
  };
  daily: DailyRow[];
  monthly: MonthlyRow[];
  cohorts: CohortRow[];
  topStakers: Array<{ address: string; staked: number; locked: number; usd: number | null; positions: number; firstStake: string }>;
  /** What LockBreakdownCard renders; /api/stake-lock-breakdown serves it read-only. */
  lockBreakdown: {
    asOfBlock: number;
    summary: { stillLocked: number; flexibleOrUnlocked: number; totalOpen: number };
    tiers: Array<{ tier: string; durationBlocks: string; stillLocked: number; unlockedOrFlexible: number; total: number; positions: number }>;
    history: Array<{ month: string; atBlock: number; partial: boolean; total: number; locked: number; free: number; byTier: Record<string, number>; lockedByTier: Record<string, number> }>;
    reconciliation: { onChainBalance: number; computedOpen: number; deltaLingo: number; note: string } | null;
    events: { staked: number; closed: number; closedUnmatched: number };
  };
  /**
   * ON-CHAIN view, for the team (the page doesn't read it): when the contract
   * actually lets locked LINGO be withdrawn. It unlocks at a block number
   * (stake block + duration); durations were sized for 2s blocks, so since
   * Base's 200ms switch every lock ends ~10× sooner than designed. Its
   * lockedNow is therefore lower than current.locked, which is as designed.
   */
  unlockSchedule: UnlockSchedule;
}

export interface UnlockSchedule {
  /** Head timestamp minus the block clock's estimate: ~0 while the clock is right. */
  clockDriftSec: number;
  /** Locked by the contract right now (unlock block not reached). */
  lockedNow: number;
  /** Future unlocks by the Monday-starting UTC week they happen in. */
  weekly: Array<{ week: string; lingo: number; positions: number }>;
  within: { d7: number; d30: number; d60: number; d90: number };
  lastUnlock: string | null;
  /** Open positions already withdrawable that, at 2s blocks, would still be locked. */
  unlockedEarly: { lingo: number; positions: number };
  /** Positions withdrawn since the switch before their designed unlock date. */
  withdrawnEarly: { lingo: number; positions: number };
  /** Still-locked positions that will unlock more than a day before their designed date. */
  stillLockedEarly: { lingo: number; positions: number };
}

// ─── Pure computation (exported for tests) ───────────────────────────────

export interface StakeEvent { block: number; logIndex: number; ts: number; user: string; amount: bigint; duration: string; tx?: string }
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
  priceSource?: { poolThrough: string | null; alchemyDays: number };
  /** [hour start, usd] from the pool, for pricing stakes the app's way (Feb 2026 on). */
  hourlyPrices?: Array<[number, number]>;
}

/** unlockTs: when the contract releases it (real block clock). designUnlockTs: when it would have at 2s blocks. */
interface Position { n: number; amount: bigint; duration: string; unlockTs: number; designUnlockTs: number; user: string; appUsd: number; appMonths: 0 | 3 | 6 | 12 }

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
  newWalletYearLockUsd: Map<string, number>;   // first-month stakes into 12-month+ locks
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

  // ── The app's fixed price per stake ──
  const hourly = new Map<number, number>(input.hourlyPrices ?? []);
  const hourKeys = [...hourly.keys()].sort((a, b) => a - b);
  const marketPriceAt = (ts: number): number => {
    const hour = Math.floor(ts / 3600) * 3600;
    const exact = hourly.get(hour);
    if (exact != null) return exact;
    // the last hour with trades in the 6 hours before, else that day's price
    let lo = 0, hi = hourKeys.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (hourKeys[mid] <= hour) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    if (best >= 0 && hour - hourKeys[best] <= 6 * 3600) return hourly.get(hourKeys[best])!;
    return priceAt(dayOf(ts)) ?? 0;
  };
  const appPriceOf = (ev: { ts: number; block: number }) =>
    ev.ts < APP_FLAT_UNTIL_TS ? APP_FLAT_PRICE : ev.block <= APP_FROZEN_UNTIL_BLOCK ? APP_FROZEN_PRICE : marketPriceAt(ev.ts);
  const appValueOf = (ev: StakeEvent) =>
    toLingo(ev.amount) * appPriceOf(ev) * (ev.tx && OTC_BOOSTED_TX_PREFIXES.has(ev.tx.slice(2, 18).toLowerCase()) ? OTC_BOOST : 1);
  const appStake = new Map<string, AppStake>();   // per wallet: qualifying USD by lock requirement

  // ── One chronological stream ──
  type Ev = { block: number; logIndex: number; ts: number; user: string; amount: bigint; close: boolean; duration: string; unlockBlock: number };
  const events: Ev[] = [];
  for (const s of input.stakes) {
    events.push({ ...s, close: false, unlockBlock: s.block + Number(s.duration) });
  }
  for (const c of input.closes) events.push({ ...c, close: true, duration: '' });
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

  const positions = new Map<string, Position>();
  const newWalletApp = new Map<string, Map<string, AppStake>>();   // month → wallet → first-month app USD
  const balance = new Map<string, bigint>();          // only wallets with a non-zero balance
  const firstStake = new Map<string, { month: string; ts: number }>();
  const everClosed = new Set<string>();
  let totalOpen = 0n;
  let closedUnmatched = 0;
  let withdrawnEarlyWei = 0n, withdrawnEarlyN = 0;

  const flows = new Map<string, Flow>();
  const flowOf = (month: string): Flow => {
    let f = flows.get(month);
    if (!f) {
      f = {
        staked: zeroBuckets(() => 0n), stakeEvents: 0, stakers: new Set(),
        unstaked: 0n, unstakeEvents: 0, newWallets: 0, newLingo: 0n, firstStakeLingo: 0n,
        returning: new Set(), returningLingo: 0n, newWalletUsd: new Map(), newWalletYearLockUsd: new Map(),
      };
      flows.set(month, f);
    }
    return f;
  };

  const daily: DailyRow[] = [];
  let dayStaked = 0n, dayUnstaked = 0n;
  const monthEnds: Array<{ month: string; partial: boolean; atTs: number; price: number | null;
    total: bigint; locked: bigint; byLabel: Map<string, { locked: bigint; total: bigint; positions: number }>;
    active: number; tiers: Record<Tier, number>; tiersNow: Record<Tier, number>; tiersApp: Record<Tier, number>;
    appWallets: Map<string, Tier> | null; cohortActive: Map<string, number> }> = [];

  /** Everything that depends on the state at one instant: lock status, tiers, cohort survival. */
  const snapshotAt = (month: string, atTs: number, partial: boolean) => {
    const price = partial ? currentPrice : priceAt(dayOf(atTs - 1));
    const byLabel = new Map<string, { locked: bigint; total: bigint; positions: number }>();
    const yearLocked = new Map<string, bigint>();   // per wallet, for Mythic
    let locked = 0n;
    for (const p of positions.values()) {
      const amt = p.amount * BigInt(p.n);
      if (isYearLock(p.duration) && p.designUnlockTs > atTs) yearLocked.set(p.user, (yearLocked.get(p.user) ?? 0n) + amt);
      // One row per lock option, as before the re-size (keyed by its original duration).
      let e = byLabel.get(canonical(p.duration));
      if (!e) { e = { locked: 0n, total: 0n, positions: 0 }; byLabel.set(canonical(p.duration), e); }
      e.total += amt;
      e.positions += p.n;
      // Flexible is never locked; everything else is locked until its lock ends
      // as designed (see LOCK STATUS in the header), not at the on-chain unlock block.
      if (p.duration !== '0' && p.designUnlockTs > atTs) { e.locked += amt; locked += amt; }
    }
    const tiers = zeroTiers();
    const tiersNow = zeroTiers();
    const tiersApp = zeroTiers();
    const appWallets = partial ? new Map<string, Tier>() : null;   // who is in which tier, for the head only
    const cohortActive = new Map<string, number>();
    for (const [user, bal] of balance) {
      const lingo = toLingo(bal);
      const yearLingo = toLingo(yearLocked.get(user) ?? 0n);
      if (price != null) tiers[tierOf(lingo * price, yearLingo * price)]++;
      if (currentPrice != null) tiersNow[tierOf(lingo * currentPrice, yearLingo * currentPrice)]++;
      const at = appTierOf(appStake.get(user));
      tiersApp[at]++;
      if (appWallets && at !== 'below') appWallets.set(user, at);
      const c = firstStake.get(user)!.month;
      cohortActive.set(c, (cohortActive.get(c) ?? 0) + 1);
    }
    monthEnds.push({ month, partial, atTs, price, total: totalOpen, locked, byLabel, active: balance.size, tiers, tiersNow, tiersApp, appWallets, cohortActive });
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
      const evAppUsd = appValueOf(ev);
      const evAppMonths = APP_LOCK_MONTHS[ev.duration] ?? 0;
      if (first.month === month) {
        f.newLingo += ev.amount;
        let nm = newWalletApp.get(month);
        if (!nm) { nm = new Map(); newWalletApp.set(month, nm); }
        const nw = nm.get(ev.user) ?? zeroAppStake();
        addAppStake(nw, evAppMonths, evAppUsd);
        nm.set(ev.user, nw);
        const p = priceAt(d);
        if (p != null) f.newWalletUsd.set(ev.user, (f.newWalletUsd.get(ev.user) ?? 0) + toLingo(ev.amount) * p);
        if (p != null && isYearLock(ev.duration)) f.newWalletYearLockUsd.set(ev.user, (f.newWalletYearLockUsd.get(ev.user) ?? 0) + toLingo(ev.amount) * p);
      } else {
        f.returning.add(ev.user);
        f.returningLingo += ev.amount;
      }

      const key = `${ev.user}|${ev.unlockBlock}|${ev.amount}`;
      const pos = positions.get(key);
      if (pos) pos.n++;
      else positions.set(key, {
        n: 1, amount: ev.amount, duration: ev.duration, user: ev.user,
        unlockTs: blockToTs(ev.unlockBlock),
        designUnlockTs: ev.ts + Number(ev.duration) * designSecondsPerBlock(ev.duration),
        appUsd: evAppUsd, appMonths: evAppMonths,
      });
      balance.set(ev.user, (balance.get(ev.user) ?? 0n) + ev.amount);
      if (evAppMonths) {
        const a = appStake.get(ev.user) ?? zeroAppStake();
        addAppStake(a, evAppMonths, evAppUsd);
        appStake.set(ev.user, a);
      }
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
      if (pos.duration !== '0' && pos.designUnlockTs > ev.ts) { withdrawnEarlyWei += ev.amount; withdrawnEarlyN++; }
      if (--pos.n === 0) positions.delete(key);
      const a = appStake.get(ev.user);
      if (a && pos.appMonths) addAppStake(a, pos.appMonths, -pos.appUsd);
      const bal = (balance.get(ev.user) ?? 0n) - ev.amount;
      if (bal > 0n) balance.set(ev.user, bal);
      else { balance.delete(ev.user); appStake.delete(ev.user); }
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
    for (const [user, usd] of f.newWalletUsd) newWalletTiers[tierOf(usd, f.newWalletYearLockUsd.get(user) ?? 0)]++;
    const newWalletTiersApp = zeroTiers();
    for (const v of newWalletApp.get(month)?.values() ?? []) newWalletTiersApp[appTierOf(v)]++;
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
      newWalletTiersApp,
      lockedByBucket: Object.fromEntries(BUCKETS.map(b => [b, round(lockedByBucket[b])])) as Record<Bucket, number>,
      totalByBucket: Object.fromEntries(BUCKETS.map(b => [b, round(totalByBucket[b])])) as Record<Bucket, number>,
      tiers: e?.tiers ?? zeroTiers(),
      tiersNow: e?.tiersNow ?? zeroTiers(),
      tiersApp: e?.tiersApp ?? zeroTiers(),
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
    if (p.duration !== '0' && p.designUnlockTs > headTs) lockedByUser.set(p.user, (lockedByUser.get(p.user) ?? 0n) + p.amount * BigInt(p.n));
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
  const blockAtTs = (ts: number) => Math.min(head, tsToBlock(ts));
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

  // ── Unlock schedule ──
  const weekOf = (ts: number) => {
    const d = new Date(ts * 1000);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
  };
  const weeks = new Map<string, { wei: bigint; positions: number }>();
  const within = { d7: 0n, d30: 0n, d60: 0n, d90: 0n };
  let onChainLockedWei = 0n, unlockedEarlyWei = 0n, unlockedEarlyN = 0, stillEarlyWei = 0n, stillEarlyN = 0, lastUnlockTs = 0;
  for (const p of positions.values()) {
    if (p.duration === '0') continue;
    const amt = p.amount * BigInt(p.n);
    if (p.unlockTs <= headTs) {
      if (p.designUnlockTs > headTs) { unlockedEarlyWei += amt; unlockedEarlyN += p.n; }
      continue;
    }
    onChainLockedWei += amt;
    const w = weeks.get(weekOf(p.unlockTs)) ?? { wei: 0n, positions: 0 };
    w.wei += amt; w.positions += p.n;
    weeks.set(weekOf(p.unlockTs), w);
    const left = p.unlockTs - headTs;
    if (left <= 7 * DAY) within.d7 += amt;
    if (left <= 30 * DAY) within.d30 += amt;
    if (left <= 60 * DAY) within.d60 += amt;
    if (left <= 90 * DAY) within.d90 += amt;
    if (p.designUnlockTs > p.unlockTs + DAY) { stillEarlyWei += amt; stillEarlyN += p.n; }
    lastUnlockTs = Math.max(lastUnlockTs, p.unlockTs);
  }
  const unlockSchedule: UnlockSchedule = {
    clockDriftSec: headTs - blockToTs(head),
    lockedNow: round(toLingo(onChainLockedWei)),   // on-chain; current.locked is as designed
    weekly: [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, w]) => ({ week, lingo: round(toLingo(w.wei)), positions: w.positions })),
    within: { d7: round(toLingo(within.d7)), d30: round(toLingo(within.d30)), d60: round(toLingo(within.d60)), d90: round(toLingo(within.d90)) },
    lastUnlock: lastUnlockTs ? new Date(lastUnlockTs * 1000).toISOString().slice(0, 10) : null,
    unlockedEarly: { lingo: round(toLingo(unlockedEarlyWei)), positions: unlockedEarlyN },
    withdrawnEarly: { lingo: round(toLingo(withdrawnEarlyWei)), positions: withdrawnEarlyN },
    stillLockedEarly: { lingo: round(toLingo(stillEarlyWei)), positions: stillEarlyN },
  };

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
    price: {
      live: livePrice, firstDay: priceDays.length ? isoDay(priceDays[0]) : null, days: priceDays.length,
      poolThrough: input.priceSource?.poolThrough ?? null, alchemyDays: input.priceSource?.alchemyDays ?? 0,
    },
    reconciliation,
    current: {
      totalStaked: totalNow,
      locked: lockedNow,
      unlocked: totalNow - lockedNow,
      activeStakers: balance.size,
      byBucket,
      tiers: now.tiers,
      tiersApp: now.tiersApp,
      appTierWallets: [...(now.appWallets ?? new Map<string, Tier>()).entries()].reduce<Partial<Record<Tier, string[]>>>((acc, [w, t]) => {
        (acc[t] ??= []).push(w);
        return acc;
      }, {}),
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
    unlockSchedule,
  };
}

// ─── Chain + prices ──────────────────────────────────────────────────────

interface RawLog { topics: string[]; data: string; blockNumber: string; logIndex: string; blockTimestamp?: string; transactionHash?: string }

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

interface PoolPricesSummary { version: number; generatedAt: string; complete: boolean; days: Array<[string, number]> }

/**
 * Daily LINGO/USD from the pool's trades ([dayStartTs, usd]), and the last day
 * the series covers: the day it was generated, since it lists only days with
 * trades. Null if it hasn't been built or can't be read.
 */
/** The pool's hourly prices (api/pool-prices.ts), for valuing stakes the app's way. */
async function getPoolHourly(): Promise<Array<[number, number]>> {
  const { data } = await readBlobJson<{ version: number; hours?: Array<[number, number]> }>(POOL_HOURLY_KEY);
  return data?.version === 1 && Array.isArray(data.hours) ? data.hours.filter(([h, p]) => Number.isFinite(h) && p > 0) : [];
}

async function getPoolPrices(): Promise<{ days: Array<[number, number]>; throughDay: number } | null> {
  const { data } = await readBlobJson<PoolPricesSummary>(POOL_PRICES_KEY);
  if (data?.version !== 1 || !data.complete || !Array.isArray(data.days)) return null;
  const days: Array<[number, number]> = [];
  for (const [day, usd] of data.days) {
    const ts = Date.parse(`${day}T00:00:00Z`) / 1000;
    if (Number.isFinite(ts) && Number.isFinite(usd) && usd > 0) days.push([ts, usd]);
  }
  const generatedMs = Date.parse(data.generatedAt);
  if (!days.length || !Number.isFinite(generatedMs)) return null;
  return { days, throughDay: dayOf(generatedMs / 1000) };
}

/** Alchemy's LINGO/USD history — only for days the pool series doesn't cover. */
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
  // A block 200ms old can still be unknown to the node: then fall back to the clock, not a crash.
  const headTs = headBlock.ok && headBlock.result ? parseInt(headBlock.result.timestamp, 16) : blockToTs(head);
  if (headBlock.ok && headBlock.result && Math.abs(headTs - blockToTs(head)) > 900) {
    throw new Error(`Base block clock is off by ${headTs - blockToTs(head)}s at block ${head}: block time changed again — add a BASE_CLOCK segment`);
  }

  // One stream after the other, not in parallel: the account's throughput
  // limit is shared with the Lingo app itself, so this daily job shouldn't
  // burst. Costs a few extra seconds once a day.
  const stakedLogs = await getAllLogs(STAKED_TOPIC, 0, head, budget);
  if (!stakedLogs) throw new Error('Request budget exhausted before the full history was read');
  const closeLogs = await getAllLogs(CLOSE_TOPIC, 0, head, budget);
  if (!stakedLogs || !closeLogs) throw new Error('Request budget exhausted before the full history was read');

  // Alchemy returns blockTimestamp on every log; estimate from the head only if absent.
  let estimated = 0;
  const tsOf = (log: RawLog) => {
    if (log.blockTimestamp) return parseInt(log.blockTimestamp, 16);
    estimated++;
    return blockToTs(parseInt(log.blockNumber, 16));
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
      tx: log.transactionHash,
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

  // Pool prices wherever they reach; Alchemy's feed only past their end, or for
  // everything if they can't be read. Days before the pool's first trade had
  // no market at all and take its first price, as they did with Alchemy's.
  const firstTs = stakes.reduce((m, s) => Math.min(m, s.ts), headTs);
  const pool = await getPoolPrices();
  const hourlyPrices = await getPoolHourly();
  const gapFromDay = pool ? pool.throughDay + 1 : dayOf(firstTs);
  const [alchemyPrices, livePrice, balRes] = await Promise.all([
    gapFromDay <= dayOf(headTs) ? getDailyPrices(gapFromDay * DAY, headTs, budget) : Promise.resolve([]),
    getLivePrice(budget),
    rpc<string>('eth_call', [{
      to: LINGO_TOKEN,
      data: '0x70a08231' + STAKING_CONTRACT.replace('0x', '').padStart(64, '0'),
    }, 'latest'], budget),
  ]);
  const onChainWei = balRes.ok && balRes.result && balRes.result !== '0x' ? BigInt(balRes.result) : null;
  const fallbackPrices = alchemyPrices.filter(([ts]) => dayOf(ts) >= gapFromDay);

  return computeMetrics({
    stakes, closes, head, headTs, livePrice, onChainWei,
    dailyPrices: [...(pool?.days ?? []), ...fallbackPrices],
    priceSource: { poolThrough: pool ? isoDay(pool.throughDay) : null, alchemyDays: new Set(fallbackPrices.map(([ts]) => dayOf(ts))).size },
    hourlyPrices,
    timestampsEstimated: estimated,
    requests: budget.used,
  });
}

// ─── Snapshot storage ────────────────────────────────────────────────────

/** A public Blob's JSON. error: it may exist but couldn't be read. */
async function readBlobJson<T>(key: string): Promise<{ data: T | null; error: boolean }> {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const match = token.match(/^vercel_blob_rw_([^_]+)_/);
  if (match) {
    try {
      const res = await fetch(`https://${match[1]}.public.blob.vercel-storage.com/${key}`);
      if (res.ok) return { data: (await res.json()) as T, error: false };
      if (res.status === 404) return { data: null, error: false };
    } catch { /* fall through to list() */ }
  }
  try {
    const { blobs } = await list({ prefix: key });
    if (blobs.length === 0) return { data: null, error: false };
    const res = await fetch(blobs[0].url);
    if (!res.ok) return { data: null, error: true };
    return { data: (await res.json()) as T, error: false };
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
  // A ?rebuild=1 reply must never be cached at the edge: a cached 'skipped' reply
  // would swallow the next real rebuild request (the cron's included).
  const cache = (v: string): void => { res.setHeader('Cache-Control', wantsRebuild ? 'no-store' : v); };
  if (wantsRebuild && !isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const stored = await readBlobJson<Snapshot>(SNAPSHOT_KEY);
    if (stored.error) {
      // Serving nothing beats rebuilding on every request during a Blob outage.
      return res.status(503).json({ error: 'Snapshot unreadable — try again shortly' });
    }
    const current = stored.data?.version === SNAPSHOT_VERSION ? stored.data : null;
    const ageMs = current ? Date.now() - Date.parse(current.generatedAt) : Infinity;
    const tooSoon = ageMs < REBUILD_MIN_AGE_MS;
    const needRebuild = !current || ageMs > STALE_AFTER_MS || (wantsRebuild && !tooSoon);

    if (!needRebuild && current) {
      cache('s-maxage=300, stale-while-revalidate=3600');
      return res.status(200).json({ ...current, served: 'stored', ...(wantsRebuild ? { rebuildSkipped: `last rebuild ${Math.round(ageMs / 60000)} min ago` } : {}) });
    }

    const t0 = Date.now();
    let snapshot: Snapshot;
    try {
      snapshot = await rebuild();
    } catch (error) {
      // A failed rebuild (e.g. Alchemy rate-limiting) must not turn every page
      // view into another full rebuild. Serve the last good snapshot if there
      // is one; otherwise cache the failure briefly.
      if (current) {
        cache('s-maxage=300, stale-while-revalidate=3600');
        return res.status(200).json({ ...current, served: 'stale', rebuildError: error instanceof Error ? error.message : 'Unknown error' });
      }
      cache('s-maxage=60');
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
    const saved = await saveSnapshot(snapshot);
    cache('s-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json({ ...snapshot, served: 'rebuilt', stored: saved, buildMs: Date.now() - t0 });
  } catch (error) {
    cache('s-maxage=60');
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
