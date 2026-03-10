/**
 * Appraisify – Store installer OAuth tokens in Vercel Blob (Vercel Serverless Function)
 *
 * Called from the install page right after BX24.init() fires.
 * Stores the installer's OAuth tokens per portal so any user of that portal
 * can trigger privileged CRM calls via /api/bx-proxy.
 *
 * Tokens are stored at: portals/{domain}/auth.json
 *
 * Env vars required:
 *   BLOB_READ_WRITE_TOKEN — from Vercel dashboard → Storage → Blob → Connect
 */

import { storeTokens } from './lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { access_token, refresh_token, domain, member_id } = req.body || {};

  if (!access_token || !member_id || !domain) {
    return res.status(400).json({
      error: 'missing_params',
      error_description: 'access_token, member_id and domain are required',
    });
  }

  try {
    await storeTokens(domain, { access_token, refresh_token, domain, member_id });
    console.log(`[store-auth] Stored tokens for ${domain} (member_id=${member_id})`);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[store-auth] Failed:', e.message);
    const status = e.code === 'storage_not_configured' ? 500 : 503;
    return res.status(status).json({
      error: e.code || 'storage_error',
      error_description: e.message,
    });
  }
}
