/**
 * Appraisify – Deal-to-Template Mapping (Vercel Serverless Function)
 *
 * Maps a Bitrix24 deal ID to an appraisal template ID, per portal.
 *
 * Blob path: portals/{domain}/appraisal-templates/{dealId}.json
 *
 * Env vars required:
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token
 */

import { blobPut, blobGet, blobFind } from './_lib/blob.js';
import { parseBody, resolveDomain } from './_lib/utils.js';

function mappingPath(domain, dealId) {
  return `portals/${domain}/appraisal-templates/${dealId}.json`;
}

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  const body = parseBody(req);
  const domain = resolveDomain(req, body);
  if (!domain) {
    return res.status(400).json({
      error: 'tenant_context_missing',
      error_description: 'Could not resolve portal domain from request context.',
    });
  }

  try {
    if (req.method === 'GET') {
      const dealId = String(req.query?.dealId || body.dealId || '').trim();
      if (!dealId) {
        return res.status(400).json({ error: 'missing_deal_id' });
      }

      const blob = await blobFind(mappingPath(domain, dealId));
      if (!blob) {
        return res.status(404).json({ error: 'template_mapping_not_found' });
      }

      const mapping = await blobGet(blob.url);
      if (!mapping || !mapping.templateId) {
        return res.status(404).json({ error: 'template_mapping_not_found' });
      }

      return res.status(200).json({ dealId, templateId: String(mapping.templateId), domain });
    }

    if (req.method === 'POST') {
      const dealId = String(body.dealId || '').trim();
      const templateId = String(body.templateId || '').trim();

      if (!dealId || !templateId) {
        return res.status(400).json({
          error: 'missing_params',
          error_description: 'dealId and templateId are required',
        });
      }

      await blobPut(mappingPath(domain, dealId), {
        templateId,
        updatedAt: new Date().toISOString(),
      });

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });

  } catch (e) {
    const code = e && e.code;
    const status = code === 'storage_not_configured' ? 500 : 503;
    return res.status(status).json({
      error: code || 'storage_error',
      error_description: e.message || 'Storage operation failed',
    });
  }
}
