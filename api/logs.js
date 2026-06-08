/**
 * Appraisify – Log Viewer (Vercel Serverless Function)
 *
 * GET /api/logs?domain=fusion.bitrix24.com&days=3
 *
 * Returns recent error logs and portal-specific appraisal logs from Upstash Redis.
 * Useful for debugging notification and submission issues.
 *
 * Query params:
 *   domain  — Bitrix24 portal domain (default: fusion.bitrix24.com)
 *   days    — how many days back to fetch (default: 2, max: 7)
 */

import { blobList, blobGet } from './_lib/kv.js';
import { loadTokens } from './_lib/auth.js';
import { logAppraisal } from './_lib/logger.js';
import { parseBody, normalizeDomain } from './_lib/utils.js';

function dateRange(days) {
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates; // most recent first
}

async function fetchLogFile(prefix, date) {
  try {
    const blobs = await blobList(`${prefix}${date}.json`);
    if (!blobs.length) return [];
    const data = await blobGet(blobs[0].url);
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  // POST — client-side log ingestion (merged from /api/log)
  if (req.method === 'POST') {
    const body   = parseBody(req);
    const domain = normalizeDomain(body.domain);
    const { event, ...rest } = body;
    if (!domain || !event) return res.status(400).json({ error: 'missing_params' });
    await logAppraisal(domain, { event, ...rest });
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const domain = String(req.query.domain || 'fusion.bitrix24.com').trim();
  const days   = Math.min(7, Math.max(1, parseInt(req.query.days || '2', 10)));
  const dates  = dateRange(days);

  const [errorEntries, portalEntries, tokenInfo] = await Promise.all([
    // Global error log: logs/errors/YYYY-MM-DD.json
    Promise.all(dates.map(d => fetchLogFile('logs/errors/', d))).then(r => r.flat()),
    // Per-portal appraisal log: portals/{domain}/logs/YYYY-MM-DD.json
    Promise.all(dates.map(d => fetchLogFile(`portals/${domain}/logs/`, d))).then(r => r.flat()),
    // Token scopes: load stored token and call /rest/scope
    loadTokens(domain).then(async tokens => {
      if (!tokens) return { stored: false };
      try {
        const r = await fetch(
          `https://${domain}/rest/scope.json?auth=${encodeURIComponent(tokens.access_token)}`
        );
        const data = await r.json();
        return {
          stored:    true,
          storedAt:  tokens.storedAt || null,
          member_id: tokens.member_id,
          scopes:    data.result || [],
          hasIm:     Array.isArray(data.result) && data.result.includes('im'),
        };
      } catch (e) {
        return { stored: true, storedAt: tokens.storedAt, error: e.message };
      }
    }).catch(e => ({ stored: false, error: e.message })),
  ]);

  // Sort newest-first
  const sort = arr => [...arr].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  return res.status(200).json({
    domain,
    days,
    dates,
    token:      tokenInfo,
    errors:     sort(errorEntries),
    appraisals: sort(portalEntries),
  });
}
