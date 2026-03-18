/**
 * Appraisify – Deal-to-Template Mapping (Vercel Serverless Function)
 *
 * Maps a Bitrix24 deal ID to an appraisal template ID, per portal.
 *
 * Blob path: portals/{domain}/appraisal-templates/{dealId}.json
 *
 * Env vars required:

 */

import { blobPut, blobGet, blobFind } from './_lib/kv.js';
import { callBitrix } from './_lib/bitrix.js';
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
      const userId = String(req.query?.userId || '').trim();

      // userId branch: return all active deals for a user across all 3 roles.
      // Uses the stored admin OAuth token so reviewers/partners can see deals
      // they are not assigned to (bypasses "See Own" CRM restriction).
      if (userId) {
        const categoryId = String(req.query?.categoryId || '').trim();
        if (!categoryId) {
          return res.status(400).json({ error: 'missing_category_id' });
        }

        const select = ['ID', 'TITLE', 'STAGE_ID', 'CLOSEDATE'];
        const baseFilter = { CATEGORY_ID: categoryId };

        const [revieweeRes, reviewerRes, partnerRes] = await Promise.allSettled([
          callBitrix(domain, 'crm.deal.list', {
            filter: { ...baseFilter, ASSIGNED_BY_ID: userId }, select,
          }),
          callBitrix(domain, 'crm.deal.list', {
            filter: { ...baseFilter, UF_CRM_APR_REVIEWER: userId }, select,
          }),
          callBitrix(domain, 'crm.deal.list', {
            filter: { ...baseFilter, UF_CRM_APR_PARTNER: userId }, select,
          }),
        ]);

        const toDeals = (result, role) => {
          if (result.status !== 'fulfilled') return [];
          return (result.value || []).map(d => {
            const raw   = d.STAGE_ID || '';
            const stage = raw.includes(':') ? raw.split(':')[1] : raw;
            return { dealId: String(d.ID), role, stage, title: d.TITLE || '', closeDate: d.CLOSEDATE || '' };
          });
        };

        // Merge; deduplicate by dealId (self > reviewer > partner); exclude completed
        const seen  = new Set();
        const deals = [];
        for (const d of [
          ...toDeals(revieweeRes, 'self'),
          ...toDeals(reviewerRes, 'reviewer'),
          ...toDeals(partnerRes,  'partner'),
        ]) {
          if (!seen.has(d.dealId) && d.stage !== 'APPRAISIFY_DONE') {
            seen.add(d.dealId);
            deals.push(d);
          }
        }

        return res.status(200).json({ ok: true, deals });
      }

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

      const title      = String(body.title      || '');
      const revieweeId = body.revieweeId ? Number(body.revieweeId) : null;
      const reviewerId = body.reviewerId ? Number(body.reviewerId) : null;
      const partnerId  = body.partnerId  ? Number(body.partnerId)  : null;
      const categoryId = body.categoryId ? Number(body.categoryId) : null;
      const closeDate  = String(body.closeDate  || '');

      await blobPut(mappingPath(domain, dealId), {
        templateId, title, revieweeId, reviewerId, partnerId, categoryId,
        closeDate, updatedAt: new Date().toISOString(),
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
