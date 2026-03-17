/**
 * Appraisify – Notification Dispatcher (Vercel Serverless Function)
 *
 * Sends Bitrix24 in-app notifications to appraisal participants using
 * per-tenant OAuth tokens instead of a shared webhook.
 *
 * Env vars required:
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob token
 *   BX24_CLIENT_ID         — for token refresh
 *   BX24_CLIENT_SECRET     — for token refresh
 */

import { callBitrix } from './lib/bitrix.js';
import { parseBody, resolveDomain } from './lib/utils.js';
import { logError } from './lib/logger.js';

function parseEmployeeName(title) {
  const t = String(title || '').trim();
  if (!t) return 'employee';
  return t.split(/\s*[–\-]\s*/)[0].trim() || 'employee';
}

function buildNotificationMessage(type, deal) {
  const name = parseEmployeeName(deal?.TITLE);
  const dealId = String(deal?.ID || '');
  const ref = dealId ? `#APR-${dealId}` : 'this appraisal';

  const MAP = {
    launch: `Your appraisal cycle has started for ${name}. Please go to Appraisify to complete your self-assessment. (${ref})`,
    self_submitted: `${name} has submitted self-assessment. Please go to Appraisify to complete reviewer evaluation. (${ref})`,
    reviewer_submitted: `${name} reviewer evaluation is complete. Please go to Appraisify to submit partner review. (${ref})`,
    partner_submitted: `${name} appraisal cycle is completed. Please go to Appraisify to view the final review summary. (${ref})`,
  };

  return MAP[type] || `Appraisal update for ${name}. Please go to Appraisify for details. (${ref})`;
}

function recipientIdsForEvent(type, deal) {
  const reviewee = Number(deal?.ASSIGNED_BY_ID);
  const reviewer = Number(deal?.UF_CRM_APR_REVIEWER);
  const partner = Number(deal?.UF_CRM_APR_PARTNER);

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
    const deal = await callBitrix(domain, 'crm.deal.get', { id: Number(dealId) });
    if (!deal) {
      return res.status(404).json({ error: 'deal_not_found' });
    }

    const recipients = recipientIdsForEvent(type, deal);
    if (!recipients.length) {
      return res.status(200).json({ ok: true, type, dealId, notified: 0, skipped: true, reason: 'no_recipients' });
    }

    const message = buildNotificationMessage(type, deal);
    const results = [];

    for (const uid of recipients) {
      try {
        await callBitrix(domain, 'im.notify.system.add', {
          USER_ID: uid,
          MESSAGE: message,
          TAG: `appraisify|${type}|${dealId}|${uid}`,
        });
        results.push({ userId: uid, ok: true });
      } catch (e) {
        results.push({ userId: uid, ok: false, error: e.code || e.message || 'notify_failed' });
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
