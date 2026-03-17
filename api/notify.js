/**
 * Appraisify – Notification Dispatcher (Vercel Serverless Function)
 *
 * Sends Bitrix24 in-app notifications to appraisal participants using
 * per-tenant OAuth tokens instead of a shared webhook.
 * Also generates a secure single-use external appraisal link for the recipient.
 *
 * Env vars required:
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob token
 *   BX24_CLIENT_ID         — for token refresh
 *   BX24_CLIENT_SECRET     — for token refresh
 *   APP_URL                — public app URL (e.g. https://appraisify-v2-123.vercel.app)
 *                            used to build the appraisal link; falls back to request host
 */

import { callBitrix } from './_lib/bitrix.js';
import { parseBody, resolveDomain } from './_lib/utils.js';
import { logError } from './_lib/logger.js';
import { generateToken } from './_lib/tokens.js';

// Which phase token to generate for each event type (undefined = no link)
const LINK_PHASE = {
  launch:             'self',
  self_submitted:     'reviewer',
  reviewer_submitted: 'partner',
  // partner_submitted → appraisal complete, no new link needed
};

function parseEmployeeName(title) {
  const t = String(title || '').trim();
  if (!t) return 'employee';
  return t.split(/\s*[–\-]\s*/)[0].trim() || 'employee';
}

function buildNotificationMessage(type, deal, link) {
  const name   = parseEmployeeName(deal?.TITLE);
  const dealId = String(deal?.ID || '');
  const ref    = dealId ? `#APR-${dealId}` : 'this appraisal';
  const linkPart = link ? ` | Direct link: ${link}` : '';

  const MAP = {
    launch:             `Your appraisal cycle has started for ${name}. Please complete your self-assessment. (${ref})${linkPart}`,
    self_submitted:     `${name} has submitted self-assessment. Please complete reviewer evaluation. (${ref})${linkPart}`,
    reviewer_submitted: `${name} reviewer evaluation is complete. Please submit partner review. (${ref})${linkPart}`,
    partner_submitted:  `${name} appraisal cycle is completed. Please go to Appraisify to view the final review summary. (${ref})`,
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

    // Generate external appraisal link (single-use, 7-day token) for actionable phases
    let link = null;
    const linkPhase = LINK_PHASE[type];
    if (linkPhase) {
      try {
        const appUrl = (process.env.APP_URL || `https://${req.headers.host}`).replace(/\/$/, '');
        const t = await generateToken(domain, Number(dealId), linkPhase);
        link = `${appUrl}/appraisal?token=${t}`;
        console.log(`[notify] Generated appraisal link for ${type} (${linkPhase}):`, link);
      } catch (e) {
        // Non-fatal — notification still sent without link
        console.error('[notify] Token generation failed (non-fatal):', e.message);
      }
    }

    const message = buildNotificationMessage(type, deal, link);
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
    return res.status(200).json({ ok: true, type, dealId, notified, results, link });

  } catch (e) {
    logError(domain, { event: 'error', source: 'notify', error: e.code || 'notification_failed', message: e.message, dealId }).catch(() => {});
    return res.status(503).json({
      error: e.code || 'notification_failed',
      error_description: e.message || 'Notification dispatch failed',
    });
  }
}
