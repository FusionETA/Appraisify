/**
 * Per-tenant OAuth token storage and refresh.
 *
 * Tokens are stored in Upstash Redis at key: portals/{domain}/auth.json
 *
 * Env vars required for token refresh:
 *   BX24_CLIENT_ID     — Bitrix24 app client ID (from Bitrix24 developer portal)
 *   BX24_CLIENT_SECRET — Bitrix24 app client secret
 */

import { blobPut, blobFind, blobGet, blobSetNX, blobDelete } from './kv.js';

function authPath(domain) {
  return `portals/${domain}/auth.json`;
}

/**
 * Persist OAuth tokens for a portal. Called from store-auth.js at install time.
 * @param {string} domain — e.g. 'myportal.bitrix24.com'
 * @param {{ access_token, refresh_token, member_id, domain }} tokens
 */
export async function storeTokens(domain, tokens) {
  await blobPut(authPath(domain), {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    member_id: tokens.member_id,
    domain: tokens.domain || domain,
    storedAt: new Date().toISOString(),
  });
}

/**
 * Load stored OAuth tokens for a portal.
 * @param {string} domain
 * @returns {{ access_token, refresh_token, member_id, domain } | null}
 */
export async function loadTokens(domain) {
  const blob = await blobFind(authPath(domain));
  if (!blob) return null;
  return blobGet(blob.url);
}

/**
 * Refresh an expired access_token using the stored refresh_token.
 * On success, persists the new token pair and returns them.
 * Throws if refresh fails (portal uninstalled, refresh_token revoked, etc.).
 * @param {string} domain
 * @param {{ access_token, refresh_token, member_id }} currentTokens
 * @returns {{ access_token, refresh_token, member_id, domain }}
 */
export async function refreshTokens(domain, currentTokens) {
  const { BX24_CLIENT_ID, BX24_CLIENT_SECRET } = process.env;
  if (!BX24_CLIENT_ID || !BX24_CLIENT_SECRET) {
    const err = new Error('BX24_CLIENT_ID and BX24_CLIENT_SECRET are required for token refresh. Add them to Vercel environment variables.');
    err.code = 'oauth_not_configured';
    throw err;
  }

  // Distributed lock: only one request may refresh at a time.
  // Concurrent requests wait 3 s then return whatever tokens were stored by the winner.
  const lockKey = `portals/${domain}/refresh_lock`;
  const lockAcquired = await blobSetNX(lockKey, 15);
  if (!lockAcquired) {
    console.log(`[auth] Refresh lock held for ${domain} — waiting for winner to finish...`);
    await new Promise(r => setTimeout(r, 3000));
    const fresh = await loadTokens(domain);
    return fresh || currentTokens;
  }

  try {
    const resp = await fetch(`https://${domain}/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: BX24_CLIENT_ID,
        client_secret: BX24_CLIENT_SECRET,
        refresh_token: currentTokens.refresh_token,
      }).toString(),
    });

    if (!resp.ok) {
      const err = new Error(`Token refresh failed: HTTP ${resp.status}`);
      err.code = 'token_refresh_failed';
      throw err;
    }

    const data = await resp.json();
    if (data.error) {
      const err = new Error(data.error_description || data.error);
      err.code = 'token_refresh_failed';
      throw err;
    }

    const updated = {
      ...currentTokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token || currentTokens.refresh_token,
      refreshedAt: new Date().toISOString(),
    };

    await storeTokens(domain, updated);
    console.log(`[auth] Tokens refreshed for ${domain}`);
    return updated;
  } finally {
    await blobDelete(lockKey).catch(() => {});
  }
}
