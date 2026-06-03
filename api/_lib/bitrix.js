/**
 * Server-side Bitrix24 REST caller using per-tenant OAuth tokens.
 * Handles automatic token refresh on expiry.
 *
 * Supports both CRM storage modes:
 *   'deal' — standard crm.deal.* API
 *   'spa'  — Smart Process Automation crm.item.* API
 *
 * fetchDeal() reads portals/{domain}/config.json from KV to determine
 * which API to use and normalises the response to UPPERCASE Deal format
 * in both cases, so callers (appraisal-pdf.js) need no changes.
 *
 * NOTE: normalizeSpaItemToDeal() is the server-side counterpart of
 * _spaRecordToDealFormat() in assets/js/bx24.js.
 * Keep the field mappings in both files in sync when adding new custom fields.
 */

import { loadTokens, refreshTokens } from './auth.js';
import { flattenParams } from './utils.js';
import { blobGet } from './kv.js';

/**
 * Call a Bitrix24 REST method using the stored OAuth tokens for a portal.
 * Automatically refreshes the access_token once if it has expired.
 *
 * @param {string} domain — e.g. 'myportal.bitrix24.com'
 * @param {string} method — e.g. 'crm.deal.get'
 * @param {object} params — method parameters
 * @returns {any} Bitrix24 result
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

    return resp.json();
  }

  let data = await attempt(tokens);

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

  return data.result;
}

/**
 * Load portal config (crm_mode, category_id, entity_type_id) from KV.
 * Returns {} if no config has been stored yet (defaults to deal mode).
 */
async function loadPortalConfig(domain) {
  try {
    return (await blobGet(`portals/${domain}/config.json`)) || {};
  } catch (e) {
    console.warn(`[bitrix] loadPortalConfig failed for ${domain}:`, e.message);
    return {};
  }
}

/**
 * Normalises a crm.item.* response record to UPPERCASE Deal format so
 * callers work identically regardless of CRM mode.
 *
 * NOTE: client-side counterpart is _spaRecordToDealFormat() in
 * assets/js/bx24.js. Keep mappings in sync when adding new custom fields.
 *
 * @param {object} item        - raw crm.item response object
 * @param {string|number} typeId - small SPA type ID (type.id from crm.type.add, e.g. 16)
 *                                 used as prefix in field names: ufCrm{typeId}AprReviewer
 * @returns {object}
 */
function normalizeSpaItemToDeal(item, typeId) {
  if (!item) return null;

  const STATIC_MAP = {
    id:           'ID',
    title:        'TITLE',
    stageId:      'STAGE_ID',
    assignedById: 'ASSIGNED_BY_ID',
    closeDate:    'CLOSEDATE',
    comments:     'COMMENTS',
  };

  const out = {};
  const ufPrefix    = `ufCrm${typeId}`;
  const ufPrefixOrig = `UF_CRM_${typeId}_`;

  for (const [key, val] of Object.entries(item)) {
    if (STATIC_MAP[key]) {
      out[STATIC_MAP[key]] = val;
      continue;
    }
    // Original-name format (returned when useOriginalUfNames:'Y' is used):
    // 'UF_CRM_174_APR_S_S01' → 'UF_CRM_APR_S_S01'
    if (key.startsWith(ufPrefixOrig)) {
      out[`UF_CRM_${key.slice(ufPrefixOrig.length)}`] = val;
      continue;
    }
    // camelCase format (default crm.item.* response):
    // 'ufCrm174AprReviewer' → 'UF_CRM_APR_REVIEWER'
    if (key.startsWith(ufPrefix)) {
      const suffix = key.slice(ufPrefix.length); // 'AprReviewer'
      const snake  = suffix
        .replace(/([A-Z])/g, '_$1')
        .toUpperCase()
        .replace(/^_/, ''); // 'APR_REVIEWER'
      out[`UF_CRM_${snake}`] = val;
      continue;
    }
    out[key] = val;
  }

  return out;
}

/**
 * Fetch a single appraisal record by ID using the stored OAuth tokens.
 * Reads crm_mode from portal config to route to the correct Bitrix24 API.
 * Always returns a record in UPPERCASE Deal format, or null if not found.
 *
 * @param {string} domain
 * @param {number|string} dealId
 * @returns {object|null}
 */
export async function fetchDeal(domain, dealId) {
  const id     = Number(dealId);
  const config = await loadPortalConfig(domain);
  const mode   = config.crm_mode || 'deal';

  if (mode === 'spa') {
    const entityTypeId = Number(config.entity_type_id);
    if (!entityTypeId) {
      const err = new Error('entity_type_id not found in portal config — reinstall may be required');
      err.code = 'spa_config_missing';
      throw err;
    }
    // typeId is the small sequential ID (type.id from crm.type.add) used as field name prefix.
    // Fall back to entityTypeId for portals installed before spa_type_id was captured.
    const typeId = config.spa_type_id || config.entity_type_id;

    console.log(`[bitrix] fetchDeal (SPA) entityTypeId=${entityTypeId} typeId=${typeId} id=${id} domain=${domain}`);
    const result = await callBitrix(domain, 'crm.item.get', { entityTypeId, id, useOriginalUfNames: 'Y' });
    // crm.item.get returns { item: { ... } }
    const item = result && result.item ? result.item : result;
    return normalizeSpaItemToDeal(item, typeId);
  }

  // Deal mode — try crm.deal.get, fall back to crm.deal.list
  console.log(`[bitrix] fetchDeal (Deal) id=${id} domain=${domain}`);
  const deal = await callBitrix(domain, 'crm.deal.get', { id });
  if (deal) return deal;

  console.warn(`[bitrix] crm.deal.get returned null for deal ${id}, trying crm.deal.list fallback`);
  const list = await callBitrix(domain, 'crm.deal.list', {
    filter: { ID: id },
    select: ['ID', 'TITLE', 'STAGE_ID', 'ASSIGNED_BY_ID', 'CATEGORY_ID', 'CLOSEDATE',
             'UF_CRM_REVIEWEE', 'UF_CRM_REVIEWER', 'UF_CRM_PARTNER',
             'UF_CRM_YEAR', 'UF_CRM_APPRAISAL_TYPE', 'UF_CRM_TEAM', 'UF_CRM_ROLE',
             'UF_CRM_REVIEWEE_SUBMITTED_AT', 'UF_CRM_REVIEWER_SUBMITTED_AT', 'UF_CRM_PARTNER_SUBMITTED_AT'],
  });
  if (Array.isArray(list) && list.length > 0) return list[0];

  return null;
}
