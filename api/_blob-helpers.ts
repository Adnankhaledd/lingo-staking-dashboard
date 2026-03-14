/**
 * Shared helpers for direct Blob URL access.
 *
 * Vercel Blob `list()` counts as an "advanced operation".
 * Since we always use `addRandomSuffix: false`, the blob URL is deterministic:
 *   https://{storeId}.public.blob.vercel-storage.com/{pathname}
 *
 * Direct HTTP fetches against that URL are FREE (just bandwidth).
 * This helper constructs the URL from the BLOB_READ_WRITE_TOKEN,
 * eliminating ~2 `list()` ops per dashboard page load.
 */

/**
 * Extract the store base URL from BLOB_READ_WRITE_TOKEN.
 * Token format: vercel_blob_rw_{storeId}_{secret}
 */
export function getBlobBaseUrl(): string | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const match = token.match(/^vercel_blob_rw_([A-Za-z0-9]+)_/);
  if (!match) return null;
  return `https://${match[1]}.public.blob.vercel-storage.com`;
}

/**
 * Fetch a blob directly by pathname — zero Blob SDK operations.
 * Returns parsed JSON, or null if the blob doesn't exist / can't be read.
 */
export async function fetchBlobJson<T = unknown>(pathname: string): Promise<T | null> {
  const base = getBlobBaseUrl();
  if (!base) return null;

  try {
    // Cache-bust to avoid stale CDN responses
    const res = await fetch(`${base}/${pathname}?t=${Date.now()}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
