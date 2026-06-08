/**
 * Appraisify – Question Builder / Editor Logic
 * Used by: question-builder.html, question-editor.html
 */

let _workspace    = 'scope';    // 'scope' | 'engagement'
let _questionsMap = {
  scope:       [],  // [{ _uid, section, text, desc }]
  engagement:  [],
};
let _scopeItems   = [];         // [{ text, desc }]
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
  const textInput = document.getElementById('scope-input');
  const descInput = document.getElementById('scope-input-desc');
  const text = textInput?.value.trim();
  if (!text) return;
  const desc = descInput?.value.trim() || '';
  if (_scopeItems.some(i => i.text.toLowerCase() === text.toLowerCase())) {
    textInput.value = ''; if (descInput) descInput.value = ''; return;
  }
  _scopeItems.push({ text, desc });
  textInput.value = '';
  if (descInput) descInput.value = '';
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
    <div class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold text-slate-800">${item.text}</p>
        ${item.desc ? `<p class="text-xs text-slate-500 mt-0.5">${item.desc}</p>` : ''}
      </div>
      <button onclick="removeScopeItem(${i})" class="text-slate-400 hover:text-red-500 shrink-0 mt-0.5">
        <span class="material-symbols-outlined text-base">delete</span>
      </button>
    </div>`).join('');
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
          <button onclick="openImproveModal('${q._uid}')"
            class="opacity-0 group-hover:opacity-100 transition-opacity text-violet-400 hover:text-violet-600 shrink-0 mt-0.5" title="Improve with AI">
            <span class="text-sm">✨</span>
          </button>
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

// ── AI Chat ───────────────────────────────────────────────────────────────
let _aiChatHistory    = [];   // { role: 'user'|'assistant', content: string }[]
let _pendingAiQuestions = []; // flat list of questions from the latest rendered AI messages

function openAiPanel() {
  const panel = document.getElementById('ai-panel');
  if (!panel) return;
  panel.classList.remove('hidden');

  const type = document.getElementById('meta-type')?.value || '—';
  const team = document.getElementById('meta-team')?.value || '—';
  const role = document.getElementById('meta-role')?.value || '—';
  const ws   = _workspace === 'scope' ? 'Scope of Work' : 'Engagement Review';
  document.getElementById('ai-context-strip').textContent = `${type} · ${team} · ${role} · ${ws}`;

  if (!_aiChatHistory.length) {
    const greeting = `Hi! I'll help you build great appraisal questions. I can see you're working on a **${type}** appraisal` +
      (team && team !== '—' ? ` for the **${team}** team` : '') +
      (role && role !== '—' ? `, **${role}** level` : '') +
      `. What would you like to focus on? You can describe a theme (e.g. "leadership and communication") or ask me to generate a full set.`;
    _aiChatHistory.push({ role: 'assistant', content: greeting });
    renderAiChat();
  }
}

function closeAiPanel() {
  document.getElementById('ai-panel')?.classList.add('hidden');
}

async function sendAiMessage() {
  const input = document.getElementById('ai-input');
  const text  = input?.value.trim();
  if (!text) return;
  input.value = '';

  _aiChatHistory.push({ role: 'user', content: text });
  renderAiChat(true);

  const sendBtn = document.getElementById('ai-send-btn');
  if (sendBtn) { sendBtn.disabled = true; }

  try {
    const domain  = (typeof TemplatesAPI !== 'undefined' && TemplatesAPI.getDomainFromContext) ? TemplatesAPI.getDomainFromContext() : '';
    const context = {
      type:      document.getElementById('meta-type')?.value || '',
      team:      document.getElementById('meta-team')?.value || '',
      role:      document.getElementById('meta-role')?.value || '',
      workspace: _workspace,
    };
    const resp = await fetch('/api/ai-assist', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-appraisify-domain': domain },
      body:    JSON.stringify({ mode: 'chat', domain, messages: _aiChatHistory, context }),
    });
    const data = await resp.json();
    _aiChatHistory.push({
      role:    'assistant',
      content: (!resp.ok || data.error) ? `Sorry, I couldn't process that. ${data.error_description || data.error || ''}` : data.reply,
    });
  } catch {
    _aiChatHistory.push({ role: 'assistant', content: 'Something went wrong. Please try again.' });
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    renderAiChat();
  }
}

function _parseAiReply(text) {
  const parts = [];
  const regex = /<questions>([\s\S]*?)<\/questions>/g;
  let lastIdx = 0, match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      const t = text.slice(lastIdx, match.index).trim();
      if (t) parts.push({ type: 'text', content: t });
    }
    try {
      parts.push({ type: 'questions', questions: JSON.parse(match[1].trim()) });
    } catch {
      parts.push({ type: 'text', content: match[0] });
    }
    lastIdx = match.index + match[0].length;
  }
  const tail = text.slice(lastIdx).trim();
  if (tail) parts.push({ type: 'text', content: tail });
  return parts;
}

