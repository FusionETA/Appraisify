/**
 * Vercel Blob REST API helpers (no npm package required — uses native fetch).
 *
 * Env var required:
 *   BLOB_READ_WRITE_TOKEN — from Vercel dashboard → Storage → Blob → Connect
 */

const BLOB_BASE = 'https://blob.vercel-storage.com';

function getToken() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    const err = new Error('BLOB_READ_WRITE_TOKEN not set. Connect Vercel Blob in your project settings.');
    err.code = 'storage_not_configured';
    throw err;
  }
  return token;
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${getToken()}`,
    'x-api-version': '7',
    ...extra,
  };
}

/**
 * Write a JSON-serialisable value to a deterministic blob path.
 * @param {string} pathname — e.g. 'portals/domain.com/auth.json'
 * @param {any} value — will be JSON.stringify'd
 * @returns {{ url: string, pathname: string }} blob metadata
 */
export async function blobPut(pathname, value) {
  const resp = await fetch(`${BLOB_BASE}/${pathname}`, {
    method: 'PUT',
    headers: authHeaders({
      'Content-Type': 'application/json',
      'x-add-random-suffix': '0',
    }),
    body: JSON.stringify(value),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`Blob PUT failed: HTTP ${resp.status}${text ? ` — ${text}` : ''}`);
    err.code = 'storage_unavailable';
    throw err;
  }

  return resp.json();
}

/**
 * Fetch and JSON-parse a blob by its URL (returned from blobPut / blobFind).
 * Public blob stores serve CDN URLs without auth — no Authorization header needed for reads.
 * (Auth is only required for PUT / LIST / DELETE on the blob.vercel-storage.com API endpoint.)
 * @param {string} url
 * @returns {any | null} parsed value, or null if 404
 */
export async function blobGet(url) {
  const resp = await fetch(url);
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const err = new Error(`Blob GET failed: HTTP ${resp.status}`);
    err.code = 'storage_unavailable';
    throw err;
  }
  return resp.json();
}

/**
 * Find the first blob whose pathname starts with the given prefix.
 * @param {string} prefix
 * @returns {{ url: string, pathname: string } | null}
 */
export async function blobFind(prefix) {
  const u = `${BLOB_BASE}?prefix=${encodeURIComponent(prefix)}&limit=1`;
  const resp = await fetch(u, { headers: authHeaders() });
  if (!resp.ok) {
    const err = new Error(`Blob LIST failed: HTTP ${resp.status}`);
    err.code = 'storage_unavailable';
    throw err;
  }
  const data = await resp.json();
  return data.blobs?.[0] || null;
}

/**
 * List all blobs under a prefix (up to 1000).
 * @param {string} prefix
 * @returns {{ url: string, pathname: string }[]}
 */
export async function blobList(prefix) {
  const u = `${BLOB_BASE}?prefix=${encodeURIComponent(prefix)}&limit=1000`;
  const resp = await fetch(u, { headers: authHeaders() });
  if (!resp.ok) {
    const err = new Error(`Blob LIST failed: HTTP ${resp.status}`);
    err.code = 'storage_unavailable';
    throw err;
  }
  const data = await resp.json();
  return data.blobs || [];
}

/**
 * Delete a blob by its CDN URL.
 * @param {string} blobUrl
 */
export async function blobDelete(blobUrl) {
  const resp = await fetch(BLOB_BASE, {
    method: 'DELETE',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ urls: [blobUrl] }),
  });
  if (!resp.ok) {
    const err = new Error(`Blob DELETE failed: HTTP ${resp.status}`);
    err.code = 'storage_unavailable';
    throw err;
  }
}
