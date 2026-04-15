import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list } from '@vercel/blob';

// ── Config ────────────────────────────────────────────────────────────
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const BLOB_KEY = 'stake-daily.json';

// Base block time ≈ 2 seconds
const BASE_BLOCK_TIME = 2;
const BLOCKS_PER_DAY = 86_400 / BASE_BLOCK_TIME; // 43,200

// Lookback windows
const DISPLAY_DAYS = 180;          // 6 months of output
const LOOKBACK_DAYS = 180;         // extra 6 months behind for "new vs old" classification
const TOTAL_SCAN_DAYS = DISPLAY_DAYS + LOOKBACK_DAYS; // 360 days

// Alchemy eth_getLogs safe chunk size for Base (avoids 10k-log response cap)
const BLOCK_CHUNK = 500_000;
// Concurrency for chunk fetching — keeps us well under Alchemy's rate limits
const FETCH_CONCURRENCY = 4;

// keccak256("Staked(address,uint256,uint256)")
const STAKED_EVENT_TOPIC = '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90';

// Only count the three lock durations the user cares about.
// Values are in block counts (Base ≈ 2-sec blocks) matching the contract — identical
// to KNOWN_DURATIONS in discord-alerts.ts for 3/6/12-month locks.
const LOCK_DURATIONS: Record<string, '3mo' | '6mo' | '12mo'> = {
  '3888000': '3mo',    // 3 months
  '7776000': '6mo',    // 6 months
  '15552000': '12mo',  // 12 months
};

const LINGO_DECIMALS = 18;

// ── Types ─────────────────────────────────────────────────────────────
interface StakeEvent {
  wallet: string;
  amount: number;
  lock: '3mo' | '6mo' | '12mo';
  blockNumber: number;
  timestamp: number; // unix seconds
}

interface DailyBucket {
  date: string;           // YYYY-MM-DD
  lock_3mo_amount: number;
  lock_6mo_amount: number;
  lock_12mo_amount: number;
  lock_3mo_count: number;
  lock_6mo_count: number;
  lock_12mo_count: number;
  new_wallet_amount: number;
  old_wallet_amount: number;
  new_wallet_count: number;
  old_wallet_count: number;
  total_amount: number;
  total_events: number;
}

interface BlobPayload {
  days: DailyBucket[];
  scannedBlocks: { from: number; to: number };
  refreshedAt: string;
  eventCount: number;
}

// ── Alchemy helpers ───────────────────────────────────────────────────
async function getLatestBlock(): Promise<number> {
  const res = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  const data = await res.json();
  return parseInt(data.result, 16);
}

