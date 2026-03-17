/**
 * Appraisify – Debug: check actual OAuth scopes of stored token
 * GET /api/debug-scope?domain=fusion.bitrix24.com
 */
import { callBitrix } from './_lib/bitrix.js';
import { loadTokens } from './_lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  const domain = String(req.query.domain || 'fusion.bitrix24.com').trim();

  try {
    const tokens = await loadTokens(domain);
    if (!tokens) {
      return res.status(404).json({ error: 'no_token_stored', domain });
    }

    // Call scope directly using stored token
    const resp = await fetch(
      `https://${domain}/rest/scope.json?auth=${encodeURIComponent(tokens.access_token)}`
    );
    const data = await resp.json();

    return res.status(200).json({
      domain,
      storedAt:  tokens.storedAt || null,
      member_id: tokens.member_id,
      scopes:    data.result || [],
      raw:       data,
    });
  } catch (e) {
    return res.status(500).json({ error: e.code || 'error', message: e.message });
  }
}
