/**
 * Appraisify – Log Viewer (Vercel Serverless Function)
 *
 * GET /api/logs?domain=fusion.bitrix24.com&days=3
 *
 * Returns recent error logs and portal-specific appraisal logs from Vercel Blob.
 * Useful for debugging notification and submission issues.
 *
 * Query params:
 *   domain  — Bitrix24 portal domain (default: fusion.bitrix24.com)
 *   days    — how many days back to fetch (default: 2, max: 7)
 */

import { blobList, blobGet } from './_lib/blob.js';

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

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const domain = String(req.query.domain || 'fusion.bitrix24.com').trim();
  const days   = Math.min(7, Math.max(1, parseInt(req.query.days || '2', 10)));
  const dates  = dateRange(days);

  const [errorEntries, portalEntries] = await Promise.all([
    // Global error log: logs/errors/YYYY-MM-DD.json
    Promise.all(dates.map(d => fetchLogFile('logs/errors/', d))).then(r => r.flat()),
    // Per-portal appraisal log: portals/{domain}/logs/YYYY-MM-DD.json
    Promise.all(dates.map(d => fetchLogFile(`portals/${domain}/logs/`, d))).then(r => r.flat()),
  ]);

  // Sort newest-first
  const sort = arr => [...arr].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  return res.status(200).json({
    domain,
    days,
    dates,
    errors:   sort(errorEntries),
    appraisals: sort(portalEntries),
  });
}
