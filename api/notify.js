/**
 * Appraisify – Notification Dispatcher (Vercel Serverless Function)
 *
 * Sends Bitrix24 in-app notifications to appraisal participants using
 * per-tenant OAuth tokens instead of a shared webhook.
 * Includes a direct link to the relevant in-app appraisal form page.
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
import { sendAppraisalEmail } from './_lib/email.js';

// Internal app page to link to for each in-app (Bitrix24 bell) notification
const NOTIFY_PAGE = {
  launch:             '/views/appraisal-reviewee.html',
  self_submitted:     '/views/appraisal-reviewer.html',
  reviewer_submitted: '/views/appraisal-partner.html',
  // partner_submitted → appraisal complete, no new page needed
};

// Phase token to generate for actionable email CTAs (external form link)
const LINK_PHASE = {
  launch:             'self',
  self_submitted:     'reviewer',
  reviewer_submitted: 'partner',
  // partner_submitted → PDF link instead (built separately below)
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

    const appUrl = (process.env.APP_URL || `https://${req.headers.host}`).replace(/\/$/, '');

    // Build in-app notification link (Bitrix24 bell)
    let link = null;
    const notifyPage = NOTIFY_PAGE[type];
    if (notifyPage) {
      link = `${appUrl}${notifyPage}?appraisal=${dealId}`;
    }

    // Build email CTA link:
    //   actionable phases → external form via single-use token
    //   completion        → direct PDF download
    let emailLink = null;
    const linkPhase = LINK_PHASE[type];
    if (linkPhase) {
      try {
        const t = await generateToken(domain, Number(dealId), linkPhase);
        emailLink = `${appUrl}/appraisal?token=${t}`;
      } catch (e) {
        console.error('[notify] Token generation failed (non-fatal):', e.message);
        logError(domain, { event: 'token_gen_failed', source: 'notify', error: e.code || 'token_gen_failed', message: e.message, dealId, type }).catch(() => {});
      }
    } else if (type === 'partner_submitted') {
      emailLink = `${appUrl}/api/appraisal-pdf?dealId=${dealId}&domain=${encodeURIComponent(domain)}`;
    }

    const message = buildNotificationMessage(type, deal, link);
    const name    = parseEmployeeName(deal?.TITLE);
    const ref     = `#APR-${dealId}`;
    const results = [];

    for (const uid of recipients) {
      // In-app Bitrix24 notification
      try {
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

      // Email notification (non-fatal — never blocks in-app)
      try {
        const userResult = await callBitrix(domain, 'user.get', { ID: uid });
        const user       = Array.isArray(userResult) ? userResult[0] : userResult;
        const rawEmail   = Array.isArray(user?.EMAIL) ? user.EMAIL[0]?.VALUE : user?.EMAIL;
        if (!rawEmail) {
          results[results.length - 1].email_skipped = 'no_email_address';
        } else {
          await sendAppraisalEmail({ to: rawEmail, type, employeeName: name, ref, ctaUrl: emailLink });
          results[results.length - 1].emailed = true;
        }
      } catch (e) {
        results[results.length - 1].email_error = e.code || e.message || 'email_failed';
        logError(domain, { event: 'email_failed', source: 'notify', error: e.code || 'email_failed', message: e.message, dealId, type, userId: uid }).catch(() => {});
      }
    }

    const notified = results.filter(r => r.ok).length;
    const emailed  = results.filter(r => r.emailed).length;
    return res.status(200).json({ ok: true, type, dealId, notified, emailed, results, link, emailLink });

  } catch (e) {
    logError(domain, { event: 'error', source: 'notify', error: e.code || 'notification_failed', message: e.message, dealId }).catch(() => {});
    return res.status(503).json({
      error: e.code || 'notification_failed',
      error_description: e.message || 'Notification dispatch failed',
    });
  }
}
