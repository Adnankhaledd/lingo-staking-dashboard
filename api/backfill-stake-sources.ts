import type { VercelRequest, VercelResponse } from '@vercel/node';
import { classifyProvenance, type ProvenanceSource } from './_lib/provenance';

/**
 * /api/backfill-stake-sources — one-off historical provenance run.
 *
 * Scans past Staked events (>= MIN_AMOUNT LINGO), classifies where each
 * staker's LINGO came from, and returns either a JSON summary or a CSV.
 * Optionally posts a single aggregate summary to Slack (no per-stake spam).
 *
 * Serverless-safe: processes newest-first up to `limit` events per call and
 * returns a `nextBeforeBlock` cursor + `hasMore` so a long range can be paged
 * across several calls. Nothing is silently truncated — the response always
 * states how many were processed and whether more remain.
 *
 * Admin-gated (X-Admin-Password == ADMIN_PASSWORD) or cron secret.
 *
 * Query params:
 *   days=90            look-back window when fromBlock not given (default 90)
 *   fromBlock / toBlock  explicit block range (override days)
 *   beforeBlock=N      cursor: only consider blocks <= N (for paging)
 *   limit=150          max events to classify this call
 *   format=json|csv    output format (default json)
 *   slack=1            also post an aggregate summary to SLACK_WEBHOOK_URL
 */

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

const MIN_AMOUNT = 10_000;
const LINGO_DECIMALS = 18;
const STAKED_EVENT_TOPIC = '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90';
const BLOCKS_PER_DAY = 43_200; // Base ~2s/block
const MAX_GETLOGS_RANGE = 500_000; // chunk eth_getLogs to stay within provider limits
const DEFAULT_LIMIT = 150;
const CLASSIFY_CONCURRENCY = 6;

const KNOWN_DURATIONS: Record<string, string> = {
  '0': 'Flexible', '1296000': '1 Month', '3888000': '3 Months',
  '7776000': '6 Months', '15552000': '12 Months', '30283200': '24 Months',
};

function durationToLabel(val: bigint): string {
  return KNOWN_DURATIONS[val.toString()] ??
    (() => { const m = Math.round(Number(val) * 2 / 86_400 / 30); return m > 0 ? `${m} Months` : 'Flexible'; })();
}

function parseAmount(hex: string): number {
  const raw = BigInt('0x' + hex);
  return Number(raw / BigInt(10 ** (LINGO_DECIMALS - 2))) / 100;
}

interface RawLog { topics: string[]; data: string; transactionHash: string; blockNumber: string; logIndex?: string }

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  const res = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  return (data.result ?? null) as T | null;
}

async function getLatestBlock(): Promise<number> {
  const r = await rpc<string>('eth_blockNumber', []);
  return r ? parseInt(r, 16) : 0;
}

interface StakeRow {
  wallet: string;
  amount: number;
  lockDuration: string;
  txHash: string;
  blockNumber: number;
}

function mkRow(log: RawLog): StakeRow {
  return {
    wallet: '0x' + log.topics[1].slice(26),
    amount: parseAmount(log.data.slice(2, 66)),
    lockDuration: durationToLabel(BigInt('0x' + log.data.slice(66))),
    txHash: log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
  };
}

/** Scan Staked events newest-first across [fromBlock, toBlock], capped at `limit`.
 *  When the cap is hit, the limit-hitting block is fully drained before
 *  returning so the exclusive cursor (block-1) on the next page can't skip any
 *  same-block stakes. */
async function scanStakes(fromBlock: number, toBlock: number, limit: number): Promise<{ rows: StakeRow[]; oldestScanned: number; hasMore: boolean }> {
  const rows: StakeRow[] = [];
  let hi = toBlock;
  let oldestScanned = toBlock;

  while (hi >= fromBlock) {
    const lo = Math.max(fromBlock, hi - MAX_GETLOGS_RANGE + 1);
    const logs = await rpc<RawLog[]>('eth_getLogs', [{
      address: STAKING_CONTRACT,
      topics: [STAKED_EVENT_TOPIC],
      fromBlock: '0x' + lo.toString(16),
      toBlock: '0x' + hi.toString(16),
    }]);

    if (logs && logs.length) {
      // newest first; deterministic same-block order via logIndex desc
      logs.sort((a, b) => {
        const bd = parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16);
        if (bd !== 0) return bd;
        return parseInt(b.logIndex ?? '0x0', 16) - parseInt(a.logIndex ?? '0x0', 16);
      });
      for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        if (log.data.length < 130) continue;
        if (parseAmount(log.data.slice(2, 66)) < MIN_AMOUNT) continue;
        rows.push(mkRow(log));
        if (rows.length >= limit) {
          // Drain the rest of THIS block so cursor = block-1 is safe.
          const B = parseInt(log.blockNumber, 16);
          for (let j = i + 1; j < logs.length; j++) {
            const l2 = logs[j];
            if (parseInt(l2.blockNumber, 16) !== B) break; // sorted desc → same-block are contiguous
            if (l2.data.length < 130) continue;
            if (parseAmount(l2.data.slice(2, 66)) < MIN_AMOUNT) continue;
            rows.push(mkRow(l2));
          }
          return { rows, oldestScanned: B, hasMore: B > fromBlock };
        }
      }
    }
    oldestScanned = lo;
    hi = lo - 1;
  }
  return { rows, oldestScanned, hasMore: false };
}

