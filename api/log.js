/**
 * Appraisify – Client-side Log Ingestion Endpoint (Vercel Serverless Function)
 *
 * The browser has no direct Blob access, so the frontend POSTs appraisal
 * lifecycle events here. Errors are logged server-side directly.
 *
 * Env vars required:
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token
 */

import { logAppraisal } from './_lib/logger.js';
import { parseBody, normalizeDomain } from './_lib/utils.js';

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'POST') return res.status(405).end();

  const body   = parseBody(req);
  const domain = normalizeDomain(body.domain);
  const { event, ...rest } = body;

  if (!domain || !event) {
    return res.status(400).json({ error: 'missing_params' });
  }

  await logAppraisal(domain, { event, ...rest });
  return res.status(200).json({ ok: true });
}
