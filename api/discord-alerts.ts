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

export const config = { maxDuration: 60 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
// Alert floor is denominated in USD and converted to LINGO at the live price
// on every run, so the bar stays at $100 no matter where LINGO trades.
const MIN_USD = 100;
const FALLBACK_MIN_LINGO = 10_000;  // only when no live AND no cached price
// Clamp BOUNDS the blast radius of a bad price; it does not eliminate it.
// At a sane ~$0.014 the floor is ~7.1k LINGO, so 1k..1M pins the effective
// threshold to roughly $14..$14k instead of 0..infinity.
const MIN_LINGO_FLOOR = 1_000;
const MIN_LINGO_CEIL = 1_000_000;
// A cached price older than this is worse than no price at all — LINGO moved
// 33% in a week recently, so a stale quote silently misplaces the bar.
const MAX_PRICE_AGE_MS = 24 * 60 * 60 * 1000;
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const PRICES_URL = `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/by-address`;
const BLOB_KEY = 'discord-last-block.json';
const LINGO_DECIMALS = 18;
const SEEN_TX_LIMIT = 500; // rolling window of tx hashes for dedupe
const KNOWN_STAKERS_LIMIT = 50_000; // cached wallet classifications — bounds blob size

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

function formatUsd(v: number): string {
  return v >= 1000
    ? Math.round(v).toLocaleString()
    : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function parseAmount(hex: string): number {
  const raw = BigInt('0x' + hex);
  return Number(raw / BigInt(10 ** (LINGO_DECIMALS - 2))) / 100;
}

/** Live LINGO/USD from the Alchemy Prices API. null on any failure. */
async function getLingoPriceUsd(): Promise<number | null> {
  try {
    const res = await fetch(PRICES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: [{ network: 'base-mainnet', address: LINGO_TOKEN }] }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const prices = json?.data?.[0]?.prices;
    if (!Array.isArray(prices)) return null;
    const usd = prices.find((p: { currency?: string }) => p?.currency === 'usd');
    const price = Number(usd?.value);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * LINGO amount worth MIN_USD at `priceUsd`, clamped. The clamp is a safety
 * rail, not a preference: a garbage price would otherwise either flood the
 * channel (price too high -> threshold near zero) or mute it entirely.
 */
function thresholdFor(priceUsd: number | null): number {
  if (priceUsd == null) return FALLBACK_MIN_LINGO;
  const raw = MIN_USD / priceUsd;
  return Math.min(MIN_LINGO_CEIL, Math.max(MIN_LINGO_FLOOR, raw));
}

interface DiscordState {
  lastBlock: number | null;
  seenTxHashes: string[];
  knownStakers: string[]; // wallets we've already classified (cache for "new vs returning")
  lastPriceUsd: number | null; // last good LINGO price, rides out price-API blips
  lastPriceAt: number | null;  // epoch ms of that price, so we can expire it
}

async function getDiscordState(): Promise<DiscordState> {
  try {
    // Direct URL fetch — zero Blob SDK operations
    const data = await fetchBlobJson<{
      lastBlock: unknown;
      seenTxHashes?: unknown;
      knownStakers?: unknown;
      lastPriceUsd?: unknown;
      lastPriceAt?: unknown;
    }>(BLOB_KEY);
    if (!data) return { lastBlock: null, seenTxHashes: [], knownStakers: [], lastPriceUsd: null, lastPriceAt: null };

    let lastBlock: number | null = null;
    const val = data.lastBlock;
    if (val != null) {
      if (typeof val === 'string') lastBlock = parseInt(val, 16) || null;
      else if (typeof val === 'number') lastBlock = val;
    }

    const seenTxHashes = Array.isArray(data.seenTxHashes)
      ? data.seenTxHashes.filter((h): h is string => typeof h === 'string')
      : [];

    const knownStakers = Array.isArray(data.knownStakers)
      ? data.knownStakers.filter((w): w is string => typeof w === 'string')
      : [];

    const cachedPrice = Number(data.lastPriceUsd);
    const lastPriceUsd = Number.isFinite(cachedPrice) && cachedPrice > 0 ? cachedPrice : null;
    const cachedAt = Number(data.lastPriceAt);
    const lastPriceAt = Number.isFinite(cachedAt) && cachedAt > 0 ? cachedAt : null;

    return { lastBlock, seenTxHashes, knownStakers, lastPriceUsd, lastPriceAt };
  } catch {
    return { lastBlock: null, seenTxHashes: [], knownStakers: [], lastPriceUsd: null, lastPriceAt: null };
  }
}

async function saveDiscordState(state: DiscordState): Promise<void> {
  // Trim rolling windows to keep blob size bounded
  const trimmedTx = state.seenTxHashes.slice(-SEEN_TX_LIMIT);
  const trimmedStakers = state.knownStakers.slice(-KNOWN_STAKERS_LIMIT);
  await put(BLOB_KEY, JSON.stringify({
    lastBlock: state.lastBlock,
    seenTxHashes: trimmedTx,
    knownStakers: trimmedStakers,
    lastPriceUsd: state.lastPriceUsd,
    lastPriceAt: state.lastPriceAt,
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

// Check whether a wallet has any Staked event from a block strictly earlier
// than `beforeBlock`. Uses Alchemy eth_getLogs with the indexed wallet topic so
// the response is just this wallet's events (small, fast).
async function hasStakedBefore(wallet: string, beforeBlock: number): Promise<boolean> {
  const paddedAddr = '0x' + wallet.toLowerCase().replace('0x', '').padStart(64, '0');
  const toBlock = Math.max(0, beforeBlock - 1);
  const res = await fetch(ALCHEMY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
      params: [{
        address: STAKING_CONTRACT,
        topics: [STAKED_EVENT_TOPIC, paddedAddr],
        fromBlock: '0x0',
        toBlock: '0x' + toBlock.toString(16),
      }],
    }),
  });
  if (!res.ok) throw new Error(`hasStakedBefore eth_getLogs ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`hasStakedBefore: ${JSON.stringify(data.error)}`);
  const logs = data.result ?? [];
  return logs.length > 0;
}

// Classify a wallet as 'new' or 'returning'. Uses the cached knownSet to skip
// RPC calls for wallets we've already seen. On RPC failure, falls back to
// 'returning' (conservative — avoids mislabeling an existing staker as new).
async function classifyStaker(
  wallet: string,
  blockNumber: number,
  knownSet: Set<string>,
): Promise<'new' | 'returning'> {
  const w = wallet.toLowerCase();
  if (knownSet.has(w)) return 'returning';
  try {
    const hasPrior = await hasStakedBefore(w, blockNumber);
    return hasPrior ? 'returning' : 'new';
  } catch (err) {
    console.warn(`classifyStaker failed for ${w}:`, err instanceof Error ? err.message : err);
    return 'returning';
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

async function getStakingEvents(fromBlock: number, toBlock: number, minAmount: number): Promise<StakingEvent[]> {
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

      if (amount >= minAmount) {
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

async function sendDiscordEmbed(
  event: StakingEvent,
  totalStaked: number,
  stakerType: 'new' | 'returning',
  usdValue: number | null = null,
): Promise<void> {
  const color = DURATION_COLORS[event.lockDuration] ?? 0x5EB851;
  const emoji = event.lockDuration === 'Flexible' ? '\uD83D\uDD13' : '\uD83D\uDD12';

  // "🆕 New Staker" or "🔁 Returning"
  const stakerLabel = stakerType === 'new'
    ? '\uD83C\uDD95 New Staker'
    : '\uD83D\uDD01 Returning';

  const fields = [
    { name: 'Wallet', value: `[\`${shortenAddress(event.wallet)}\`](https://basescan.org/address/${event.wallet})`, inline: true },
    { name: 'Lock Duration', value: event.lockDuration, inline: true },
    { name: 'Amount', value: `${event.amount.toLocaleString()} LINGO`, inline: true },
  ];

  if (usdValue != null) {
    fields.push({ name: 'USD Value', value: `$${formatUsd(usdValue)}`, inline: true });
  }

  if (totalStaked > 0) {
    fields.push({ name: 'Total Staked', value: `${formatAmount(totalStaked)} LINGO`, inline: true });
  }

  fields.push({ name: 'Type', value: stakerLabel, inline: true });

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

// Slack Block Kit message — same content as the Discord embed PLUS a Source
// line from the provenance classifier. Posts only when SLACK_WEBHOOK_URL is set.
async function sendSlackMessage(
  event: StakingEvent,
  totalStaked: number,
  stakerType: 'new' | 'returning',
  provenance: Provenance,
  usdValue: number | null = null,
): Promise<void> {
  const emoji = event.lockDuration === 'Flexible' ? '🔓' : '🔒';
  const stakerLabel = stakerType === 'new' ? '🆕 New Staker' : '🔁 Returning';

  const fields: Array<{ type: 'mrkdwn'; text: string }> = [
    { type: 'mrkdwn', text: `*Wallet:*\n<https://basescan.org/address/${event.wallet}|\`${shortenAddress(event.wallet)}\`>` },
    { type: 'mrkdwn', text: `*Lock Duration:*\n${event.lockDuration}` },
    { type: 'mrkdwn', text: `*Amount:*\n${event.amount.toLocaleString()} LINGO` },
  ];
  if (usdValue != null) {
    fields.push({ type: 'mrkdwn', text: `*USD Value:*\n$${formatUsd(usdValue)}` });
  }
  if (totalStaked > 0) {
    fields.push({ type: 'mrkdwn', text: `*Total Staked:*\n${formatAmount(totalStaked)} LINGO` });
  }
  fields.push({ type: 'mrkdwn', text: `*Type:*\n${stakerLabel}` });
  // NEW: the source section the user asked for
  const sourceText = `${provenance.emoji} ${provenance.label}` +
    (provenance.detail ? `\n_${provenance.detail}_` : '');
  fields.push({ type: 'mrkdwn', text: `*Source:*\n${sourceText}` });

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${emoji} ${formatAmount(event.amount)} LINGO Staked`, emoji: true } },
    { type: 'section', fields },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `<https://basescan.org/tx/${event.txHash}|View transaction> · Lingo Staking Bot` }] },
  ];

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${formatAmount(event.amount)} LINGO staked — ${provenance.label}`, blocks }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Slack webhook failed: ${response.status} ${body.slice(0, 200)}`);
  }
}

// ─── Stake provenance classifier (inlined — Vercel does not bundle api/_lib) ──
// See git history / the original module for the design rationale. Helper names
// are prefixed `prov` so this block drops into any api function without
// colliding with that file's own helpers.
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
  '0x7e3e2d6b8b87ce617b7ccdd63d0f5449e4057513': 'Team Buybacks',
  '0x69892fc8e176d9750e7f0ca06fc9aede0fc97bcb': 'Team Buybacks',
  '0x61f8d3fc749ecda98d378bc2cc8459ba0f7dfd58': 'Team Multisig',
  '0x0fe275fdfde7eb75a15c0ae8971450dd6f06e7f8': 'Project Safe',
  '0x8557ef53d037408d225479dd8544dffb06c88d46': 'Liquidity Locker',
  '0x3ea37aa113b092dd14dfada7118efb919c092d0d': 'Liquidity Locker',
  '0xc588e4415ab61aa8a9496efbe9d715de75550e2a': 'Deployer',
};
// DEX pools and swap routers/aggregators. LINGO leaving one of these is
// somebody BUYING it, not a project transfer. The V3 pool used to sit in
// PROV_KNOWN_WALLETS, so every buy through it read as "From Liquidity".
const PROV_DEX_POOLS: Record<string, string> = {
  '0x9399da51c1a85e64cce4b30b554875d2b89b2445': 'the LINGO/WETH V3 pool',
  '0xb08fefa8f0f01b9a224fdef416e919b1ceba0d84': 'the LINGO/WETH V2 pair',
  '0x6d85d9f6d80b433ef9eed943e83868d71805a6cd': 'the LINGO/WETH 1% pool',
  '0x498581ff718922c3f8e6a244956af099b2652b2b': 'the Uniswap V4 pool',
  '0x675177f8ede3f25f8149b4e9df7562798014467f': 'the Aerodrome USDC/LINGO pool',
  '0x6d2205bd16d9f132713e00fb9e1da8ffb5150d37': 'an Aerodrome LINGO pool',
  '0x1ba7301b43b69f1dc9a6d2017b090a52ff386478': 'an Aerodrome LINGO pool',
  '0x0191fea2ff26116dec46ea699c65b8696020e766': 'an Aerodrome LINGO pool',
};
// A router/aggregator delivering LINGO means the user swapped for it.
const PROV_ROUTERS: Record<string, string> = {
  '0x6ff5693b99212da76ad316178a184ab56d299b43': 'Uniswap',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap',
  '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap',
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aerodrome',
  '0x6cb442acf35158d5eda88fe602221b67b400be3e': 'Aerodrome',
  '0x19ceead7105607cd444f5ad10dd51356436095a1': 'Odos',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch',
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'KyberSwap',
  '0xc7d3ab410d49b664d03fe5b1038852ac852b1b29': 'KyberSwap',
  '0x6a000f20005980200259b80c5102003040001068': 'ParaSwap',
  '0xdef171fe48cf0115b1d80b88dc8eab59176fee57': 'ParaSwap',
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41': 'CoW Swap',
  '0x6352a56caadc4f1e25cd6c75970fa768a3304e64': 'OpenOcean',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x/Matcha',
  '0x053bd88ae6fb19ad94d6ac781dcfc178a463436c': '0x/Matcha',
  '0xdb6f1920a889355780af7570773609bd8cb1f498': '0x/Matcha',
  '0x881d40237659c251811cec9c364ef91dc08d300c': 'MetaMask Swaps',
  '0x67d03631fe51b741c0c00c4e16eb662ac84381df': 'OKX DEX',
  '0x6b2c0c7be2048daa9b5527982c29f48062b34d58': 'OKX DEX',
  '0x5e8df5b010d57e525562791717011d496676552a': 'OKX DEX',
  '0x3d98f6f05e7940c056788ff8492a943a0904240d': 'OKX DEX',
  '0x69c236e021f5775b0d0328ded5eac708e3b869df': 'OKX DEX',
  '0x5e2f47bd7d4b357fcfd0bb224eb665773b1b9801': 'OKX DEX',
  '0x2bd541ab3b704f7d4c9dff79efadeaa85ec034f1': 'OKX DEX',
  '0xbc1d9760bd6ca468ca9fb5ff2cfbeac35d86c973': 'Bitget DEX',
  '0xb141f554188cf306fde443f6e991949636f80e49': 'Bitget Swap',
  '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae': 'LI.FI/Jumper',
  '0x02e5be68d46dac0b524905bff209cf47ee6db2a9': 'a swap proxy',
  '0x278d858f05b94576c1e6f73285886876ff6ef8d2': 'a swap router',
  '0x411d2c093e4c2e69bf0d8e94be1bf13dadd879c6': 'an aggregator',
  '0xd688ab46dc476a05a093e4442d06ceb348adbda8': 'an aggregator',
};
// Bridges. LINGO is Base-native, so a bridge is rarely the direct sender —
// the exception is Wormhole NTT (lock/release), which really does deliver it.
const PROV_BRIDGES: Record<string, string> = {
  '0x7c91baca69ad289ec5de46b0b36287770a1ea91e': 'Wormhole NTT',
  '0xfcb443fd643a09f4740214bc1895b0f31a109f3d': 'Wormhole NTT',
  '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f': 'Relay',
  '0xa5f565650890fba1824ee0f21ebbbf660a179934': 'Relay',
  '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be': 'Relay',
  '0x4cd00e387622c35bddb9b4c962c136462338bc31': 'Relay',
  '0xf70da97812cb96acdf810712aa562db8dfa3dbef': 'Relay',
  '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64': 'Across',
  '0x3a23f943181408eac424116af7b7790c94cb97a5': 'Socket/Bungee',
  '0xe7351fd770a37282b91d153ee690b63579d6dd7f': 'deBridge',
  '0x7e7a0e201fd38d3adaa9523da6c109a07118c96a': 'Synapse',
  '0x4200000000000000000000000000000000000010': 'the Base bridge',
  '0x80c67432656d59144ceff962e8faf8926599bcf8': 'Orbiter',
  '0xe4edb277e41dc89ab076a1f049f4a3efa700bce8': 'Orbiter',
};
// Centralised-exchange wallets. A CEX withdrawal means the user BOUGHT there,
// so it is a purchase, not a plain wallet transfer. Only addresses whose
// exchange label was verified are listed. 0x18b0f454 (KuCoin 57) and
// 0x4e3ae00e (MEXC 15) were both observed funding real LINGO stakers.
const PROV_CEX_WALLETS: Record<string, string> = {
  '0x18b0f4547a89fe4c5fe84f258bea3601fa281e9f': 'KuCoin',
  '0xb8e6d31e7b212b2b7250ee9c26c56cebbfbe6b23': 'KuCoin',
  '0x4e3ae00e8323558fa5cac04b152238924aa31b60': 'MEXC',
  '0x0d0707963952f2fba59dd06f2b425ace40b492fe': 'Gate.io',
  '0x6596da8b65995d5feacff8c2936f0b7a2051b0d0': 'Gate.io',
  '0xc882b111a75c0c657fc507c04fbfcd2cc984f071': 'Gate.io',
  '0x7793cd85c11a924478d358d49b05b37e91b5810f': 'Gate.io',
  '0x1c4b70a3968436b9a0a9cf5205c787eb81bb558c': 'Gate.io',
  '0x234ee9e35f8e9749a002fc42970d570db716453b': 'Gate.io',
  '0x05ee546c1a62f90d7acbffd6d846c9c54c7cf94c': 'Gate.io',
  '0x9c4fe1c3d5975e5c5e493f24352969aa280b7cfc': 'LBank',
  '0xbaed383ede0e5d9d72430661f3285daa77e9439f': 'Bybit',
  '0x2ded5ce31a0c61ecaf6429a1ba1a00b2bfe67099': 'Bybit',
  '0x0051ef9259c7ec0644a80e866ab748a2f30841b3': 'Bybit',
  '0xb5873e333161e5b45adac57379ec2b15d861178d': 'Bybit',
  '0x4ce053dfe58541e08f149c1050eb3df09d7a40bc': 'Bybit',
  '0x97b9d2102a9a65a26e1ee82d59e42d1b73b68689': 'Bitget',
  '0xffa8db7b38579e6a2d14f9b347a9ace4d044cd54': 'Bitget',
  '0x2b3bf74b29f59fb8dda41cf3d6a8da28cf8e7921': 'BingX',
  '0xd38cf87f114f2a0582c329fb9df4f7044ce71330': 'BingX',
  '0x406c22b8740ae955b04fd11c2061e053807e2a69': 'BingX',
  '0x74b0e133bee3384dfcfa60b31d85d8e2062de811': 'BingX',
  '0x6c69fa64ec451b1bc5b5fbaa56cf648a281634be': 'BingX',
  '0xaf1e33f8153f25e304dec5cb544b5b6ccc5520ed': 'BingX',
  '0xef317e433b0836f294866d43f67d6871b609b351': 'BingX',
  '0x1651d700cd4020334bd185ba4c6e0271ffc0c732': 'BingX',
  '0xdec815281519f6cb080090317e0ba3e446fafe43': 'BingX',
  '0xc4334a9af50c80a12c484de643149f6159bdd110': 'BingX',
  '0xb48c5ca99d33a8625e125f69ac8e07f3dffe34a0': 'BingX',
  '0xc3dcd744db3f114f0edf03682b807b78a227bf74': 'BingX',
  '0x7a8ba143f8866242782e5b3a5ad1410bb6722206': 'HTX',
  '0xdb861e302ef7b7578a448e951aede06302936c28': 'Phemex',
  '0x3304e22ddaa22bcdc5fca2269b418046ae7b566a': 'Binance',
  '0x9430801ebaf509ad49202aabc5f5bc6fd8a3daf8': 'Binance',
  '0xe69f81b825d7dc31ee9becef4dbeab5cf30e3abb': 'Binance',
  '0x15ece0d7de25436bcfcf3d62a9085ddc7838aee9': 'Binance',
  '0xf977814e90da44bfa03b6295a0616a897441acec': 'Binance',
  '0x1985ea6e9c68e1c272d8209f3b478ac2fdb25c87': 'Coinbase',
  '0x91d66b38ae24292e9e12dd962bbb3aecf4ab769a': 'Coinbase',
  '0x6dcbce46a8b494c885d0e7b6817d2b519df64467': 'Coinbase',
  '0x739120ade7ed878fca5bbdb806263a8258fe2360': 'Coinbase',
  '0x20fe51a9229eef2cf8ad9e89d91cab9312cf3b7a': 'Coinbase',
  '0xb4807865a786e9e9e26e6a9610f2078e7fc507fb': 'Coinbase',
  '0x40ebc1ac8d4fedd2e144b75fe9c0420be82750c6': 'Coinbase',
  '0xd34ea7278e6bd48defe656bbe263aef11101469c': 'Coinbase',
  '0xc5c10e7f6d31e3979d4466a099e2df4af8fa0208': 'Coinbase',
  '0x382ffce2287252f930e1c8dc9328dac5bf282ba1': 'Coinbase',
  '0xfd92f4e91d54b9ef91cc3f97c011a6af0c2a7eda': 'OKX',
  '0x39591e7c099a379fd7b349ebfecaeef439c40454': 'OKX',
  '0x10b7dfc30e290b77ded2550d66974c6a124dfa0d': 'OKX',
  '0x8db0f952b8b6a462445c732c41ec2937bcae9c35': 'OKX',
  '0x8744f9a43c22c804553835ba33c5c402af3c79d6': 'OKX',
  '0x42cf18596ee08e877d532df1b7cf763059a7ea57': 'OKX',
  '0xb4ec508adeb174610b4295e233a458b3475964f7': 'OKX',
  '0x6d046280c44c0fee770563614f7a7a71f156ca20': 'OKX',
  '0x64fa910048403c5d2243f471d63fca013ecb4d2b': 'OKX',
  '0xc215537e47a1d01058f3ba39dce6752d8f217bbd': 'OKX',
  '0x2ce910fbba65b454bbaf6a18c952a70f3bcd8299': 'OKX',
  '0xb604f2d512eaa32e06f1ac40362bc9157ce5da96': 'Kraken',
  '0xa6e5f4b57869b4a12e83e98bbcbccf0480c20861': 'Kraken',
  '0xbb2e8648035b760836c16ebb14f6b666f9ea1010': 'Kraken',
  '0x94dbf04e273d87e6d9bed68c616f43bf86560c74': 'Kraken',
  '0x50afe53eb8123d33061ae5b16c1ad2ce995f82a0': 'Kraken',
  '0x60e942f97fd46ab7a0dd5dced40ef2796c043c7d': 'Kraken',
  '0xae45a8240147e6179ec7c9f92c5a18f9a97b3fca': 'Crypto.com',
  '0xb7333d779c6ecdfc4507a53706b0e173bd086a18': 'Crypto.com',
};
// Reward-distribution hot wallet(s) — transfers from here are reward payouts.
const PROV_REWARD_WALLETS = new Set([
  '0xffc781ddfa8d1358ce8c7dda7ced1e56e922aea6', // current reward wallet
  '0x64967c0dd5605dd3efc6a9bb148b2687a532c15f', // previous reward wallet (still used)
]);
// Claim/distribution contracts (verified on-chain). LINGO arriving from one of
// these is a claim, not a buy. Each maps to its OWN source so the reports can
// tell an APY claim apart from a vesting unlock instead of lumping both under
// a single "claimed" bucket.
const PROV_CLAIM_CONTRACTS: Record<string, { source: ProvenanceSource; label: string }> = {
  '0x2f26621e931c32542579cf8860d7e8616df32e0e': { source: 'claimed_apy', label: 'APY reward claim' },
  '0xad11f733e401e16c72033c5decaf05dcc0e1beb8': { source: 'claimed_vesting', label: 'Vesting claim' },
  '0x8001b2029782bbf1b3c85c3a23ecae60e3fa0447': { source: 'claimed_vesting', label: 'Vesting claim (Decubate)' },
  '0x610111763a4a6c64dd8926c12ca3e52fb7b7897c': { source: 'claimed', label: 'Token claim' },
};
const PROV_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// Dust below this is address-poisoning spam, not funding. Ten spammer wallets
// account for 180k+ LINGO transfers worth almost nothing; unfiltered they
// would dominate the mix by sender count while funding none of the stake.
const PROV_DUST_LINGO = 1;
const PROV_WINDOW_BLOCKS = 43_200; // ~24h on Base

type ProvenanceSource =
  | 'bought' | 'bought_cex' | 'bridged'
  | 'claimed' | 'claimed_apy' | 'claimed_vesting' | 'reward' | 'restaked'
  | 'transferred' | 'transferred_bought_upstream' | 'internal' | 'preheld' | 'unknown';

interface ProvMixPart { source: ProvenanceSource; lingo: number; pct: number }

interface Provenance {
  source: ProvenanceSource;
  label: string;
  emoji: string;
  detail: string;
  confidence: 'high' | 'medium' | 'low';
  /** Full funding breakdown when the stake was funded from several sources. */
  mix?: ProvMixPart[];
}

const PROV_LABELS: Record<ProvenanceSource, { label: string; emoji: string }> = {
  bought:                      { label: 'Bought on DEX',                 emoji: '🛒' },
  bought_cex:                  { label: 'Bought on exchange',            emoji: '🏦' },
  bridged:                     { label: 'Bridged in',                    emoji: '🌉' },
  claimed:                     { label: 'Claimed (other)',               emoji: '🎁' },
  claimed_apy:                 { label: 'APY reward claim',              emoji: '📈' },
  claimed_vesting:             { label: 'Vesting claim',                 emoji: '⏳' },
  restaked:                    { label: 'Unstaked & re-staked',          emoji: '🔁' },
  transferred:                 { label: 'Transferred in',                emoji: '↔️' },
  transferred_bought_upstream: { label: 'Transferred (bought upstream)', emoji: '🛒' },
  internal:                    { label: 'From project wallet',           emoji: '🏦' },
  reward:                      { label: 'Reward payout',                 emoji: '💸' },
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
interface ProvReceiptSignals { hasSwap: boolean; hasClaim: boolean; claimFrom: string | null; inbound: ProvInboundLeg[] }

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
  let claimFrom: string | null = null;
  const inbound: ProvInboundLeg[] = [];
  for (const log of receipt.logs ?? []) {
    const topic0 = (log.topics?.[0] ?? '').toLowerCase();
    const addr = log.address?.toLowerCase() ?? '';
    if (PROV_SWAP_TOPICS.has(topic0)) hasSwap = true;
    if (PROV_CLAIM_TOPICS.has(topic0)) {
      hasClaim = true;
      // Remember WHICH contract emitted it, so an APY claim and a vesting
      // unlock don't collapse into the same bucket.
      if (!claimFrom && PROV_CLAIM_CONTRACTS[addr]) claimFrom = addr;
    }
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
  return { hasSwap, hasClaim, claimFrom, inbound };
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

const PROV_MAX_SENDERS = 6; // bound the RPC work spent classifying one stake

/**
 * EIP-7702: a delegated EOA's "code" is 0xef0100 || 20-byte implementation.
 * It is still an ordinary user wallet. Treating it as a contract mislabelled
 * roughly one in seven inbound LINGO transfers as a bogus "claimed".
 */
function provIsDelegatedEoa(code: string): boolean {
  return code.toLowerCase().startsWith('0xef0100');
}

/**
 * Classify ONE funding source. Order matters: pools, routers, exchanges and
 * bridges are all checked before the generic known-wallet map, because the
 * LINGO/WETH pool used to live in that map and every buy through it read as
 * a project transfer.
 */
async function provClassifySender(
  from: string,
  hash: string,
  blockNum: number,
  walletLc: string,
): Promise<{ source: ProvenanceSource; detail: string }> {
  if (from === STAKING_CONTRACT) return { source: 'restaked', detail: 'From the staking contract' };
  // A mint (from 0x0) is the vesting contract paying a claimer directly.
  if (from === PROV_ZERO_ADDRESS) return { source: 'claimed_vesting', detail: 'Minted by a vesting claim' };
  if (PROV_DEX_POOLS[from]) return { source: 'bought', detail: `Bought from ${PROV_DEX_POOLS[from]}` };
  if (PROV_ROUTERS[from]) return { source: 'bought', detail: `Swapped via ${PROV_ROUTERS[from]}` };
  if (PROV_CEX_WALLETS[from]) return { source: 'bought_cex', detail: `Withdrawn from ${PROV_CEX_WALLETS[from]}` };
  if (PROV_BRIDGES[from]) return { source: 'bridged', detail: `Bridged in via ${PROV_BRIDGES[from]}` };
  if (PROV_REWARD_WALLETS.has(from)) return { source: 'reward', detail: 'From a reward wallet' };
  if (PROV_CLAIM_CONTRACTS[from]) return { source: PROV_CLAIM_CONTRACTS[from].source, detail: PROV_CLAIM_CONTRACTS[from].label };
  if (PROV_KNOWN_WALLETS[from]) return { source: 'internal', detail: `From ${PROV_KNOWN_WALLETS[from]}` };

  const code = await provGetCode(from);
  if (code !== '0x' && !provIsDelegatedEoa(code)) {
    // A real contract we don't recognise. Try to read intent from the tx.
    const r = await provGetReceipt(hash);
    if (r) {
      const sig = provAnalyze(r, walletLc);
      if (sig.hasSwap) return { source: 'bought', detail: 'Received from a DEX/pool' };
      if (sig.hasClaim) {
        const cc = sig.claimFrom ? PROV_CLAIM_CONTRACTS[sig.claimFrom] : null;
        return { source: cc?.source ?? 'claimed', detail: cc ? `${cc.label} just before staking` : 'Claim event just before staking' };
      }
    }
    // Previously this guessed "claimed", which was simply a guess. Unknown is
    // honest, and surfaces the address so it can be added to a table above.
    return { source: 'unknown', detail: `From unrecognised contract ${from.slice(0, 10)}…` };
  }

  if (Number.isFinite(blockNum) && await provBoughtUpstream(from, blockNum)) {
    return { source: 'transferred_bought_upstream', detail: `Sent from ${from.slice(0, 10)}… which bought it on-chain` };
  }
  return { source: 'transferred', detail: `Wallet transfer from ${from.slice(0, 10)}…` };
}

async function classifyProvenance(input: ClassifyInput): Promise<Provenance> {
  try {
    const walletLc = input.wallet.toLowerCase();

    // TIER A - same tx as the stake. A swap/claim here is decisive.
    const stakeReceipt = await provGetReceipt(input.stakeTxHash);
    if (stakeReceipt) {
      const a = provAnalyze(stakeReceipt, walletLc);
      if (a.hasSwap) return provMk('bought', 'high', 'Swap in the stake tx');
      if (a.hasClaim) {
        const cc = a.claimFrom ? PROV_CLAIM_CONTRACTS[a.claimFrom] : null;
        return provMk(cc?.source ?? 'claimed', 'high', cc ? `${cc.label} in the stake tx` : 'Claim event in the stake tx');
      }
      const principal = a.inbound.slice().sort((x, y) => (y.value > x.value ? 1 : y.value < x.value ? -1 : 0))[0];
      if (principal && provToLingo(principal.value) >= input.amount * 0.5) {
        const c = await provClassifySender(principal.from, input.stakeTxHash, input.stakeBlock, walletLc);
        return provMk(c.source, a.inbound.length > 1 ? 'medium' : 'high', c.detail);
      }
    }

    // TIER B - every inbound LINGO in the ~24h before the stake, weighted BY
    // VALUE rather than by recency. Taking only the latest transfer misread the
    // two most common real patterns: a small reward landing right after a large
    // unstake made the whole stake look like a reward payout, and "unstaked,
    // then bought more" was reported as a pure re-stake with the buy invisible.
    const transfers = (await provInbound(walletLc, input.stakeBlock - PROV_WINDOW_BLOCKS, input.stakeBlock))
      .filter(t => t.hash.toLowerCase() !== input.stakeTxHash.toLowerCase());
    if (transfers.length === 0) return provMk('preheld', 'low', 'No inbound LINGO in the ~24h before staking');

    // Group by sender, largest first, so the RPC budget goes where the value is.
    const bySender = new Map<string, { lingo: number; hash: string; blockNum: number }>();
    for (const t of transfers) {
      const from = t.from?.toLowerCase();
      if (!from) continue;
      const v = typeof t.value === 'number' && Number.isFinite(t.value) ? t.value : 0;
      if (v < PROV_DUST_LINGO) continue; // address-poisoning spam, not funding
      const prev = bySender.get(from);
      if (prev) prev.lingo += v;
      else bySender.set(from, { lingo: v, hash: t.hash, blockNum: parseInt(t.blockNum, 16) });
    }
    const senders = [...bySender.entries()].sort((a, b) => b[1].lingo - a[1].lingo);
    const examined = senders.slice(0, PROV_MAX_SENDERS);

    const bySource = new Map<ProvenanceSource, { lingo: number; detail: string }>();
    for (const [from, info] of examined) {
      const c = await provClassifySender(from, info.hash, info.blockNum, walletLc);
      const b = bySource.get(c.source);
      if (b) b.lingo += info.lingo;
      else bySource.set(c.source, { lingo: info.lingo, detail: c.detail });
    }
    if (bySource.size === 0) return provMk('unknown', 'low', 'No attributable inbound transfers');

    const ranked = [...bySource.entries()].sort((a, b) => b[1].lingo - a[1].lingo);
    const total = ranked.reduce((sum, [, v]) => sum + v.lingo, 0);
    const [topSource, topInfo] = ranked[0];
    const share = total > 0 ? topInfo.lingo / total : 1;
    const mix: ProvMixPart[] = total > 0
      ? ranked.map(([source, v]) => ({ source, lingo: v.lingo, pct: Math.round((v.lingo / total) * 100) }))
      : [];

    // Confidence now tracks how CONCENTRATED the funding was, not sender count.
    const confidence: Provenance['confidence'] = share >= 0.9 ? 'high' : share >= 0.6 ? 'medium' : 'low';

    // Only call it "mixed" when a second source is actually visible at 1%+ —
    // a 100/0 rounding split should read as a plain single-source stake.
    const parts = mix.filter(m => m.pct > 0);
    let detail = topInfo.detail;
    if (parts.length > 1) {
      detail = 'Mixed funding \u2014 ' + parts
        .map(m => `${m.pct}% ${PROV_LABELS[m.source].label.toLowerCase()}`).join(', ');
    }
    const skipped = senders.length - examined.length;
    if (skipped > 0) detail += ` (+${skipped} smaller sender${skipped === 1 ? '' : 's'} not classified)`;

    return { ...provMk(topSource, confidence, detail), mix };
  } catch {
    return provMk('unknown', 'low', 'Classification error');
  }
}
// ─── end provenance classifier ─────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Need Alchemy + the staking contract, and at least one destination webhook.
  if (!ALCHEMY_API_KEY || !STAKING_CONTRACT || (!DISCORD_WEBHOOK_URL && !SLACK_WEBHOOK_URL)) {
    return res.status(200).json({
      message: 'Not configured',
      missing: [
        !ALCHEMY_API_KEY && 'ALCHEMY_API_KEY',
        !STAKING_CONTRACT && 'STAKING_CONTRACT_ADDRESS',
        (!DISCORD_WEBHOOK_URL && !SLACK_WEBHOOK_URL) && 'DISCORD_WEBHOOK_URL or SLACK_WEBHOOK_URL',
      ].filter(Boolean),
    });
  }

  try {
    const [state, latestBlock, livePrice] = await Promise.all([
      getDiscordState(),
      getLatestBlock(),
      getLingoPriceUsd(),
    ]);

    // Prefer the live price; fall back to the last good one so a transient
    // Prices-API blip doesn't move the bar — but only while it's fresh, since
    // a stale quote silently misplaces the threshold. thresholdFor handles null.
    const cacheAge = state.lastPriceAt != null ? Date.now() - state.lastPriceAt : Infinity;
    const cachedPrice = cacheAge < MAX_PRICE_AGE_MS ? state.lastPriceUsd : null;
    const priceUsd = livePrice ?? cachedPrice;
    const minAmount = thresholdFor(priceUsd);

    // Carry the freshest price we have into every save site below.
    const priceState = livePrice != null
      ? { lastPriceUsd: livePrice, lastPriceAt: Date.now() }
      : { lastPriceUsd: state.lastPriceUsd, lastPriceAt: state.lastPriceAt };

    // Cold start (no stored pointer: first deploy, or a Blob read that failed).
    // Do NOT replay a week of history into a live channel — these alerts are
    // meant to be live. Just claim the pointer and start clean. (Normal
    // catch-up after downtime still works: lastBlock persists across runs.)
    if (!state.lastBlock) {
      await saveDiscordState({
        lastBlock: latestBlock,
        seenTxHashes: state.seenTxHashes,
        knownStakers: state.knownStakers,
        ...priceState,
      });
      return res.status(200).json({
        message: 'Cold start — pointer initialised, no backfill posted',
        toBlock: latestBlock,
        minUsd: MIN_USD,
        minAmount: Math.round(minAmount),
        priceUsd,
      });
    }

    const fromBlock = state.lastBlock + 1;
    const events = await getStakingEvents(fromBlock, latestBlock, minAmount);

    // Build Sets from previous state for O(1) lookups
    const seenSet = new Set(state.seenTxHashes);
    const knownSet = new Set(state.knownStakers.map(w => w.toLowerCase()));

    if (events.length === 0) {
      await saveDiscordState({
        lastBlock: latestBlock,
        seenTxHashes: state.seenTxHashes,
        knownStakers: state.knownStakers,
        ...priceState,
      });
      return res.status(200).json({
        message: `No new activity above $${MIN_USD}`,
        minAmount: Math.round(minAmount),
        priceUsd,
        fromBlock,
        toBlock: latestBlock,
      });
    }

    let posted = 0;
    let skipped = 0;
    let newStakers = 0;

    for (const event of events) {
      // Dedupe: if we've already posted this tx hash, skip it
      if (seenSet.has(event.txHash)) {
        skipped++;
        continue;
      }

      const wallet = event.wallet.toLowerCase();

      // Fetch total staked, classify the wallet, and (only if Slack is on)
      // classify token provenance — all in parallel. Provenance is best-effort:
      // classifyProvenance never throws, so it can't break the Discord post.
      const [totalStaked, stakerType, provenance] = await Promise.all([
        getTotalStaked(wallet),
        classifyStaker(wallet, event.blockNumber, knownSet),
        SLACK_WEBHOOK_URL
          ? classifyProvenance({ wallet, stakeTxHash: event.txHash, stakeBlock: event.blockNumber, amount: event.amount })
          : Promise.resolve(null),
      ]);

      // Discord stays exactly as before (only when configured).
      const usdValue = priceUsd != null ? event.amount * priceUsd : null;
      if (DISCORD_WEBHOOK_URL) {
        await sendDiscordEmbed(event, totalStaked, stakerType, usdValue);
      }
      // Slack adds the new Source section.
      if (SLACK_WEBHOOK_URL && provenance) {
        try {
          await sendSlackMessage(event, totalStaked, stakerType, provenance, usdValue);
        } catch (slackErr) {
          console.warn('Slack post failed:', slackErr instanceof Error ? slackErr.message : slackErr);
        }
      }

      // Mark as seen and remember we've classified this wallet
      seenSet.add(event.txHash);
      knownSet.add(wallet);
      posted++;
      if (stakerType === 'new') newStakers++;

      try {
        await saveDiscordState({
          lastBlock: state.lastBlock, // don't advance block pointer until all events processed
          seenTxHashes: Array.from(seenSet),
          knownStakers: Array.from(knownSet),
          ...priceState,
        });
      } catch (saveErr) {
        console.warn('Failed to persist state mid-loop:', saveErr);
        // continue — worst case, duplicate happens once; better than crashing the loop
      }
    }

    // Final save: advance the lastBlock pointer now that all events are handled
    await saveDiscordState({
      lastBlock: latestBlock,
      seenTxHashes: Array.from(seenSet),
      knownStakers: Array.from(knownSet),
      ...priceState,
    });

    return res.status(200).json({
      message: `Posted ${posted} stakes (${newStakers} new, ${posted - newStakers} returning, skipped ${skipped} duplicates)`,
      fromBlock,
      toBlock: latestBlock,
      posted,
      newStakers,
      skipped,
      minUsd: MIN_USD,
      minAmount: Math.round(minAmount),
      priceUsd,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
