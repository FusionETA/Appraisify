/**
 * Server-side Bitrix24 REST caller using per-tenant OAuth tokens.
 * Handles automatic token refresh on expiry.
 */

import { loadTokens, refreshTokens } from './auth.js';
import { flattenParams } from './utils.js';

/**
 * Call a Bitrix24 REST method using the stored OAuth tokens for a portal.
 * Automatically refreshes the access_token once if it has expired.
 *
 * @param {string} domain — e.g. 'myportal.bitrix24.com'
 * @param {string} method — e.g. 'crm.deal.get'
 * @param {object} params — method parameters
 * @returns {any} Bitrix24 result
 * @throws if portal has no stored tokens, token refresh fails, or Bitrix24 returns an error
 */
export async function callBitrix(domain, method, params = {}) {
  let tokens = await loadTokens(domain);
  if (!tokens) {
    const err = new Error(`No stored tokens for ${domain}. The app may not be installed on this portal.`);
    err.code = 'portal_not_installed';
    throw err;
  }

  async function attempt(tok) {
    const url = `https://${domain}/rest/${method}`;
    const body = new URLSearchParams([
      ...flattenParams(params),
      ['auth', tok.access_token],
    ]).toString();

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    // Bitrix24 always returns 200; errors are in the JSON body
    return resp.json();
  }

  let data = await attempt(tokens);

  // Bitrix24 returns { error: 'expired_token' } (not HTTP 401) when access_token expires
  if (data.error === 'expired_token' || data.error === 'invalid_token') {
    console.log(`[bitrix] Token expired for ${domain}, refreshing...`);
    tokens = await refreshTokens(domain, tokens);
    data = await attempt(tokens);
  }

  if (data.error) {
    const err = new Error(data.error_description || data.error);
    err.code = data.error;
    throw err;
  }

  if (data.result === null || data.result === undefined) {
    console.warn(`[bitrix] ${method} returned null result. Full response:`, JSON.stringify(data));
  }

  return data.result;
}

/**
 * Fetch a single CRM deal by ID using the stored OAuth tokens.
 * Tries crm.deal.get first; falls back to crm.deal.list with ID filter
 * in case the token owner lacks direct deal read access (CRM role restriction).
 *
 * @param {string} domain
 * @param {number|string} dealId
 * @returns {object|null} deal object or null if not found
 */
export async function fetchDeal(domain, dealId) {
  const id = Number(dealId);

  // Primary: crm.deal.get
  const deal = await callBitrix(domain, 'crm.deal.get', { id });
  if (deal) return deal;

  // Fallback: crm.deal.list with ID filter (works when token has list but not get access)
  console.warn(`[bitrix] crm.deal.get returned null for deal ${id}, trying crm.deal.list fallback`);
  const list = await callBitrix(domain, 'crm.deal.list', {
    filter: { ID: id },
    select: ['ID', 'TITLE', 'STAGE_ID', 'ASSIGNED_BY_ID', 'CATEGORY_ID',
             'UF_CRM_APR_REVIEWER', 'UF_CRM_APR_PARTNER', 'CLOSEDATE'],
  });
  if (Array.isArray(list) && list.length > 0) return list[0];

  return null;
}
