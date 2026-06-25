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
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const MIN_AMOUNT = 10_000;
const BLOB_KEY = 'discord-last-block.json';
const LINGO_DECIMALS = 18;
const SEEN_TX_LIMIT = 500; // rolling window of tx hashes for dedupe
const KNOWN_STAKERS_LIMIT = 50_000; // cached wallet classifications — bounds blob size

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
  knownStakers: string[]; // wallets we've already classified (cache for "new vs returning")
}

async function getDiscordState(): Promise<DiscordState> {
  try {
    // Direct URL fetch — zero Blob SDK operations
    const data = await fetchBlobJson<{
      lastBlock: unknown;
      seenTxHashes?: unknown;
      knownStakers?: unknown;
    }>(BLOB_KEY);
    if (!data) return { lastBlock: null, seenTxHashes: [], knownStakers: [] };

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

    return { lastBlock, seenTxHashes, knownStakers };
  } catch {
    return { lastBlock: null, seenTxHashes: [], knownStakers: [] };
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

async function sendDiscordEmbed(
  event: StakingEvent,
  totalStaked: number,
  stakerType: 'new' | 'returning',
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
): Promise<void> {
  const emoji = event.lockDuration === 'Flexible' ? '🔓' : '🔒';
  const stakerLabel = stakerType === 'new' ? '🆕 New Staker' : '🔁 Returning';

  const fields: Array<{ type: 'mrkdwn'; text: string }> = [
    { type: 'mrkdwn', text: `*Wallet:*\n<https://basescan.org/address/${event.wallet}|\`${shortenAddress(event.wallet)}\`>` },
    { type: 'mrkdwn', text: `*Lock Duration:*\n${event.lockDuration}` },
    { type: 'mrkdwn', text: `*Amount:*\n${event.amount.toLocaleString()} LINGO` },
  ];
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
  '0x9399da51c1a85e64cce4b30b554875d2b89b2445': 'Liquidity',
  '0x7e3e2d6b8b87ce617b7ccdd63d0f5449e4057513': 'Team Buybacks',
  '0x69892fc8e176d9750e7f0ca06fc9aede0fc97bcb': 'Team Buybacks',
  '0x61f8d3fc749ecda98d378bc2cc8459ba0f7dfd58': 'Team Multisig',
  '0x7c91baca69ad289ec5de46b0b36287770a1ea91e': 'Distribution',
};
// Project-owned distribution/claim contracts (verified on-chain: owner() ==
// Treasury). LINGO arriving from one of these is a claim/distribution, not a buy.
const PROV_CLAIM_CONTRACTS = new Set([
  '0x2f26621e931c32542579cf8860d7e8616df32e0e', // Treasury-owned distribution contract
]);
const PROV_WINDOW_BLOCKS = 43_200; // ~24h on Base

type ProvenanceSource =
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
    // TIER A — same tx as the stake
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
        if (PROV_CLAIM_CONTRACTS.has(from)) return provMk('claimed', conf, 'From a project distribution/claim contract');
        if ((await provGetCode(from)) !== '0x') return provMk('claimed', 'low', `From contract ${from.slice(0, 10)}… in the stake tx (no claim event)`);
      }
    }
    // TIER B — most recent inbound LINGO in the ~24h before the stake (drop the stake tx itself)
    const transfers = (await provInbound(walletLc, input.stakeBlock - PROV_WINDOW_BLOCKS, input.stakeBlock))
      .filter(t => t.hash.toLowerCase() !== input.stakeTxHash.toLowerCase());
    if (transfers.length === 0) return provMk('preheld', 'low', 'No inbound LINGO in the ~24h before staking');
    const latest = transfers[0];
    const from = latest.from.toLowerCase();
    const multi = new Set(transfers.map(t => t.from.toLowerCase())).size > 1;
    if (from === STAKING_CONTRACT) return provMk('restaked', multi ? 'medium' : 'high', 'Unstaked then re-staked');
    if (PROV_KNOWN_WALLETS[from]) return provMk('internal', multi ? 'medium' : 'high', `From ${PROV_KNOWN_WALLETS[from]}`);
    if (PROV_CLAIM_CONTRACTS.has(from)) return provMk('claimed', multi ? 'medium' : 'high', 'From a project distribution/claim contract');
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
    const [state, latestBlock] = await Promise.all([
      getDiscordState(),
      getLatestBlock(),
    ]);

    const fromBlock = state.lastBlock ? state.lastBlock + 1 : latestBlock - DEFAULT_LOOKBACK;
    const events = await getStakingEvents(fromBlock, latestBlock);

    // Build Sets from previous state for O(1) lookups
    const seenSet = new Set(state.seenTxHashes);
    const knownSet = new Set(state.knownStakers.map(w => w.toLowerCase()));

    if (events.length === 0) {
      await saveDiscordState({
        lastBlock: latestBlock,
        seenTxHashes: state.seenTxHashes,
        knownStakers: state.knownStakers,
      });
      return res.status(200).json({
        message: 'No new activity above 10K',
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
      if (DISCORD_WEBHOOK_URL) {
        await sendDiscordEmbed(event, totalStaked, stakerType);
      }
      // Slack adds the new Source section.
      if (SLACK_WEBHOOK_URL && provenance) {
        try {
          await sendSlackMessage(event, totalStaked, stakerType, provenance);
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
    });

    return res.status(200).json({
      message: `Posted ${posted} stakes (${newStakers} new, ${posted - newStakers} returning, skipped ${skipped} duplicates)`,
      fromBlock,
      toBlock: latestBlock,
      posted,
      newStakers,
      skipped,
    });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
