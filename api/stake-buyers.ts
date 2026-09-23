import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/stake-buyers — one row per WALLET, for outreach lists.
 *
 * Aggregates the per-stake rows /api/backfill-stake-sources already produces —
 * no new chain scanning here, and no repricing: each stake keeps the USD value
 * it had on its own day.
 *
 * Attribution uses the FUNDING MIX, not the primary source. A stake that was
 * 40% bought and 60% re-staked contributes 40% of its LINGO to that wallet's
 * bought total. The summaries' "counts as this type at >=50%" rule is right
 * for a source breakdown but would drop real buyers from this list. Shares
 * below MIN_SHARE are dropped so dust can't invent a buyer.
 *
 * `total_staked_*` is the wallet's actual staked total (every stake, at face
 * value); only the per-source split is share-weighted.
 *
 * Params:
 *   days=90            look-back window (default 90, max 190)
 *   fromBlock/toBlock  explicit range instead of days
 *   minUsd=10          drop wallets below this much bought value
 *   includeDirect=1    count bought_direct (our own stake-on-behalf flow)
 *   includeProject=1   keep project-owned wallets
 *   top=N              cap the rows returned
 *   pageLimit=200      stakes per backfill page
 *   format=json|csv    default json; CSV is sorted by bought_usd desc
 *
 * Admin-gated (X-Admin-Password / ?password=) or cron secret.
 */

export const config = { maxDuration: 60 };

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
// Self-calls must use the PUBLIC production domain — VERCEL_URL sits behind
// deployment protection and returns an HTML login page.
const SELF_BASE = process.env.SELF_BASE_URL || 'https://lingo-staking-dashboard.vercel.app';

const MAX_DAYS = 190;
const BUDGET_MS = 50_000;   // leave room to build the response before maxDuration
const MAX_PAGES = 15;
const MIN_SHARE = 0.005;    // below this a share rounds to 0% — dust, not funding

/** Every source, so a wallet's mix can be shown in full. */
const ALL_SOURCES = [
  'bought', 'bought_cex', 'bought_direct', 'bridged',
  'claimed_apy', 'claimed_vesting', 'claimed', 'reward', 'restaked',
  'transferred', 'transferred_bought_upstream', 'internal', 'preheld', 'unknown',
] as const;

/** Somebody chose to buy. bought_direct is added only with includeDirect. */
const BOUGHT_SOURCES = ['bought', 'bought_cex', 'transferred_bought_upstream'];

// Project-owned wallets: their stakes are treasury operations, not demand.
const PROJECT_WALLETS = new Set([
  '0xe8313a4b7a6aaea9e92a8d4acbb08034cb39bf2f', // team wallet (Safe-funded staker)
  '0x0e0bc2919540119fc22a502842a74af4d81502b6', // Treasury
  '0x0fe275fdfde7eb75a15c0ae8971450dd6f06e7f8', // Project Safe
  '0x61f8d3fc749ecda98d378bc2cc8459ba0f7dfd58', // Team Multisig
  '0x7e3e2d6b8b87ce617b7ccdd63d0f5449e4057513', // Team Buybacks
  '0x69892fc8e176d9750e7f0ca06fc9aede0fc97bcb', // Team Buybacks
  '0xc588e4415ab61aa8a9496efbe9d715de75550e2a', // Deployer
  '0x8557ef53d037408d225479dd8544dffb06c88d46', // Liquidity Locker
  '0x3ea37aa113b092dd14dfada7118efb919c092d0d', // Liquidity Locker
  '0xffc781ddfa8d1358ce8c7dda7ced1e56e922aea6', // Reward wallet
  '0x64967c0dd5605dd3efc6a9bb148b2687a532c15f', // Previous reward wallet
  '0x53a78a339262e374950c491884b0954323b616ef', // Stake-on-behalf operator
  '0x2bd8fc849f7c91ce2d3e9c78dd85792a0b14da6d', // Buy-and-stake wallet
]);

