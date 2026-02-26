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
    // Find all blobs with this prefix (should be 1 after cleanup)
    const { blobs } = await list({ prefix: 'dune-data.json' });

    if (blobs.length === 0) {
      return res.status(404).json({ error: 'No cached data available. Run /api/refresh-dune first.' });
    }

    // Use the most recently uploaded blob
    const latestBlob = blobs[blobs.length - 1];

    // Fetch blob content with cache-busting query param
    const response = await fetch(`${latestBlob.url}?t=${Date.now()}`);
    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to read cached data' });
    }

    const data = await response.json();

    // Cache at CDN for 1 minute, allow stale for 5 minutes while revalidating.
    // Short TTLs ensure admin refreshes are picked up quickly.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

    return res.status(200).json(data);
  } catch (error) {
    console.error('Error reading Dune blob:', error);
    return res.status(500).json({
      error: 'Internal server error',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
