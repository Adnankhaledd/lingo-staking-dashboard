import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/reward-wallet-monthly — monthly LINGO IN and OUT for a wallet, straight
 * from Alchemy (no Dune). Defaults to the community reward wallet; override with
 * ?wallet=0x…. Sums raw ERC-20 Transfer values (BigInt, exact) bucketed by month.
 *
 * Uses alchemy_getAssetTransfers in both directions (fromAddress = out,
 * toAddress = in), plus the current balanceOf, and reconciles:
 *   totalIn − totalOut  should equal  balanceNow  (for a wallet that began at 0)
 * so you can see at a glance whether anything is unaccounted for.
 *
 * Backward compatible: the old out-only fields (lingoSent / transfers /
 * totalLingoSent / totalTransfers) are preserved.
 */

export const config = { maxDuration: 45 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const DEFAULT_WALLET = '0x64967c0dd5605dd3efc6a9bb148b2687a532c15f'; // community reward wallet
const MAX_PAGES = 80; // per direction: 80 * 1000 = 80k transfers ceiling

interface Transfer {
  rawContract?: { value?: string };
  metadata?: { blockTimestamp?: string };
}

const DIV = 10n ** 18n;
const toLingo = (wei: bigint) => Number(wei / DIV) + Number(wei % DIV) / 1e18;

/** Sum LINGO transfers for one direction, bucketed by month. */
async function sumByMonth(wallet: string, direction: 'from' | 'to') {
  const weiByMonth = new Map<string, bigint>();
  const countByMonth = new Map<string, number>();
  let pageKey: string | undefined;
  let pages = 0;
  let total = 0n;

  do {
    pages++;
    const params: Record<string, unknown> = {
      [direction === 'from' ? 'fromAddress' : 'toAddress']: wallet,
      contractAddresses: [LINGO_TOKEN],
      category: ['erc20'],
      withMetadata: true,
      excludeZeroValue: true,
      maxCount: '0x3e8',
      order: 'desc',
    };
    if (pageKey) params.pageKey = pageKey;

    const r = await fetch(ALCHEMY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
    });
    if (!r.ok) return { error: `Alchemy HTTP ${r.status}`, pages };
    const data = await r.json();
    if (data.error) return { error: JSON.stringify(data.error).slice(0, 200), pages };

    for (const t of (data.result?.transfers ?? []) as Transfer[]) {
      const ts = t.metadata?.blockTimestamp;
      if (!ts) continue;
      const month = ts.slice(0, 7);
      let wei = 0n;
      const raw = t.rawContract?.value;
      if (raw) { try { wei = BigInt(raw); } catch { /* skip malformed */ } }
      weiByMonth.set(month, (weiByMonth.get(month) ?? 0n) + wei);
      countByMonth.set(month, (countByMonth.get(month) ?? 0) + 1);
      total += wei;
    }
    pageKey = data.result?.pageKey;
  } while (pageKey && pages < MAX_PAGES);

  return { weiByMonth, countByMonth, total, pages, capped: !!pageKey && pages >= MAX_PAGES };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!ALCHEMY_API_KEY) return res.status(200).json({ configured: false, error: 'ALCHEMY_API_KEY not set' });

  const qWallet = req.query.wallet;
  const wallet = (typeof qWallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(qWallet)) ? qWallet.toLowerCase() : DEFAULT_WALLET;

  try {
    const [out, inn] = await Promise.all([sumByMonth(wallet, 'from'), sumByMonth(wallet, 'to')]);
    if ('error' in out) return res.status(200).json({ wallet, error: `out: ${out.error}`, pages: out.pages });
    if ('error' in inn) return res.status(200).json({ wallet, error: `in: ${inn.error}`, pages: inn.pages });

    // Current on-chain balance for reconciliation
    let balanceWei: bigint | null = null;
    try {
      const balRes = await fetch(ALCHEMY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: LINGO_TOKEN, data: '0x70a08231' + wallet.replace('0x', '').padStart(64, '0') }, 'latest'] }),
      });
      const balData = await balRes.json();
      if (balData.result && balData.result !== '0x') balanceWei = BigInt(balData.result);
    } catch { /* balance optional */ }

    const allMonths = [...new Set([...out.weiByMonth.keys(), ...inn.weiByMonth.keys()])].sort();
    const months = allMonths.map(m => {
      const o = out.weiByMonth.get(m) ?? 0n;
      const i = inn.weiByMonth.get(m) ?? 0n;
      return {
        month: m,
        lingoSent: Math.round(toLingo(o)),   // OUT (backward-compatible name)
        lingoIn: Math.round(toLingo(i)),
        net: Math.round(toLingo(i - o)),
        transfers: out.countByMonth.get(m) ?? 0,
        inTransfers: inn.countByMonth.get(m) ?? 0,
      };
    });

    const totalOut = out.total;
    const totalIn = inn.total;
    const reconciliation = balanceWei == null ? null : {
      balanceNow: Math.round(toLingo(balanceWei)),
      impliedBalance: Math.round(toLingo(totalIn - totalOut)),           // in − out (assumes started at 0)
      unaccountedLingo: Math.round(toLingo((totalIn - totalOut) - balanceWei)),
      note: 'unaccounted ≈ 0 means all in/out is captured; a large value means a top-up or outflow is missing from history',
    };

    return res.status(200).json({
      wallet,
      token: LINGO_TOKEN,
      pages: out.pages + inn.pages,
      capped: out.capped || inn.capped,
      totalTransfers: [...out.countByMonth.values()].reduce((a, b) => a + b, 0),
      totalLingoSent: Math.round(toLingo(totalOut)),  // OUT (backward-compatible)
      totalLingoIn: Math.round(toLingo(totalIn)),
      totalInTransfers: [...inn.countByMonth.values()].reduce((a, b) => a + b, 0),
      reconciliation,
      months,
    });
  } catch (error) {
    return res.status(200).json({ wallet, error: error instanceof Error ? error.message : 'Unknown error' });
  }
}
