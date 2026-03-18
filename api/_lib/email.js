/**
 * Appraisify – Email Notification Helper (Resend REST API)
 *
 * Sends HTML appraisal notification emails via Resend.
 * Uses native fetch — no npm package required (same pattern as blob.js).
 *
 * Env vars required:
 *   RESEND_API_KEY — from Resend dashboard → API Keys
 *   RESEND_FROM    — verified sender, e.g. "Appraisify <noreply@yourdomain.com>"
 *
 * If RESEND_API_KEY is not set, sendAppraisalEmail returns { skipped: true }
 * so the caller continues without error.
 */

const RESEND_API = 'https://api.resend.com/emails';

// ─── Content maps ────────────────────────────────────────────────────────────

const EMAIL_SUBJECT = {
  launch:             (ref) => `Self-assessment ready — ${ref}`,
  self_submitted:     (ref) => `Reviewer evaluation needed — ${ref}`,
  reviewer_submitted: (ref) => `Partner review needed — ${ref}`,
  partner_submitted:  (ref) => `Appraisal complete — ${ref}`,
};

const EMAIL_BODY = {
  launch:             (name) => `Your appraisal cycle has started for <strong>${esc(name)}</strong>. Please complete your self-assessment.`,
  self_submitted:     (name) => `<strong>${esc(name)}</strong> has submitted their self-assessment. Please complete your reviewer evaluation.`,
  reviewer_submitted: (name) => `The reviewer evaluation for <strong>${esc(name)}</strong> is complete. Please submit your partner review.`,
  partner_submitted:  (name) => `The appraisal cycle for <strong>${esc(name)}</strong> is now complete.`,
};

const EMAIL_CTA = {
  launch:             'Start Self-Assessment',
  self_submitted:     'Start Reviewer Evaluation',
  reviewer_submitted: 'Start Partner Review',
  partner_submitted:  'Download PDF Report',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── HTML email template ─────────────────────────────────────────────────────

function buildHtml({ type, employeeName, bodyHtml, ctaLabel, ctaUrl, ref }) {
  const ctaBlock = ctaLabel && ctaUrl ? `
    <tr>
      <td align="center" style="padding:28px 40px 8px;">
        <a href="${esc(ctaUrl)}"
           style="display:inline-block;background:#136dec;color:#ffffff;font-family:'Manrope',Arial,sans-serif;
                  font-size:15px;font-weight:700;text-decoration:none;padding:14px 32px;
                  border-radius:10px;letter-spacing:0.01em;">
          ${esc(ctaLabel)}
        </a>
      </td>
    </tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${esc(EMAIL_SUBJECT[type]?.(ref) || 'Appraisify Notification')}</title>
</head>
<body style="margin:0;padding:0;background:#f0f3f5;font-family:'Manrope',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f3f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

          <!-- Header -->
          <tr>
            <td style="background:#136dec;border-radius:12px 12px 0 0;padding:24px 40px;">
              <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-0.02em;">Appraisify</span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:32px 40px 8px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
              <p style="margin:0 0 16px;font-size:15px;color:#1e293b;line-height:1.6;">
                ${bodyHtml}
              </p>
              <p style="margin:0;font-size:12px;color:#94a3b8;">Reference: ${esc(ref)}</p>
            </td>
          </tr>

          <!-- CTA -->
          ${ctaBlock}

          <!-- Footer -->
          <tr>
            <td style="background:#ffffff;border-radius:0 0 12px 12px;padding:24px 40px 28px;
                       border:1px solid #e2e8f0;border-top:none;">
              <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.5;">
                You're receiving this because you're part of an appraisal cycle.<br/>
                Please do not reply to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send an appraisal notification email via Resend.
 *
 * @param {object} opts
 * @param {string} opts.to           — recipient email address
 * @param {string} opts.type         — notification type (launch | self_submitted | reviewer_submitted | partner_submitted)
 * @param {string} opts.employeeName — employee being appraised (from deal title)
 * @param {string} opts.ref          — deal reference, e.g. "#APR-58122"
 * @param {string|null} opts.ctaUrl  — CTA button URL (token link or PDF link)
 * @returns {{ id: string } | { skipped: true }}
 */
export async function sendAppraisalEmail({ to, type, employeeName, ref, ctaUrl }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true };

  const from = process.env.RESEND_FROM || 'Appraisify <noreply@appraisify.io>';

  const subjectFn = EMAIL_SUBJECT[type];
  const bodyFn    = EMAIL_BODY[type];
  const ctaLabel  = ctaUrl ? (EMAIL_CTA[type] || null) : null;

  if (!subjectFn || !bodyFn) {
    const err = new Error(`Unknown email notification type: ${type}`);
    err.code = 'unknown_email_type';
    throw err;
  }

  const subject  = subjectFn(ref);
  const bodyHtml = bodyFn(employeeName);
  const html     = buildHtml({ type, employeeName, bodyHtml, ctaLabel, ctaUrl, ref });

  const resp = await fetch(RESEND_API, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const err = new Error(data?.message || data?.name || `Resend API error: HTTP ${resp.status}`);
    err.code = data?.name || 'resend_error';
    throw err;
  }

  return { id: data.id };
}