interface MixPart { source: string; lingo: number; pct: number }
interface StakeRow {
  wallet: string;
  amount: number;
  amountUsd: number | null;
  lockDuration: string;
  txHash: string;
  blockNumber: number;
  timestamp?: number | null;
  source: string;
  mix?: MixPart[];
}
interface BackfillPage {
  rows?: StakeRow[];
  range?: { fromBlock: number; toBlock: number };
  hasMore?: boolean;
  nextBeforeBlock?: number | null;
  pricingBasis?: string;
}

interface Bucket { lingo: number; usd: number }
interface WalletAgg {
  wallet: string;
  stakes: number;
  totalLingo: number;
  totalUsd: number;
  firstTs: number | null;
  lastTs: number | null;
  unpriced: number;
  bySource: Record<string, Bucket>;
  byLock: Record<string, Bucket & { stakes: number }>;
}

function selfHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (ADMIN_PASSWORD) h['X-Admin-Password'] = ADMIN_PASSWORD;
  if (CRON_SECRET) h['Authorization'] = `Bearer ${CRON_SECRET}`;
  return h;
}

/**
 * How this stake's LINGO splits across sources, as fractions summing to <= 1.
 * Tier-A classifications carry no mix — they are wholly their primary source.
 */
function shareOf(row: StakeRow): Array<[string, number]> {
  const mix = row.mix ?? [];
  const total = mix.reduce((sum, m) => sum + (m.lingo > 0 ? m.lingo : 0), 0);
  const parts: Array<[string, number]> = (mix.length && total > 0)
    ? mix.filter(m => m.lingo > 0).map(m => [m.source, m.lingo / total] as [string, number])
    : [[row.source, 1]];
  return parts.filter(([, share]) => share >= MIN_SHARE);
}

function emptyAgg(wallet: string): WalletAgg {
  return { wallet, stakes: 0, totalLingo: 0, totalUsd: 0, firstTs: null, lastTs: null, unpriced: 0, bySource: {}, byLock: {} };
}