/** Classify rows with bounded concurrency. */
async function classifyAll(rows: StakeRow[]): Promise<Array<StakeRow & { source: ProvenanceSource; confidence: string; detail: string }>> {
  const out: Array<StakeRow & { source: ProvenanceSource; confidence: string; detail: string }> = new Array(rows.length);
  let idx = 0;
  async function worker() {
    while (idx < rows.length) {
      const i = idx++;
      const r = rows[i];
      const p = await classifyProvenance({ wallet: r.wallet, stakeTxHash: r.txHash, stakeBlock: r.blockNumber, amount: r.amount });
      out[i] = { ...r, source: p.source, confidence: p.confidence, detail: p.detail };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, rows.length) }, worker));
  return out;
}

function toCsv(rows: Array<StakeRow & { source: string; confidence: string; detail: string }>): string {
  const header = ['blockNumber', 'txHash', 'wallet', 'amount_LINGO', 'lockDuration', 'source', 'confidence', 'detail', 'basescanTx'];
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map(r => [
    r.blockNumber, r.txHash, r.wallet, r.amount, r.lockDuration, r.source, r.confidence, r.detail,
    `https://basescan.org/tx/${r.txHash}`,
  ].map(esc).join(','));
  return [header.join(','), ...lines].join('\n');
}

const SOURCE_LABELS: Record<string, string> = {
  bought: '🛒 Bought on DEX',
  claimed: '🎁 Claimed',
  restaked: '🔁 Unstaked & re-staked',
  transferred: '↔️ Transferred in',
  transferred_bought_upstream: '🛒 Transferred (bought upstream)',
  internal: '🏦 From project wallet',
  preheld: '⏳ Pre-held balance',
  unknown: '❔ Source unknown',
};

async function postSlackSummary(
  classified: Array<{ source: string; amount: number }>,
  range: { fromBlock: number; toBlock: number; processed: number; hasMore: boolean },
): Promise<boolean> {
  const bySource = new Map<string, { count: number; lingo: number }>();
  for (const r of classified) {
    const b = bySource.get(r.source) ?? { count: 0, lingo: 0 };
    b.count += 1; b.lingo += r.amount;
    bySource.set(r.source, b);
  }
  const ordered = [...bySource.entries()].sort((a, b) => b[1].count - a[1].count);
  const totalCount = classified.length || 1;
  const lines = ordered.map(([src, v]) =>
    `${SOURCE_LABELS[src] ?? src}: *${v.count}* (${((v.count / totalCount) * 100).toFixed(0)}%) · ${Math.round(v.lingo).toLocaleString()} LINGO`
  );

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📊 Stake Sources — backfill (${classified.length} stakes ≥${MIN_AMOUNT.toLocaleString()} LINGO)`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || '_No stakes in range_' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Blocks ${range.fromBlock.toLocaleString()}–${range.toBlock.toLocaleString()}${range.hasMore ? ' · more remain (paged)' : ''}` }] },
  ];

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `Stake-sources backfill: ${classified.length} stakes classified`, blocks }),
  });
  return res.ok;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Auth: admin password (header OR ?password= for browser CSV downloads) or cron secret
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const reqPassword = (req.headers['x-admin-password'] as string | undefined)
    ?? (req.query.password as string | undefined);
  const isCron = !cronSecret || req.headers.authorization === `Bearer ${cronSecret}` || req.headers['x-vercel-cron'] === '1';
  const isAdmin = adminPassword && reqPassword === adminPassword;
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'Unauthorized' });

  if (!ALCHEMY_API_KEY || !STAKING_CONTRACT) {
    return res.status(200).json({ error: 'Missing ALCHEMY_API_KEY or STAKING_CONTRACT_ADDRESS' });
  }

  const q = req.query as Record<string, string | undefined>;
  const days = q.days ? parseInt(q.days, 10) : 90;
  const limit = q.limit ? Math.max(1, parseInt(q.limit, 10)) : DEFAULT_LIMIT;
  const format = (q.format === 'csv') ? 'csv' : 'json';
  const wantSlack = q.slack === '1';

  try {
    const latest = await getLatestBlock();
    const toBlock = q.beforeBlock ? parseInt(q.beforeBlock, 10) : (q.toBlock ? parseInt(q.toBlock, 10) : latest);
    const fromBlock = q.fromBlock ? parseInt(q.fromBlock, 10) : Math.max(0, toBlock - days * BLOCKS_PER_DAY);

    const { rows, oldestScanned, hasMore } = await scanStakes(fromBlock, toBlock, limit);
    const classified = await classifyAll(rows);

    if (wantSlack && SLACK_WEBHOOK_URL) {
      await postSlackSummary(classified, { fromBlock, toBlock, processed: classified.length, hasMore }).catch(() => {});
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="stake-sources-${fromBlock}-${toBlock}.csv"`);
      return res.status(200).send(toCsv(classified));
    }

    // JSON summary
    const summary: Record<string, { count: number; lingo: number }> = {};
    for (const r of classified) {
      const b = summary[r.source] ?? { count: 0, lingo: 0 };
      b.count += 1; b.lingo += r.amount;
      summary[r.source] = b;
    }

    return res.status(200).json({
      range: { fromBlock, toBlock, days: q.fromBlock ? undefined : days },
      processed: classified.length,
      hasMore,
      nextBeforeBlock: hasMore ? oldestScanned - 1 : null,
      summary,
      rows: classified,
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
