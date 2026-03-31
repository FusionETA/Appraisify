/**
 * Appraisify – Server-side Bitrix24 API Proxy (Vercel Serverless Function)
 *
 * Multi-tenant: uses each portal's stored OAuth tokens instead of a single webhook.
 * The frontend must include the portal `domain` (and optionally `member_id`) in
 * the POST body so this handler can load the correct credentials.
 *
 * Env vars required:

 *   BX24_CLIENT_ID         — for token refresh
 *   BX24_CLIENT_SECRET     — for token refresh
 */

import { loadTokens, refreshTokens } from './_lib/auth.js';
import { flattenParams } from './_lib/utils.js';
import { logError } from './_lib/logger.js';

// Methods permitted via the system proxy.
const ALLOWED_METHODS = new Set([
  // Deal pipeline
  'crm.deal.add',
  'crm.deal.get',
  'crm.deal.update',
  'crm.deal.list',
  'crm.deal.userfield.list',
  'crm.deal.userfield.add',
  'crm.deal.userfield.update',
  'crm.deal.details.configuration.set',
  'crm.category.list',
  'crm.timeline.comment.add',
  // SPA (Smart Process Automation)
  'crm.type.list',
  'crm.type.add',
  'crm.item.add',
  'crm.item.get',
  'crm.item.update',
  'crm.item.list',
  'crm.item.fields',
  // SPA user fields — correct API is userfieldconfig.* (crm.userfield.* does not exist for SPA)
  'userfieldconfig.add',
  'userfieldconfig.list',
  'userfieldconfig.update',
]);

async function callBitrixWithToken(domain, tokens, method, params) {
  const url = `https://${domain}/rest/${method}`;
  const body = new URLSearchParams([
    ...flattenParams(params),
    ['auth', tokens.access_token],
  ]).toString();

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  // Bitrix24 always returns HTTP 200; errors are in the JSON body
  return resp.json();
}

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { method, params, domain, member_id } = req.body || {};

  if (!method || !ALLOWED_METHODS.has(method)) {
    return res.status(400).json({
      error: 'method_not_allowed',
      error_description: `'${method}' is not permitted via proxy`,
    });
  }

  if (!domain) {
    return res.status(400).json({
      error: 'tenant_context_missing',
      error_description: 'domain must be included in the request body',
    });
  }

  try {
    let tokens = await loadTokens(domain);
    if (!tokens) {
      return res.status(401).json({
        error: 'portal_not_installed',
        error_description: `No stored tokens for ${domain}. The app may need to be reinstalled.`,
      });
    }

    // Security: if the caller provides a member_id, verify it matches the stored portal identity
    if (member_id && tokens.member_id && tokens.member_id !== member_id) {
      console.warn(`[bx-proxy] member_id mismatch for domain ${domain}: expected ${tokens.member_id}, got ${member_id}`);
      return res.status(403).json({
        error: 'tenant_mismatch',
        error_description: 'Request member_id does not match stored portal identity',
      });
    }

    console.log('[bx-proxy] →', method, 'for', domain);
    let data = await callBitrixWithToken(domain, tokens, method, params || {});

    // Bitrix24 returns { error: 'expired_token' } (HTTP 200) when access_token expires
    if (data.error === 'expired_token' || data.error === 'invalid_token') {
      console.log(`[bx-proxy] Token expired for ${domain}, refreshing...`);
      // Guard against concurrent refresh race: multiple parallel requests can all
      // see 'expired_token' at the same time and each try to use the same
      // refresh_token. Bitrix24 only allows a refresh token to be used once —
      // subsequent uses fail. Re-read Redis first: if another in-flight request
      // already refreshed the token, reuse it instead of refreshing again.
      const latestTokens = await loadTokens(domain);
      if (latestTokens && latestTokens.access_token !== tokens.access_token) {
        console.log(`[bx-proxy] Token already refreshed by concurrent request for ${domain}, reusing.`);
        tokens = latestTokens;
      } else {
        tokens = await refreshTokens(domain, tokens);
      }
      data = await callBitrixWithToken(domain, tokens, method, params || {});
    }

    if (data.error) {
      console.error('[bx-proxy] Bitrix24 error:', method, data.error, data.error_description);
      return res.status(200).json({
        error: data.error,
        error_description: data.error_description,
      });
    }

    console.log('[bx-proxy] OK:', method, 'for', domain);
    return res.status(200).json({ result: data.result });

  } catch (e) {
    console.error('[bx-proxy] Error:', e.message);
    logError(domain, { event: 'error', source: 'bx-proxy', method, error: e.code || 'proxy_error', message: e.message }).catch(() => {});
    const status = e.code === 'storage_not_configured' ? 500
      : e.code === 'oauth_not_configured' ? 500
      : e.code === 'token_refresh_failed' ? 401
      : 503;
    return res.status(status).json({
      error: e.code || 'proxy_error',
      error_description: e.message,
    });
  }
}
