/**
 * Upstash Redis REST helpers — drop-in replacement for blob.js.
 * Exports the same functions: blobPut, blobGet, blobFind, blobList, blobDelete.
 *
 * Env vars (set in Vercel dashboard from Upstash console):
 *   UPSTASH_REDIS_REST_URL   — e.g. https://us1-xxxx.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN — bearer token
 */

function base() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  if (!url) {
    const e = new Error('UPSTASH_REDIS_REST_URL not set.');
    e.code = 'storage_not_configured';
    throw e;
  }
  return url;
}

function token() {
  const t = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!t) {
    const e = new Error('UPSTASH_REDIS_REST_TOKEN not set.');
    e.code = 'storage_not_configured';
    throw e;
  }
  return t;
}

async function cmd(...args) {
  const path = args.map(a => encodeURIComponent(String(a))).join('/');
  const resp = await fetch(`${base()}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
  });
  const json = await resp.json();
  if (json.error) {
    const e = new Error(json.error);
    e.code = 'storage_unavailable';
    throw e;
  }
  return json.result;
}

/** Write a JSON-serialisable value at a deterministic key. */
export async function blobPut(key, value) {
  await cmd('SET', key, JSON.stringify(value));
  return { url: key, pathname: key };
}

/**
 * Fetch and JSON-parse a value by key.
 * Falls back to a direct https:// fetch for legacy Blob CDN URLs.
 */
export async function blobGet(keyOrUrl) {
  if (String(keyOrUrl).startsWith('https://')) {
    const resp = await fetch(keyOrUrl);
    if (resp.status === 404) return null;
    if (!resp.ok) {
      const e = new Error(`GET failed: ${resp.status}`);
      e.code = 'storage_unavailable';
      throw e;
    }
    return resp.json();
  }
  const raw = await cmd('GET', keyOrUrl);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Find a key — returns { url: key, pathname: key } or null.
 * (blob.js did LIST+GET; KV does a single GET — saves 1 op per call.)
 */
export async function blobFind(key) {
  const raw = await cmd('GET', key);
  if (raw === null) return null;
  return { url: key, pathname: key };
}

/**
 * List all keys matching a prefix (uses Redis SCAN).
 * Returns [{ url: key, pathname: key }].
 */
export async function blobList(prefix) {
  const keys = [];
  let cursor = 0;
  do {
    const result = await cmd('SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
    cursor = Number(result[0]);
    keys.push(...result[1]);
  } while (cursor !== 0);
  return keys.map(k => ({ url: k, pathname: k }));
}

/** Delete a key (or legacy blob CDN URL — pathname extracted automatically). */
export async function blobDelete(keyOrUrl) {
  const key = String(keyOrUrl).startsWith('https://')
    ? new URL(keyOrUrl).pathname.replace(/^\//, '')
    : keyOrUrl;
  await cmd('DEL', key);
}

/**
 * Atomic SET NX EX — sets key only if it does not exist (distributed lock).
 * Returns true if lock acquired, false if already held by another request.
 * @param {string} key
 * @param {number} ttlSeconds — lock auto-expires after this many seconds
 */
export async function blobSetNX(key, ttlSeconds) {
  const result = await cmd('SET', key, '1', 'NX', 'EX', String(ttlSeconds));
  return result === 'OK';
}