interface RawLog {
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

async function getLogsChunk(fromBlock: number, toBlock: number): Promise<RawLog[]> {
  const res = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [{
        address: STAKING_CONTRACT,
        topics: [STAKED_EVENT_TOPIC],
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
      }],
    }),
  });
  if (!res.ok) throw new Error(`eth_getLogs failed ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`eth_getLogs error: ${JSON.stringify(data.error)}`);
  return data.result ?? [];
}

function parseAmount(hex: string): number {
  const raw = BigInt('0x' + hex);
  return Number(raw / BigInt(10 ** (LINGO_DECIMALS - 2))) / 100;
}

// ── Main logic ────────────────────────────────────────────────────────
async function scanAllEvents(fromBlock: number, toBlock: number): Promise<StakeEvent[]> {
  const events: StakeEvent[] = [];
  const now = Math.floor(Date.now() / 1000);

  // Walk blocks in chunks
  const chunks: Array<[number, number]> = [];
  for (let start = fromBlock; start <= toBlock; start += BLOCK_CHUNK) {
    const end = Math.min(start + BLOCK_CHUNK - 1, toBlock);
    chunks.push([start, end]);
  }

  // Fetch with a simple concurrency limiter
  async function fetchChunk(start: number, end: number): Promise<RawLog[]> {
    try {
      return await getLogsChunk(start, end);
    } catch (err) {
      // Too many logs in one chunk → split in half
      console.warn(`Chunk ${start}-${end} failed, splitting:`, err instanceof Error ? err.message : err);
      const mid = Math.floor((start + end) / 2);
      const [left, right] = await Promise.all([
        getLogsChunk(start, mid).catch(() => [] as RawLog[]),
        getLogsChunk(mid + 1, end).catch(() => [] as RawLog[]),
      ]);
      return [...left, ...right];
    }
  }

  for (let i = 0; i < chunks.length; i += FETCH_CONCURRENCY) {
    const batch = chunks.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(([s, e]) => fetchChunk(s, e)));

    for (const logs of results) {
      for (const log of logs) {
        if (!log.data || log.data.length < 130) continue;
        const wallet = '0x' + log.topics[1].slice(26);
        const amount = parseAmount(log.data.slice(2, 66));
        const durationRaw = BigInt('0x' + log.data.slice(66)).toString();
        const lock = LOCK_DURATIONS[durationRaw];
        if (!lock) continue; // skip Flexible / 1mo / 24mo / unknown
        const blockNumber = parseInt(log.blockNumber, 16);
        // Approximate timestamp from block offset (Base ≈ 2-sec blocks)
        const blocksAgo = toBlock - blockNumber;
        const timestamp = now - blocksAgo * BASE_BLOCK_TIME;

        events.push({ wallet: wallet.toLowerCase(), amount, lock, blockNumber, timestamp });
      }
    }
  }

  events.sort((a, b) => a.blockNumber - b.blockNumber);
  return events;
}

function aggregateDaily(events: StakeEvent[], displayStartTs: number): DailyBucket[] {
  // Track wallet → most recent prior stake timestamp (within the 360-day window)
  const lastStakeByWallet = new Map<string, number>();

  // Map of date (YYYY-MM-DD) → bucket
  const buckets = new Map<string, DailyBucket>();

  for (const ev of events) {
    const isInDisplayWindow = ev.timestamp >= displayStartTs;

    // Classify new vs old: wallet is "new" if no prior stake in the previous 180 days
    const prior = lastStakeByWallet.get(ev.wallet);
    const LOOKBACK_SEC = LOOKBACK_DAYS * 86_400;
    const isNewWallet = prior == null || (ev.timestamp - prior) > LOOKBACK_SEC;

    // Update map for future events
    lastStakeByWallet.set(ev.wallet, ev.timestamp);

    if (!isInDisplayWindow) continue; // only aggregate events inside the 180-day display window

    const date = new Date(ev.timestamp * 1000).toISOString().slice(0, 10);
    let b = buckets.get(date);
    if (!b) {
      b = {
        date,
        lock_3mo_amount: 0, lock_6mo_amount: 0, lock_12mo_amount: 0,
        lock_3mo_count: 0, lock_6mo_count: 0, lock_12mo_count: 0,
        new_wallet_amount: 0, old_wallet_amount: 0,
        new_wallet_count: 0, old_wallet_count: 0,
        total_amount: 0, total_events: 0,
      };
      buckets.set(date, b);
    }

    // Lock bucket
    if (ev.lock === '3mo') { b.lock_3mo_amount += ev.amount; b.lock_3mo_count += 1; }
    else if (ev.lock === '6mo') { b.lock_6mo_amount += ev.amount; b.lock_6mo_count += 1; }
    else if (ev.lock === '12mo') { b.lock_12mo_amount += ev.amount; b.lock_12mo_count += 1; }

    // Wallet bucket
    if (isNewWallet) {
      b.new_wallet_amount += ev.amount;
      b.new_wallet_count += 1;
    } else {
      b.old_wallet_amount += ev.amount;
      b.old_wallet_count += 1;
    }

    b.total_amount += ev.amount;
    b.total_events += 1;
  }

  // Sort buckets chronologically, round numbers
  return Array.from(buckets.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(b => ({
      ...b,
      lock_3mo_amount: Math.round(b.lock_3mo_amount),
      lock_6mo_amount: Math.round(b.lock_6mo_amount),
      lock_12mo_amount: Math.round(b.lock_12mo_amount),
      new_wallet_amount: Math.round(b.new_wallet_amount),
      old_wallet_amount: Math.round(b.old_wallet_amount),
      total_amount: Math.round(b.total_amount),
    }));
}

// Read existing blob (for fallback if scan fails) — inline helper
async function fetchBlobJson<T = unknown>(pathname: string): Promise<T | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const match = token.match(/^vercel_blob_rw_([^_]+)_/);
  if (match) {
    try {
      const res = await fetch(`https://${match[1]}.public.blob.vercel-storage.com/${pathname}?t=${Date.now()}`);
      if (res.ok) return (await res.json()) as T;
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

// ── Handler ───────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Password');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth (same pattern as refresh-dune)
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const requestPassword = req.headers['x-admin-password'] as string;
  const isCronAuth = !cronSecret ||
    authHeader === `Bearer ${cronSecret}` ||
    req.headers['x-vercel-cron'] === '1';
  const isAdminAuth = adminPassword && requestPassword === adminPassword;

  if (!isCronAuth && !isAdminAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!ALCHEMY_API_KEY || !STAKING_CONTRACT) {
    return res.status(500).json({
      error: 'Not configured',
      missing: [!ALCHEMY_API_KEY && 'ALCHEMY_API_KEY', !STAKING_CONTRACT && 'STAKING_CONTRACT_ADDRESS'].filter(Boolean),
    });
  }

  try {
    const latestBlock = await getLatestBlock();
    const fromBlock = Math.max(0, latestBlock - TOTAL_SCAN_DAYS * BLOCKS_PER_DAY);
    const displayStartTs = Math.floor(Date.now() / 1000) - DISPLAY_DAYS * 86_400;

    console.log(`Scanning blocks ${fromBlock}..${latestBlock} (${TOTAL_SCAN_DAYS} days)`);

    const events = await scanAllEvents(fromBlock, latestBlock);
    console.log(`Found ${events.length} qualifying stake events`);

    const days = aggregateDaily(events, displayStartTs);

    // If scan produced no events AND we have existing data, keep the existing data
    if (days.length === 0) {
      const existing = await fetchBlobJson<BlobPayload>(BLOB_KEY);
      if (existing && existing.days?.length > 0) {
        return res.status(200).json({
          message: 'Scan produced 0 days — keeping existing data',
          kept: true,
          refreshedAt: existing.refreshedAt,
        });
      }
    }

    const payload: BlobPayload = {
      days,
      scannedBlocks: { from: fromBlock, to: latestBlock },
      refreshedAt: new Date().toISOString(),
      eventCount: events.length,
    };

    const blob = await put(BLOB_KEY, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });

    return res.status(200).json({
      message: `Refreshed ${days.length} days from ${events.length} events`,
      blobUrl: blob.url,
      refreshedAt: payload.refreshedAt,
      dayCount: days.length,
      eventCount: events.length,
    });
  } catch (error) {
    console.error('refresh-stake-daily failed:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
