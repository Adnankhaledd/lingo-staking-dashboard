import type { VercelRequest, VercelResponse } from '@vercel/node';
import { list } from '@vercel/blob';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Find the blob
    const { blobs } = await list({ prefix: 'dune-data.json', limit: 1 });

    if (blobs.length === 0) {
      return res.status(404).json({ error: 'No cached data available. Run /api/refresh-dune first.' });
    }

    const blobUrl = blobs[0].url;

    // Fetch the blob content
    const response = await fetch(blobUrl);
    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to read cached data' });
    }

    const data = await response.json();

    // CDN caches for 1 hour, serves stale for up to 24 hours while revalidating
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

    return res.status(200).json(data);
  } catch (error) {
    console.error('Error reading Dune blob:', error);
    return res.status(500).json({
      error: 'Internal server error',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
