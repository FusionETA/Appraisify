/**
 * Appraisify – External Appraisal Submission (Vercel Serverless Function)
 *
 * POST /api/appraisal-submit
 * Body: { token, scores: { "q1": 4, "q2": 3 }, comments: { "q1": "…" } }
 *
 * Validates + consumes the token, updates the deal in Bitrix24, adds a
 * timeline comment, and triggers the in-app notification to the next person.
 *
 * Env vars required:
 *   BLOB_READ_WRITE_TOKEN  — Vercel Blob token
 *   BX24_CLIENT_ID / BX24_CLIENT_SECRET — for Bitrix24 token refresh
 */

import { validateToken, consumeToken } from './_lib/tokens.js';
import { callBitrix } from './_lib/bitrix.js';
import { parseBody } from './_lib/utils.js';
import { logAppraisal, logError } from './_lib/logger.js';

const PHASE_CODE = { self: 'S', reviewer: 'R', partner: 'P' };
const PHASE_NEXT = { self: 'RVWR', reviewer: 'PART', partner: 'DONE' };
const PHASE_EVENT = { self: 'self_submitted', reviewer: 'reviewer_submitted', partner: 'partner_submitted' };

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Build UF_CRM_APR_S_* / UF_CRM_APR_C_* fields from raw scores/comments objects. */
function buildResponseFields(phase, scores, comments) {
  const code = PHASE_CODE[phase];
  if (!code) return {};

  const fields = {};
  const allQids = new Set([...Object.keys(scores || {}), ...Object.keys(comments || {})]);

  for (const qid of allQids) {
    const m = String(qid).match(/^q(\d+)$/i);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (idx < 1 || idx > 20) continue;

    const suffix = `${code}${pad2(idx)}`;
    const score = scores?.[qid];
    const comment = comments?.[qid];

    if (score !== undefined && score !== null && !isNaN(Number(score))) {
      fields[`UF_CRM_APR_S_${suffix}`] = Number(score);
    }
    if (comment !== undefined) {
      fields[`UF_CRM_APR_C_${suffix}`] = String(comment || '');
    }
  }

  return fields;
}

/** Build the timeline audit comment text. */
function buildTimelineComment(phase, scores, comments) {
  const submittedAt = new Date().toISOString();

  const allQids = [...new Set([...Object.keys(scores || {}), ...Object.keys(comments || {})])]
    .sort((a, b) => {
      const ai = parseInt(String(a).replace(/\D/g, '') || '0', 10);
      const bi = parseInt(String(b).replace(/\D/g, '') || '0', 10);
      return ai - bi;
    });

  const lines = allQids.map(qid => {
    const score = scores?.[qid];
    const comment = comments?.[qid];
    const scoreLabel = (score !== undefined && !isNaN(Number(score))) ? `${Number(score)}/5` : '—';
    const note = comment ? ` – ${comment}` : '';
    return `${String(qid).toUpperCase()}: ${scoreLabel}${note}`;
  });

  return `[${phase.toUpperCase()} ASSESSMENT — EXTERNAL] ${submittedAt}\n` +
    (lines.length ? lines.join('\n') : '(no scores recorded)');
}

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'POST') return res.status(405).end();

  const body = parseBody(req);
  const token = String(body.token || '').trim();
  const scores   = typeof body.scores   === 'object' && body.scores   ? body.scores   : {};
  const comments = typeof body.comments === 'object' && body.comments ? body.comments : {};

  if (!token) {
    return res.status(400).json({ error: 'missing_token', error_description: 'No token provided.' });
  }

  // Validate token before doing anything
  let tokenResult;
  try {
    tokenResult = await validateToken(token);
  } catch (e) {
    const status = e.code === 'token_used' ? 410 : 401;
    return res.status(status).json({ error: e.code || 'token_invalid', error_description: e.message });
  }

  const { domain, dealId, phase, blobUrl, data: rawData } = tokenResult;

  // Consume token immediately to prevent replay attacks
  try {
    await consumeToken(token, blobUrl, rawData);
  } catch (e) {
    console.error('[appraisal-submit] Token consumption failed:', e.message);
    return res.status(500).json({ error: 'token_consume_failed', error_description: 'Could not mark token as used.' });
  }

  try {
    // Get deal from Bitrix24 (need CATEGORY_ID for stage prefix)
    const deal = await callBitrix(domain, 'crm.deal.get', { id: dealId });
    if (!deal) {
      return res.status(404).json({ error: 'deal_not_found', error_description: 'Appraisal deal not found.' });
    }

    const categoryId = deal.CATEGORY_ID;
    const stagePrefix = categoryId ? `C${categoryId}:` : '';
    const stageSuffix = PHASE_NEXT[phase];

    if (!stageSuffix) {
      return res.status(400).json({ error: 'invalid_phase', error_description: `Unknown phase: ${phase}` });
    }

    const STAGE_ID = `${stagePrefix}APPRAISIFY_${stageSuffix}`;
    const responseFields = buildResponseFields(phase, scores, comments);

    // Update deal stage + response fields
    await callBitrix(domain, 'crm.deal.update', {
      id: dealId,
      fields: { STAGE_ID, ...responseFields },
    });

    // Add timeline comment (non-fatal if it fails)
    const commentText = buildTimelineComment(phase, scores, comments);
    callBitrix(domain, 'crm.timeline.comment.add', {
      fields: {
        ENTITY_TYPE_ID: 2,
        ENTITY_ID: dealId,
        COMMENT: commentText,
      },
    }).catch(e => {
      console.warn('[appraisal-submit] Timeline comment failed (non-fatal):', e.message);
    });

    // Trigger next-phase notification + token generation.
    // Must be awaited — Vercel kills the function the moment the response is sent,
    // so fire-and-forget fetch calls are silently dropped before they complete.
    const notifyType = PHASE_EVENT[phase];
    if (notifyType) {
      const host = req.headers.host || '';
      const proto = host.startsWith('localhost') ? 'http' : 'https';
      try {
        await fetch(`${proto}://${host}/api/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: notifyType, dealId: String(dealId), domain }),
        });
      } catch (e) {
        console.warn('[appraisal-submit] Notify dispatch failed (non-fatal):', e.message);
      }
    }

    // Log submission
    logAppraisal(domain, { event: 'appraisal_submitted', source: 'external', dealId, phase }).catch(() => {});

    return res.status(200).json({ ok: true });

  } catch (e) {
    logError(domain, {
      event: 'error', source: 'appraisal-submit',
      error: e.code || 'submit_failed', message: e.message, dealId, phase,
    }).catch(() => {});
    return res.status(503).json({
      error: e.code || 'submit_failed',
      error_description: e.message || 'Submission failed.',
    });
  }
}
