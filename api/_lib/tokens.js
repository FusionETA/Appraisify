/**
 * Appraisify – Secure single-use appraisal link tokens (Upstash Redis backed)
 *
 * Token schema stored at tokens/{token}.json:
 *   { domain, dealId, phase, expiresAt (ISO), usedAt (ISO | null) }
 *
 * Token lifetime: 7 days.
 * Token length: 32-char hex (16 random bytes).
 */

import { blobPut, blobFind, blobGet, blobDelete, blobList } from './kv.js';
import { logAppraisal, logError } from './logger.js';

const TOKEN_TTL_DAYS = 7;

function makeHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function tokenPath(token) {
  return `tokens/${token}.json`;
}

/**
 * Delete all expired or used tokens older than TOKEN_TTL_DAYS.
 * Uses the expiresAt field stored in the token data (Upstash has no uploadedAt).
 * Runs in the background — never throws.
 */
async function _cleanupExpiredTokens() {
  try {
    const keys = await blobList('tokens/');
    const cutoff = new Date();
    let deleted = 0;
    for (const { url: key } of keys) {
      const data = await blobGet(key).catch(() => null);
      if (!data) { await blobDelete(key); deleted++; continue; }
      const expired = !data.expiresAt || new Date(data.expiresAt) < cutoff;
      if (expired || data.usedAt) {
        await blobDelete(key);
        deleted++;
      }
    }
    if (deleted > 0) {
      logError('system', { event: 'token_sweep', deleted, total: keys.length }).catch(() => {});
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
 * @returns {{ domain: string, dealId: number, phase: string, tokenKey: string, data: object }}
 * @throws {Error} with .code = 'token_invalid' | 'token_expired' | 'token_used'
 */
export async function validateToken(token) {
  if (!token || typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) {
    const err = new Error('Token not found.');
    err.code = 'token_invalid';
    throw err;
  }

  const tokenKey = tokenPath(token);
  let found;
  try {
    found = await blobFind(tokenKey);
  } catch (_) {
    const err = new Error('Token not found.');
    err.code = 'token_invalid';
    throw err;
  }

  if (!found) {
    const err = new Error('Token not found.');
    err.code = 'token_invalid';
    throw err;
  }

  const data = await blobGet(tokenKey);
  if (!data) {
    const err = new Error('Token not found.');
    err.code = 'token_invalid';
    throw err;
  }

  if (data.usedAt) {
    blobDelete(tokenKey).catch(() => {});
    logAppraisal(data.domain, { event: 'token_deleted', reason: 'already_used', dealId: data.dealId, phase: data.phase }).catch(() => {});
    const err = new Error('This appraisal link has already been used.');
    err.code = 'token_used';
    throw err;
  }

  if (!data.expiresAt || new Date(data.expiresAt) < new Date()) {
    blobDelete(tokenKey).catch(() => {});
    logAppraisal(data.domain, { event: 'token_deleted', reason: 'expired', dealId: data.dealId, phase: data.phase }).catch(() => {});
    const err = new Error('This appraisal link has expired.');
    err.code = 'token_expired';
    throw err;
  }

  return { domain: data.domain, dealId: data.dealId, phase: data.phase, tokenKey, data };
}

/**
 * Consume (delete) a token after successful use.
 * @param {string} token — the 32-char hex token string
 * @param {string} tokenKey — key from validateToken result
 * @param {object} data — token data for logging
 */
export async function consumeToken(token, tokenKey, data) {
  await blobDelete(tokenKey);
  logAppraisal(data?.domain, { event: 'token_deleted', reason: 'consumed', dealId: data?.dealId, phase: data?.phase }).catch(() => {});
}
