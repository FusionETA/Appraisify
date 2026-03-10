/**
 * Appraisify – Shared Appraisal Form Logic
 * Used by: appraisal-reviewee.html, appraisal-reviewer.html, appraisal-partner.html
 */

let _appraisalConfig = {};
let _scores          = {};
let _comments        = {};
let _autosaveTimer   = null;
let _liveSyncTimer   = null;
let _pendingLiveDealFieldUpdates = {};

const LIVE_SYNC_DELAY_MS = 500;

// ── Initialise ────────────────────────────────────────────────────────────
/**
 * @param {object} cfg
 * @param {string} cfg.role          - 'reviewee' | 'reviewer' | 'partner'
 * @param {string} cfg.appraisalId   - unique appraisal ID for draft key
 * @param {string} [cfg.progressColor] - Tailwind class for progress bar colour
 * @param {function} [cfg.onScoreUpdate] - optional callback(avg) when score changes
 */
function initAppraisalForm(cfg) {
  _appraisalConfig = cfg;

  // Ensure score fields support decimal precision (legacy portals may have
  // been created with integer precision for double fields).
  if (typeof BX24App !== 'undefined' && typeof BX24App.ensureAppraisalResponseFields === 'function') {
    BX24App.ensureAppraisalResponseFields()
      .catch(e => console.warn('[Appraisify] Failed to verify response field precision:', e));
  }

  // Start autosave interval (30 s)
  _autosaveTimer = setInterval(saveDraft, 30000);

  // Initial progress update
  updateProgress();
}

// ── Score / comment event handlers ───────────────────────────────────────
function onScoreChange(input) {
  const qid = input.dataset.qid;
  const raw = String(input.value || '').trim();

  // Keep typing-friendly behavior: allow intermediate forms like "2." and
  // only store committed numeric values with up to 2 decimals.
  let normalizedRaw = raw;
  const decimalMatch = normalizedRaw.match(/^(\d+)\.(\d+)$/);
  if (decimalMatch && decimalMatch[2].length > 2) {
    normalizedRaw = `${decimalMatch[1]}.${decimalMatch[2].slice(0, 2)}`;
    input.value = normalizedRaw;
  }

  if (!normalizedRaw) {
    delete _scores[qid];
    queueLiveDealScoreSync(qid, null);
  } else {
    const numeric = Number(normalizedRaw);
    const isIntermediate = normalizedRaw.endsWith('.');
    const hasValidShape = /^\d+(\.\d{0,2})?$/.test(normalizedRaw);
    const isCommitted = hasValidShape && !isIntermediate && Number.isFinite(numeric) && numeric >= 1 && numeric <= 5;

    if (isCommitted) {
      _scores[qid] = numeric;
      queueLiveDealScoreSync(qid, numeric);
    } else if (!hasValidShape || (Number.isFinite(numeric) && (numeric < 1 || numeric > 5))) {
      delete _scores[qid];
      if (Number.isFinite(numeric) && (numeric < 1 || numeric > 5)) {
        queueLiveDealScoreSync(qid, null);
      }
    }
  }

  // Visual feedback: red border while the typed value is out of range.
  // The border clears on blur (onScoreBlur clamps/resets and removes it).
  const numericForDisplay = Number(normalizedRaw);
  const outOfRange = normalizedRaw !== '' && Number.isFinite(numericForDisplay)
    && (numericForDisplay < 1 || numericForDisplay > 5);
  input.style.borderColor = outOfRange ? '#ef4444' : '';
  input.title = outOfRange ? 'Score must be between 1 and 5' : '';

  // Sync value to all sibling inputs with the same qid (desktop ↔ mobile)
  const syncVal = normalizedRaw;
  document.querySelectorAll(`[data-field$="-score"][data-qid="${qid}"]`).forEach(inp => {
    if (inp !== input) {
      inp.value = syncVal;
      inp.style.borderColor = outOfRange ? '#ef4444' : '';
      inp.title = outOfRange ? 'Score must be between 1 and 5' : '';
    }
  });

  updateProgress();
  updateAverage();
  if (typeof _appraisalConfig.onScoreUpdate === 'function') {
    _appraisalConfig.onScoreUpdate(calcAverage());
  }
}

/**
 * Called onblur on every score input.
 * Clamps the value into the valid 1–5 range: caps at 5 if too high,
 * clears the field if below 1. Also removes the red error border.
 */
