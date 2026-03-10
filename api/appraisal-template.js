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
  value = value.split('/')[0].split('?')[0];
  return value;
}

function resolveDomain(req, body) {
  return normalizeDomain(
    req.query?.DOMAIN || req.query?.domain || body.DOMAIN || body.domain || req.headers['x-appraisify-domain']
  );
}

async function redisCommand(command, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    const err = new Error('Upstash Redis not configured');
    err.code = 'storage_not_configured';
    throw err;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });

  if (!resp.ok) {
    const err = new Error(`Redis command failed with HTTP ${resp.status}`);
    err.code = 'storage_unavailable';
    throw err;
  }

  const json = await resp.json();
  if (json.error) {
    const err = new Error(json.error);
    err.code = 'storage_error';
    throw err;
  }

  return json.result;
}

function dealTemplateKey(domain, dealId) {
  return `appraisal_template:${domain}:${dealId}`;
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
      const dealId = String(req.query?.dealId || body.dealId || '').trim();
      if (!dealId) {
        return res.status(400).json({ error: 'missing_deal_id' });
      }

      const templateId = await redisCommand('GET', dealTemplateKey(domain, dealId));
      if (!templateId) {
        return res.status(404).json({ error: 'template_mapping_not_found' });
      }

      return res.status(200).json({ dealId, templateId: String(templateId), domain });
    }

    if (req.method === 'POST') {
      const dealId = String(body.dealId || '').trim();
      const templateId = String(body.templateId || '').trim();

      if (!dealId || !templateId) {
        return res.status(400).json({ error: 'missing_params', error_description: 'dealId and templateId are required' });
      }

      await redisCommand('SET', dealTemplateKey(domain, dealId), templateId);
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
