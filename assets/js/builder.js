/**
 * Appraisify – Question Builder / Editor Logic
 * Used by: question-builder.html, question-editor.html
 */

let _workspace    = 'scope';    // 'scope' | 'engagement'
let _questionsMap = {
  scope:       [],  // [{ _uid, section, text, desc }]
  engagement:  [],
};
let _scopeItems   = [];         // strings
let _sectionCatalog = {
  scope: [],
  engagement: [],
};

// ── Workspace switch ──────────────────────────────────────────────────────
function setWorkspace(ws) {
  _workspace = ws;
  refreshSectionDropdown();
  renderQuestionList();
}

// ── Scope of work items ───────────────────────────────────────────────────
function addScopeItem() {
  const input = document.getElementById('scope-input');
  const val   = input?.value.trim();
  if (!val) return;
  if (_scopeItems.includes(val)) { input.value = ''; return; }
  _scopeItems.push(val);
  input.value = '';
  renderScopeItems();
}

function removeScopeItem(idx) {
  _scopeItems.splice(idx, 1);
  renderScopeItems();
}

function renderScopeItems() {
  const container = document.getElementById('scope-items');
  if (!container) return;
  container.innerHTML = _scopeItems.map((item, i) => `
    <span class="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary border border-primary/20">
      ${item}
      <button onclick="removeScopeItem(${i})" class="ml-1 text-primary/60 hover:text-primary">
        <span class="material-symbols-outlined text-sm">close</span>
      </button>
    </span>`).join('');
}

// ── Section management ────────────────────────────────────────────────────
function getSections() {
  const fromQuestions = _questionsMap[_workspace].map(q => q.section);
  const fromCatalog = _sectionCatalog[_workspace] || [];
  return [...new Set([...fromCatalog, ...fromQuestions].filter(Boolean))];
}

function refreshSectionDropdown() {
  const sel = document.getElementById('new-section');
  if (!sel) return;
  const prev = sel.value;
  const sections = getSections();
  sel.innerHTML = '<option value="">— Select section —</option>' +
    sections.map(s => `<option value="${s}">${s}</option>`).join('');
  if (prev && sections.includes(prev)) sel.value = prev;
}

function createSectionFromInput() {
  const input = document.getElementById('new-section-name');
  const sel = document.getElementById('new-section');
  const section = input?.value.trim();
  if (!section) {
    input?.focus();
    input?.classList.add('border-red-400');
    setTimeout(() => input?.classList.remove('border-red-400'), 1500);
    return;
  }
  if (!_sectionCatalog[_workspace].includes(section)) {
    _sectionCatalog[_workspace].push(section);
  }
  refreshSectionDropdown();
  if (sel) sel.value = section;
  if (input) input.value = '';
}

// ── Add question ──────────────────────────────────────────────────────────
function addQuestion() {
  const sectionSel  = document.getElementById('new-section');
  const sectionName = document.getElementById('new-section-name');
  const textInput   = document.getElementById('new-question-text');
  const descInput   = document.getElementById('new-question-desc');

  const text = textInput?.value.trim();
  if (!text) {
    textInput?.focus();
    textInput?.classList.add('border-red-400');
    setTimeout(() => textInput?.classList.remove('border-red-400'), 1500);
    return;
  }

  const section = sectionSel?.value;
  if (!section) {
    sectionSel?.focus();
    sectionSel?.classList.add('border-red-400');
    setTimeout(() => sectionSel?.classList.remove('border-red-400'), 1500);
    return;
  }

  _questionsMap[_workspace].push({
    _uid:    Math.random().toString(36).slice(2),
    section: section,
    text:    text,
    desc:    descInput?.value.trim() || '',
  });

  // Reset form
  if (textInput)  textInput.value  = '';
  if (descInput)  descInput.value  = '';
  if (sectionSel) sectionSel.value = section;
  if (sectionName) sectionName.value = '';

  refreshSectionDropdown();
  renderQuestionList();
}

