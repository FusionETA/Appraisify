/**
 * Appraisify – Deeplink Retrieval (Vercel Serverless Function)
 *
 * Called by api/app.js (client-side) after BX24.init() to check whether
 * a pending deeplink was stored when a notification was sent to this user.
 * Returns and clears the deeplink in one request.
 *
 * GET /api/deeplink?domain=DOMAIN&userId=UID
 */

import { blobGet, blobDelete } from './_lib/kv.js';
import { normalizeDomain } from './_lib/utils.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const domain = normalizeDomain(req.query?.domain || '');
  const userId = String(req.query?.userId || '').trim();

  if (!domain || !userId) {
    return res.status(400).json({ error: 'missing_params', deeplink: null });
  }

  const key = `deeplink:${domain}:${userId}`;

  try {
    const deeplink = await blobGet(key);
    if (deeplink) {
      await blobDelete(key).catch(() => {});
      console.log(`[Appraisify] deeplink consumed for user ${userId}: appraisal=${deeplink.appraisal} view=${deeplink.view}`);
      return res.status(200).json({ deeplink });
    }
    return res.status(200).json({ deeplink: null });
  } catch (e) {
    console.error(`[Appraisify] deeplink fetch failed for ${userId}:`, e?.message || e);
    return res.status(200).json({ deeplink: null });
  }
}
