/**
 * Appraisify – Appraisal Record Fetcher (Vercel Serverless Function)
 *
 * Mode-aware wrapper around fetchDeal: routes to crm.deal.get (deal mode)
 * or crm.item.get (SPA mode) based on the portal's stored config.
 * Used by appraisal-report-preview.html to avoid hardcoding crm.deal.get.
 */

import { fetchDeal } from './_lib/bitrix.js';
import { parseBody, resolveDomain } from './_lib/utils.js';
import { logError } from './_lib/logger.js';

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = parseBody(req);
  const dealId = String(req.query?.dealId || body.dealId || '').trim();
  const domain = resolveDomain(req, body);

  if (!dealId) return res.status(400).json({ error: 'missing_deal_id' });
  if (!domain) return res.status(400).json({ error: 'missing_domain' });

  try {
    const deal = await fetchDeal(domain, dealId);
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });
    return res.status(200).json({ result: deal });
  } catch (e) {
    logError(domain, { event: 'error', source: 'appraisal-record', error: e.code || 'fetch_error', message: e.message }).catch(() => {});
    const status = e.code === 'portal_not_installed' ? 401
      : e.code === 'spa_config_missing' ? 500
      : 503;
    return res.status(status).json({ error: e.code || 'fetch_error', error_description: e.message });
  }
}
