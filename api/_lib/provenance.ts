/**
 * Stake provenance classifier.
 *
 * Given a stake (wallet + stake tx + block + amount), figure out where the
 * staked LINGO came from by inspecting the SAME transaction first, then the
 * most recent inbound LINGO transfer in a tight window just before the stake
 * (mirrors the manual "look at the transaction right before it" method).
 *
 * Design notes (informed by an adversarial review):
 *  - We constrain to a short look-back window (~24h) so we never attribute an
 *    old, commingled balance. If nothing arrived in the window, we say so
 *    ("pre-held") instead of guessing.
 *  - We do NOT depend on an exact amount match (LINGO's transfer-fee mechanics
 *    are unverified), so we don't false-attribute via a fragile fee band.
 *  - We classify "claimed" by the source being a contract and/or a claim event
 *    in the funding tx — not by a hardcoded vesting list we don't have.
 *  - We do NOT attempt CEX detection (needs a curated hot-wallet list we don't
 *    maintain); CEX withdrawals fall under "transferred".
 *  - Every path is wrapped so a failure degrades to 'unknown' and never throws
 *    into the caller (the alert must still post).
 */

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const STAKING_CONTRACT = (process.env.STAKING_CONTRACT_ADDRESS || '').toLowerCase();
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';

// ERC-20 Transfer(address,address,uint256)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// DEX Swap signatures (Uniswap v3 / Aerodrome+v2-style)
const SWAP_TOPICS = new Set([
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', // UniV3 Swap
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', // V2/Aerodrome Swap
  '0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b', // Aerodrome v2 Swap (alt)
]);
// Common claim/vesting/reward event signatures (best-effort set)
const CLAIM_TOPICS = new Set([
  '0x47cee97cb7acd717b3c0aa1435d004cd5b3c8c57d70dbceb4e4458bbd60e39d4', // Claimed(address,uint256)
  '0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026', // Claimed(address,uint256,uint256)
  '0xc0e523490dd523c33b1878c9eb14ff46991233ed7e7a40b6f37fdb4e4dac6b32', // TokensClaimed-like
  '0xfb81f9b30d73d830c3544b34d827c08142579ee75710b490bb0237bf89e0fcc7', // Released(uint256)/vesting
]);

// Project-owned wallets (from api/supply.ts KNOWN_WALLETS) — a transfer from any
// of these is an internal/project move, not a user buy/claim.
const KNOWN_WALLETS: Record<string, string> = {
  '0x0e0bc2919540119fc22a502842a74af4d81502b6': 'Treasury',
  '0x9399da51c1a85e64cce4b30b554875d2b89b2445': 'Liquidity',
  '0x7e3e2d6b8b87ce617b7ccdd63d0f5449e4057513': 'Team Buybacks',
  '0x69892fc8e176d9750e7f0ca06fc9aede0fc97bcb': 'Team Buybacks',
  '0x61f8d3fc749ecda98d378bc2cc8459ba0f7dfd58': 'Team Multisig',
  '0x7c91baca69ad289ec5de46b0b36287770a1ea91e': 'Distribution',
};

// Base ~2s/block. ~24h look-back keeps us in the staker's "same session".
const WINDOW_BLOCKS = 43_200;

export type ProvenanceSource =
  | 'bought'
  | 'claimed'
  | 'restaked'
  | 'transferred'
  | 'transferred_bought_upstream'
  | 'internal'
  | 'preheld'
  | 'unknown';

export interface Provenance {
  source: ProvenanceSource;
  label: string;
  emoji: string;
  detail: string;
  confidence: 'high' | 'medium' | 'low';
}

