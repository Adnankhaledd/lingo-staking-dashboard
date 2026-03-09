import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list } from '@vercel/blob';

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const MIN_AMOUNT = 10_000;
const BLOB_KEY = 'discord-last-block.json';
const LINGO_DECIMALS = 18;

// keccak256("Staked(address,uint256,uint256)")
const STAKED_EVENT_TOPIC = '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90';

// ~7 days of blocks on Base (2 sec/block)
const DEFAULT_LOOKBACK = 302_400;

const KNOWN_DURATIONS: Record<string, string> = {
  '0': 'Flexible',
  '1296000': '1 Month',
  '3888000': '3 Months',
  '7776000': '6 Months',
  '15552000': '12 Months',
  '30283200': '24 Months',
};

const DURATION_COLORS: Record<string, number> = {
  'Flexible': 0x9B8EC2,
  '1 Month': 0x5EB851,
  '3 Months': 0x5EB851,
  '6 Months': 0xFF7847,
  '12 Months': 0xE8B100,
  '24 Months': 0xE8B100,
};

interface StakedEvent {
  wallet: string;
  amount: number;
  lockDuration: string;
  txHash: string;
  blockNumber: number;
}

function durationToLabel(val: bigint): string {
  return KNOWN_DURATIONS[val.toString()] ??
    (() => { const m = Math.round(Number(val) * 2 / 86_400 / 30); return m > 0 ? `${m} Months` : 'Flexible'; })();
}

function formatAmount(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toFixed(0);
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function getLastSeenBlock(): Promise<number | null> {
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

async function saveLastSeenBlock(block: number): Promise<void> {
  await put(BLOB_KEY, JSON.stringify({ lastBlock: block, updatedAt: new Date().toISOString() }), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

async function getLatestBlock(): Promise<number> {
  const res = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  const data = await res.json();
  return parseInt(data.result, 16);
}

// Query Staked events directly from the contract logs
async function getStakedEvents(fromBlock: number, toBlock: number): Promise<StakedEvent[]> {
  const res = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_getLogs',
      params: [{
        address: STAKING_CONTRACT,
        topics: [STAKED_EVENT_TOPIC],
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
      }],
    }),
  });

  if (!res.ok) return [];
  const data = await res.json();
  const logs = data.result ?? [];

  const events: StakedEvent[] = [];
  for (const log of logs) {
    if (log.data.length < 130) continue;

    // topics[1] = indexed user address (padded to 32 bytes)
    const wallet = '0x' + log.topics[1].slice(26);
    // data = abi.encode(uint256 amount, uint256 duration)
    const amountRaw = BigInt('0x' + log.data.slice(2, 66));
    const durationRaw = BigInt('0x' + log.data.slice(66));

    const amount = Number(amountRaw / BigInt(10 ** (LINGO_DECIMALS - 2))) / 100;

    if (amount >= MIN_AMOUNT) {
      events.push({
        wallet,
        amount,
        lockDuration: durationToLabel(durationRaw),
        txHash: log.transactionHash,
        blockNumber: parseInt(log.blockNumber, 16),
      });
    }
  }

  return events;
}

async function sendDiscordEmbed(event: StakedEvent): Promise<void> {
  const color = DURATION_COLORS[event.lockDuration] ?? 0x5EB851;
  const lockEmoji = event.lockDuration === 'Flexible' ? '\uD83D\uDD13' : '\uD83D\uDD12';

  const embed = {
    title: `${lockEmoji} ${formatAmount(event.amount)} LINGO Staked`,
    color,
    fields: [
      { name: 'Wallet', value: `[\`${shortenAddress(event.wallet)}\`](https://basescan.org/address/${event.wallet})`, inline: true },
      { name: 'Lock Duration', value: event.lockDuration, inline: true },
      { name: 'Amount', value: `${event.amount.toLocaleString()} LINGO`, inline: true },
    ],
    footer: { text: 'Lingo Staking Bot' },
    url: `https://basescan.org/tx/${event.txHash}`,
  };

  await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Lingo Staking', embeds: [embed] }),
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
    const [lastBlock, latestBlock] = await Promise.all([
      getLastSeenBlock(),
      getLatestBlock(),
    ]);

    // First run: look back ~7 days. Subsequent: from last seen block + 1
    const fromBlock = lastBlock ? lastBlock + 1 : latestBlock - DEFAULT_LOOKBACK;

    const events = await getStakedEvents(fromBlock, latestBlock);

    if (events.length === 0) {
      // Save current block so next run starts from here
      await saveLastSeenBlock(latestBlock);
      return res.status(200).json({
        message: 'No new stakes above 10K',
        fromBlock,
        toBlock: latestBlock,
        eventsChecked: 0,
      });
    }

    // Post to Discord (oldest first)
    let posted = 0;
    for (const event of events) {
      await sendDiscordEmbed(event);
      posted++;
    }

    // Save highest block processed
    await saveLastSeenBlock(latestBlock);

    return res.status(200).json({
      message: `Posted ${posted} stake alerts to Discord`,
      fromBlock,
      toBlock: latestBlock,
      posted,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