function onScoreBlur(input) {
  const raw = String(input.value || '').trim();

  // Clear error styling regardless of what we do next
  const clearError = (inp) => { inp.style.borderColor = ''; inp.title = ''; };
  clearError(input);

  if (raw === '') return; // Empty field is fine — nothing to clamp

  const numeric = Number(raw);
  if (numeric > 5) {
    input.value = '5';
    onScoreChange(input); // re-validate and sync with clamped value
  } else if (Number.isFinite(numeric) && numeric < 1) {
    input.value = '';
    onScoreChange(input); // re-validate and sync with cleared value
  }

  // Clear error on sibling inputs too (onScoreChange may have already done it,
  // but ensure it's clean regardless)
  const qid = input.dataset.qid;
  document.querySelectorAll(`[data-field$="-score"][data-qid="${qid}"]`).forEach(inp => {
    if (inp !== input) clearError(inp);
  });
}

function onCommentChange(input) {
  _comments[input.dataset.qid] = input.value;
}

// ── Calculations ──────────────────────────────────────────────────────────
function calcAverage() {
  const vals = Object.values(_scores).filter(v => !isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function updateAverage() {
  const avg = calcAverage();
  const el  = document.getElementById('avg-score');
  if (el) el.textContent = avg !== null ? avg.toFixed(2) : '—';
}

function updateProgress() {
  const total  = document.querySelectorAll('.question-row').length;
  const filled = Object.keys(_scores).length;
  const pct    = total ? Math.round((filled / total) * 100) : 0;

  const bar   = document.getElementById('progress-bar');
  const label = document.getElementById('progress-label');
  if (bar)   bar.style.width  = `${pct}%`;
  if (label) label.textContent = `${filled} / ${total} questions`;
}

// ── Draft persistence (sessionStorage) ───────────────────────────────────
function saveDraft() {
  if (!_appraisalConfig.appraisalId) return;
  const key  = `draft_${_appraisalConfig.appraisalId}_${_appraisalConfig.role}`;
  const data = { scores: _scores, comments: _comments, savedAt: Date.now() };
  sessionStorage.setItem(key, JSON.stringify(data));

  // Flash autosave indicator
  const indicator = document.getElementById('autosave-indicator');
  if (indicator) {
    indicator.classList.remove('hidden');
    clearTimeout(indicator._hideTimer);
    indicator._hideTimer = setTimeout(() => indicator.classList.add('hidden'), 3000);
  }
}

function loadDraft() {
  if (!_appraisalConfig.appraisalId) return;
  const key  = `draft_${_appraisalConfig.appraisalId}_${_appraisalConfig.role}`;
  const raw  = sessionStorage.getItem(key);
  if (!raw) return;

  try {
    const data = JSON.parse(raw);
    _scores   = data.scores   || {};
    _comments = data.comments || {};

    // Restore score inputs (both desktop table + mobile cards)
    Object.entries(_scores).forEach(([qid, val]) => {
      document.querySelectorAll(`[data-field$="-score"][data-qid="${qid}"]`).forEach(input => {
        input.value = val;
      });
    });

    // Restore comment inputs (both desktop table + mobile cards)
    Object.entries(_comments).forEach(([qid, val]) => {
      document.querySelectorAll(`[data-field$="-comment"][data-qid="${qid}"]`).forEach(input => {
        input.value = val;
      });
    });

    updateProgress();
    updateAverage();
  } catch (e) {
    console.warn('[Appraisify] Failed to load draft:', e);
  }
}

// ── Download draft PDF (stub) ─────────────────────────────────────────────
function downloadDraft() {
  const appraisalId = String((_appraisalConfig && _appraisalConfig.appraisalId) || '').trim();
  if (!appraisalId) {
    alert('Unable to open report preview: missing appraisal ID.');
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const domain = (typeof TemplatesAPI !== 'undefined' && TemplatesAPI.getDomainFromContext)
    ? TemplatesAPI.getDomainFromContext()
    : '';
  const next = new URLSearchParams({ appraisal: appraisalId });
  if (domain) next.set('domain', domain);
  const d = params.get('DOMAIN') || params.get('domain');
  if (!domain && d) next.set('domain', d);
  window.open(`appraisal-report-preview.html?${next.toString()}`, '_blank');
}

function normalizeNotifyDomain(raw) {
  if (!raw) return '';
  let value = String(raw).trim().toLowerCase();
  if (!value) return '';
  if (value.includes('://')) {
    try { value = new URL(value).hostname.toLowerCase(); } catch (_) {}
  }
  return value.split('/')[0].split('?')[0];
}

function resolveNotifyDomain() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = normalizeNotifyDomain(params.get('DOMAIN') || params.get('domain'));
  if (fromUrl) {
    localStorage.setItem('appraisify_domain', fromUrl);
    return fromUrl;
  }
  if (typeof TemplatesAPI !== 'undefined' && TemplatesAPI.getDomainFromContext) {
    const fromApi = normalizeNotifyDomain(TemplatesAPI.getDomainFromContext());
    if (fromApi) return fromApi;
  }
  if (typeof BX24 !== 'undefined' && BX24.getAuth) {
    try {
      const auth = BX24.getAuth();
      const fromAuth = normalizeNotifyDomain(auth && auth.domain);
      if (fromAuth) {
        localStorage.setItem('appraisify_domain', fromAuth);
        return fromAuth;
      }
    } catch (_) {}
  }
  return normalizeNotifyDomain(localStorage.getItem('appraisify_domain'));
}

async function triggerWorkflowNotification(type, dealId) {
  const domain = resolveNotifyDomain();
  if (!domain || !type || !dealId) return;

  try {
    const resp = await fetch('/api/notify', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'x-appraisify-domain': domain },
      body: JSON.stringify({ type, dealId: String(dealId), domain }),
    });
    const json = await resp.json();
    if (!resp.ok || json.error) {
      console.warn('[Appraisify] Notification failed:', type, dealId, json.error || json.error_description || resp.status);
    }
  } catch (e) {
    console.warn('[Appraisify] Notification request failed:', type, dealId, e);
  }
}

