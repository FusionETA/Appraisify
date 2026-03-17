/**
 * Appraisify – External Appraisal Link Validator (Vercel Serverless Function)
 *
 * GET /api/appraisal-link?token={token}
 *
 * Validates the token and returns deal + template data so the external form
 * can render questions. Does NOT consume the token (allows page refresh).
 *
 * Env vars required:
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob token
 *   BX24_CLIENT_ID / BX24_CLIENT_SECRET — for Bitrix24 token refresh
 */

import { validateToken } from './_lib/tokens.js';
import { callBitrix } from './_lib/bitrix.js';
import { blobFind, blobGet } from './_lib/blob.js';
import { logError } from './_lib/logger.js';

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'GET') return res.status(405).end();

  const token = String(req.query.token || '').trim();

  if (!token) {
    return res.status(400).json({ error: 'missing_token', error_description: 'No token provided.' });
  }

  let tokenResult;
  try {
    tokenResult = await validateToken(token);
  } catch (e) {
    const status = e.code === 'token_used' ? 410 : 401;
    return res.status(status).json({ error: e.code || 'token_invalid', error_description: e.message });
  }

  const { domain, dealId, phase } = tokenResult;

  try {
    // Fetch deal from Bitrix24
    const deal = await callBitrix(domain, 'crm.deal.get', { id: dealId });
    if (!deal) {
      return res.status(404).json({ error: 'deal_not_found', error_description: 'Appraisal deal not found.' });
    }

    // Load template mapping for this deal (portals/{domain}/appraisal-templates/{dealId}.json)
    let templateId = null;
    try {
      const mappingBlob = await blobFind(`portals/${domain}/appraisal-templates/${dealId}`);
      if (mappingBlob?.url) {
        const mapping = await blobGet(mappingBlob.url);
        templateId = mapping?.templateId || null;
      }
    } catch (_) {}

    // Fallback: extract template ID embedded in deal COMMENTS field
    if (!templateId && deal.COMMENTS) {
      const m = String(deal.COMMENTS).match(/\[APPRAISIFY_TEMPLATE_ID:([^\]]+)\]/);
      if (m) templateId = m[1].trim();
    }

    // Load template document
    let template = null;
    if (templateId) {
      try {
        const tBlob = await blobFind(`portals/${domain}/templates/${templateId}`);
        if (tBlob?.url) {
          template = await blobGet(tBlob.url);
        }
      } catch (_) {}
    }

    return res.status(200).json({
      phase,
      deal: {
        id: String(deal.ID),
        title: deal.TITLE || '',
        CATEGORY_ID: deal.CATEGORY_ID || null,
        ASSIGNED_BY_ID: deal.ASSIGNED_BY_ID || null,
        UF_CRM_APR_REVIEWER: deal.UF_CRM_APR_REVIEWER || null,
        UF_CRM_APR_PARTNER: deal.UF_CRM_APR_PARTNER || null,
      },
      template: template
        ? { id: template.id, name: template.name || '', sections: template.sections || {} }
        : null,
    });

  } catch (e) {
    logError(domain, {
      event: 'error', source: 'appraisal-link',
      error: e.code || 'server_error', message: e.message, dealId,
    }).catch(() => {});
    return res.status(503).json({ error: e.code || 'server_error', error_description: e.message });
  }
}