const LABELS: Record<ProvenanceSource, { label: string; emoji: string }> = {
  bought:                      { label: 'Bought on DEX',                emoji: '🛒' }, // 🛒
  claimed:                     { label: 'Claimed',                      emoji: '🎁' }, // 🎁
  restaked:                    { label: 'Unstaked & re-staked',         emoji: '🔁' }, // 🔁
  transferred:                 { label: 'Transferred in',               emoji: '↔️' }, // ↔️
  transferred_bought_upstream: { label: 'Transferred (bought upstream)', emoji: '🛒' }, // 🛒
  internal:                    { label: 'From project wallet',          emoji: '🏦' }, // 🏦
  preheld:                     { label: 'Pre-held balance',             emoji: '⏳' },       // ⏳
  unknown:                     { label: 'Source unknown',               emoji: '❔' },       // ❔
};

function mk(source: ProvenanceSource, confidence: Provenance['confidence'], detail = ''): Provenance {
  return { source, ...LABELS[source], detail, confidence };
}

// ─── Low-level Alchemy helpers ─────────────────────────────────────────

interface ReceiptLog { address: string; topics: string[]; data: string }
interface TxReceipt { transactionHash: string; logs: ReceiptLog[] }
interface AssetTransfer { from: string; to: string; hash: string; blockNum: string; value: number | null }

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
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

async function getReceipt(txHash: string): Promise<TxReceipt | null> {
  return rpc<TxReceipt>('eth_getTransactionReceipt', [txHash]);
}

async function getCode(address: string): Promise<string> {
  const code = await rpc<string>('eth_getCode', [address, 'latest']);
  return code ?? '0x';
}

