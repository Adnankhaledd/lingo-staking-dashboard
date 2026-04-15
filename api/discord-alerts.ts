import type { VercelRequest, VercelResponse } from '@vercel/node';
import { put, list } from '@vercel/blob';

// Inline blob helper — direct URL fetch with list() fallback
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

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const MIN_AMOUNT = 10_000;
const BLOB_KEY = 'discord-last-block.json';
const LINGO_DECIMALS = 18;
const SEEN_TX_LIMIT = 500; // rolling window of tx hashes for dedupe

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

interface StakingEvent {
  type: 'stake';
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

interface DiscordState {
  lastBlock: number | null;
  seenTxHashes: string[];
}

async function getDiscordState(): Promise<DiscordState> {
  try {
    // Direct URL fetch — zero Blob SDK operations
    const data = await fetchBlobJson<{ lastBlock: unknown; seenTxHashes?: unknown }>(BLOB_KEY);
    if (!data) return { lastBlock: null, seenTxHashes: [] };

    let lastBlock: number | null = null;
    const val = data.lastBlock;
    if (val != null) {
      if (typeof val === 'string') lastBlock = parseInt(val, 16) || null;
      else if (typeof val === 'number') lastBlock = val;
    }

    const seenTxHashes = Array.isArray(data.seenTxHashes)
      ? data.seenTxHashes.filter((h): h is string => typeof h === 'string')
      : [];

    return { lastBlock, seenTxHashes };
  } catch {
    return { lastBlock: null, seenTxHashes: [] };
  }
}

async function saveDiscordState(state: DiscordState): Promise<void> {
  // Trim seenTxHashes to rolling window to keep blob small
  const trimmed = state.seenTxHashes.slice(-SEEN_TX_LIMIT);
  await put(BLOB_KEY, JSON.stringify({
    lastBlock: state.lastBlock,
    seenTxHashes: trimmed,
    updatedAt: new Date().toISOString(),
  }), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

// getStakes(address) selector = 0x7ba6f458
// Returns Position[] where Position = { uint256 amount, uint256 unlockBlock }
async function getTotalStaked(wallet: string): Promise<number> {
  try {
    // Pad wallet address to 32 bytes
    const paddedAddr = wallet.toLowerCase().replace('0x', '').padStart(64, '0');
    const res = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: STAKING_CONTRACT, data: '0x7ba6f458' + paddedAddr }, 'latest'],
      }),
    });
    const data = await res.json();
    if (!data.result || data.result === '0x') return 0;

    const hex = data.result.slice(2); // remove 0x
    // ABI decode: offset (32 bytes) + length (32 bytes) + Position[] entries (each 64 bytes = amount + unlockBlock)
    if (hex.length < 128) return 0;
    const count = parseInt(hex.slice(64, 128), 16);
    let total = BigInt(0);
    for (let i = 0; i < count; i++) {
      const offset = 128 + i * 128; // each Position is 2 x 32 bytes = 128 hex chars
      if (offset + 64 > hex.length) break;
      const amount = BigInt('0x' + hex.slice(offset, offset + 64));
      total += amount;
    }
    return Number(total / BigInt(10 ** (LINGO_DECIMALS - 2))) / 100;
  } catch {
    return 0;
  }
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

async function getStakingEvents(fromBlock: number, toBlock: number): Promise<StakingEvent[]> {
  const stakesRes = await fetch(ALCHEMY_URL, {
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
  });

  const events: StakingEvent[] = [];

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

  events.sort((a, b) => a.blockNumber - b.blockNumber);
  return events;
}

async function sendDiscordEmbed(event: StakingEvent, totalStaked: number): Promise<void> {
  const color = DURATION_COLORS[event.lockDuration] ?? 0x5EB851;
  const emoji = event.lockDuration === 'Flexible' ? '\uD83D\uDD13' : '\uD83D\uDD12';

  const fields = [
    { name: 'Wallet', value: `[\`${shortenAddress(event.wallet)}\`](https://basescan.org/address/${event.wallet})`, inline: true },
    { name: 'Lock Duration', value: event.lockDuration, inline: true },
    { name: 'Amount', value: `${event.amount.toLocaleString()} LINGO`, inline: true },
  ];

  if (totalStaked > 0) {
    fields.push({ name: 'Total Staked', value: `${formatAmount(totalStaked)} LINGO`, inline: true });
  }

  const embed = {
    title: `${emoji} ${formatAmount(event.amount)} LINGO Staked`,
    color,
    fields,
    footer: { text: 'Lingo Staking Bot' },
    url: `https://basescan.org/tx/${event.txHash}`,
  };

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Lingo Staking', embeds: [embed] }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord webhook failed: ${response.status} ${body.slice(0, 200)}`);
  }
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
    const [state, latestBlock] = await Promise.all([
      getDiscordState(),
      getLatestBlock(),
    ]);

    const fromBlock = state.lastBlock ? state.lastBlock + 1 : latestBlock - DEFAULT_LOOKBACK;
    const events = await getStakingEvents(fromBlock, latestBlock);

    // Build Set from previously-seen tx hashes for O(1) dedup checks
    const seenSet = new Set(state.seenTxHashes);

    if (events.length === 0) {
      await saveDiscordState({ lastBlock: latestBlock, seenTxHashes: state.seenTxHashes });
      return res.status(200).json({
        message: 'No new activity above 10K',
        fromBlock,
        toBlock: latestBlock,
      });
    }

    let posted = 0;
    let skipped = 0;

    for (const event of events) {
      // Dedupe: if we've already posted this tx hash, skip it
      if (seenSet.has(event.txHash)) {
        skipped++;
        continue;
      }

      const totalStaked = await getTotalStaked(event.wallet);
      await sendDiscordEmbed(event, totalStaked);

      // Mark as seen and persist immediately — if the next step fails,
      // subsequent runs will still see this tx hash and skip it.
      seenSet.add(event.txHash);
      posted++;

      try {
        await saveDiscordState({
          lastBlock: state.lastBlock, // don't advance block pointer until all events processed
          seenTxHashes: Array.from(seenSet),
        });
      } catch (saveErr) {
        console.warn('Failed to persist seenTxHashes mid-loop:', saveErr);
        // continue — worst case, duplicate happens once; better than crashing the loop
      }
    }

    // Final save: advance the lastBlock pointer now that all events are handled
    await saveDiscordState({
      lastBlock: latestBlock,
      seenTxHashes: Array.from(seenSet),
    });

    return res.status(200).json({
      message: `Posted ${posted} stakes (skipped ${skipped} duplicates)`,
      fromBlock,
      toBlock: latestBlock,
      posted,
      skipped,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
