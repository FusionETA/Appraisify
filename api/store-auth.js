/**
 * Appraisify – Store installer OAuth tokens in Vercel KV (Vercel Serverless Function)
 *
 * Called from the install page (api/install.js) right after BX24.init() fires.
 * Stores the installer's tokens keyed by member_id (portal-unique UUID) so any
 * user of the portal can trigger privileged CRM calls via /api/bx-proxy.
 *
 * Env vars required:
 *   UPSTASH_REDIS_REST_URL   — from Upstash dashboard → REST API
 *   UPSTASH_REDIS_REST_TOKEN — from Upstash dashboard → REST API
 */

async function kvSet(key, value) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, value]),
  });
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { access_token, refresh_token, domain, member_id } = req.body || {};

  if (!access_token || !member_id || !domain) {
    return res.status(400).json({ error: 'missing_params',
      error_description: 'access_token, member_id and domain are required' });
  }

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.error('[store-auth] Upstash env vars not set — add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to Vercel');
    return res.status(500).json({ error: 'kv_not_configured',
      error_description: 'Upstash Redis not configured. Add env vars to Vercel.' });
  }

  const encoded = Buffer.from(
    JSON.stringify({ access_token, refresh_token, domain, member_id })
  ).toString('base64');

  const kvResult = await kvSet(`sys_auth:${member_id}`, encoded);
  if (kvResult.error) {
    console.error('[store-auth] KV set failed:', kvResult.error);
    return res.status(500).json({ error: 'kv_write_failed', error_description: kvResult.error });
  }

  console.log(`[store-auth] Stored sys_auth for ${domain} (member_id=${member_id})`);
  return res.status(200).json({ ok: true });
}