const MAX_Q_PER_PHASE = 20;
const PHASE_CODE = {
  self: 'S',
  reviewer: 'R',
  partner: 'P',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseQid(qid) {
  const m = String(qid || '').match(/^q(\d+)$/i);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function collectQuestionIndexesFromDom() {
  const indexes = new Set();
  document.querySelectorAll('[data-field$="-score"][data-qid], [data-field$="-comment"][data-qid]').forEach(el => {
    const idx = parseQid(el.dataset.qid);
    if (idx) indexes.add(idx);
  });
  return [...indexes].sort((a, b) => a - b);
}

function validateResponseCapacity() {
  const templateIndexes = collectQuestionIndexesFromDom();
  if (templateIndexes.length > MAX_Q_PER_PHASE) {
    return {
      ok: false,
      message: `This appraisal template has ${templateIndexes.length} questions. Maximum supported is ${MAX_Q_PER_PHASE}. Please contact your admin.`,
    };
  }

  const submittedIndexes = new Set();
  const allKeys = new Set([...Object.keys(_scores), ...Object.keys(_comments)]);
  for (const qid of allKeys) {
    const idx = parseQid(qid);
    if (!idx) {
      return {
        ok: false,
        message: `Invalid question ID "${qid}" detected. Please refresh and try again.`,
      };
    }
    if (idx > MAX_Q_PER_PHASE) {
      return {
        ok: false,
        message: `Question ${idx} exceeds supported capacity (${MAX_Q_PER_PHASE}). Please contact your admin.`,
      };
    }
    submittedIndexes.add(idx);
  }

  return { ok: true, submittedIndexes: [...submittedIndexes] };
}

function buildResponseFieldPayload(phase, indexes) {
  const code = PHASE_CODE[phase];
  const fields = {};
  indexes.forEach(idx => {
    const qid = `q${idx}`;
    const suffix = `${code}${pad2(idx)}`;
    if (Object.prototype.hasOwnProperty.call(_scores, qid) && !isNaN(_scores[qid])) {
      fields[`UF_CRM_APR_S_${suffix}`] = Number(_scores[qid]);
    }
    if (Object.prototype.hasOwnProperty.call(_comments, qid)) {
      fields[`UF_CRM_APR_C_${suffix}`] = String(_comments[qid] || '');
    }
  });
  return fields;
}

function roleToPhase(role) {
  if (role === 'reviewee') return 'self';
  if (role === 'reviewer') return 'reviewer';
  if (role === 'partner') return 'partner';
  return '';
}

function scoreFieldNameFor(role, qid) {
  const phase = roleToPhase(role);
  const code = PHASE_CODE[phase];
  const idx = parseQid(qid);
  if (!code || !idx || idx > MAX_Q_PER_PHASE) return '';
  return `UF_CRM_APR_S_${code}${pad2(idx)}`;
}

function queueLiveDealScoreSync(qid, scoreValue) {
  const dealId = String((_appraisalConfig && _appraisalConfig.appraisalId) || '').trim();
  const role = String((_appraisalConfig && _appraisalConfig.role) || '').trim();
  if (!dealId) return;

  const fieldName = scoreFieldNameFor(role, qid);
  if (!fieldName) return;

  _pendingLiveDealFieldUpdates[fieldName] = (scoreValue === null || scoreValue === undefined) ? '' : Number(scoreValue);

  clearTimeout(_liveSyncTimer);
  _liveSyncTimer = setTimeout(flushLiveDealSync, LIVE_SYNC_DELAY_MS);
}

async function flushLiveDealSync() {
  const dealId = String((_appraisalConfig && _appraisalConfig.appraisalId) || '').trim();
  if (!dealId || !Object.keys(_pendingLiveDealFieldUpdates).length) return;
  if (typeof BX24App === 'undefined' || typeof BX24App.updateDeal !== 'function') return;

  const fields = { ..._pendingLiveDealFieldUpdates };
  _pendingLiveDealFieldUpdates = {};

  try {
    await BX24App.updateDeal(dealId, fields);
  } catch (e) {
    // Non-blocking: keep form usable even if background sync fails.
    console.warn('[Appraisify] Live score sync failed:', e);
  }
}

// ── Submit ────────────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string} opts.phase        - 'self' | 'reviewer' | 'partner'
 * @param {string} opts.appraisalId  - CRM deal ID
 */
async function handleSubmit(opts) {
  // Map phase → next CRM stage.
  // Non-default pipeline deals require STAGE_ID prefixed as C{categoryId}:STATUS_ID
  // (same format crm.deal.list returns; bare STATUS_ID causes 400 on update).
  const categoryId = await BX24App.getCategoryId();
  const prefix = categoryId && categoryId !== 'dev' ? `C${categoryId}:` : '';
  const NEXT_STAGE = {
    'self':     `${prefix}APPRAISIFY_RVWR`,  // after self-assessment → awaiting reviewer
    'reviewer': `${prefix}APPRAISIFY_PART`,  // after reviewer → awaiting partner
    'partner':  `${prefix}APPRAISIFY_DONE`,  // after partner → submitted/complete
  };

  const dealId    = opts.appraisalId;
  const nextStage = NEXT_STAGE[opts.phase];

  if (!dealId || !nextStage) {
    alert('Unable to submit appraisal. Missing appraisal reference or phase.');
    return;
  }

  const validation = validateResponseCapacity();
  if (!validation.ok) {
    alert(validation.message);
    return;
  }

  const submittedAt = new Date().toISOString();

  // Ensure custom response fields exist (created during install, but verify).
  // Non-fatal: fields were created on install; if this check fails the deal
  // update may still succeed with existing fields.
  try {
    await BX24App.ensureAppraisalResponseFields();
  } catch (e) {
    console.warn('[Appraisify] ensureAppraisalResponseFields failed (non-fatal):', e);
  }

  // Note: ensureDealCardConfig is intentionally NOT called here.
  // crm.deal.details.configuration.set requires an admin user token and fails
  // via incoming webhook (INTERNAL_SERVER_ERROR). The deal card was configured
  // during install using the admin's BX24.callMethod — no need to repeat it.

  try {
    const responseFields = buildResponseFieldPayload(opts.phase, validation.submittedIndexes);
    await BX24App.updateDeal(dealId, { STAGE_ID: nextStage, ...responseFields });

    // Keep timeline comment as secondary audit log.
    const lines = Object.entries(_scores).map(([qid, score]) => {
      const note = _comments[qid] ? ` – ${_comments[qid]}` : '';
      return `Q${qid}: ${score}/5${note}`;
    });
    const commentText =
      `[${opts.phase.toUpperCase()} ASSESSMENT] ${submittedAt}\n` +
      (lines.length ? lines.join('\n') : '(no scores recorded)');

    BX24App.callAsSystem('crm.timeline.comment.add', {
      fields: { ENTITY_TYPE: 'deal', ENTITY_ID: Number(dealId), COMMENT: commentText }
    }).catch(e => console.warn('[Appraisify] Timeline comment failed:', e));

    const notifyTypeMap = {
      self: 'self_submitted',
      reviewer: 'reviewer_submitted',
      partner: 'partner_submitted',
    };
    const notifyType = notifyTypeMap[opts.phase];
    if (notifyType) {
      // Submissions redirect immediately; give notify a short completion window.
      await Promise.race([
        triggerWorkflowNotification(notifyType, dealId),
        new Promise(resolve => setTimeout(resolve, 800)),
      ]);
    }

  } catch (e) {
    const detail = (e && (e.description || e.message || e.code)) || String(e);
    console.error('[Appraisify] Failed to update deal:', e);
    alert(`Failed to save appraisal responses to CRM deal.\n\n${detail}\n\nPlease try again.`);
    return;
  }

  // Clear draft
  if (_appraisalConfig.appraisalId) {
    const key = `draft_${_appraisalConfig.appraisalId}_${_appraisalConfig.role}`;
    sessionStorage.removeItem(key);
  }
  if (_autosaveTimer) clearInterval(_autosaveTimer);

  const ref = new URLSearchParams(window.location.search).get('appraisal') || '';
  window.location.href = `confirm.html?phase=${opts.phase}&ref=${encodeURIComponent(ref)}`;
}