function addStake(agg: WalletAgg, row: StakeRow): void {
  const usd = row.amountUsd ?? 0;
  agg.stakes += 1;
  // Face value: the wallet really did stake this much, whatever funded it.
  agg.totalLingo += row.amount;
  agg.totalUsd += usd;
  if (row.amountUsd == null) agg.unpriced += 1;

  const ts = typeof row.timestamp === 'number' && row.timestamp > 0 ? row.timestamp : null;
  if (ts) {
    if (agg.firstTs == null || ts < agg.firstTs) agg.firstTs = ts;
    if (agg.lastTs == null || ts > agg.lastTs) agg.lastTs = ts;
  }

  const lock = row.lockDuration || 'Unknown';
  const lb = agg.byLock[lock] ?? { lingo: 0, usd: 0, stakes: 0 };
  lb.lingo += row.amount; lb.usd += usd; lb.stakes += 1;
  agg.byLock[lock] = lb;

  for (const [source, share] of shareOf(row)) {
    const b = agg.bySource[source] ?? { lingo: 0, usd: 0 };
    b.lingo += row.amount * share;
    b.usd += usd * share;
    agg.bySource[source] = b;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const isoDay = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '');

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const header = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(','), ...rows.map(r => header.map(h => esc(r[h])).join(','))].join('\n');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = CRON_SECRET;
  const reqPassword = (req.headers['x-admin-password'] as string | undefined) ?? (req.query.password as string | undefined);
  const isCron = !cronSecret || req.headers.authorization === `Bearer ${cronSecret}`;
  const isAdmin = !!ADMIN_PASSWORD && reqPassword === ADMIN_PASSWORD;
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });

  const q = req.query as Record<string, string | undefined>;
  const days = Math.min(MAX_DAYS, Math.max(1, Number(q.days) || 90));
  const minUsd = q.minUsd != null ? Math.max(0, Number(q.minUsd) || 0) : 10;
  const includeDirect = q.includeDirect === '1';
  const includeProject = q.includeProject === '1';
  const pageLimit = Math.min(500, Math.max(25, Number(q.pageLimit) || 200));
  const top = Number(q.top) > 0 ? Number(q.top) : null;
  const format = q.format === 'csv' ? 'csv' : 'json';
  const boughtSources = includeDirect ? [...BOUGHT_SOURCES, 'bought_direct'] : BOUGHT_SOURCES;

  try {
    // ── Page the classifier, honestly reporting how far back we actually got ──
    const wallets = new Map<string, WalletAgg>();
    const startMs = Date.now();
    let pages = 0;
    let partial = false;
    let pricingBasis = '';
    let fromBlock = q.fromBlock ? parseInt(q.fromBlock, 10) : null;
    let toBlock: number | null = q.toBlock ? parseInt(q.toBlock, 10) : null;
    let cursor: number | null = toBlock;
    let coveredFromBlock: number | null = null;
    let scanned = 0;
    let more = true;

    while (more && pages < MAX_PAGES) {
      if (BUDGET_MS - (Date.now() - startMs) < 5_000) { partial = true; break; }
      pages++;
      const params = new URLSearchParams({ limit: String(pageLimit), format: 'json' });
      if (fromBlock != null) params.set('fromBlock', String(fromBlock));
      else params.set('days', String(days));
      if (cursor != null) params.set('beforeBlock', String(cursor));

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Math.min(BUDGET_MS - (Date.now() - startMs), 25_000));
      let page: BackfillPage;
      try {
        const r = await fetch(`${SELF_BASE}/api/backfill-stake-sources?${params}`, { headers: selfHeaders(), signal: ctl.signal });
        if (!r.ok) { partial = true; break; }
        page = (await r.json()) as BackfillPage;
      } catch {
        partial = true;
        break;
      } finally {
        clearTimeout(timer);
      }

      // The first page defines the window; later pages page within it.
      if (fromBlock == null && page.range) fromBlock = page.range.fromBlock;
      if (toBlock == null && page.range) toBlock = page.range.toBlock;
      if (page.pricingBasis) pricingBasis = page.pricingBasis;

      for (const row of page.rows ?? []) {
        if (!row?.wallet) continue;
        scanned++;
        const w = row.wallet.toLowerCase();
        const agg = wallets.get(w) ?? emptyAgg(w);
        addStake(agg, row);
        wallets.set(w, agg);
      }

      more = !!(page.hasMore && page.nextBeforeBlock != null);
      if (more) {
        cursor = page.nextBeforeBlock as number;
        coveredFromBlock = cursor + 1;
      } else {
        coveredFromBlock = fromBlock;
      }
    }
    if (more) partial = true; // pages or time ran out with blocks left unscanned

    // ── One row per wallet ──
    const sourceBucket = (agg: WalletAgg, s: string) => agg.bySource[s] ?? { lingo: 0, usd: 0 };
    const sum = (agg: WalletAgg, list: string[], k: 'lingo' | 'usd') =>
      list.reduce((t, s) => t + sourceBucket(agg, s)[k], 0);

    let rows = [...wallets.values()]
      .filter(agg => includeProject || !PROJECT_WALLETS.has(agg.wallet))
      .map(agg => {
        const locks = Object.entries(agg.byLock).sort((a, b) => b[1].lingo - a[1].lingo);
        const mix: Record<string, { lingo: number; usd: number; pct: number }> = {};
        for (const s of ALL_SOURCES) {
          const b = sourceBucket(agg, s);
          if (b.lingo <= 0) continue;
          mix[s] = { lingo: round2(b.lingo), usd: round2(b.usd), pct: agg.totalLingo > 0 ? Math.round((b.lingo / agg.totalLingo) * 100) : 0 };
        }
        return {
          wallet: agg.wallet,
          bought_lingo: round2(sum(agg, boughtSources, 'lingo')),
          bought_usd: round2(sum(agg, boughtSources, 'usd')),
          bought_dex_lingo: round2(sourceBucket(agg, 'bought').lingo),
          bought_dex_usd: round2(sourceBucket(agg, 'bought').usd),
          bought_cex_lingo: round2(sourceBucket(agg, 'bought_cex').lingo),
          bought_cex_usd: round2(sourceBucket(agg, 'bought_cex').usd),
          bought_upstream_lingo: round2(sourceBucket(agg, 'transferred_bought_upstream').lingo),
          bought_upstream_usd: round2(sourceBucket(agg, 'transferred_bought_upstream').usd),
          total_staked_lingo: round2(agg.totalLingo),
          total_staked_usd: round2(agg.totalUsd),
          stakes: agg.stakes,
          first_stake: isoDay(agg.firstTs),
          last_stake: isoDay(agg.lastTs),
          dominant_lock: locks.length ? locks[0][0] : '',
          lock_mix: locks.map(([label, v]) => `${label}:${v.stakes}`).join(' | '),
          mix,
          unpriced_stakes: agg.unpriced,
          basescan: `https://basescan.org/address/${agg.wallet}`,
        };
      })
      .filter(r => r.bought_usd >= minUsd)
      .sort((a, b) => b.bought_usd - a.bought_usd || b.bought_lingo - a.bought_lingo);

    // ── Summary over the wallets that made the list ──
    const boughtUsds = rows.map(r => r.bought_usd).sort((a, b) => a - b);
    const totalBoughtUsd = boughtUsds.reduce((t, v) => t + v, 0);
    const totalBoughtLingo = rows.reduce((t, r) => t + r.bought_lingo, 0);
    const desc = [...boughtUsds].reverse();
    const topShare = (n: number) => (totalBoughtUsd > 0
      ? Math.round((desc.slice(0, n).reduce((t, v) => t + v, 0) / totalBoughtUsd) * 1000) / 10
      : 0);

    const summary = {
      wallets: rows.length,
      total_bought_lingo: round2(totalBoughtLingo),
      total_bought_usd: round2(totalBoughtUsd),
      total_staked_lingo: round2(rows.reduce((t, r) => t + r.total_staked_lingo, 0)),
      total_staked_usd: round2(rows.reduce((t, r) => t + r.total_staked_usd, 0)),
      avg_bought_usd: rows.length ? round2(totalBoughtUsd / rows.length) : 0,
      median_bought_usd: round2(median(boughtUsds)),
      concentration_pct_of_bought: { top10: topShare(10), top25: topShare(25), top50: topShare(50) },
    };

    if (top != null) rows = rows.slice(0, top);

    if (format === 'csv') {
      // Flatten the mix so the CSV hides nothing: one column per source.
      const flat = rows.map(r => {
        const { mix, ...rest } = r;
        const cols: Record<string, unknown> = { ...rest };
        cols.mix_pct = ALL_SOURCES.filter(s => mix[s]).map(s => `${s}:${mix[s].pct}%`).join(' | ');
        for (const s of ALL_SOURCES) cols[`src_${s}_lingo`] = mix[s] ? mix[s].lingo : 0;
        return cols;
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="lingo-stake-buyers-${days}d.csv"`);
      return res.status(200).send(toCsv(flat));
    }

    return res.status(200).json({
      window: { days: q.fromBlock ? undefined : days, fromBlock, toBlock, coveredFromBlock },
      pricingBasis,
      attribution: `funding-mix shares, dust below ${MIN_SHARE * 100}% dropped; totals are face value`,
      excluded: {
        bought_direct: !includeDirect,
        project_wallets: !includeProject,
        below_usd: minUsd,
      },
      scannedStakes: scanned,
      pages,
      partial,
      ...(partial ? { warning: 'scan stopped early — older stakes in the window are missing; narrow days or call again' } : {}),
      summary,
      rows,
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
