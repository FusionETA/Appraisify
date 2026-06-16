/**
 * Appraisify – ONAPPUNINSTALL handler (Vercel Serverless Function)
 *
 * Bitrix24 POSTs to this endpoint when the app is uninstalled from a portal.
 * Register this URL as the ONAPPUNINSTALL event handler in the app manifest.
 *
 * Logs the uninstall event to: logs/installs/YYYY-MM-DD.json
 */

import { logInstall } from './_lib/logger.js';
import { normalizeDomain } from './_lib/utils.js';

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body   = req.body || {};
  const domain = normalizeDomain(body.DOMAIN || body.domain || '');

  if (domain) {
    logInstall(domain, {
      event:     'uninstall',
      member_id: body.member_id || body.MEMBER_ID || '',
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true });
}
