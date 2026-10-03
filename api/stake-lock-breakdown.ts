import type { VercelRequest, VercelResponse } from '@vercel/node';
import { list } from '@vercel/blob';

/**
 * /api/stake-lock-breakdown — staked LINGO by lock tier, now and month by month.
 *
 * Served from the daily /api/staking-metrics snapshot, which already carries
 * this exact breakdown (same shape, same labels, reconciled against the
 * contract balance). This endpoint used to rebuild the full staking history
 * itself — ~58 eth_getLogs calls on every CDN miss, for every visitor — which
 * made it one of the dashboard's most expensive reads. It now makes no Alchemy
 * calls at all.
 *
 * The snapshot is refreshed daily by cron; this never triggers a rebuild.
 */

const SNAPSHOT_KEY = 'staking-metrics-v1.json';   // written by api/staking-metrics.ts

async function readSnapshot(): Promise<{ lockBreakdown?: unknown; generatedAt?: string } | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const match = token.match(/^vercel_blob_rw_([^_]+)_/);
  if (match) {
    try {
      const res = await fetch(`https://${match[1]}.public.blob.vercel-storage.com/${SNAPSHOT_KEY}`);
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
    } catch { /* fall through to list() */ }
  }
  try {
    const { blobs } = await list({ prefix: SNAPSHOT_KEY });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const snap = await readSnapshot();
  const lb = snap?.lockBreakdown as { tiers?: unknown; history?: unknown; summary?: unknown } | undefined;
  // LockBreakdownCard iterates tiers and history without guards — only serve the shape it expects.
  if (!lb || !Array.isArray(lb.tiers) || !Array.isArray(lb.history) || !lb.summary) {
    return res.status(200).json({ error: 'Lock breakdown not available yet — the daily snapshot has not been built' });
  }
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  return res.status(200).json({ ...(lb as object), generatedAt: snap?.generatedAt });
}
