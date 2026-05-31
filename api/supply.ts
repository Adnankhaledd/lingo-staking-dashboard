import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/supply — Returns LINGO total supply and known-wallet balances so the
 * client can compute circulating = totalSupply − sum(known wallets).
 *
 * Uses a single batched JSON-RPC call to Alchemy. Cached on the CDN for
 * 5 minutes (matches the cadence of the live total-staked endpoint).
 */

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const LINGO_DECIMALS = 18;

// Function selectors
const SEL_TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()
const SEL_BALANCE_OF   = '0x70a08231'; // balanceOf(address)

/** Owner of LINGO that is considered locked / non-circulating. */
interface KnownWallet {
  name: string;
  address: string;
  note?: string;
}

const KNOWN_WALLETS: KnownWallet[] = [
  { name: 'Treasury',            address: '0x0e0bc2919540119fC22a502842A74AF4D81502b6' },
  { name: 'Staking Contract',    address: '0x9aF8C0dac726CcEE2BFd6c0f3E21f320d42398AC' },
  { name: 'Liquidity',           address: '0x9399dA51C1a85e64CCe4b30B554875D2b89b2445' },
  { name: 'Team Buybacks #1',    address: '0x7e3e2d6b8b87ce617b7ccdd63d0f5449e4057513' },
  { name: 'Team Buybacks #2',    address: '0x69892fc8e176d9750e7f0ca06fc9aede0fc97bcb' },
  { name: 'Unidentified Contract #1', address: '0x61f8D3Fc749ECDa98D378BC2cc8459Ba0F7dFd58', note: 'Pending identification' },
  { name: 'Unidentified Contract #2', address: '0x7c91bAca69ad289eC5De46B0b36287770a1Ea91e', note: 'Pending identification' },
];

/** Pad a 20-byte address into the 32-byte ABI calldata slot (no 0x prefix). */
function padAddress(addr: string): string {
  return addr.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/** Parse a hex-string balance into whole-token Number with 18 decimals. */
function hexToTokens(hex: string | undefined | null): number | null {
  if (!hex || hex === '0x' || hex === '0x0') return 0;
  try {
    const raw = BigInt(hex);
    const divisor = BigInt(10) ** BigInt(LINGO_DECIMALS);
    // Preserve some precision by computing whole and fractional separately.
    const whole = raw / divisor;
    const remainder = raw % divisor;
    return Number(whole) + Number(remainder) / Number(divisor);
  } catch {
    return null;
  }
}

export interface SupplyApiResponse {
  totalSupply: number | null;
  totalSupplyRaw: string | null;
  wallets: Array<{
    name: string;
    address: string;
    balance: number | null;
    note?: string;
  }>;
  fetchedAt: string;
  configured: boolean;
  error?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!ALCHEMY_API_KEY) {
    return res.status(200).json({
      totalSupply: null,
      totalSupplyRaw: null,
      wallets: [],
      fetchedAt: new Date().toISOString(),
      configured: false,
      error: 'ALCHEMY_API_KEY not configured',
    } satisfies SupplyApiResponse);
  }

  // Build a batched JSON-RPC payload: 1 call for totalSupply + 1 balanceOf per wallet.
  const batch = [
    {
      jsonrpc: '2.0',
      id: 'totalSupply',
      method: 'eth_call',
      params: [{ to: LINGO_TOKEN, data: SEL_TOTAL_SUPPLY }, 'latest'],
    },
    ...KNOWN_WALLETS.map((w, i) => ({
      jsonrpc: '2.0',
      id: `bal-${i}`,
      method: 'eth_call',
      params: [{ to: LINGO_TOKEN, data: SEL_BALANCE_OF + padAddress(w.address) }, 'latest'],
    })),
  ];

  try {
    const response = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      return res.status(200).json({
        totalSupply: null,
        totalSupplyRaw: null,
        wallets: KNOWN_WALLETS.map(w => ({ ...w, balance: null })),
        fetchedAt: new Date().toISOString(),
        configured: true,
        error: `Alchemy HTTP ${response.status}`,
      } satisfies SupplyApiResponse);
    }

    const results = (await response.json()) as Array<{ id: string; result?: string; error?: { message: string } }>;
    const byId = new Map(results.map(r => [r.id, r] as const));

    const totalSupplyRaw = byId.get('totalSupply')?.result ?? null;
    const totalSupply = hexToTokens(totalSupplyRaw);

    const wallets = KNOWN_WALLETS.map((w, i) => {
      const r = byId.get(`bal-${i}`);
      return {
        name: w.name,
        address: w.address,
        balance: hexToTokens(r?.result),
        note: w.note,
      };
    });

    return res.status(200).json({
      totalSupply,
      totalSupplyRaw,
      wallets,
      fetchedAt: new Date().toISOString(),
      configured: true,
    } satisfies SupplyApiResponse);
  } catch (error) {
    return res.status(200).json({
      totalSupply: null,
      totalSupplyRaw: null,
      wallets: KNOWN_WALLETS.map(w => ({ ...w, balance: null })),
      fetchedAt: new Date().toISOString(),
      configured: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    } satisfies SupplyApiResponse);
  }
}
