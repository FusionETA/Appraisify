/**
 * Appraisify – Server-side Bitrix24 API Proxy (Vercel Serverless Function)
 *
 * Uses a Bitrix24 incoming webhook (never expires, no token refresh needed)
 * to make privileged CRM calls on behalf of the app.
 *
 * Sends requests as application/x-www-form-urlencoded with PHP-style bracket
 * notation (fields[CATEGORY_ID]=96) — the most reliable format for Bitrix24's
 * PHP backend when called from Node.js server-to-server.
 *
 * Env vars required:
 *   BX24_WEBHOOK_URL — e.g. https://your-portal.bitrix24.com/rest/1/secretcode/
 */

// Methods permitted via the system proxy.
const ALLOWED_METHODS = new Set([
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
]);

/**
 * Flattens a nested object to PHP-style bracket-notation key/value pairs.
 * e.g. { fields: { CATEGORY_ID: 96 } } → [["fields[CATEGORY_ID]", "96"]]
 */
function flattenParams(obj, prefix = '') {
  const pairs = [];
  for (const [key, val] of Object.entries(obj)) {
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

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { method, params } = req.body || {};

  if (!method || !ALLOWED_METHODS.has(method)) {
    return res.status(400).json({
      error: 'method_not_allowed',
      error_description: `'${method}' is not permitted via proxy`,
    });
  }

  const webhookUrl = (process.env.BX24_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    console.error('[bx-proxy] BX24_WEBHOOK_URL env var not set');
    return res.status(500).json({
      error: 'webhook_not_configured',
      error_description: 'BX24_WEBHOOK_URL is not set in Vercel environment variables.',
    });
  }

  const url = `${webhookUrl}${method}`;
  const formBody = new URLSearchParams(flattenParams(params || {})).toString();
  console.log('[bx-proxy] →', method, formBody);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
    });

    const data = await resp.json();

    if (data.error) {
      console.error('[bx-proxy] Bitrix24 error:', method, data.error, data.error_description);
      return res.status(200).json({
        error: data.error,
        error_description: data.error_description,
      });
    }

    console.log('[bx-proxy] OK:', method);
    return res.status(200).json({ result: data.result });

  } catch (e) {
    console.error('[bx-proxy] Fetch failed:', e.message);
    return res.status(500).json({ error: 'proxy_error', error_description: e.message });
  }
}