function _esc(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderAiChat(loading = false) {
  const area = document.getElementById('ai-chat-area');
  if (!area) return;
  _pendingAiQuestions = [];

  const html = _aiChatHistory.map(msg => {
    if (msg.role === 'user') {
      return `<div class="flex justify-end">
        <div class="max-w-[85%] bg-violet-600 text-white text-sm rounded-2xl rounded-tr-sm px-4 py-2.5">${_esc(msg.content).replace(/\n/g,'<br>')}</div>
      </div>`;
    }
    const parts = _parseAiReply(msg.content);
    const inner = parts.map(part => {
      if (part.type === 'text') {
        return `<p class="text-sm text-slate-700 leading-relaxed">${_esc(part.content).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>')}</p>`;
      }
      const startIdx = _pendingAiQuestions.length;
      part.questions.forEach(q => _pendingAiQuestions.push(q));
      const cards = part.questions.map((q, i) => `
        <div class="border border-slate-200 rounded-xl p-3 bg-slate-50/80">
          <div class="flex items-start gap-2">
            <div class="flex-1 min-w-0">
              <span class="text-[10px] font-bold text-violet-600 uppercase tracking-wider">${_esc(q.section || 'General')}</span>
              <p class="text-xs font-medium text-slate-800 mt-0.5">${_esc(q.text)}</p>
              ${q.desc ? `<p class="text-[11px] text-slate-500 mt-1">${_esc(q.desc)}</p>` : ''}
            </div>
            <button onclick="addAiQuestion(${startIdx + i}, this)"
              class="shrink-0 flex items-center justify-center w-7 h-7 rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors" title="Add to list">
              <span class="material-symbols-outlined text-sm">add</span>
            </button>
          </div>
        </div>`).join('');
      const addAll = part.questions.length > 1
        ? `<button onclick="addAllAiQuestions(${startIdx},${startIdx + part.questions.length})"
             class="w-full py-1.5 rounded-xl border border-violet-300 text-violet-700 text-xs font-bold hover:bg-violet-50 transition-colors">
             + Add All ${part.questions.length} Questions
           </button>` : '';
      return `<div class="space-y-2 mt-1">${cards}${addAll}</div>`;
    }).join('');
    return `<div class="flex gap-2.5">
      <div class="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center shrink-0 text-sm mt-0.5">✨</div>
      <div class="flex-1 space-y-2">${inner}</div>
    </div>`;
  }).join('');

  const loadingBubble = loading ? `<div class="flex gap-2.5">
    <div class="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center shrink-0 text-sm">✨</div>
    <div class="bg-slate-100 rounded-2xl px-4 py-2.5 text-sm text-slate-400 animate-pulse">Thinking…</div>
  </div>` : '';

  area.innerHTML = html + loadingBubble;
  area.scrollTop = area.scrollHeight;
}

function addAiQuestion(idx, btn) {
  const q = _pendingAiQuestions[idx];
  if (!q) return;
  const section = q.section || 'AI Generated';
  if (!_sectionCatalog[_workspace].includes(section)) {
    _sectionCatalog[_workspace].push(section);
  }
  _questionsMap[_workspace].push({
    _uid:    Math.random().toString(36).slice(2),
    section, text: q.text || '', desc: q.desc || '',
  });
  if (btn) {
    btn.innerHTML = '<span class="material-symbols-outlined text-sm">check</span>';
    btn.disabled  = true;
    btn.classList.replace('bg-violet-600', 'bg-emerald-500');
    btn.classList.replace('hover:bg-violet-700', 'hover:bg-emerald-500');
  }
  refreshSectionDropdown();
  renderQuestionList();
}

function addAllAiQuestions(startIdx, endIdx) {
  for (let i = startIdx; i < endIdx; i++) addAiQuestion(i, null);
  renderAiChat();
}

// ── Improve question modal ────────────────────────────────────────────────
let _aiImproveHistory = [];
let _aiImproveUid     = null;
let _aiImprovePending = [];

function openImproveModal(uid) {
  const q = _questionsMap[_workspace].find(q => q._uid === uid);
  if (!q) return;
  _aiImproveUid     = uid;
  _aiImproveHistory = [];
  _aiImprovePending = [];

  const seed = `I have an appraisal question I'd like to improve:\n\n**Question:** ${q.text}${q.desc ? `\n**Guidance:** ${q.desc}` : ''}\n\nCan you suggest an improved version?`;
  _aiImproveHistory.push({ role: 'user', content: seed });

  document.getElementById('ai-improve-modal')?.classList.remove('hidden');
  _callImproveApi();
}

function closeImproveModal() {
  document.getElementById('ai-improve-modal')?.classList.add('hidden');
  _aiImproveUid = null; _aiImproveHistory = []; _aiImprovePending = [];
}

async function sendImproveMessage() {
  const input = document.getElementById('ai-improve-input');
  const text  = input?.value.trim();
  if (!text) return;
  input.value = '';
  _aiImproveHistory.push({ role: 'user', content: text });
  renderImproveChat(true);
  _callImproveApi();
}

async function _callImproveApi() {
  const sendBtn = document.getElementById('ai-improve-send-btn');
  if (sendBtn) sendBtn.disabled = true;
  renderImproveChat(true);

  try {
    const domain  = (typeof TemplatesAPI !== 'undefined' && TemplatesAPI.getDomainFromContext) ? TemplatesAPI.getDomainFromContext() : '';
    const context = {
      type:      document.getElementById('meta-type')?.value || '',
      team:      document.getElementById('meta-team')?.value || '',
      role:      document.getElementById('meta-role')?.value || '',
      workspace: _workspace,
    };
    const resp = await fetch('/api/ai-assist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-appraisify-domain': domain },
      body:   JSON.stringify({ mode: 'chat', domain, messages: _aiImproveHistory, context }),
    });
    const data = await resp.json();
    _aiImproveHistory.push({
      role:    'assistant',
      content: (!resp.ok || data.error) ? `Sorry, something went wrong. ${data.error_description || ''}` : data.reply,
    });
  } catch {
    _aiImproveHistory.push({ role: 'assistant', content: 'Something went wrong. Please try again.' });
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    renderImproveChat();
  }
}