// ── Render question list ──────────────────────────────────────────────────
function renderQuestionList() {
  const container = document.getElementById('question-list');
  const countBadge = document.getElementById('question-count');
  if (!container) return;

  const qs = _questionsMap[_workspace];
  if (countBadge) countBadge.textContent = qs.length;

  // Remove empty state placeholder
  const empty = document.getElementById('empty-state');
  if (empty) empty.style.display = qs.length ? 'none' : '';

  if (!qs.length) {
    container.innerHTML = '';
    return;
  }

  // Group by section
  const sections = {};
  qs.forEach(q => {
    if (!sections[q.section]) sections[q.section] = [];
    sections[q.section].push(q);
  });

  let num = 1;
  container.innerHTML = Object.entries(sections).map(([section, items]) => `
    <div class="section-group">
      <div class="px-6 py-2 bg-slate-50/70 border-b border-slate-100 flex items-center justify-between">
        <span class="text-xs font-semibold text-primary uppercase tracking-wider">${section}</span>
        <span class="text-xs text-slate-400">${items.length} question${items.length !== 1 ? 's' : ''}</span>
      </div>
      ${items.map(q => {
        const n = num++;
        return `
        <div class="flex items-start gap-4 px-6 py-4 hover:bg-slate-50/50 transition-colors group" data-uid="${q._uid}">
          <span class="text-xs font-black text-slate-400 mt-1 w-6 text-right shrink-0">${n}</span>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-slate-800">${q.text}</p>
            ${q.desc ? `<p class="text-xs text-slate-500 mt-0.5">${q.desc}</p>` : ''}
          </div>
          <button onclick="deleteBuilderQuestion('${q._uid}')"
            class="opacity-0 group-hover:opacity-100 transition-opacity text-red-400 hover:text-red-600 shrink-0 mt-0.5">
            <span class="material-symbols-outlined text-base">delete</span>
          </button>
        </div>`;
      }).join('')}
    </div>`).join('');
}

// ── Delete question (builder) ─────────────────────────────────────────────
function deleteBuilderQuestion(uid) {
  _questionsMap[_workspace] = _questionsMap[_workspace].filter(q => q._uid !== uid);
  refreshSectionDropdown();
  renderQuestionList();
}

// ── Save template ─────────────────────────────────────────────────────────
function showBuilderFeedback(message, kind = 'error') {
  const el = document.getElementById('builder-feedback');
  if (!el) {
    if (message && kind === 'error') alert(message);
    return;
  }
  if (!message) {
    el.className = 'hidden';
    el.textContent = '';
    return;
  }
  el.textContent = message;
  el.className = kind === 'success'
    ? 'mb-4 px-4 py-3 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-medium'
    : 'mb-4 px-4 py-3 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm font-medium';
}

function setBuilderSaveLoading(isLoading) {
  const btn = document.getElementById('btn-save-template');
  if (!btn) return;
  btn.disabled = isLoading;
  btn.classList.toggle('opacity-60', isLoading);
  btn.classList.toggle('cursor-not-allowed', isLoading);
  btn.innerHTML = isLoading
    ? '<span class="material-symbols-outlined text-lg animate-spin">progress_activity</span> Saving...'
    : '<span class="material-symbols-outlined text-lg">save</span> Save Template';
}

async function saveTemplate() {
  const typeEl     = document.getElementById('meta-type');
  const teamEl     = document.getElementById('meta-team');
  const roleEl     = document.getElementById('meta-role');
  const nameText   = document.getElementById('template-name-text')?.textContent || 'Untitled';
  const totalQs    = _questionsMap.scope.length + _questionsMap.engagement.length;

  if (!typeEl?.value) {
    showBuilderFeedback('Please select an Appraisal Type before saving.');
    typeEl?.focus();
    return;
  }
  if (totalQs === 0) {
    showBuilderFeedback('Please add at least one question before saving.');
    return;
  }
  if (typeof TemplatesAPI === 'undefined') {
    showBuilderFeedback('Template API is not loaded. Please refresh and try again.');
    return;
  }

  const payload = {
    name:        nameText,
    type:        typeEl.value,
    team:        teamEl?.value || 'all',
    role:        roleEl?.value || 'all',
    scopeItems:  _scopeItems,
    sections: {
      scope:      _questionsMap.scope,
      engagement: _questionsMap.engagement,
    },
  };

  try {
    showBuilderFeedback('');
    setBuilderSaveLoading(true);
    await TemplatesAPI.createTemplate(payload);
    showBuilderFeedback(`Template "${nameText}" saved. Redirecting...`, 'success');
    window.location.href = 'dashboard.html?template_saved=1';
  } catch (e) {
    showBuilderFeedback(`Failed to save template: ${e.message || e}`);
  } finally {
    setBuilderSaveLoading(false);
  }
}
