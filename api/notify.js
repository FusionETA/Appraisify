function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return typeof req.body === 'object' ? req.body : {};
}

function normalizeDomain(raw) {
  if (!raw) return '';
  let value = String(raw).trim().toLowerCase();
  if (!value) return '';
  if (value.includes('://')) {
    try { value = new URL(value).hostname.toLowerCase(); } catch (_) {}
  }
  return value.split('/')[0].split('?')[0];
}

function resolveDomain(req, body) {
  return normalizeDomain(
    req.query?.DOMAIN || req.query?.domain || body.DOMAIN || body.domain || req.headers['x-appraisify-domain']
  );
}

function flattenParams(obj, prefix = '') {
  const pairs = [];
  for (const [key, val] of Object.entries(obj || {})) {
    const k = prefix ? `${prefix}[${key}]` : key;
    if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
      pairs.push(...flattenParams(val, k));
    } else if (Array.isArray(val)) {
      val.forEach((item, i) => pairs.push([`${k}[${i}]`, String(item)]));
    } else if (val !== null && val !== undefined) {
      pairs.push([k, String(val)]);
    }
  }
  return pairs;
}

async function callBitrix(method, params = {}) {
  const webhookUrl = (process.env.BX24_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    const err = new Error('BX24_WEBHOOK_URL is not set');
    err.code = 'webhook_not_configured';
    throw err;
  }

  const url = `${webhookUrl}${method}`;
  const formBody = new URLSearchParams(flattenParams(params)).toString();

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });

  const data = await resp.json();
  if (data.error) {
    const err = new Error(data.error_description || data.error);
    err.code = data.error;
    throw err;
  }
  return data.result;
}

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
    const deal = await callBitrix('crm.deal.get', { id: Number(dealId) });
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
        await callBitrix('im.notify.system.add', {
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
    return res.status(503).json({
      error: e.code || 'notification_failed',
      error_description: e.message || 'Notification dispatch failed',
    });
  }
}
