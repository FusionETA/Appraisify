/**
 * Shared server-side utilities used across API handlers.
 */

/**
 * Flattens a nested object to PHP-style bracket-notation key/value pairs.
 * e.g. { fields: { CATEGORY_ID: 96 } } → [["fields[CATEGORY_ID]", "96"]]
 * Required by the Bitrix24 REST API when called server-to-server.
 */
export function flattenParams(obj, prefix = '') {
  const pairs = [];
  for (const [key, val] of Object.entries(obj || {})) {
    const k = prefix ? `${prefix}[${key}]` : key;
    if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
      pairs.push(...flattenParams(val, k));
    } else if (Array.isArray(val)) {
      val.forEach((item, i) => pairs.push([`${k}[${i}]`, String(item)]));
    } else if (val !== null && val !== undefined) {
      pairs.push([k, String(val)]);
    }
  }
  return pairs;
}

/**
 * Normalise a raw domain string — strips protocol, path, query string, lowercases.
 * e.g. 'https://myportal.bitrix24.com/path?q=1' → 'myportal.bitrix24.com'
 */
export function normalizeDomain(raw) {
  if (!raw) return '';
  let value = String(raw).trim().toLowerCase();
  if (!value) return '';
  if (value.includes('://')) {
    try { value = new URL(value).hostname.toLowerCase(); } catch (_) {}
  }
  return value.split('/')[0].split('?')[0];
}

/**
 * Parse the request body from a Vercel serverless function request.
 * Handles pre-parsed objects, JSON strings, and missing bodies.
 */
export function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return typeof req.body === 'object' ? req.body : {};
}

/**
 * Resolve the Bitrix24 portal domain from a Vercel request.
 * Bitrix24 passes DOMAIN in the query string when opening the app iframe.
 */
export function resolveDomain(req, body) {
  return normalizeDomain(
    req.query?.DOMAIN ||
    req.query?.domain ||
    body?.DOMAIN ||
    body?.domain ||
    req.headers?.['x-appraisify-domain']
  );
}
