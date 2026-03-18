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

      // userId branch: return all active deals for a user (dashboard pending tasks)
      if (userId) {
        const key  = `portals/${domain}/user_deals/${userId}`;
        const data = await blobGet(key) || {};
        const activeEntries = Object.entries(data).filter(([, d]) => d && d.stage !== 'APPRAISIFY_DONE');

        if (activeEntries.length) {
          // Verify deals still exist in CRM and sync real STAGE_ID as source of truth.
          // Uses the stored admin OAuth token — works even when the user has "See Own" only.
          const dealIds = activeEntries.map(([id]) => id);
          let crmDeals = {};
          try {
            const list = await callBitrix(domain, 'crm.deal.list', {
              filter: { '@ID': dealIds },
              select: ['ID', 'STAGE_ID'],
            });
            (list || []).forEach(d => { crmDeals[String(d.ID)] = d; });
          } catch (e) {
            console.warn('[appraisal-template] CRM deal list failed (non-fatal):', e.message);
          }

          let dirty = false;
          for (const [dealId] of activeEntries) {
            const crmDeal = crmDeals[dealId];
            if (!crmDeal) {
              // Deal was deleted from CRM — remove from cache
              delete data[dealId];
              dirty = true;
            } else {
              // Sync stage from CRM (strip C{catId}: prefix if present)
              const raw   = crmDeal.STAGE_ID || '';
              const stage = raw.includes(':') ? raw.split(':')[1] : raw;
              if (stage && stage !== data[dealId]?.stage) {
                data[dealId] = { ...data[dealId], stage };
                dirty = true;
              }
            }
          }

          if (dirty) {
            blobPut(key, data).catch(e => console.warn('[appraisal-template] Upstash write failed:', e.message));
          }
        }

        const deals = Object.entries(data)
          .filter(([, d]) => d && d.stage !== 'APPRAISIFY_DONE')
          .map(([dealId, d]) => ({ dealId, ...d }));
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

      // Store per-user role assignments so the dashboard can find deals
      // without needing CRM access (avoids "See Own" system token restriction).
      const roleEntries = [
        [revieweeId, 'self'],
        [reviewerId, 'reviewer'],
        [partnerId,  'partner'],
      ];
      await Promise.all(roleEntries
        .filter(([uid]) => uid)
        .map(async ([uid, role]) => {
          const key      = `portals/${domain}/user_deals/${uid}`;
          const existing = await blobGet(key) || {};
          existing[dealId] = { role, stage: 'APPRAISIFY_RVWEE', title, closeDate };
          await blobPut(key, existing);
        }));

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
