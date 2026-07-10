import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * /api/reward-wallet-monthly — monthly LINGO sent FROM a wallet, straight from
 * Alchemy (no Dune). Defaults to the community reward wallet; override with
 * ?wallet=0x…. Sums the raw ERC-20 Transfer values (BigInt, exact) and buckets
 * by the block-timestamp month.
 *
 * Uses alchemy_getAssetTransfers (fromAddress + contractAddresses), which pages
 * by result count (1000/page) rather than block range, so full history is a
 * few dozen calls. Newest-first so if the page cap is hit, recent months stay
 * complete and `capped` flags that older history was truncated.
 */

export const config = { maxDuration: 30 };

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const ALCHEMY_URL = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
const LINGO_TOKEN = '0xfb42da273158b0f642f59f2ba7cc1d5457481677';
const DEFAULT_WALLET = '0x64967c0dd5605dd3efc6a9bb148b2687a532c15f'; // community reward wallet
const MAX_PAGES = 80; // 80 * 1000 = 80k transfers ceiling

interface Transfer {
  rawContract?: { value?: string };
  metadata?: { blockTimestamp?: string };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!ALCHEMY_API_KEY) return res.status(200).json({ configured: false, error: 'ALCHEMY_API_KEY not set' });

  const qWallet = req.query.wallet;
  const wallet = (typeof qWallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(qWallet))
    ? qWallet.toLowerCase()
    : DEFAULT_WALLET;

  const weiByMonth = new Map<string, bigint>();
  const countByMonth = new Map<string, number>();
  let pageKey: string | undefined;
  let pages = 0;

  try {
    do {
      pages++;
      const params: Record<string, unknown> = {
        fromAddress: wallet,
        contractAddresses: [LINGO_TOKEN],
        category: ['erc20'],
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: '0x3e8', // 1000
        order: 'desc',
      };
      if (pageKey) params.pageKey = pageKey;

      const r = await fetch(ALCHEMY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
      });
      if (!r.ok) return res.status(200).json({ wallet, error: `Alchemy HTTP ${r.status}`, pages });
      const data = await r.json();
      if (data.error) return res.status(200).json({ wallet, error: JSON.stringify(data.error), pages });

      const transfers: Transfer[] = data.result?.transfers ?? [];
      for (const t of transfers) {
        const ts = t.metadata?.blockTimestamp;
        if (!ts) continue;
        const month = ts.slice(0, 7); // "YYYY-MM"
        let wei = 0n;
        const raw = t.rawContract?.value;
        if (raw) { try { wei = BigInt(raw); } catch { /* skip malformed */ } }
        weiByMonth.set(month, (weiByMonth.get(month) ?? 0n) + wei);
        countByMonth.set(month, (countByMonth.get(month) ?? 0) + 1);
      }
      pageKey = data.result?.pageKey;
    } while (pageKey && pages < MAX_PAGES);

    const DIV = 10n ** 18n;
    const toLingo = (wei: bigint) => Number(wei / DIV) + Number(wei % DIV) / 1e18;

    const months = [...weiByMonth.keys()].sort().map(m => ({
      month: m,
      lingoSent: Math.round(toLingo(weiByMonth.get(m)!)),
      transfers: countByMonth.get(m) ?? 0,
    }));
    const totalWei = [...weiByMonth.values()].reduce((a, b) => a + b, 0n);
    const totalCount = [...countByMonth.values()].reduce((a, b) => a + b, 0);

    return res.status(200).json({
      wallet,
      token: LINGO_TOKEN,
      pages,
      capped: pages >= MAX_PAGES && !!pageKey, // older history truncated if true
      totalTransfers: totalCount,
      totalLingoSent: Math.round(toLingo(totalWei)),
      months,
    });
  } catch (error) {
    return res.status(200).json({ wallet, error: error instanceof Error ? error.message : 'Unknown error', pages });
  }
}
