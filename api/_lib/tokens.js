/**
 * Appraisify – Secure single-use appraisal link tokens (Vercel Blob backed)
 *
 * Token schema stored at tokens/{token}.json:
 *   { domain, dealId, phase, expiresAt (ISO), usedAt (ISO | null) }
 *
 * Token lifetime: 7 days.
 * Token length: 32-char hex (16 random bytes).
 */

import { blobPut, blobFind, blobGet, blobDelete, blobList } from './blob.js';

const TOKEN_TTL_DAYS = 7;

function makeHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function tokenPath(token) {
  return `tokens/${token}.json`;
}

/**
 * Delete all token blobs older than TOKEN_TTL_DAYS (expired, used, or abandoned).
 * Runs in the background — never throws.
 */
async function _cleanupExpiredTokens() {
  try {
    const blobs = await blobList('tokens/');
    const cutoff = Date.now() - TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
    for (const blob of blobs) {
      const uploaded = blob.uploadedAt ? new Date(blob.uploadedAt).getTime() : 0;
      if (uploaded && uploaded < cutoff) {
        await blobDelete(blob.url);
      }
    }
  } catch (_) { /* never let cleanup break the caller */ }
}

/**
 * Generate a new single-use token for an appraisal phase link.
 * @param {string} domain — normalised portal domain
 * @param {number|string} dealId
 * @param {'self'|'reviewer'|'partner'} phase
 * @returns {string} 32-char hex token
 */
export async function generateToken(domain, dealId, phase) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = makeHex(bytes);

  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await blobPut(tokenPath(token), { domain, dealId: Number(dealId), phase, expiresAt, usedAt: null });

  // Sweep expired tokens in the background (fire-and-forget)
  _cleanupExpiredTokens().catch(() => {});

  return token;
}

/**
 * Validate a token — checks existence, expiry, and single-use semantics.
 * Does NOT consume the token.
 *
 * @param {string} token
 * @returns {{ domain: string, dealId: number, phase: string, blobUrl: string, data: object }}
 * @throws {Error} with .code = 'token_invalid' | 'token_expired' | 'token_used'
 */
export async function validateToken(token) {
  if (!token || typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) {
    const err = new Error('Token not found.');
    err.code = 'token_invalid';
    throw err;
  }

  let blob;
  try {
    blob = await blobFind(tokenPath(token));
  } catch (_) {
    const err = new Error('Token not found.');
    err.code = 'token_invalid';
    throw err;
  }

  if (!blob?.url) {
    const err = new Error('Token not found.');
    err.code = 'token_invalid';
    throw err;
  }

  const data = await blobGet(blob.url);
  if (!data) {
    const err = new Error('Token not found.');
    err.code = 'token_invalid';
    throw err;
  }

  if (data.usedAt) {
    // Token was consumed — delete the blob and report as used
    blobDelete(blob.url).catch(() => {});
    const err = new Error('This appraisal link has already been used.');
    err.code = 'token_used';
    throw err;
  }

  if (!data.expiresAt || new Date(data.expiresAt) < new Date()) {
    // Token expired — delete the blob immediately
    blobDelete(blob.url).catch(() => {});
    const err = new Error('This appraisal link has expired.');
    err.code = 'token_expired';
    throw err;
  }

  return { domain: data.domain, dealId: data.dealId, phase: data.phase, blobUrl: blob.url, data };
}

/**
 * Consume (delete) a token after successful use.
 * Deletes the blob entirely — it is no longer needed once the form is submitted.
 * @param {string} token — the 32-char hex token string
 * @param {string} blobUrl — CDN URL from validateToken result
 * @param {object} _data — unused (kept for API compatibility)
 */
export async function consumeToken(token, blobUrl, _data) {
  await blobDelete(blobUrl);
}
