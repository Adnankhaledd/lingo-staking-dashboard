import type { VercelRequest, VercelResponse } from '@vercel/node';

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

// ─── Stake provenance classifier (inlined — Vercel does not bundle api/_lib) ──
const PROV_LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const PROV_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const PROV_SWAP_TOPICS = new Set([
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  '0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b',
]);
const PROV_CLAIM_TOPICS = new Set([
  '0x47cee97cb7acd717b3c0aa1435d004cd5b3c8c57d70dbceb4e4458bbd60e39d4',
  '0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026',
  '0xc0e523490dd523c33b1878c9eb14ff46991233ed7e7a40b6f37fdb4e4dac6b32',
  '0xfb81f9b30d73d830c3544b34d827c08142579ee75710b490bb0237bf89e0fcc7',
]);
const PROV_KNOWN_WALLETS: Record<string, string> = {
  '0x0e0bc2919540119fc22a502842a74af4d81502b6': 'Treasury',
  '0x9399da51c1a85e64cce4b30b554875d2b89b2445': 'Liquidity',
  '0x7e3e2d6b8b87ce617b7ccdd63d0f5449e4057513': 'Team Buybacks',
  '0x69892fc8e176d9750e7f0ca06fc9aede0fc97bcb': 'Team Buybacks',
  '0x61f8d3fc749ecda98d378bc2cc8459ba0f7dfd58': 'Team Multisig',
  '0x7c91baca69ad289ec5de46b0b36287770a1ea91e': 'Distribution',
};
// Claim/distribution contracts (verified on-chain). LINGO arriving from one of
// these is a claim, not a buy. Value is the human label shown in the alert.
const PROV_CLAIM_CONTRACTS: Record<string, string> = {
  '0x2f26621e931c32542579cf8860d7e8616df32e0e': 'APY reward claim', // Treasury-owned APY claim contract
  '0xad11f733e401e16c72033c5decaf05dcc0e1beb8': 'Vesting claim',    // Vesting contract
};
const PROV_WINDOW_BLOCKS = 43_200; // ~24h on Base

export type ProvenanceSource =
  | 'bought' | 'claimed' | 'restaked' | 'transferred'
  | 'transferred_bought_upstream' | 'internal' | 'preheld' | 'unknown';

interface Provenance {
  source: ProvenanceSource;
  label: string;
  emoji: string;
  detail: string;
  confidence: 'high' | 'medium' | 'low';
}

const PROV_LABELS: Record<ProvenanceSource, { label: string; emoji: string }> = {
  bought:                      { label: 'Bought on DEX',                 emoji: '🛒' },
  claimed:                     { label: 'Claimed',                       emoji: '🎁' },
  restaked:                    { label: 'Unstaked & re-staked',          emoji: '🔁' },
  transferred:                 { label: 'Transferred in',                emoji: '↔️' },
  transferred_bought_upstream: { label: 'Transferred (bought upstream)', emoji: '🛒' },
  internal:                    { label: 'From project wallet',           emoji: '🏦' },
  preheld:                     { label: 'Pre-held balance',              emoji: '⏳' },
  unknown:                     { label: 'Source unknown',                emoji: '❔' },
};

function provMk(source: ProvenanceSource, confidence: Provenance['confidence'], detail = ''): Provenance {
  return { source, ...PROV_LABELS[source], detail, confidence };
}

interface ProvReceiptLog { address: string; topics: string[]; data: string }
interface ProvTxReceipt { transactionHash: string; logs: ProvReceiptLog[] }
interface ProvAssetTransfer { from: string; to: string; hash: string; blockNum: string; value: number | null }
interface ProvInboundLeg { from: string; value: bigint }
interface ProvReceiptSignals { hasSwap: boolean; hasClaim: boolean; inbound: ProvInboundLeg[] }

