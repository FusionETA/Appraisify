/**
 * Appraisify – Caller verification
 *
 * Every data endpoint here takes a `domain` and answers with data fetched using
 * the stored admin token. Until now none of them established *who was asking* —
 * a request carrying nothing but a portal domain was served in full.
 *
 * This module establishes identity. The client sends the access token Bitrix24
 * issued to the current user's session (BX24.getAuth().access_token). That token
 * is verified against the portal itself: only Bitrix24 can say whether it is
 * valid and whose it is, so it cannot be forged the way a `userId` URL parameter
 * can.
 *
 * Two questions are answered:
 *   verifyCaller()   — who is this, and are they a portal admin?
 *   canAccessRecord() — may they see this particular appraisal?
 *
 * ── Rollout ──────────────────────────────────────────────────────────────
 * ENFORCE_AUTH gates whether a failed check actually blocks. While it is off,
 * endpoints verify, log what they *would* have denied, and serve the request
 * anyway. That lets the deny log be read before anything breaks for a real
 * user. Turn it on once the log is quiet.
 */

import { blobGet, blobPutEx } from './kv.js';
import { logError } from './logger.js';

/** Flip to enforcing by setting ENFORCE_AUTH=1 in the Vercel environment. */
export const ENFORCE_AUTH = String(process.env.ENFORCE_AUTH || '') === '1';

/** Shared secret for server-to-server callers (maintenance scripts). */
const SERVICE_TOKEN = process.env.APPRAISIFY_SERVICE_TOKEN || '';

const CACHE_TTL_SECONDS = 120;

/**
 * Pull the caller's credentials off a request, wherever they were put.
 * Header is preferred; query and body are accepted so a plain <a href> or an
 * existing fetch can carry one without restructuring.
 */
export function readCallerToken(req, body = {}) {
  const header = req.headers?.['x-appraisify-auth'] || req.headers?.['X-Appraisify-Auth'];
  return String(header || req.query?.auth || body.auth || '').trim();
}

export function readServiceToken(req, body = {}) {
  const header = req.headers?.['x-appraisify-service-token'];
  return String(header || body.serviceToken || '').trim();
}

/**
 * Establish who is calling.
 *
 * @returns {{verified: boolean, userId: string|null, isAdmin: boolean,
 *            isService: boolean, reason: string|null}}
 */
export async function verifyCaller(domain, req, body = {}) {
  // Maintenance scripts have no Bitrix session. They present a shared secret
  // instead and are treated as an administrator.
  const service = readServiceToken(req, body);
  if (service && SERVICE_TOKEN && service === SERVICE_TOKEN) {
    return { verified: true, userId: null, isAdmin: true, isService: true, reason: null };
  }

  const token = readCallerToken(req, body);
  if (!token) {
    return { verified: false, userId: null, isAdmin: false, isService: false, reason: 'no_token' };
  }
  if (!domain) {
    return { verified: false, userId: null, isAdmin: false, isService: false, reason: 'no_domain' };
  }

  // Cache on a fingerprint of the token, never the token itself.
  const cacheKey = `auth/verified/${domain}/${fingerprint(token)}`;
  try {
    const hit = await blobGet(cacheKey);
    if (hit && hit.userId) return { ...hit, isService: false, reason: null };
  } catch (_) { /* cache miss or KV down — verify directly */ }

  let identity;
  try {
    identity = await Promise.all([
      restCall(domain, 'user.current', token),
      restCall(domain, 'user.admin', token),
    ]);
  } catch (e) {
    return { verified: false, userId: null, isAdmin: false, isService: false, reason: `portal_unreachable: ${e.message}` };
  }

  const [current, admin] = identity;
  if (current?.error || !current?.result?.ID) {
    return {
      verified: false, userId: null, isAdmin: false, isService: false,
      reason: current?.error || 'invalid_token',
    };
  }

  const result = {
    verified: true,
    userId: String(current.result.ID),
    isAdmin: admin?.result === true,
  };

  try { await blobPutEx(cacheKey, result, CACHE_TTL_SECONDS); } catch (_) { /* non-fatal */ }
  return { ...result, isService: false, reason: null };
}

/**
 * May this caller see this appraisal?
 *
 * Portal admins see everything. Everyone else sees only records they are a
 * party to — the reviewee (the record's assignee), the reviewer, or the
 * partner. The partner is optional and may be the same person as the reviewer;
 * both cases fall out of the comparison without special handling.
 */
export function canAccessRecord(caller, record) {
  if (!caller?.verified) return false;
  if (caller.isAdmin) return true;
  if (!record) return false;

  const me = String(caller.userId);
  return [
    record.ASSIGNED_BY_ID,
    record.UF_CRM_REVIEWEE,
    record.UF_CRM_REVIEWER,
    record.UF_CRM_PARTNER,
  ].some(v => v != null && String(v) === me);
}

/**
 * Apply the decision.
 *
 * While ENFORCE_AUTH is off this only records what would have been refused and
 * lets the request through, so the change can be observed before it bites.
 *
 * @returns {boolean} true when the caller may proceed.
 */
export async function enforce(res, domain, caller, { source, action, recordId = null, allowed }) {
  if (allowed) return true;

  logError(domain, {
    event:    ENFORCE_AUTH ? 'access_denied' : 'access_would_deny',
    source,
    action,
    recordId,
    callerId: caller?.userId || null,
    verified: !!caller?.verified,
    reason:   caller?.reason || 'not_permitted',
    enforced: ENFORCE_AUTH,
  }).catch(() => {});

  if (!ENFORCE_AUTH) return true;

  res.status(caller?.verified ? 403 : 401).json({
    error: caller?.verified ? 'forbidden' : 'unauthenticated',
    error_description: caller?.verified
      ? 'You do not have access to this appraisal.'
      : 'Sign in to Bitrix24 and open this from the app.',
  });
  return false;
}

// ── internals ──────────────────────────────────────────────────────────────

async function restCall(domain, method, authToken) {
  const resp = await fetch(`https://${domain}/rest/${method}.json?auth=${encodeURIComponent(authToken)}`);
  return resp.json();
}

/** Short, non-reversible cache key component. Never store the token itself. */
function fingerprint(token) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}
