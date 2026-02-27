import type { VercelRequest, VercelResponse } from '@vercel/node';
import { list } from '@vercel/blob';

/**
 * Serves Mixpanel data from Vercel Blob (pre-fetched by /api/refresh-mixpanel).
 * Same pattern as api/dune-data.ts — no live Mixpanel API calls.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { blobs } = await list({ prefix: 'mixpanel-data.json' });

    if (blobs.length === 0) {
      return res.status(404).json({ error: 'No cached Mixpanel data available. Run /api/refresh-mixpanel first.' });
    }

    const latestBlob = blobs[blobs.length - 1];

    // Fetch blob content with cache-busting
    const response = await fetch(`${latestBlob.url}?t=${Date.now()}`);
    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to read cached Mixpanel data' });
    }

    const data = await response.json();

    // Cache at CDN for 1 minute, allow stale for 5 minutes while revalidating
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

    return res.status(200).json(data);
  } catch (error) {
    console.error('Error reading Mixpanel blob:', error);
    return res.status(500).json({
      error: 'Internal server error',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
