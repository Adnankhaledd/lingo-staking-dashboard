/**
 * Shared helpers for direct Blob URL access.
 *
 * Vercel Blob `list()` counts as an "advanced operation".
 * Since we always use `addRandomSuffix: false`, the blob URL is deterministic:
 *   https://{storeId}.public.blob.vercel-storage.com/{pathname}
 *
 * Direct HTTP fetches against that URL are FREE (just bandwidth).
 * This helper constructs the URL from the BLOB_READ_WRITE_TOKEN,
 * falling back to `list()` if the URL can't be derived.
 */

import { list } from '@vercel/blob';

/**
 * Extract the store base URL from BLOB_READ_WRITE_TOKEN.
 * Token format: vercel_blob_rw_{storeId}_{secret}
 */
export function getBlobBaseUrl(): string | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  // Match store ID: any chars between the 3rd and 4th underscores
  const match = token.match(/^vercel_blob_rw_([^_]+)_/);
  if (!match) return null;
  return `https://${match[1]}.public.blob.vercel-storage.com`;
}

/**
 * Fetch a blob directly by pathname — zero Blob SDK operations.
 * Falls back to list() if the direct URL can't be constructed or returns an error.
 */
export async function fetchBlobJson<T = unknown>(pathname: string): Promise<T | null> {
  // Try direct URL first (free — no Blob SDK ops)
  const base = getBlobBaseUrl();
  if (base) {
    try {
      const res = await fetch(`${base}/${pathname}?t=${Date.now()}`);
      if (res.ok) {
        return (await res.json()) as T;
      }
    } catch {
      // Fall through to list() fallback
    }
  }

  // Fallback: use list() (costs 1 advanced op, but ensures data loads)
  try {
    const { blobs } = await list({ prefix: pathname });
    if (blobs.length === 0) return null;
    const res = await fetch(`${blobs[blobs.length - 1].url}?t=${Date.now()}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
