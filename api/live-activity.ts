import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const MIN_AMOUNT = 10_000;

// keccak256("Staked(address,uint256,uint256)")
const STAKED_EVENT_TOPIC = '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90';

interface AlchemyTransfer {
  blockNum: string;
  hash: string;
  from: string;
  to: string;
  value: number | null;
  asset: string | null;
  metadata: { blockTimestamp: string };
}

interface StakingEvent {
  type: 'stake';
  wallet: string;
  amount: number;
  txHash: string;
  timestamp: string;
  blockNum: string;
  lockDuration: string | null;
}

interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
}

interface TxReceipt {
  transactionHash: string;
  logs: ReceiptLog[];
}

async function getStakes(): Promise<AlchemyTransfer[]> {
  const response = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [{
        contractAddresses: [LINGO_TOKEN],
        category: ['erc20'],
        toAddress: STAKING_CONTRACT,
        maxCount: '0x32',
        order: 'desc',
        withMetadata: true,
      }],
    }),
  });

  if (!response.ok) return [];
  const data = await response.json();
  return data.result?.transfers ?? [];
}

// Map a raw duration value (seconds or blocks) to a human label
function durationToLabel(val: bigint): string {
  if (val === 0n) return 'Flexible';

  // Duration could be in seconds or blocks (~2s per block on Base)
  const n = Number(val);

  // Check if values look like seconds (large numbers)
  if (n >= 86_400) {
    const days = Math.round(n / 86_400);
    if (days <= 45) return '1 Month';
    if (days <= 105) return '3 Months';
    if (days <= 200) return '6 Months';
    if (days <= 400) return '12 Months';
    return `${Math.round(days / 30)}M Lock`;
  }

  // Check if values look like blocks (~2s each on Base)
  const approxDays = (n * 2) / 86_400;
  if (approxDays <= 45) return '1 Month';
  if (approxDays <= 105) return '3 Months';
  if (approxDays <= 200) return '6 Months';
  if (approxDays <= 400) return '12 Months';
  return `${Math.round(approxDays / 30)}M Lock`;
}

// Read lock durations from the contract to build a value → label map
async function getLockDurationsMap(): Promise<Map<bigint, string>> {
  const map = new Map<bigint, string>();

  try {
    // Call lockDurationsCount()
    const countRes = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: STAKING_CONTRACT, data: '0x5ef35984' }, 'latest'],
      }),
    });

    if (!countRes.ok) return map;
    const countData = await countRes.json();
    const count = Number(BigInt(countData.result || '0x0'));

    if (count === 0) return map;

    // Batch fetch all lockDurations(i)
    const batch = Array.from({ length: count }, (_, i) => ({
      jsonrpc: '2.0', id: i, method: 'eth_call',
      params: [{
        to: STAKING_CONTRACT,
        // lockDurations(uint256) selector + padded index
        data: '0x32298be1' + i.toString(16).padStart(64, '0'),
      }, 'latest'],
    }));

    const batchRes = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });

    if (!batchRes.ok) return map;
    const results: { id: number; result?: string }[] = await batchRes.json();

    for (const r of results) {
      if (r.result) {
        const val = BigInt(r.result);
        map.set(val, durationToLabel(val));
      }
    }
  } catch {
    // Fall through — lock durations will be null
  }

  return map;
}

// Batch-fetch transaction receipts
async function batchGetReceipts(txHashes: string[]): Promise<Map<string, TxReceipt>> {
  const map = new Map<string, TxReceipt>();
  if (txHashes.length === 0) return map;

  const batch = txHashes.map((hash, i) => ({
    jsonrpc: '2.0', id: i, method: 'eth_getTransactionReceipt', params: [hash],
  }));

  const response = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });

  if (!response.ok) return map;
  const results: { result?: TxReceipt }[] = await response.json();

  for (const r of results) {
    if (r.result?.transactionHash) {
      map.set(r.result.transactionHash.toLowerCase(), r.result);
    }
  }
  return map;
}

// Extract lock duration from the Staked event in a tx receipt
function extractDuration(receipt: TxReceipt, durationMap: Map<bigint, string>): string | null {
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === STAKING_CONTRACT &&
      log.topics[0] === STAKED_EVENT_TOPIC
    ) {
      // data = abi.encode(uint256 amount, uint256 duration)
      // 0x + 64 chars (amount) + 64 chars (duration)
      if (log.data.length >= 130) {
        const durationHex = '0x' + log.data.slice(66);
        const duration = BigInt(durationHex);
        return durationMap.get(duration) ?? durationToLabel(duration);
      }
    }
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!ALCHEMY_API_KEY || !STAKING_CONTRACT) {
    return res.status(200).json({ events: [], configured: false });
  }

  try {
    // Fetch stakes and lock duration config in parallel
    const [stakes, durationMap] = await Promise.all([
      getStakes(),
      getLockDurationsMap(),
    ]);

    const filtered = stakes
      .map(t => ({
        type: 'stake' as const,
        wallet: t.from,
        amount: t.value ?? 0,
        txHash: t.hash,
        timestamp: t.metadata?.blockTimestamp || '',
        blockNum: t.blockNum,
      }))
      .filter(e => e.amount >= MIN_AMOUNT)
      .slice(0, 20);

    // Batch-fetch receipts for filtered events to get lock durations
    const receipts = await batchGetReceipts(filtered.map(e => e.txHash));

    const events: StakingEvent[] = filtered.map(e => ({
      ...e,
      lockDuration: receipts.has(e.txHash.toLowerCase())
        ? extractDuration(receipts.get(e.txHash.toLowerCase())!, durationMap)
        : null,
    }));

    return res.status(200).json({ events, configured: true });
  } catch (error) {
    return res.status(200).json({
      events: [],
      configured: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
