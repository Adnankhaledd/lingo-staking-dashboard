import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchBlobJson } from './_blob-helpers';

/**
 * Serves Mixpanel data from Vercel Blob (pre-fetched by /api/refresh-mixpanel).
 * Uses direct URL fetch — zero Blob SDK operations.
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
    // Direct fetch by known pathname — zero Blob SDK operations
    const data = await fetchBlobJson('mixpanel-data.json');

    if (!data) {
      return res.status(404).json({ error: 'No cached Mixpanel data available. Run /api/refresh-mixpanel first.' });
    }

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
