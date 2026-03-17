/**
 * Appraisify – External Appraisal Form Logic
 *
 * Standalone form (no Bitrix24 SDK). Reads a token from ?token= in the URL,
 * fetches deal + template data from /api/appraisal-link, renders the form
 * with the exact same layout as the internal appraisal forms, and submits
 * to /api/appraisal-submit.
 */

(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const token  = params.get('token') || '';

  let _phase    = '';
  let _dealId   = '';
  let _totalQ   = 0;
  let _scores   = {};   // { "q1": 4.5, "q2": 3 }
  let _comments = {};   // { "q1": "some note" }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function el(id) { return document.getElementById(id); }

  // ── State machine ────────────────────────────────────────────────────────

  function setState(state, message) {
    ['loading', 'error', 'form', 'success'].forEach(s => {
      const node = el(`state-${s}`);
      if (node) node.classList.toggle('hidden', s !== state);
    });
    if (state === 'error' && message) {
      const m = el('error-message');
      if (m) m.textContent = message;
    }
    const bar = el('action-bar');
    if (bar) bar.classList.toggle('hidden', state !== 'form');
  }

  // ── Template → sections (identical to appraisal-reviewee.html) ───────────

  function slugifySection(text) {
    return String(text || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  }

  function buildSectionsFromTemplate(template) {
    const grouped  = [];
    const groupMap = {};
    let qNo = 0;

    const list = []
      .concat(Array.isArray(template.sections?.scope)      ? template.sections.scope      : [])
      .concat(Array.isArray(template.sections?.engagement) ? template.sections.engagement : []);

    list.forEach(q => {
      const sectionTitle = String(q.section || 'General').trim() || 'General';
      if (!groupMap[sectionTitle]) {
        groupMap[sectionTitle] = {
          id: `${slugifySection(sectionTitle)}-${Object.keys(groupMap).length + 1}`,
          title: sectionTitle,
          questions: [],
        };
        grouped.push(groupMap[sectionTitle]);
      }
      qNo += 1;
      groupMap[sectionTitle].questions.push({ id: `q${qNo}`, text: String(q.text || '').trim() });
    });

    return grouped.filter(s => s.questions.length);
  }

  // ── Phase column configuration ────────────────────────────────────────────

  const PHASE_CFG = {
    self: {
      cols: [
        { label: 'Self',     field: 'self',     active: true  },
        { label: 'Reviewer', field: 'reviewer', active: false },
        { label: 'Partner',  field: 'partner',  active: false },
      ],
      activeIcon:        'edit',
      activeColor:       'text-amber-700',
      activeCellBg:      'bg-amber-50/20',
      activeCommentBg:   'bg-amber-50/10',
      activeMobileBg:    'background:rgba(255,251,235,0.4)',
      activeMobileColor: 'color:#92400e',
      badgeText:         'Self-Assessment Phase',
      badgeClass:        'bg-amber-100 text-amber-700',
      headerSub:         'Self-Assessment',
      submitLabel:       'Submit Self-Appraisal',
      modalTitle:        'Submit Self-Appraisal?',
      modalDesc:         "Once submitted, you won't be able to edit your responses. Your reviewer will be notified to begin their evaluation.",
    },
    reviewer: {
      cols: [
        { label: 'Self',     field: 'self',     active: false },
        { label: 'Reviewer', field: 'reviewer', active: true  },
        { label: 'Partner',  field: 'partner',  active: false },
      ],
      activeIcon:        'rate_review',
      activeColor:       'text-primary',
      activeCellBg:      'bg-primary/5',
      activeCommentBg:   'bg-primary/5',
      activeMobileBg:    'background:rgba(19,109,236,0.05)',
      activeMobileColor: 'color:#136dec',
      badgeText:         'Reviewer Phase',
      badgeClass:        'bg-blue-100 text-blue-700',
      headerSub:         'Reviewer Evaluation',
      submitLabel:       'Submit Reviewer Evaluation',
      modalTitle:        'Submit Reviewer Evaluation?',
      modalDesc:         "Once submitted, you won't be able to edit your responses. The partner reviewer will be notified.",
    },
    partner: {
      cols: [
        { label: 'Self',     field: 'self',     active: false },
        { label: 'Reviewer', field: 'reviewer', active: false },
        { label: 'Partner',  field: 'partner',  active: true  },
      ],
      activeIcon:        'diversity_3',
      activeColor:       'text-primary',
      activeCellBg:      'bg-primary/5',
      activeCommentBg:   'bg-primary/5',
      activeMobileBg:    'background:rgba(19,109,236,0.05)',
      activeMobileColor: 'color:#136dec',
      badgeText:         'Partner Phase',
      badgeClass:        'bg-purple-100 text-purple-700',
      headerSub:         'Partner Review',
      submitLabel:       'Submit Partner Review',
      modalTitle:        'Submit Partner Review?',
      modalDesc:         "Once submitted, you won't be able to edit your responses. The appraisal cycle will be marked complete.",
    },
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtScore(v) {
    const n = parseFloat(v);
    return isNaN(n) ? '' : n.toFixed(2).replace(/\.00$/, '');
  }

  // ── Form rendering (matching appraisal-reviewee.html exactly) ────────────

  function renderForm(sections, phase, responses) {
    const cfg       = PHASE_CFG[phase] || PHASE_CFG.self;
    const activeCol = cfg.cols.find(c => c.active);
    const container = el('form-sections');
    const resp      = responses || {};

    container.innerHTML = sections.map(section => {

      // Column header cells
      const thCells = cfg.cols.map(col => {
        if (col.active) {
          return `<th class="px-4 py-3 text-center w-28 ${cfg.activeCellBg}">
            <span class="inline-flex items-center gap-1 ${cfg.activeColor}">
              <span class="material-symbols-outlined text-sm">${cfg.activeIcon}</span> ${col.label}
            </span></th>`;
        }
        return `<th class="px-4 py-3 text-center w-28 bg-slate-50/80 text-slate-400">${col.label}</th>`;
      }).join('');

      // Desktop rows
      const desktopRows = section.questions.map(q => {
        const qIdx = parseInt(q.id.replace('q', ''), 10);

        const scoreCells = cfg.cols.map(col => {
          if (col.active) {
            return `<td class="px-4 py-4 text-center ${cfg.activeCellBg} align-top">
              <input type="number" min="1" max="5" step="0.01" placeholder="1–5"
                data-field="${col.field}-score" data-qid="${q.id}"
                class="rating-input"
                oninput="onScoreChange(this)" onblur="onScoreBlur(this)"/>
              <p class="text-xs text-red-500 mt-1" data-score-hint style="display:none">Only 1–5 is accepted</p>
            </td>`;
          }
          const existing = (resp[col.field] || {})[qIdx];
          if (existing) {
            const commentHtml = existing.comment
              ? `<p class="text-xs text-slate-400 mt-1.5 italic leading-snug">${escHtml(existing.comment)}</p>`
              : '';
            return `<td class="px-4 py-4 text-center bg-slate-50/50 align-top">
              <div class="rating-readonly">${fmtScore(existing.score)}</div>
              ${commentHtml}
            </td>`;
          }
          return `<td class="px-4 py-4 text-center bg-slate-50/50 align-top">
            <div class="rating-readonly text-slate-400 italic text-xs">Pending</div>
          </td>`;
        }).join('');

        return `<tr class="question-row" data-qid="${q.id}" data-section="${section.id}">
          <td class="px-6 py-4 font-medium text-slate-700 align-top">${q.text}</td>
          ${scoreCells}
          <td class="px-6 py-4 ${cfg.activeCommentBg} align-top">
            <textarea rows="3" placeholder="Add your comments or supporting evidence…"
              data-field="${activeCol.field}-comment" data-qid="${q.id}"
              class="comment-input"
              oninput="onCommentChange(this)"></textarea>
          </td>
        </tr>`;
      }).join('');

      // Mobile cards
      const mobileCards = section.questions.map(q => {
        const qIdx = parseInt(q.id.replace('q', ''), 10);

        const scoreCells = cfg.cols.map(col => {
          if (col.active) {
            return `<div class="mobile-q-score-cell" style="${cfg.activeMobileBg}">
              <span class="mobile-q-score-label" style="${cfg.activeMobileColor}">✏ ${col.label}</span>
              <input type="number" min="1" max="5" step="0.01" placeholder="—"
                data-field="${col.field}-score" data-qid="${q.id}"
                class="rating-input-mobile"
                oninput="onScoreChange(this)" onblur="onScoreBlur(this)"/>
              <p class="text-xs text-red-500 mt-1" data-score-hint style="display:none">Only 1–5 is accepted</p>
            </div>`;
          }
          const existing = (resp[col.field] || {})[qIdx];
          if (existing) {
            return `<div class="mobile-q-score-cell">
              <span class="mobile-q-score-label">${col.label}</span>
              <span class="rating-badge">${fmtScore(existing.score)}</span>
              ${existing.comment ? `<p class="text-xs text-slate-400 mt-1 italic leading-snug px-1">${escHtml(existing.comment)}</p>` : ''}
            </div>`;
          }
          return `<div class="mobile-q-score-cell">
            <span class="mobile-q-score-label">${col.label}</span>
            <span class="rating-badge rating-badge-pending">Pending</span>
          </div>`;
        }).join('');

        return `<div class="mobile-q-card" data-qid="${q.id}" data-section="${section.id}">
          <div class="mobile-q-card-header">${q.text}</div>
          <div class="mobile-q-scores">${scoreCells}</div>
          <div class="mobile-q-comment">
            <span class="mobile-q-comment-label" style="${cfg.activeMobileColor}">Your Comment</span>
            <textarea rows="3" placeholder="Add your comments or supporting evidence…"
              data-field="${activeCol.field}-comment" data-qid="${q.id}"
              class="comment-input"
              oninput="onCommentChange(this)"></textarea>
          </div>
        </div>`;
      }).join('');

      return `<div class="section-block bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden" data-section="${section.id}">
        <div class="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
          <h3 class="font-bold text-slate-900">${section.title}</h3>
        </div>
        <div class="hidden md:block overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-slate-100 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                <th class="px-6 py-3 text-left w-80">Question</th>
                ${thCells}
                <th class="px-6 py-3 text-left ${cfg.activeCommentBg}">Comments</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">${desktopRows}</tbody>
          </table>
        </div>
        <div class="md:hidden space-y-3 p-4">${mobileCards}</div>
      </div>`;
    }).join('');
  }

  function renderSectionTabs(sections) {
    const tabBar = el('section-tabs');
    if (!tabBar) return;
    sections.forEach(s => {
      const btn = document.createElement('button');
      btn.onclick = () => filterSection(s.id);
      btn.dataset.tab = s.id;
      btn.className = 'section-tab shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold border border-slate-200 bg-white text-slate-600 hover:border-primary hover:text-primary transition-colors';
      btn.textContent = s.title;
      tabBar.appendChild(btn);
    });
  }

  function filterSection(id) {
    document.querySelectorAll('.section-block').forEach(block => {
      block.style.display = (id === 'all' || block.dataset.section === id) ? '' : 'none';
    });
    document.querySelectorAll('.section-tab').forEach(btn => {
      const active = btn.dataset.tab === id;
      btn.className = active
        ? 'section-tab shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold border border-primary bg-primary text-white transition-colors'
        : 'section-tab shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold border border-slate-200 bg-white text-slate-600 hover:border-primary hover:text-primary transition-colors';
    });
  }

  // ── Score / comment handlers (identical signatures to appraisal.js) ───────

  function onScoreChange(inputEl) {
    const qid  = inputEl.dataset.qid;
    const raw  = inputEl.value;
    const val  = parseFloat(raw);
    const hint = inputEl.parentElement.querySelector('[data-score-hint]');

    if (raw === '') {
      delete _scores[qid];
      if (hint) hint.style.display = 'none';
    } else if (isNaN(val) || val < 1 || val > 5) {
      if (hint) hint.style.display = '';
      delete _scores[qid];
    } else {
      if (hint) hint.style.display = 'none';
      _scores[qid] = val;
    }
    updateProgress();
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

  // ── Progress bar ─────────────────────────────────────────────────────────

  function updateProgress() {
    const scored = Object.keys(_scores).length;
    const pct    = _totalQ > 0 ? Math.round((scored / _totalQ) * 100) : 0;
    const label  = el('progress-label');
    const bar    = el('progress-bar');
    const avg    = el('avg-score');
    if (label) label.textContent = `${scored} / ${_totalQ} questions`;
    if (bar)   bar.style.width   = `${pct}%`;
    if (avg) {
      const vals = Object.values(_scores).filter(v => !isNaN(v));
      avg.textContent = vals.length
        ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)
        : '—';
    }
  }

  // ── Submit flow ───────────────────────────────────────────────────────────

  function confirmSubmit() {
    el('modal-submit').classList.remove('hidden');
  }

  async function submitAppraisal() {
    el('modal-submit').classList.add('hidden');

    const btn   = el('btn-submit');
    const label = el('btn-submit-label');
    if (btn)   btn.disabled      = true;
    if (label) label.textContent = 'Submitting…';

    try {
      const resp = await fetch('/api/appraisal-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, scores: _scores, comments: _comments }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || json.error) throw new Error(json.error_description || json.error || `HTTP ${resp.status}`);
      setState('success');
    } catch (e) {
      if (btn) btn.disabled = false;
      const cfg = PHASE_CFG[_phase] || PHASE_CFG.self;
      if (label) label.textContent = cfg.submitLabel;
      alert('Submission failed: ' + e.message + '\n\nPlease try again or contact your HR team.');
    }
  }

  // ── Initialise ────────────────────────────────────────────────────────────

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
        const MSGS = {
          token_invalid:  'This appraisal link is invalid. Please use the link from your email.',
          token_expired:  'This appraisal link has expired. Links are valid for 7 days — please contact your HR team for a new one.',
          token_used:     'This appraisal link has already been used and cannot be reused.',
          deal_not_found: 'The appraisal record was not found. Please contact your HR team.',
        };
        setState('error', MSGS[data.error] || 'This appraisal link is not valid. Please contact your HR team.');
        return;
      }

      const { phase, deal, template, responses } = data;
      _phase  = phase;
      _dealId = deal.id;
      const cfg = PHASE_CFG[phase] || PHASE_CFG.self;

      // ── Header ──────────────────────────────────────────────────────────
      const phaseBadge = el('phase-badge');
      if (phaseBadge) {
        phaseBadge.textContent = cfg.badgeText;
        phaseBadge.className   = `px-2.5 py-0.5 rounded-full text-xs font-bold ${cfg.badgeClass}`;
        phaseBadge.classList.remove('hidden');
      }
      const hdrSub = el('hdr-sub');
      if (hdrSub) hdrSub.textContent = cfg.headerSub;

      // Extract name from "Name – Cycle" deal title format
      const dealName = String(deal.title || '').split(/\s*[–\-]\s*/)[0].trim() || '—';
      const hdrName  = el('hdr-name');
      const hdrAv    = el('hdr-avatar');
      if (hdrName) hdrName.textContent = dealName;
      if (hdrAv)   hdrAv.textContent   = (dealName.charAt(0) || '?').toUpperCase();

      // ── Metadata card ────────────────────────────────────────────────────
      const revieweeEl = el('meta-reviewee');
      if (revieweeEl) revieweeEl.textContent = dealName;
      const refEl = el('meta-ref');
      if (refEl) refEl.textContent = `#APR-${deal.id}`;
      const yearEl = el('meta-year');
      if (yearEl) yearEl.textContent = new Date().getFullYear();

      // ── Build + render sections ──────────────────────────────────────────
      const sections = buildSectionsFromTemplate(template || { sections: {} });

      if (!sections.length) {
        const fc = el('form-sections');
        if (fc) fc.innerHTML = `<div class="bg-white rounded-2xl border border-red-200 p-6 text-sm text-red-700">
          This template has no questions. Please contact your admin.</div>`;
        const btnS = el('btn-submit');
        if (btnS) btnS.disabled = true;
        setState('form');
        return;
      }

      _totalQ = sections.reduce((sum, s) => sum + s.questions.length, 0);
      updateProgress();

      renderForm(sections, phase, responses);
      renderSectionTabs(sections);

      // ── Submit button + modal text ───────────────────────────────────────
      const btnLabel   = el('btn-submit-label');
      const modalTitle = el('modal-title');
      const modalDesc  = el('modal-description');
      if (btnLabel)   btnLabel.textContent   = cfg.submitLabel;
      if (modalTitle) modalTitle.textContent = cfg.modalTitle;
      if (modalDesc)  modalDesc.textContent  = cfg.modalDesc;

      setState('form');

    } catch (e) {
      setState('error', 'Could not load the appraisal form. Please check your connection and try again.');
    }
  }

  // ── Expose as globals so inline HTML handlers work without prefix ─────────

  window.onScoreChange   = onScoreChange;
  window.onScoreBlur     = onScoreBlur;
  window.onCommentChange = onCommentChange;
  window.filterSection   = filterSection;
  window.confirmSubmit   = confirmSubmit;
  window.submitAppraisal = submitAppraisal;

  // ── Boot ──────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadForm);
  } else {
    loadForm();
  }

})();
