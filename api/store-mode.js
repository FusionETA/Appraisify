/**
 * Appraisify – Store portal CRM mode config in Upstash Redis (Vercel Serverless Function)
 *
 * Called from the install page after the admin chooses a mode and the pipeline
 * or SPA entity has been created. Persists mode configuration so server-side
 * handlers (appraisal-pdf.js, bitrix.js) can route to the correct Bitrix24 API.
 *
 * Config is stored at: portals/{domain}/config.json
 * Shape: { crm_mode: 'deal'|'spa', category_id?: string, entity_type_id?: string }
 *
 * Env vars required:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

import { blobGet, blobPut } from './_lib/kv.js';

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = req.body || {};
  const domain     = String(body.domain     || '').split('/')[0].toLowerCase().trim();
  const member_id  = String(body.member_id  || '').trim();
  const crm_mode   = String(body.crm_mode   || '').trim();

  if (!domain) {
    return res.status(400).json({
      error: 'missing_domain',
      error_description: 'domain is required',
    });
  }

  if (!crm_mode || !['deal', 'spa'].includes(crm_mode)) {
    return res.status(400).json({
      error: 'invalid_mode',
      error_description: "crm_mode must be 'deal' or 'spa'",
    });
  }

  try {
    const key = `portals/${domain}/config.json`;

    // Merge into existing config so unrelated fields are preserved
    const existing = await blobGet(key) || {};
    const updated = { ...existing, crm_mode };

    if (crm_mode === 'deal') {
      const category_id = String(body.category_id || '').trim();
      if (category_id) updated.category_id = category_id;
      // Clear any stale SPA fields from a previous install
      delete updated.entity_type_id;
    }

    if (crm_mode === 'spa') {
      const entity_type_id  = String(body.entity_type_id  || '').trim();
      const spa_category_id = String(body.spa_category_id || '').trim();
      if (entity_type_id)  updated.entity_type_id  = entity_type_id;
      if (spa_category_id) updated.spa_category_id = spa_category_id;
      // Clear any stale Deal fields from a previous install
      delete updated.category_id;
    }

    if (member_id) updated.member_id = member_id;

    await blobPut(key, updated);

    console.log(`[store-mode] Stored crm_mode=${crm_mode} for ${domain}`);
    return res.status(200).json({ ok: true, crm_mode });

  } catch (e) {
    console.error('[store-mode] Error:', e.message);
    const status = e.code === 'storage_not_configured' ? 500 : 503;
    return res.status(status).json({
      error: e.code || 'storage_error',
      error_description: e.message,
    });
  }
}