async function provRpc<T>(method: string, params: unknown[]): Promise<T | null> {
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

async function provGetReceipt(txHash: string): Promise<ProvTxReceipt | null> {
  return provRpc<ProvTxReceipt>('eth_getTransactionReceipt', [txHash]);
}

async function provGetCode(address: string): Promise<string> {
  return (await provRpc<string>('eth_getCode', [address, 'latest'])) ?? '0x';
}

async function provInbound(wallet: string, fromBlock: number, toBlock: number, maxCount = 0x14): Promise<ProvAssetTransfer[]> {
  if (toBlock < 0) return [];
  const result = await provRpc<{ transfers: ProvAssetTransfer[] }>('alchemy_getAssetTransfers', [{
    contractAddresses: [PROV_LINGO_TOKEN],
    category: ['erc20'],
    toAddress: wallet,
    fromBlock: '0x' + Math.max(0, fromBlock).toString(16),
    toBlock: '0x' + Math.max(0, toBlock).toString(16),
    order: 'desc',
    maxCount: '0x' + maxCount.toString(16),
    withMetadata: false,
  }]);
  return result?.transfers ?? [];
}

function provAnalyze(receipt: ProvTxReceipt, walletLc: string): ProvReceiptSignals {
  let hasSwap = false;
  let hasClaim = false;
  const inbound: ProvInboundLeg[] = [];
  for (const log of receipt.logs ?? []) {
    const topic0 = (log.topics?.[0] ?? '').toLowerCase();
    if (PROV_SWAP_TOPICS.has(topic0)) hasSwap = true;
    if (PROV_CLAIM_TOPICS.has(topic0)) hasClaim = true;
    if (log.address?.toLowerCase() === PROV_LINGO_TOKEN && topic0 === PROV_TRANSFER_TOPIC && log.topics.length >= 3) {
      const to = '0x' + log.topics[2].slice(26).toLowerCase();
      if (to === walletLc) {
        const from = '0x' + log.topics[1].slice(26).toLowerCase();
        let value = 0n;
        try { value = BigInt(log.data); } catch { /* malformed → 0 */ }
        inbound.push({ from, value });
      }
    }
  }
  return { hasSwap, hasClaim, inbound };
}

function provToLingo(weiValue: bigint): number {
  return Number(weiValue / BigInt(10 ** 16)) / 100;
}

async function provBoughtUpstream(eoa: string, beforeBlock: number): Promise<boolean> {
  const ts = await provInbound(eoa, beforeBlock - PROV_WINDOW_BLOCKS, beforeBlock, 0x5);
  if (ts.length === 0) return false;
  const r = await provGetReceipt(ts[0].hash);
  if (!r) return false;
  return provAnalyze(r, eoa.toLowerCase()).hasSwap;
}

interface ClassifyInput {
  wallet: string;
  stakeTxHash: string;
  stakeBlock: number;
  amount: number;
}

async function classifyProvenance(input: ClassifyInput): Promise<Provenance> {
  try {
    const walletLc = input.wallet.toLowerCase();
    const stakeReceipt = await provGetReceipt(input.stakeTxHash);
    if (stakeReceipt) {
      const a = provAnalyze(stakeReceipt, walletLc);
      if (a.hasSwap) return provMk('bought', 'high', 'Swap in the stake tx');
      if (a.hasClaim) return provMk('claimed', 'high', 'Claim event in the stake tx');
      const principal = a.inbound.slice().sort((x, y) => (y.value > x.value ? 1 : y.value < x.value ? -1 : 0))[0];
      if (principal && provToLingo(principal.value) >= input.amount * 0.5) {
        const from = principal.from;
        const conf: Provenance['confidence'] = a.inbound.length > 1 ? 'medium' : 'high';
        if (from === STAKING_CONTRACT) return provMk('restaked', conf, 'Came from the staking contract');
        if (PROV_KNOWN_WALLETS[from]) return provMk('internal', conf, `From ${PROV_KNOWN_WALLETS[from]}`);
        if (PROV_CLAIM_CONTRACTS[from]) return provMk('claimed', conf, PROV_CLAIM_CONTRACTS[from]);
        if ((await provGetCode(from)) !== '0x') return provMk('claimed', 'low', `From contract ${from.slice(0, 10)}… in the stake tx (no claim event)`);
      }
    }
    const transfers = (await provInbound(walletLc, input.stakeBlock - PROV_WINDOW_BLOCKS, input.stakeBlock))
      .filter(t => t.hash.toLowerCase() !== input.stakeTxHash.toLowerCase());
    if (transfers.length === 0) return provMk('preheld', 'low', 'No inbound LINGO in the ~24h before staking');
    const latest = transfers[0];
    const from = latest.from.toLowerCase();
    const multi = new Set(transfers.map(t => t.from.toLowerCase())).size > 1;
    if (from === STAKING_CONTRACT) return provMk('restaked', multi ? 'medium' : 'high', 'Unstaked then re-staked');
    if (PROV_KNOWN_WALLETS[from]) return provMk('internal', multi ? 'medium' : 'high', `From ${PROV_KNOWN_WALLETS[from]}`);
    if (PROV_CLAIM_CONTRACTS[from]) return provMk('claimed', multi ? 'medium' : 'high', PROV_CLAIM_CONTRACTS[from]);
    if ((await provGetCode(from)) !== '0x') {
      const r = await provGetReceipt(latest.hash);
      if (r) {
        const sig = provAnalyze(r, walletLc);
        if (sig.hasSwap) return provMk('bought', multi ? 'medium' : 'high', 'Received from a DEX/pool just before staking');
        if (sig.hasClaim) return provMk('claimed', multi ? 'medium' : 'high', 'Claim event just before staking');
      }
      return provMk('claimed', 'low', `From contract ${from.slice(0, 10)}… (unrecognized event)`);
    }
    const blockNum = parseInt(latest.blockNum, 16);
    if (Number.isFinite(blockNum) && await provBoughtUpstream(from, blockNum)) {
      return provMk('transferred_bought_upstream', 'medium', `Sent from ${from.slice(0, 10)}… which bought it on-chain`);
    }
    return provMk('transferred', 'low', `Wallet transfer from ${from.slice(0, 10)}…`);
  } catch {
    return provMk('unknown', 'low', 'Classification error');
  }
}
// ─── end provenance classifier ─────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Auth: admin password (header OR ?password= for browser CSV downloads) or cron secret
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const reqPassword = (req.headers['x-admin-password'] as string | undefined)
    ?? (req.query.password as string | undefined);
  // When CRON_SECRET is set, Vercel cron sends it as a Bearer token automatically.
  // (The spoofable x-vercel-cron header is deliberately not trusted.)
  const isCron = !cronSecret || req.headers.authorization === `Bearer ${cronSecret}`;
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
