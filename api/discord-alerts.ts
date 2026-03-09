import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list } from '@vercel/blob';

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const MIN_AMOUNT = 10_000;
const BLOB_KEY = 'discord-last-block.json';

// keccak256("Staked(address,uint256,uint256)")
const STAKED_EVENT_TOPIC = '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90';

const KNOWN_DURATIONS: Record<string, string> = {
  '0': 'Flexible',
  '1296000': '1 Month',
  '3888000': '3 Months',
  '7776000': '6 Months',
  '15552000': '12 Months',
  '30283200': '24 Months',
};

// Lock duration → Discord embed color
const DURATION_COLORS: Record<string, number> = {
  'Flexible': 0x9B8EC2,    // purple-gray
  '1 Month': 0x5EB851,     // green
  '3 Months': 0x5EB851,    // green
  '6 Months': 0xFF7847,    // orange
  '12 Months': 0xE8B100,   // gold
  '24 Months': 0xE8B100,   // gold
};

interface AlchemyTransfer {
  blockNum: string;
  hash: string;
  from: string;
  to: string;
  value: number | null;
  metadata: { blockTimestamp: string };
}

interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
}

function durationToLabel(val: bigint): string {
  const known = KNOWN_DURATIONS[val.toString()];
  if (known) return known;
  const months = Math.round(Number(val) * 2 / 86_400 / 30);
  return months > 0 ? `${months} Months` : 'Flexible';
}

function formatAmount(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toFixed(0);
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function getLastSeenBlock(): Promise<string | null> {
  try {
    const { blobs } = await list({ prefix: BLOB_KEY });
    if (blobs.length === 0) return null;
    const res = await fetch(blobs[0].url);
    const data = await res.json();
    return data.lastBlock ?? null;
  } catch {
    return null;
  }
}

async function saveLastSeenBlock(blockHex: string): Promise<void> {
  await put(BLOB_KEY, JSON.stringify({ lastBlock: blockHex, updatedAt: new Date().toISOString() }), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

async function getRecentStakes(fromBlock?: string): Promise<AlchemyTransfer[]> {
  const params: Record<string, unknown> = {
    contractAddresses: [LINGO_TOKEN],
    category: ['erc20'],
    toAddress: STAKING_CONTRACT,
    maxCount: '0x14', // 20
    order: 'desc',
    withMetadata: true,
  };

  // If we have a last block, only fetch newer events
  if (fromBlock) {
    params.fromBlock = fromBlock;
  }

  const response = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [params],
    }),
  });

  if (!response.ok) return [];
  const data = await response.json();
  return data.result?.transfers ?? [];
}

async function getReceiptDuration(txHash: string): Promise<string | null> {
  try {
    const response = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const logs: ReceiptLog[] = data.result?.logs ?? [];

    for (const log of logs) {
      if (
        log.address.toLowerCase() === STAKING_CONTRACT &&
        log.topics[0] === STAKED_EVENT_TOPIC &&
        log.data.length >= 130
      ) {
        const duration = BigInt('0x' + log.data.slice(66));
        return durationToLabel(duration);
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function sendDiscordEmbed(
  wallet: string,
  amount: number,
  lockDuration: string | null,
  txHash: string,
  timestamp: string,
): Promise<void> {
  const lock = lockDuration ?? 'Unknown';
  const color = DURATION_COLORS[lock] ?? 0x5EB851;
  const lockEmoji = lock === 'Flexible' ? '\uD83D\uDD13' : '\uD83D\uDD12';
  const amountStr = formatAmount(amount);

  const embed = {
    title: `${lockEmoji} ${amountStr} LINGO Staked`,
    color,
    fields: [
      { name: 'Wallet', value: `[\`${shortenAddress(wallet)}\`](https://basescan.org/address/${wallet})`, inline: true },
      { name: 'Lock Duration', value: lock, inline: true },
      { name: 'Amount', value: `${amount.toLocaleString()} LINGO`, inline: true },
    ],
    timestamp: timestamp || new Date().toISOString(),
    footer: {
      text: 'Lingo Staking Bot',
    },
    url: `https://basescan.org/tx/${txHash}`,
  };

  await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Lingo Staking',
      embeds: [embed],
    }),
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!ALCHEMY_API_KEY || !STAKING_CONTRACT || !DISCORD_WEBHOOK_URL) {
    return res.status(200).json({
      message: 'Not configured',
      missing: [
        !ALCHEMY_API_KEY && 'ALCHEMY_API_KEY',
        !STAKING_CONTRACT && 'STAKING_CONTRACT_ADDRESS',
        !DISCORD_WEBHOOK_URL && 'DISCORD_WEBHOOK_URL',
      ].filter(Boolean),
    });
  }

  try {
    const lastBlock = await getLastSeenBlock();

    // Fetch from one block after the last seen (to avoid duplicates)
    const fromBlock = lastBlock
      ? '0x' + (parseInt(lastBlock, 16) + 1).toString(16)
      : undefined;

    const stakes = await getRecentStakes(fromBlock);

    // Filter to 10K+ LINGO
    const filtered = stakes
      .filter(t => (t.value ?? 0) >= MIN_AMOUNT)
      .reverse(); // oldest first so Discord messages appear in order

    if (filtered.length === 0) {
      return res.status(200).json({
        message: 'No new stakes',
        lastBlock,
        fromBlock,
        debug: { totalFetched: stakes.length, allValues: stakes.map(s => s.value) },
      });
    }

    // Get lock duration for each and post to Discord
    let posted = 0;
    let highestBlock = lastBlock ?? '0x0';

    for (const stake of filtered) {
      const lockDuration = await getReceiptDuration(stake.hash);

      await sendDiscordEmbed(
        stake.from,
        stake.value ?? 0,
        lockDuration,
        stake.hash,
        stake.metadata?.blockTimestamp || '',
      );

      // Track highest block
      if (parseInt(stake.blockNum, 16) > parseInt(highestBlock, 16)) {
        highestBlock = stake.blockNum;
      }
      posted++;
    }

    // Save the highest block we've processed
    await saveLastSeenBlock(highestBlock);

    return res.status(200).json({
      message: `Posted ${posted} stake alerts to Discord`,
      lastBlock: highestBlock,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