function renderImproveChat(loading = false) {
  const area = document.getElementById('ai-improve-chat');
  if (!area) return;
  _aiImprovePending = [];

  const html = _aiImproveHistory.map(msg => {
    if (msg.role === 'user') {
      return `<div class="flex justify-end">
        <div class="max-w-[85%] bg-violet-600 text-white text-sm rounded-2xl rounded-tr-sm px-4 py-2.5">${_esc(msg.content).replace(/\n/g,'<br>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')}</div>
      </div>`;
    }
    const parts = _parseAiReply(msg.content);
    const inner = parts.map(part => {
      if (part.type === 'text') {
        return `<p class="text-sm text-slate-700 leading-relaxed">${_esc(part.content).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>')}</p>`;
      }
      const startIdx = _aiImprovePending.length;
      part.questions.forEach(q => _aiImprovePending.push(q));
      return `<div class="space-y-2 mt-1">${part.questions.map((q, i) => `
        <div class="border border-emerald-200 rounded-xl p-3 bg-emerald-50/50">
          <span class="text-[10px] font-bold text-emerald-700 uppercase">${_esc(q.section || 'Improved')}</span>
          <p class="text-xs font-medium text-slate-800 mt-0.5">${_esc(q.text)}</p>
          ${q.desc ? `<p class="text-[11px] text-slate-500 mt-1">${_esc(q.desc)}</p>` : ''}
          <button onclick="applyImprovedQuestion(${startIdx + i})"
            class="mt-2 w-full py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition-colors">
            ✓ Use This Version
          </button>
        </div>`).join('')}</div>`;
    }).join('');
    return `<div class="flex gap-2.5">
      <div class="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center shrink-0 text-sm mt-0.5">✨</div>
      <div class="flex-1 space-y-2">${inner}</div>
    </div>`;
  }).join('');

  const loadingBubble = loading ? `<div class="flex gap-2.5">
    <div class="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center shrink-0 text-sm">✨</div>
    <div class="bg-slate-100 rounded-2xl px-4 py-2.5 text-sm text-slate-400 animate-pulse">Thinking…</div>
  </div>` : '';

  area.innerHTML = html + loadingBubble;
  area.scrollTop = area.scrollHeight;
}

function applyImprovedQuestion(idx) {
  const q = _aiImprovePending[idx];
  if (!q || !_aiImproveUid) return;
  const existing = _questionsMap[_workspace].find(q => q._uid === _aiImproveUid);
  if (existing) {
    if (q.text)    existing.text = q.text;
    if (q.desc !== undefined) existing.desc = q.desc;
    if (q.section) existing.section = q.section;
  }
  refreshSectionDropdown();
  renderQuestionList();
  closeImproveModal();
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
