import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put } from '@vercel/blob';
import { fetchBlobJson } from './_blob-helpers';

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const MIN_AMOUNT = 10_000;
const BLOB_KEY = 'discord-last-block.json';
const LINGO_DECIMALS = 18;

// keccak256("Staked(address,uint256,uint256)")
const STAKED_EVENT_TOPIC = '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90';
// keccak256("Unstaked(address,uint256,uint256)")
const UNSTAKED_EVENT_TOPIC = '0x7fc4727e062e336010f2c282598ef5f14facb3de68cf8195c2f23e1454b2b74e';

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

// Known block duration values (for reverse-matching unstakes)
const KNOWN_DURATION_BLOCKS = [0, 1296000, 3888000, 7776000, 15552000, 30283200];

const DURATION_COLORS: Record<string, number> = {
  'Flexible': 0x9B8EC2,
  '1 Month': 0x5EB851,
  '3 Months': 0x5EB851,
  '6 Months': 0xFF7847,
  '12 Months': 0xE8B100,
  '24 Months': 0xE8B100,
};

// Red shades for unstake embeds
const UNSTAKE_COLOR = 0xE84040;

interface StakingEvent {
  type: 'stake' | 'unstake';
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

function parseAmount(hex: string): number {
  const raw = BigInt('0x' + hex);
  return Number(raw / BigInt(10 ** (LINGO_DECIMALS - 2))) / 100;
}

async function getLastSeenBlock(): Promise<number | null> {
  try {
    // Direct URL fetch — zero Blob SDK operations
    const data = await fetchBlobJson<{ lastBlock: unknown }>(BLOB_KEY);
    if (!data) return null;
    const val = data.lastBlock;
    if (val == null) return null;
    if (typeof val === 'string') return parseInt(val, 16) || null;
    return typeof val === 'number' ? val : null;
  } catch {
    return null;
  }
}

async function saveLastSeenBlock(block: number): Promise<void> {
  await put(BLOB_KEY, JSON.stringify({ lastBlock: block, updatedAt: new Date().toISOString() }), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
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

// For an unstake, derive the lock duration from unlockBlock
// unlockBlock = stakeBlock + lockDuration
// We try each known duration and pick the one where stakeBlock is most reasonable
function deriveLockDuration(unlockBlock: bigint, unstakeBlock: number): string {
  const unlock = Number(unlockBlock);

  for (const dur of KNOWN_DURATION_BLOCKS) {
    if (dur === 0) {
      // Flexible: unlockBlock would equal the stakeBlock (0 duration)
      // So the stakeBlock = unlockBlock, and it must be <= unstakeBlock
      if (unlock <= unstakeBlock && unlock > 0) {
        // Check if it's plausible (staked within last ~2 years)
        const blockAge = unstakeBlock - unlock;
        if (blockAge < 31_536_000) { // ~2 years of blocks
          continue; // Skip flexible, try longer durations first
        }
      }
    }

    const stakeBlock = unlock - dur;
    // Must have staked before unstaking, and within a reasonable timeframe
    if (stakeBlock > 0 && stakeBlock < unstakeBlock) {
      return KNOWN_DURATIONS[dur.toString()] ?? 'Unknown';
    }
  }
  return 'Unknown';
}

// Query Staked + Unstaked events from the contract
async function getStakingEvents(fromBlock: number, toBlock: number): Promise<StakingEvent[]> {
  // Fetch both event types in parallel
  const [stakesRes, unstakesRes] = await Promise.all([
    fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
        params: [{
          address: STAKING_CONTRACT,
          topics: [STAKED_EVENT_TOPIC],
          fromBlock: '0x' + fromBlock.toString(16),
          toBlock: '0x' + toBlock.toString(16),
        }],
      }),
    }),
    fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'eth_getLogs',
        params: [{
          address: STAKING_CONTRACT,
          topics: [UNSTAKED_EVENT_TOPIC],
          fromBlock: '0x' + fromBlock.toString(16),
          toBlock: '0x' + toBlock.toString(16),
        }],
      }),
    }),
  ]);

  const events: StakingEvent[] = [];

  // Parse Staked events: data = abi.encode(uint256 amount, uint256 duration)
  if (stakesRes.ok) {
    const data = await stakesRes.json();
    for (const log of data.result ?? []) {
      if (log.data.length < 130) continue;
      const wallet = '0x' + log.topics[1].slice(26);
      const amount = parseAmount(log.data.slice(2, 66));
      const durationRaw = BigInt('0x' + log.data.slice(66));

      if (amount >= MIN_AMOUNT) {
        events.push({
          type: 'stake',
          wallet,
          amount,
          lockDuration: durationToLabel(durationRaw),
          txHash: log.transactionHash,
          blockNumber: parseInt(log.blockNumber, 16),
        });
      }
    }
  }

  // Parse Unstaked events: data = abi.encode(uint256 amount, uint256 unlockBlock)
  if (unstakesRes.ok) {
    const data = await unstakesRes.json();
    for (const log of data.result ?? []) {
      if (log.data.length < 130) continue;
      const wallet = '0x' + log.topics[1].slice(26);
      const amount = parseAmount(log.data.slice(2, 66));
      const unlockBlock = BigInt('0x' + log.data.slice(66));
      const blockNumber = parseInt(log.blockNumber, 16);

      if (amount >= MIN_AMOUNT) {
        events.push({
          type: 'unstake',
          wallet,
          amount,
          lockDuration: deriveLockDuration(unlockBlock, blockNumber),
          txHash: log.transactionHash,
          blockNumber,
        });
      }
    }
  }

  // Sort by block number (oldest first)
  events.sort((a, b) => a.blockNumber - b.blockNumber);
  return events;
}

async function sendDiscordEmbed(event: StakingEvent): Promise<void> {
  const isStake = event.type === 'stake';
  const color = isStake
    ? (DURATION_COLORS[event.lockDuration] ?? 0x5EB851)
    : UNSTAKE_COLOR;
  const emoji = isStake
    ? (event.lockDuration === 'Flexible' ? '\uD83D\uDD13' : '\uD83D\uDD12')
    : '\uD83D\uDCE4'; // 📤
  const action = isStake ? 'Staked' : 'Unstaked';

  const embed = {
    title: `${emoji} ${formatAmount(event.amount)} LINGO ${action}`,
    color,
    fields: [
      { name: 'Wallet', value: `[\`${shortenAddress(event.wallet)}\`](https://basescan.org/address/${event.wallet})`, inline: true },
      { name: isStake ? 'Lock Duration' : 'Was Locked', value: event.lockDuration, inline: true },
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

    const fromBlock = lastBlock ? lastBlock + 1 : latestBlock - DEFAULT_LOOKBACK;
    const events = await getStakingEvents(fromBlock, latestBlock);

    if (events.length === 0) {
      await saveLastSeenBlock(latestBlock);
      return res.status(200).json({
        message: 'No new activity above 10K',
        fromBlock,
        toBlock: latestBlock,
      });
    }

    let staked = 0;
    let unstaked = 0;
    for (const event of events) {
      await sendDiscordEmbed(event);
      if (event.type === 'stake') staked++;
      else unstaked++;
    }

    await saveLastSeenBlock(latestBlock);

    return res.status(200).json({
      message: `Posted ${staked} stakes + ${unstaked} unstakes to Discord`,
      fromBlock,
      toBlock: latestBlock,
      staked,
      unstaked,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
