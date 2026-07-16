/**
 * Appraisify – Notification Dispatcher (Vercel Serverless Function)
 *
 * Sends Bitrix24 in-app notifications to appraisal participants using
 * per-tenant OAuth tokens instead of a shared webhook.
 *
 * Env vars required:
 *   BX24_CLIENT_ID         — for token refresh
 *   BX24_CLIENT_SECRET     — for token refresh
 */

import { callBitrix, fetchDeal } from './_lib/bitrix.js';
import { blobFind, blobGet } from './_lib/kv.js';
import { parseBody, resolveDomain } from './_lib/utils.js';
import { logError } from './_lib/logger.js';

function parseEmployeeName(title) {
  const t = String(title || '').trim();
  if (!t) return 'employee';
  return t.split(/\s*[–\-]\s*/)[0].trim() || 'employee';
}

function parseCycleTitle(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  const parts = t.split(/\s*[–\-]\s*/);
  return parts.length > 1 ? parts.slice(1).join(' – ').trim() : '';
}

const DIRECT_PAGE = {
  launch:             'appraisal-reviewee.html',
  self_submitted:     'appraisal-reviewer.html',
  reviewer_submitted: 'appraisal-partner.html',
  partner_submitted:  'appraisal-reviewee.html',
};

const APP_BASE_URL = 'https://appraisify-plus.vercel.app/views/';

function buildDirectLink(type, dealId, domain, uid, config) {
  const page = DIRECT_PAGE[type];
  if (!page) return null;
  const params = new URLSearchParams({
    appraisal: dealId,
    domain,
    userId: String(uid),
    mode: config.crm_mode || 'deal',
  });
  if (config.category_id)     params.set('categoryId',    String(config.category_id));    // deal mode pipeline category
  if (config.entity_type_id)  params.set('entityTypeId',  String(config.entity_type_id));
  if (config.spa_type_id)     params.set('spaTypeId',     String(config.spa_type_id));
  if (config.spa_category_id) params.set('spaCategoryId', String(config.spa_category_id));
  return `${APP_BASE_URL}${page}?${params.toString()}`;
}

function buildNotificationMessage(type, deal, domain, uid, config) {
  const name    = parseEmployeeName(deal?.TITLE);
  const cycle   = parseCycleTitle(deal?.TITLE);
  const dealId  = String(deal?.ID || '');
  const ref     = dealId ? `#APR-${dealId}` : 'this appraisal';
  const label   = cycle ? `"${cycle}"` : ref;
  const appUrl  = domain ? `https://${domain}/marketplace/app/fusion_eta.appraisify_v2/` : null;
  const directUrl = buildDirectLink(type, dealId, domain, uid, config);

  const appLink    = appUrl    ? `[URL=${appUrl}]open Appraisify[/URL]`  : 'open Appraisify';
  const directLink = directUrl ? ` or [URL=${directUrl}]click here[/URL]` : '';

  const MAP = {
    launch:             `Your appraisal ${label} has started. Please ${appLink}${directLink} to submit your self-assessment.`,
    self_submitted:     `${name} has submitted their self-assessment for ${label}. Please ${appLink}${directLink} to complete your reviewer evaluation.`,
    reviewer_submitted: `The reviewer evaluation for ${name} – ${label} is complete. Please ${appLink}${directLink} to submit your partner review.`,
    partner_submitted:  `The appraisal ${label} for ${name} is now complete. Please ${appLink}${directLink} to view the final review summary.`,
  };

  return MAP[type] || `Appraisal update for ${name} (${ref}). Please ${appLink}${directLink} for details.`;
}

function recipientIdsForEvent(type, deal) {
  const reviewee = Number(deal?.ASSIGNED_BY_ID);
  const reviewer = Number(deal?.UF_CRM_REVIEWER);
  const partner = Number(deal?.UF_CRM_PARTNER);

  const map = {
    launch: [reviewee],
    self_submitted: [reviewer],
    reviewer_submitted: [partner],
    partner_submitted: [reviewee],
  };

  return [...new Set((map[type] || []).filter(Number.isFinite))];
}

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = parseBody(req);
  const type = String(body.type || '').trim();
  const dealId = String(body.dealId || '').trim();
  const domain = resolveDomain(req, body);

  const allowedTypes = new Set(['launch', 'self_submitted', 'reviewer_submitted', 'partner_submitted']);
  if (!allowedTypes.has(type)) {
    return res.status(400).json({ error: 'invalid_notification_type' });
  }
  if (!dealId) {
    return res.status(400).json({ error: 'missing_deal_id' });
  }
  if (!domain) {
    return res.status(400).json({ error: 'tenant_context_missing' });
  }

  try {
    // Try Redis-cached deal metadata first (avoids CRM permission issues with server-side token)
    let deal = null;
    try {
      const mappingBlob = await blobFind(`portals/${domain}/appraisal-templates/${dealId}.json`);
      if (mappingBlob?.url) {
        const m = await blobGet(mappingBlob.url);
        if (m?.revieweeId) {
          deal = {
            ID: String(dealId),
            TITLE: m.title || '',
            ASSIGNED_BY_ID: String(m.revieweeId),
            UF_CRM_REVIEWER: m.reviewerId ? String(m.reviewerId) : null,
            UF_CRM_PARTNER:  m.partnerId  ? String(m.partnerId)  : null,
            CATEGORY_ID: m.categoryId ? String(m.categoryId) : null,
          };
        }
      }
    } catch (_) {}
    // Fallback: fetch from Bitrix24 directly
    if (!deal) deal = await fetchDeal(domain, dealId);
    if (!deal) {
      return res.status(404).json({ error: 'deal_not_found' });
    }

    const recipients = recipientIdsForEvent(type, deal);
    if (!recipients.length) {
      return res.status(200).json({ ok: true, type, dealId, notified: 0, skipped: true, reason: 'no_recipients' });
    }

    // Portal config needed to build direct URL params (CRM mode, SPA IDs)
    const config = await blobGet(`portals/${domain}/config.json`).catch(() => null) || {};

    const results = [];

    for (const uid of recipients) {
      try {
        const message = buildNotificationMessage(type, deal, domain, uid, config);
        await callBitrix(domain, 'im.notify.system.add', {
          USER_ID: uid,
          MESSAGE: message,
          TAG: `appraisify|${type}|${dealId}|${uid}`,
        });
        results.push({ userId: uid, ok: true });
      } catch (e) {
        const errCode = e.code || 'notify_failed';
        results.push({ userId: uid, ok: false, error: errCode });
        logError(domain, { event: 'notify_failed', source: 'notify', error: errCode, message: e.message, dealId, type, userId: uid }).catch(() => {});
      }
    }

    const notified = results.filter(r => r.ok).length;
    return res.status(200).json({ ok: true, type, dealId, notified, results });

  } catch (e) {
    logError(domain, { event: 'error', source: 'notify', error: e.code || 'notification_failed', message: e.message, dealId }).catch(() => {});
    return res.status(503).json({
      error: e.code || 'notification_failed',
      error_description: e.message || 'Notification dispatch failed',
    });
  }
}
