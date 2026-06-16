/**
 * Appraisify – Log Viewer (Vercel Serverless Function)
 *
 * GET  /api/logs?domain=levstal.bitrix24.eu&days=30
 * GET  /api/logs?domains=true
 * POST /api/logs  { domain, event, ...rest }
 */

import { blobList, blobGet, blobPut } from './_lib/kv.js';
import { loadTokens } from './_lib/auth.js';
import { logAppraisal } from './_lib/logger.js';
import { parseBody, normalizeDomain } from './_lib/utils.js';

const DOMAINS_KEY = '_domains';

function dateRange(days) {
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

async function fetchLogFile(prefix, date) {
  try {
    const data = await blobGet(`${prefix}${date}.json`);
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

async function addDomainToIndex(domain) {
  try {
    const existing = await blobGet(DOMAINS_KEY);
    const list = Array.isArray(existing) ? existing : [];
    if (!list.includes(domain)) {
      list.push(domain);
      list.sort();
      await blobPut(DOMAINS_KEY, list);
    }
  } catch (_) {}
}

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  // POST — client-side log ingestion
  if (req.method === 'POST') {
    const body   = parseBody(req);
    const domain = normalizeDomain(body.domain);
    const { event, ...rest } = body;
    if (!domain || !event) return res.status(400).json({ error: 'missing_params' });
    await logAppraisal(domain, { event, ...rest });
    addDomainToIndex(domain).catch(() => {});
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // ?domains=true — fast: read from cached index
  if (req.query.domains === 'true') {
    try {
      const data = await blobGet(DOMAINS_KEY);
      const domains = Array.isArray(data) ? data : [];
      return res.status(200).json({ domains });
    } catch (e) {
      return res.status(200).json({ domains: [], error: e.message });
    }
  }

  // ?seed=true — one-time: scan all portals and build the domain index
  if (req.query.seed === 'true') {
    try {
      const blobs = await blobList('portals/');
      const seen = [...new Set(
        blobs.map(b => b.pathname.match(/^portals\/([^/]+)\//)?.[1]).filter(Boolean)
      )].sort();
      await blobPut(DOMAINS_KEY, seen);
      return res.status(200).json({ seeded: true, domains: seen });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ?scan=domain — debug: list actual Upstash keys for a domain
  if (req.query.scan) {
    const d = String(req.query.scan).trim();
    try {
      const keys = await blobList(`portals/${d}/logs/`);
      return res.status(200).json({ prefix: `portals/${d}/logs/`, keys: keys.map(k => k.pathname) });
    } catch (e) {
      return res.status(200).json({ error: e.message });
    }
  }

  // ?raw=key — debug: read an exact Upstash key
  if (req.query.raw) {
    const key = String(req.query.raw).trim();
    try {
      const data = await blobGet(key);
      return res.status(200).json({ key, type: typeof data, isArray: Array.isArray(data), length: Array.isArray(data) ? data.length : null, data });
    } catch (e) {
      return res.status(200).json({ key, error: e.message });
    }
  }

  // Main GET — fetch logs for a domain
  const domain = String(req.query.domain || '').trim();
  const days   = Math.min(30, Math.max(1, parseInt(req.query.days || '30', 10)));
  const dates  = dateRange(days);

  try {
    const [errorEntries, portalEntries, aiEntries, installEntries, tokenInfo] = await Promise.all([
      Promise.all(dates.map(d => fetchLogFile('logs/errors/', d))).then(r => r.flat()),
      domain
        ? Promise.all(dates.map(d => fetchLogFile(`portals/${domain}/logs/`, d))).then(r => r.flat())
        : Promise.resolve([]),
      domain
        ? Promise.all(dates.map(d => fetchLogFile(`portals/${domain}/logs/ai/`, d))).then(r => r.flat())
        : Promise.resolve([]),
      Promise.all(dates.map(d => fetchLogFile('logs/installs/', d))).then(r => {
        const all = r.flat();
        return domain ? all.filter(e => e.domain === domain) : all;
      }),
      domain
        ? loadTokens(domain).then(async tokens => {
            if (!tokens) return { stored: false };
            try {
              const r    = await fetch(`https://${domain}/rest/scope.json?auth=${encodeURIComponent(tokens.access_token)}`);
              const data = await r.json();
              return { stored: true, storedAt: tokens.storedAt || null, member_id: tokens.member_id, scopes: data.result || [], hasIm: Array.isArray(data.result) && data.result.includes('im') };
            } catch (e) {
              return { stored: true, storedAt: tokens.storedAt, error: e.message };
            }
          }).catch(e => ({ stored: false, error: e.message }))
        : Promise.resolve({ stored: false }),
    ]);

    const sort = arr => [...arr].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

    return res.status(200).json({
      domain, days, dates,
      token:      tokenInfo,
      errors:     sort(errorEntries),
      appraisals: sort(portalEntries),
      ai:         sort(aiEntries),
      installs:   sort(installEntries),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