/** Most recent inbound LINGO transfers to `wallet` within [fromBlock, toBlock]. */
async function inboundLingo(wallet: string, fromBlock: number, toBlock: number, maxCount = 0x14): Promise<AssetTransfer[]> {
  if (toBlock < 0) return [];
  const result = await rpc<{ transfers: AssetTransfer[] }>('alchemy_getAssetTransfers', [{
    contractAddresses: [LINGO_TOKEN],
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

// ─── Receipt analysis ──────────────────────────────────────────────────

interface InboundLeg { from: string; value: bigint }
interface ReceiptSignals { hasSwap: boolean; hasClaim: boolean; inbound: InboundLeg[] }

function analyzeReceipt(receipt: TxReceipt, walletLc: string): ReceiptSignals {
  let hasSwap = false;
  let hasClaim = false;
  const inbound: InboundLeg[] = [];
  for (const log of receipt.logs ?? []) {
    const topic0 = (log.topics?.[0] ?? '').toLowerCase();
    if (SWAP_TOPICS.has(topic0)) hasSwap = true;
    if (CLAIM_TOPICS.has(topic0)) hasClaim = true;
    if (
      log.address?.toLowerCase() === LINGO_TOKEN &&
      topic0 === TRANSFER_TOPIC &&
      log.topics.length >= 3
    ) {
      const to = '0x' + log.topics[2].slice(26).toLowerCase();
      if (to === walletLc) {
        const from = '0x' + log.topics[1].slice(26).toLowerCase();
        let value = 0n;
        try { value = BigInt(log.data); } catch { /* malformed data → leave 0 */ }
        inbound.push({ from, value });
      }
    }
  }
  return { hasSwap, hasClaim, inbound };
}

/** Did the funding tx for an EOA's LINGO come from a swap? (one-hop upstream) */
async function boughtUpstream(eoa: string, beforeBlock: number): Promise<boolean> {
  const ts = await inboundLingo(eoa, beforeBlock - WINDOW_BLOCKS, beforeBlock, 0x5);
  if (ts.length === 0) return false;
  const r = await getReceipt(ts[0].hash);
  if (!r) return false;
  return analyzeReceipt(r, eoa.toLowerCase()).hasSwap;
}

// ─── Public API ────────────────────────────────────────────────────────

export interface ClassifyInput {
  wallet: string;
  stakeTxHash: string;
  stakeBlock: number;
  /** Staked amount in whole LINGO — used to ignore incidental reward/dust legs. */
  amount: number;
}

/** Convert an 18-decimal wei value to whole LINGO (2-decimal precision). */
function toLingo(weiValue: bigint): number {
  return Number(weiValue / BigInt(10 ** 16)) / 100;
}

export async function classifyProvenance(input: ClassifyInput): Promise<Provenance> {
  try {
    const walletLc = input.wallet.toLowerCase();

    // ── TIER A: same transaction as the stake ──────────────────────────
    const stakeReceipt = await getReceipt(input.stakeTxHash);
    if (stakeReceipt) {
      const a = analyzeReceipt(stakeReceipt, walletLc);
      if (a.hasSwap) return mk('bought', 'high', 'Swap in the stake tx');
      if (a.hasClaim) return mk('claimed', 'high', 'Claim event in the stake tx');
      // Pick the LARGEST inbound-to-staker leg, and only treat it as the funding
      // source if it's comparable to the staked amount. This ignores incidental
      // reward/dust/refund legs (e.g. a harvest-on-stake) that would otherwise
      // be misread as the source.
      const principal = a.inbound
        .slice()
        .sort((x, y) => (y.value > x.value ? 1 : y.value < x.value ? -1 : 0))[0];
      if (principal && toLingo(principal.value) >= input.amount * 0.5) {
        const from = principal.from;
        const conf: Provenance['confidence'] = a.inbound.length > 1 ? 'medium' : 'high';
        if (from === STAKING_CONTRACT) return mk('restaked', conf, 'Came from the staking contract');
        if (KNOWN_WALLETS[from]) return mk('internal', conf, `From ${KNOWN_WALLETS[from]}`);
        const code = await getCode(from);
        if (code !== '0x') return mk('claimed', 'low', `From contract ${from.slice(0, 10)}… in the stake tx (no claim event)`);
      }
    }

    // ── TIER B: most recent inbound LINGO before the stake (tight window) ─
    // Window includes the stake's own block, but we drop the stake tx itself so
    // a same-block-different-tx funding transfer is still caught.
    const transfers = (await inboundLingo(walletLc, input.stakeBlock - WINDOW_BLOCKS, input.stakeBlock))
      .filter(t => t.hash.toLowerCase() !== input.stakeTxHash.toLowerCase());
    if (transfers.length === 0) {
      return mk('preheld', 'low', 'No inbound LINGO in the ~24h before staking');
    }

    const latest = transfers[0];
    const from = latest.from.toLowerCase();
    // If multiple distinct senders fed the wallet in-window, attribution is softer.
    const distinctFroms = new Set(transfers.map(t => t.from.toLowerCase()));
    const multi = distinctFroms.size > 1;

    if (from === STAKING_CONTRACT) return mk('restaked', multi ? 'medium' : 'high', 'Unstaked then re-staked');
    if (KNOWN_WALLETS[from]) return mk('internal', multi ? 'medium' : 'high', `From ${KNOWN_WALLETS[from]}`);

    const code = await getCode(from);
    if (code !== '0x') {
      // Contract source — inspect that tx to tell a swap (bought) from a claim/distribution.
      const r = await getReceipt(latest.hash);
      if (r) {
        const sig = analyzeReceipt(r, walletLc);
        if (sig.hasSwap) return mk('bought', multi ? 'medium' : 'high', 'Received from a DEX/pool just before staking');
        if (sig.hasClaim) return mk('claimed', multi ? 'medium' : 'high', 'Claim event just before staking');
      }
      // Contract source but no recognized swap/claim event — likely a claim/
      // distribution, but a buy on an unrecognized pool can land here too, so
      // keep it low confidence rather than asserting 'claimed' firmly.
      return mk('claimed', 'low', `From contract ${from.slice(0, 10)}… (unrecognized event)`);
    }

    // EOA source — a plain transfer in. Follow one hop to catch "bought elsewhere".
    const blockNum = parseInt(latest.blockNum, 16);
    if (Number.isFinite(blockNum) && await boughtUpstream(from, blockNum)) {
      return mk('transferred_bought_upstream', 'medium', `Sent from ${from.slice(0, 10)}… which bought it on-chain`);
    }
    return mk('transferred', multi ? 'low' : 'low', `Wallet transfer from ${from.slice(0, 10)}…`);
  } catch {
    return mk('unknown', 'low', 'Classification error');
  }
}
