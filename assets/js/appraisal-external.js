/**
 * Appraisify – External Appraisal Form Logic
 *
 * Standalone form (no Bitrix24 SDK). Reads a token from ?token=
 * in the URL, fetches deal + template data from /api/appraisal-link,
 * renders questions, and submits to /api/appraisal-submit.
 */

(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const token  = params.get('token') || '';

  let _appraisalData = null;
  let _scores        = {};   // { "q1": 4.5, "q2": 3 }
  let _comments      = {};   // { "q1": "some note" }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str || ''));
    return d.innerHTML;
  }

  function el(id) { return document.getElementById(id); }

  // ── State machine ────────────────────────────────────────────────────────

  const STATES = ['loading', 'error', 'form', 'success'];

  function setState(state, message) {
    STATES.forEach(s => {
      const node = el(`state-${s}`);
      if (node) node.classList.toggle('hidden', s !== state);
    });

    if (state === 'error' && message) {
      const msgEl = el('error-message');
      if (msgEl) msgEl.textContent = message;
    }

    const bar = el('action-bar');
    if (bar) bar.classList.toggle('hidden', state !== 'form');
  }

  // ── Template question extraction ─────────────────────────────────────────

  /**
   * Flattens a template's sections into a list of { id, text, _sectionName }.
   * Handles two structures:
   *   A) sections.scope = [{ id, name, questions: [{id, text}] }]  ← section groups
   *   B) sections.scope = [{ id, text }]                            ← flat question list
   */
  function collectQuestions(template) {
    if (!template?.sections) return [];

    const questions = [];

    for (const [sectionKey, sectionItems] of Object.entries(template.sections)) {
      if (!Array.isArray(sectionItems)) continue;

      for (const item of sectionItems) {
        if (!item) continue;

        // Structure A: item is a section group containing a questions array
        if (Array.isArray(item.questions)) {
          for (const q of item.questions) {
            if (q?.id && q?.text) {
              questions.push({ id: q.id, text: q.text, _section: item.name || sectionKey });
            }
          }
        // Structure B: item is a question directly
        } else if (item.id && item.text) {
          questions.push({ id: item.id, text: item.text, _section: sectionKey });
        }
      }
    }

    return questions;
  }

  // ── Form rendering ────────────────────────────────────────────────────────

  const PHASE_LABELS = {
    self:     { badge: 'Self-Assessment', desc: 'Please rate yourself on each competency and add supporting comments.' },
    reviewer: { badge: 'Reviewer Evaluation', desc: 'Please evaluate the employee on each competency and add your comments.' },
    partner:  { badge: 'Partner Review', desc: 'Please provide your partner review ratings and comments for each competency.' },
  };

  const PHASE_MODAL_DESC = {
    self:     "Once submitted, you won't be able to edit your responses. Your reviewer will be notified to begin their evaluation.",
    reviewer: "Once submitted, you won't be able to edit your responses. The partner reviewer will be notified.",
    partner:  "Once submitted, you won't be able to edit your responses. The appraisal cycle will be marked complete.",
  };

  function renderForm(data) {
    const { phase, deal, template } = data;
    const phaseInfo = PHASE_LABELS[phase] || { badge: 'Appraisal', desc: '' };

    // Header
    const phaseBadge = el('phase-badge');
    if (phaseBadge) { phaseBadge.textContent = phaseInfo.badge; phaseBadge.classList.remove('hidden'); }

    const dealTitle = el('deal-title');
    if (dealTitle) dealTitle.textContent = deal?.title || 'Appraisal';

    const phaseDesc = el('phase-description');
    if (phaseDesc) phaseDesc.textContent = phaseInfo.desc;

    // Submit button label
    const btnSubmit = el('btn-submit');
    if (btnSubmit) btnSubmit.querySelector('span:last-child').textContent = `Submit ${phaseInfo.badge}`;

    // Modal description
    const modalDesc = el('modal-description');
    if (modalDesc) modalDesc.textContent = PHASE_MODAL_DESC[phase] || "Once submitted, you won't be able to edit your responses.";

    // Questions
    const questions = collectQuestions(template);
    const container = el('questions-container');

    if (!container) return;
    container.innerHTML = '';

    if (!questions.length) {
      const notice = el('no-template-notice');
      if (notice) notice.classList.remove('hidden');
      return;
    }

    // Group questions by section for visual separation
    let lastSection = null;
    questions.forEach((q, i) => {
      if (q._section !== lastSection) {
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'pt-2 pb-1';
        sectionHeader.innerHTML = `
          <h2 class="text-xs font-bold text-slate-400 uppercase tracking-widest">
            ${escapeHtml(q._section || 'Questions')}
          </h2>`;
        container.appendChild(sectionHeader);
        lastSection = q._section;
      }

      container.appendChild(createQuestionCard(q, phase, i + 1));
    });
  }

  function createQuestionCard(q, phase, number) {
    const div = document.createElement('div');
    div.className = 'bg-white rounded-2xl border border-slate-200 shadow-sm p-5';
    div.dataset.qid = q.id;

    div.innerHTML = `
      <div class="flex items-start gap-3 mb-4">
        <span class="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center mt-0.5">${number}</span>
        <p class="text-sm font-semibold text-slate-800 leading-relaxed">${escapeHtml(q.text)}</p>
      </div>

      <!-- Desktop: side-by-side layout -->
      <div class="hidden sm:flex items-start gap-4">
        <div class="flex-shrink-0 w-36">
          <label class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Score (1–5)</label>
          <input type="number" min="1" max="5" step="0.01" placeholder="1–5"
            data-field="${phase}-score" data-qid="${q.id}"
            class="rating-input"
            oninput="window._APR.onScoreChange(this)"
            onblur="window._APR.onScoreBlur(this)"/>
          <p class="text-xs text-red-500 mt-1" data-score-hint style="display:none">Only 1–5 is accepted</p>
        </div>
        <div class="flex-1">
          <label class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Comments (optional)</label>
          <textarea rows="3" placeholder="Add your comments or supporting evidence…"
            data-field="${phase}-comment" data-qid="${q.id}"
            class="comment-input w-full"
            oninput="window._APR.onCommentChange(this)"></textarea>
        </div>
      </div>

      <!-- Mobile: stacked layout -->
      <div class="sm:hidden space-y-3">
        <div>
          <label class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Score (1–5)</label>
          <input type="number" min="1" max="5" step="0.01" placeholder="1–5"
            data-field="${phase}-score" data-qid="${q.id}"
            class="rating-input-mobile"
            oninput="window._APR.onScoreChange(this)"
            onblur="window._APR.onScoreBlur(this)"/>
          <p class="text-xs text-red-500 mt-1" data-score-hint style="display:none">Only 1–5 is accepted</p>
        </div>
        <div>
          <label class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Comments (optional)</label>
          <textarea rows="3" placeholder="Add your comments or supporting evidence…"
            data-field="${phase}-comment" data-qid="${q.id}"
            class="comment-input w-full"
            oninput="window._APR.onCommentChange(this)"></textarea>
        </div>
      </div>
    `;

    return div;
  }

  // ── Score / comment handlers ──────────────────────────────────────────────

  function onScoreChange(inputEl) {
    const qid  = inputEl.dataset.qid;
    const raw  = inputEl.value;
    const val  = parseFloat(raw);
    const hint = inputEl.parentElement.querySelector('[data-score-hint]');

    if (raw === '' || raw === null) {
      delete _scores[qid];
      if (hint) hint.style.display = 'none';
      return;
    }

    if (isNaN(val) || val < 1 || val > 5) {
      if (hint) hint.style.display = '';
      delete _scores[qid];
    } else {
      if (hint) hint.style.display = 'none';
      _scores[qid] = val;
    }
  }

  function onScoreBlur(inputEl) {
    const val = parseFloat(inputEl.value);
    if (inputEl.value !== '' && !isNaN(val)) {
      inputEl.value = Math.min(5, Math.max(1, val)).toFixed(2).replace(/\.00$/, '');
    }
  }

  function onCommentChange(textareaEl) {
    _comments[textareaEl.dataset.qid] = textareaEl.value;
  }

  // ── Submit flow ───────────────────────────────────────────────────────────

  function confirmSubmit() {
    el('modal-submit').classList.remove('hidden');
  }

  function cancelSubmit() {
    el('modal-submit').classList.add('hidden');
  }

  async function submitAppraisal() {
    el('modal-submit').classList.add('hidden');

    const btn = el('btn-submit');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="material-symbols-outlined text-lg" style="animation:spin 1s linear infinite">progress_activity</span> <span>Submitting…</span>';
    }

    try {
      const resp = await fetch('/api/appraisal-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, scores: _scores, comments: _comments }),
      });

      const json = await resp.json().catch(() => ({}));

      if (!resp.ok || json.error) {
        throw new Error(json.error_description || json.error || `HTTP ${resp.status}`);
      }

      setState('success');

    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined text-lg">send</span> <span>Submit</span>';
      }
      alert('Submission failed: ' + e.message + '\n\nPlease try again or contact your HR team.');
    }
  }

  // ── Form loader ───────────────────────────────────────────────────────────

  async function loadForm() {
    setState('loading');

    if (!token) {
      setState('error', 'No appraisal link token found. Please use the link from your email.');
      return;
    }

    try {
      const resp = await fetch(`/api/appraisal-link?token=${encodeURIComponent(token)}`);
      const data = await resp.json().catch(() => ({}));

      if (!resp.ok || data.error) {
        const ERROR_MESSAGES = {
          token_invalid: 'This appraisal link is invalid. Please use the link from your email.',
          token_expired: 'This appraisal link has expired. Links are valid for 7 days — please contact your HR team for a new one.',
          token_used:    'This appraisal link has already been used and cannot be reused.',
          deal_not_found: 'The appraisal record was not found. Please contact your HR team.',
        };
        setState('error', ERROR_MESSAGES[data.error] || 'This appraisal link is not valid. Please contact your HR team.');
        return;
      }

      _appraisalData = data;
      renderForm(data);
      setState('form');

    } catch (e) {
      setState('error', 'Could not load the appraisal form. Please check your connection and try again.');
    }
  }

  // ── Expose to inline HTML handlers ───────────────────────────────────────

  window._APR = { onScoreChange, onScoreBlur, onCommentChange, confirmSubmit, cancelSubmit, submitAppraisal };

  // ── Boot ──────────────────────────────────────────────────────────────────

  // Add spin animation for the submit button loading state
  if (!document.getElementById('apr-spin-style')) {
    const style = document.createElement('style');
    style.id = 'apr-spin-style';
    style.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadForm);
  } else {
    loadForm();
  }

})();
