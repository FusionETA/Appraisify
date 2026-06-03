/**
 * Appraisify – Dashboard Logic
 */

let currentUser = null;
let selectedEmployees = new Set();
let pendingTasksCache = [];

// Bitrix24 crm.deal.list returns STAGE_ID prefixed: 'C{categoryId}:{STATUS_ID}'
// Strip the prefix before looking up in STAGE_MAP.
const shortStageId = id => (id && id.includes(':')) ? id.split(':')[1] : id;
const stageFilterId = (categoryId, statusId) => (categoryId === 'dev' ? statusId : `C${categoryId}:${statusId}`);

// Stage ID → display info mapping (matches STATUS_IDs created on install)
const STAGE_MAP = {
  'INITIALIZED':                { phase: 'self',     label: 'Reviewee Pending', cls: 'bg-amber-100 text-amber-700' },
  'REVIEWEEPENDING':            { phase: 'self',     label: 'Reviewee Pending', cls: 'bg-amber-100 text-amber-700' },
  'REVIEWERPENDING':            { phase: 'reviewer', label: 'Reviewer Pending', cls: 'bg-blue-100 text-blue-700' },
  'PARTNERPENDING':             { phase: 'partner',  label: 'Partner Pending',  cls: 'bg-purple-100 text-purple-700' },
  'SUBMITTED':                  { phase: 'complete', label: 'Submitted',        cls: 'bg-emerald-100 text-emerald-700' },
};

// ── Init ─────────────────────────────────────────────────────────────
BX24App.init(async () => {
  currentUser = await BX24App.getUser();
  const role = currentUser.APP_ROLE;
  const name = `${currentUser.NAME} ${currentUser.LAST_NAME || ''}`.trim();

  // Header
  document.getElementById('user-name').textContent = name;
  document.getElementById('user-name').classList.remove('hidden');

  // Mobile drawer user info
  const mobileNameEl = document.getElementById('mobile-user-name');
  const mobileRoleEl = document.getElementById('mobile-user-role');
  const mobileAvatar = document.getElementById('mobile-user-avatar');
  if (mobileNameEl) mobileNameEl.textContent = name;
  if (mobileRoleEl) mobileRoleEl.textContent = role;
  if (mobileAvatar) mobileAvatar.textContent = name.charAt(0).toUpperCase();

  // Show sections by role.
  // NOTE: Bitrix24 APP_ROLE is only ever 'admin' or 'employee'.
  // Reviewer/partner status is determined by checking CRM deals directly.
  const showSection = id => document.getElementById(id)?.classList.remove('hidden');

  if (role === 'admin') {
    showSection('section-admin');
    document.getElementById('nav-questions')?.classList.remove('hidden');
    document.getElementById('mobile-nav-questions')?.classList.remove('hidden');
    loadEmployeeTable();

    // Show which CRM mode this portal is using
    const mode = BX24App.getMode();
    const modeBadge = document.getElementById('mode-badge');
    if (modeBadge) {
      if (mode === 'spa') {
        modeBadge.textContent = 'SPA Mode';
        modeBadge.classList.add('bg-blue-50', 'text-blue-600', 'border-blue-200');
      } else {
        modeBadge.textContent = 'Deal Mode';
        modeBadge.classList.add('bg-amber-50', 'text-amber-600', 'border-amber-200');
      }
      modeBadge.classList.remove('hidden');
    }
  }

  // Always show personal appraisal summary + pending task queue for everyone.
  showSection('section-employee');
  showSection('section-pending');
  loadMyAppraisal(name);
  loadPendingTasks();

  // Toast from redirect
  const params = new URLSearchParams(window.location.search);
  if (params.get('submitted')) showToast('Appraisal submitted successfully!');
  if (params.get('launched')) showToast('Appraisal cycle launched!');
  if (params.get('template_saved')) showToast('Template saved successfully!');
});

// ── Employee section ──────────────────────────────────────────────────
async function loadMyAppraisal(name) {
  document.getElementById('emp-name').textContent = name;
  document.getElementById('emp-role-team').textContent = currentUser.WORK_POSITION || 'Employee';
  document.getElementById('emp-avatar').textContent = name.charAt(0).toUpperCase();

  const badge = document.getElementById('phase-badge');
  const cycleBadge = document.getElementById('cycle-badge');
  const btn = document.getElementById('btn-submit-appraisal');
  const btnDownload = document.getElementById('btn-download-report');

  try {
    const categoryId = await BX24App.getCategoryId();
    if (!categoryId) throw new Error('No pipeline');

    const deals = await BX24App.listDeals(
      { CATEGORY_ID: categoryId, ASSIGNED_BY_ID: currentUser.ID, UF_CRM_SOURCE_APP: 'APPRAISIFY' },
      ['ID', 'TITLE', 'STAGE_ID', 'CLOSEDATE'],
    );
    if (!deals.length) {
      badge.textContent = 'No active appraisal';
      badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-500';
      cycleBadge.textContent = '—';
      if (btn) { btn.disabled = true; btn.classList.add('opacity-40', 'cursor-not-allowed'); }
      if (btnDownload) { btnDownload.disabled = true; btnDownload.classList.add('opacity-40', 'cursor-not-allowed'); }
      return;
    }

    // Sort by ID descending so the newest deal comes first regardless of Bitrix24's
    // default list ordering (which is oldest-first).
    const sorted = [...deals].sort((a, b) => Number(b.ID) - Number(a.ID));
    // Prefer the newest active (non-SUBMITTED) deal. Falls back to the newest
    // submitted deal if all cycles are done — e.g. between appraisal cycles.
    const deal = sorted.find(d => shortStageId(d.STAGE_ID) !== 'SUBMITTED') ?? sorted[0];
    // Most recent completed deal — used for the download button (only available when done).
    const submittedDeal = sorted.find(d => shortStageId(d.STAGE_ID) === 'SUBMITTED');
    const stageInfo = STAGE_MAP[shortStageId(deal.STAGE_ID)] || { phase: 'self', label: deal.STAGE_ID, cls: 'bg-slate-100 text-slate-500' };

    badge.textContent = stageInfo.label;
    badge.className = `px-2.5 py-0.5 rounded-full text-xs font-bold ${stageInfo.cls}`;
    cycleBadge.textContent = deal.TITLE;

    if (stageInfo.phase !== 'self') {
      if (btn) { btn.disabled = true; btn.classList.add('opacity-40', 'cursor-not-allowed'); }
    } else {
      if (btn) btn.onclick = () => { window.location.href = `appraisal-reviewee.html?appraisal=${deal.ID}`; };
    }
    if (btnDownload) {
      if (submittedDeal) {
        btnDownload.disabled = false;
        btnDownload.classList.remove('opacity-40', 'cursor-not-allowed');
        btnDownload.onclick = () => {
          const params = new URLSearchParams({ appraisal: String(submittedDeal.ID) });
          const current = new URLSearchParams(window.location.search);
          const domain = current.get('DOMAIN') || current.get('domain');
          if (domain) params.set('domain', domain);
          window.open(`appraisal-report-preview.html?${params.toString()}`, '_blank');
        };
      } else {
        btnDownload.disabled = true;
        btnDownload.classList.add('opacity-40', 'cursor-not-allowed');
      }
    }

    if (stageInfo.phase === 'complete') {
      document.getElementById('score-cards')?.classList.remove('hidden');
      try {
        const fullDeal = await BX24App.getDeal(deal.ID);
        if (fullDeal) {
          ['S', 'R', 'P'].forEach((phaseCode, i) => {
            const vals = [];
            for (let n = 1; n <= 20; n++) {
              const actor = ['REVIEWEE', 'REVIEWER', 'PARTNER'][i];
              const key = `UF_CRM_QUESTION_${n}_${actor}_RATING`;
              const v = fullDeal[key];
              if (v !== null && v !== undefined && v !== '' && v !== false) {
                const num = parseFloat(v);
                if (!isNaN(num)) vals.push(num);
              }
            }
            const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
            const id = ['self', 'reviewer', 'partner'][i];
            const scoreEl = document.getElementById(`score-${id}`);
            const barEl   = document.getElementById(`bar-${id}`);
            if (scoreEl) scoreEl.textContent = avg !== null ? avg.toFixed(2) : '—';
            if (barEl)   barEl.style.width   = avg !== null ? `${(avg / 5) * 100}%` : '0%';
          });
        }
      } catch (e) {
        console.warn('[Appraisify] Failed to load score averages:', e);
      }
    }
  } catch (e) {
    console.error('[Appraisify] loadMyAppraisal error:', e);
    badge.textContent = 'Unable to load';
    badge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-600';
    if (btnDownload) { btnDownload.disabled = true; btnDownload.classList.add('opacity-40', 'cursor-not-allowed'); }
  }
}

// ── Unified pending tasks section ─────────────────────────────────────
async function loadPendingTasks() {
  const list = document.getElementById('pending-list');
  const warning = document.getElementById('pending-load-warning');

  // Pending task stage(s) for each role.
  // self accepts both IDs: INITIALIZED (SPA) and REVIEWEEPENDING (deal mode).
  const PENDING_STAGE = {
    self:     ['INITIALIZED', 'REVIEWEEPENDING'],
    reviewer: ['REVIEWERPENDING'],
    partner:  ['PARTNERPENDING'],
  };

  try {
    const categoryId = await BX24App.getCategoryId();
    const select = ['ID', 'TITLE', 'STAGE_ID', 'CLOSEDATE'];

    // Fetch deals where this user is reviewee, reviewer, or partner in parallel.
    // All three queries use the installer's system token via listDeals(), which
    // works uniformly for any filter as long as the installer has CRM "See All".
    const [selfDeals, reviewerDeals, partnerDeals] = await Promise.all([
      BX24App.listDeals({ CATEGORY_ID: categoryId, ASSIGNED_BY_ID:  currentUser.ID, UF_CRM_SOURCE_APP: 'APPRAISIFY' }, select),
      BX24App.listDeals({ CATEGORY_ID: categoryId, UF_CRM_REVIEWER: currentUser.ID, UF_CRM_SOURCE_APP: 'APPRAISIFY' }, select),
      BX24App.listDeals({ CATEGORY_ID: categoryId, UF_CRM_PARTNER:  currentUser.ID, UF_CRM_SOURCE_APP: 'APPRAISIFY' }, select),
    ]);

    // Track deal+role pairs to avoid duplicates, but allow the same deal to appear
    // under different roles. This handles the case where one person is both reviewer
    // AND partner on the same deal — after reviewer submission the stage advances to
    // PARTNERPENDING and only the partner task should show. Using a combined key
    // (dealId+role) means each role is evaluated independently for each deal.
    const seen = new Set();
    const tasks = [];
    for (const [deals, role] of [[selfDeals, 'self'], [reviewerDeals, 'reviewer'], [partnerDeals, 'partner']]) {
      for (const deal of deals) {
        const key = `${deal.ID}:${role}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const stage = shortStageId(deal.STAGE_ID);
        if (stage !== 'SUBMITTED' && PENDING_STAGE[role].includes(stage)) {
          tasks.push(normalizeTask(deal, role));
        }
      }
    }

    tasks.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.dueTs !== b.dueTs) return a.dueTs - b.dueTs;
      return String(a.id).localeCompare(String(b.id));
    });

    renderPendingTasks(tasks);
    if (warning) warning.classList.add('hidden');

  } catch (e) {
    console.error('[Appraisify] loadPendingTasks error:', e);
    renderPendingTasks([]);
    if (list) {
      list.innerHTML = `
        <div class="p-6 text-sm text-red-600">
          Unable to load pending submissions right now.
        </div>`;
    }
    if (warning) {
      warning.classList.remove('hidden');
      warning.textContent = 'Unable to load pending submissions.';
    }
  }
}

function normalizeTask(deal, taskType) {
  const META = {
    self: {
      chipCls: 'bg-amber-100 text-amber-700',
      iconCls: 'bg-amber-100 text-amber-700',
      buttonCls: 'bg-amber-600 hover:bg-amber-700 shadow-amber-500/20',
      label: 'Self Submission',
      icon: 'edit_note',
      href: 'appraisal-reviewee.html',
      ctaLabel: 'Submit Self Appraisal',
      priority: 1,
    },
    reviewer: {
      chipCls: 'bg-emerald-100 text-emerald-700',
      iconCls: 'bg-emerald-100 text-emerald-700',
      buttonCls: 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/20',
      label: 'Reviewer Submission',
      icon: 'rate_review',
      href: 'appraisal-reviewer.html',
      ctaLabel: 'Start Review',
      priority: 2,
    },
    partner: {
      chipCls: 'bg-purple-100 text-purple-700',
      iconCls: 'bg-purple-100 text-purple-700',
      buttonCls: 'bg-purple-600 hover:bg-purple-700 shadow-purple-500/20',
      label: 'Partner Submission',
      icon: 'handshake',
      href: 'appraisal-partner.html',
      ctaLabel: 'Start Partner Review',
      priority: 3,
    },
  };
  const meta = META[taskType];
  const dueTs = deal.CLOSEDATE ? new Date(deal.CLOSEDATE).getTime() : Number.POSITIVE_INFINITY;
  return {
    id: deal.ID,
    taskType,
    title: deal.TITLE || `Appraisal #${deal.ID}`,
    dueDate: deal.CLOSEDATE || null,
    dueTs,
    ref: `#APR-${deal.ID}`,
    href: meta.href,
    ctaLabel: meta.ctaLabel,
    priority: meta.priority,
    chipCls: meta.chipCls,
    iconCls: meta.iconCls,
    buttonCls: meta.buttonCls,
    label: meta.label,
    icon: meta.icon,
  };
}

function renderPendingTasks(tasks) {
  const list = document.getElementById('pending-list');
  const count = document.getElementById('pending-count');
  const badge = document.getElementById('notif-badge');
  pendingTasksCache = Array.isArray(tasks) ? tasks : [];

  if (!list) return;
  if (count) count.textContent = String(tasks.length);
  if (badge) badge.classList.toggle('hidden', tasks.length === 0);

  if (!tasks.length) {
    list.innerHTML = `
      <div class="p-6 text-sm text-slate-500">
        No pending submissions. You're all caught up.
      </div>`;
    return;
  }

  list.innerHTML = tasks.map(taskRow).join('');
}

function notificationMessage(task) {
  if (!task) return '';
  if (task.taskType === 'self') {
    return 'Please submit your self-assessment.';
  }
  if (task.taskType === 'reviewer') {
    return `Please complete reviewer evaluation for ${task.title || `#APR-${task.id}`}.`;
  }
  if (task.taskType === 'partner') {
    return `Please submit partner review for ${task.title || `#APR-${task.id}`}.`;
  }
  return `Please review appraisal ${task.title || `#APR-${task.id}`}.`;
}

function notificationGroupMeta(taskType) {
  const map = {
    self: {
      title: 'Self-Assessment',
      icon: 'edit_note',
      cls: 'bg-amber-50 border-amber-200 text-amber-800',
      chip: 'bg-amber-100 text-amber-700',
    },
    reviewer: {
      title: 'Reviewer Evaluation',
      icon: 'rate_review',
      cls: 'bg-emerald-50 border-emerald-200 text-emerald-800',
      chip: 'bg-emerald-100 text-emerald-700',
    },
    partner: {
      title: 'Partner Review',
      icon: 'handshake',
      cls: 'bg-purple-50 border-purple-200 text-purple-800',
      chip: 'bg-purple-100 text-purple-700',
    },
  };
  return map[taskType] || {
    title: 'Other',
    icon: 'notifications',
    cls: 'bg-slate-50 border-slate-200 text-slate-700',
    chip: 'bg-slate-100 text-slate-600',
  };
}

function formatDueDate(dueDate) {
  if (!dueDate) return '';
  const dt = new Date(dueDate);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderNotificationsPopup() {
  const body = document.getElementById('notifications-popup-body');
  if (!body) return;

  if (!pendingTasksCache.length) {
    body.innerHTML = "<p class=\"text-slate-500\">You're all caught up. No submissions pending.</p>";
    return;
  }

  const grouped = { self: [], reviewer: [], partner: [], other: [] };
  pendingTasksCache.forEach((task) => {
    const key = Object.prototype.hasOwnProperty.call(grouped, task.taskType) ? task.taskType : 'other';
    grouped[key].push(task);
  });

  const all = ['self', 'reviewer', 'partner', 'other']
    .filter(key => grouped[key].length)
    .map((key) => {
      const items = grouped[key];
      const meta = notificationGroupMeta(key);
      return `
      <section class="space-y-2">
        <div class="flex items-center justify-between px-3 py-2 rounded-xl border ${meta.cls}">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-base">${meta.icon}</span>
            <span class="font-semibold text-sm">${meta.title}</span>
          </div>
          <span class="px-2 py-0.5 rounded-full text-xs font-bold ${meta.chip}">${items.length}</span>
        </div>
        <div class="space-y-2">
          ${items.map((task) => {
            const due = formatDueDate(task.dueDate);
            return `
            <article class="p-3 rounded-xl border border-slate-200 bg-white">
              <p class="text-slate-800 font-medium leading-relaxed">${notificationMessage(task)}</p>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span class="font-mono">${task.ref || `#APR-${task.id}`}</span>
                ${due ? `<span>Due ${due}</span>` : ''}
                <span class="truncate max-w-[100%]">${task.title || ''}</span>
              </div>
            </article>`;
          }).join('')}
        </div>
      </section>`;
    }).join('');

  const total = pendingTasksCache.length;
  body.innerHTML = `
    <div class="mb-3 p-3 rounded-xl bg-slate-50 border border-slate-200">
      <p class="text-sm font-semibold text-slate-800">${total} pending notification${total === 1 ? '' : 's'}</p>
      <p class="text-xs text-slate-500 mt-0.5">Please complete the items below in Appraisify.</p>
    </div>
    <div class="space-y-4">${all}</div>
  `;
}

function openNotificationsPopup() {
  renderNotificationsPopup();
  const modal = document.getElementById('notifications-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeNotificationsPopup() {
  const modal = document.getElementById('notifications-modal');
  if (modal) modal.classList.add('hidden');
}

document.addEventListener('click', (e) => {
  const modal = document.getElementById('notifications-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (e.target === modal) closeNotificationsPopup();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('notifications-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  closeNotificationsPopup();
});

function taskRow(task) {
  const due = task.dueDate
    ? new Date(task.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  return `
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-6 py-4 hover:bg-slate-50/50 transition-colors">
      <div class="flex items-center gap-4 min-w-0">
        <div class="w-10 h-10 rounded-full ${task.iconCls} flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-base">${task.icon}</span>
        </div>
        <div class="min-w-0">
          <p class="font-semibold text-slate-900 text-sm truncate">${task.title}</p>
          <div class="flex flex-wrap items-center gap-2 mt-0.5">
            <span class="px-2 py-0.5 rounded-full text-xs font-bold ${task.chipCls}">${task.label}</span>
            ${due ? `<span class="text-xs text-slate-400">Due ${due}</span>` : ''}
            <span class="text-xs font-mono text-slate-400">${task.ref}</span>
          </div>
        </div>
      </div>
      <a href="${task.href}?appraisal=${task.id}"
        class="flex items-center justify-center gap-1.5 px-5 py-2 rounded-xl ${task.buttonCls} text-white text-xs font-bold transition-colors shadow-sm shrink-0">
        <span class="material-symbols-outlined text-sm">${task.icon}</span>
        ${task.ctaLabel}
      </a>
    </div>`;
}

// ── Admin employee table ──────────────────────────────────────────────
async function loadEmployeeTable() {
  const tbody = document.getElementById('employee-table');

  // Show loading skeleton while fetching
  tbody.innerHTML = Array(4).fill(0).map(() => `
    <tr>
      <td class="px-4 py-3"><div class="w-4 h-4 bg-slate-200 rounded animate-pulse"></div></td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-full bg-slate-200 animate-pulse shrink-0"></div>
          <div class="space-y-1.5">
            <div class="w-28 h-3 bg-slate-200 rounded animate-pulse"></div>
            <div class="w-20 h-2.5 bg-slate-100 rounded animate-pulse sm:hidden"></div>
          </div>
        </div>
      </td>
      <td class="px-4 py-3 hidden sm:table-cell"><div class="w-24 h-3 bg-slate-200 rounded animate-pulse"></div></td>
      <td class="px-4 py-3 hidden lg:table-cell"><div class="w-20 h-3 bg-slate-200 rounded animate-pulse"></div></td>
      <td class="px-4 py-3"><div class="w-20 h-5 bg-slate-100 rounded-full animate-pulse"></div></td>
      <td class="px-4 py-3"></td>
    </tr>`).join('');

  try {
    // Fetch users, departments, and all deals in parallel
    const categoryId = await BX24App.getCategoryId();
    const [users, departments, deals] = await Promise.all([
      BX24App.getUsers(),
      BX24App.getDepartments(),
      categoryId
        ? BX24App.listDeals({ CATEGORY_ID: categoryId, UF_CRM_SOURCE_APP: 'APPRAISIFY' }, ['ID', 'TITLE', 'STAGE_ID', 'ASSIGNED_BY_ID', 'CLOSEDATE'])
        : Promise.resolve([]),
    ]);

    // Build dept ID → name lookup
    const deptMap = {};
    (departments || []).forEach(d => { deptMap[String(d.ID)] = d.NAME; });

    // Group all deals by employee (newest first), then derive the most relevant deal per employee.
    // Rules for most relevant: active (non-SUBMITTED) beats submitted; newer ID wins ties.
    const allDealsMap = {};
    (deals || []).sort((a, b) => Number(b.ID) - Number(a.ID)).forEach(d => {
      const empId = String(d.ASSIGNED_BY_ID);
      if (!allDealsMap[empId]) allDealsMap[empId] = [];
      allDealsMap[empId].push(d);
    });
    const dealMap = {};
    Object.entries(allDealsMap).forEach(([empId, empDeals]) => {
      dealMap[empId] = empDeals.find(d => shortStageId(d.STAGE_ID) !== 'SUBMITTED') ?? empDeals[0];
    });

    // Populate stats cards
    const activeCount  = Object.values(dealMap).filter(d => shortStageId(d.STAGE_ID) !== 'SUBMITTED').length;
    const pendingCount = Object.values(dealMap).filter(d => {
      const s = shortStageId(d.STAGE_ID);
      return s === 'REVIEWERPENDING' || s === 'PARTNERPENDING';
    }).length;
    const completeCount = Object.values(allDealsMap)
      .filter(empDeals => empDeals.some(d => shortStageId(d.STAGE_ID) === 'SUBMITTED')).length;
    const statActive   = document.getElementById('stat-active');
    const statPending  = document.getElementById('stat-pending');
    const statComplete = document.getElementById('stat-complete');
    if (statActive)   statActive.textContent   = activeCount;
    if (statPending)  statPending.textContent   = pendingCount;
    if (statComplete) statComplete.textContent  = completeCount;

    if (!users || !users.length) {
      tbody.innerHTML = `
        <tr><td colspan="5" class="px-6 py-10 text-center text-slate-400 text-sm">
          No employees found in this Bitrix24 instance.
        </td></tr>`;
      return;
    }

    tbody.innerHTML = users.map(u => {
      const fullName = `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim() || 'Unknown';
      const initial = fullName.charAt(0).toUpperCase();
      const deptNames = (u.UF_DEPARTMENT || [])
        .map(id => deptMap[String(id)] || `Dept ${id}`)
        .join(', ') || '—';
      const avatarHtml = u.PERSONAL_PHOTO
        ? `<img src="${u.PERSONAL_PHOTO}" alt="${fullName}" class="w-8 h-8 rounded-full object-cover shrink-0"/>`
        : `<div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm shrink-0">${initial}</div>`;

      const deal = dealMap[String(u.ID)];
      let statusBadge;
      if (deal) {
        const si = STAGE_MAP[shortStageId(deal.STAGE_ID)] || { label: deal.STAGE_ID, cls: 'bg-slate-100 text-slate-500' };
        statusBadge = `<span class="px-2 py-0.5 rounded-full text-xs font-bold ${si.cls}">${si.label}</span>`;
      } else {
        statusBadge = `<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-400">No appraisal</span>`;
      }

      return `
        <tr class="hover:bg-slate-50/50 transition-colors" data-name="${fullName.toLowerCase()}">
          <td class="px-4 py-3">
            <input type="checkbox" value="${u.ID}" onchange="onRowCheck(this)"
              class="rounded border-slate-300 text-primary focus:ring-primary"/>
          </td>
          <td class="px-4 py-3">
            <div class="flex items-center gap-3">
              ${avatarHtml}
              <div>
                <span class="font-semibold text-slate-800 text-sm">${fullName}</span>
                <span class="text-xs text-slate-500 block sm:hidden">${u.WORK_POSITION || '—'}</span>
              </div>
            </div>
          </td>
          <td class="px-4 py-3 text-slate-600 text-sm hidden sm:table-cell">${u.WORK_POSITION || '—'}</td>
          <td class="px-4 py-3 text-slate-500 text-sm hidden lg:table-cell">${deptNames}</td>
          <td class="px-4 py-3">${statusBadge}</td>
        </tr>`;
    }).join('');

    renderHistoryTable(allDealsMap, users, deptMap);

  } catch (err) {
    console.error('[Appraisify] Failed to load employees:', err);
    tbody.innerHTML = `
      <tr><td colspan="5" class="px-6 py-10 text-center">
        <p class="text-slate-500 text-sm mb-3">Failed to load employee list.</p>
        <button onclick="loadEmployeeTable()"
          class="px-4 py-2 bg-primary text-white rounded-lg text-xs font-bold hover:bg-primary/90 transition-colors">
          Retry
        </button>
      </td></tr>`;
  }
}

function renderHistoryTable(allDealsMap, users, deptMap) {
  const tbody = document.getElementById('history-table');
  if (!tbody) return;

  const userMap = {};
  (users || []).forEach(u => { userMap[String(u.ID)] = u; });

  // Flatten all deals, newest first
  const allDeals = Object.values(allDealsMap).flat()
    .sort((a, b) => Number(b.ID) - Number(a.ID));

  if (!allDeals.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-slate-400 text-sm">No appraisals found.</td></tr>`;
    return;
  }

  tbody.innerHTML = allDeals.map(d => {
    const u = userMap[String(d.ASSIGNED_BY_ID)];
    const fullName = u ? `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim() || 'Unknown' : `User #${d.ASSIGNED_BY_ID}`;
    const initial = fullName.charAt(0).toUpperCase();
    const avatarHtml = u?.PERSONAL_PHOTO
      ? `<img src="${u.PERSONAL_PHOTO}" alt="${fullName}" class="w-7 h-7 rounded-full object-cover shrink-0"/>`
      : `<div class="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs shrink-0">${initial}</div>`;

    const si = STAGE_MAP[shortStageId(d.STAGE_ID)] || { label: d.STAGE_ID, cls: 'bg-slate-100 text-slate-500' };
    const title = d.TITLE || `Appraisal #${d.ID}`;
    const isComplete = shortStageId(d.STAGE_ID) === 'SUBMITTED';
    const dueDate = d.CLOSEDATE ? new Date(d.CLOSEDATE).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
    const dlBtn = isComplete
      ? `<button onclick="adminDownloadPdf('${d.ID}')" class="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50 transition-colors">
           <span class="material-symbols-outlined text-sm">picture_as_pdf</span> Download
         </button>`
      : '';

    return `
      <tr class="hover:bg-slate-50/50 transition-colors">
        <td class="px-4 py-3">
          <div class="flex items-center gap-2">
            ${avatarHtml}
            <span class="font-medium text-slate-800 text-sm">${fullName}</span>
          </div>
        </td>
        <td class="px-4 py-3 text-slate-700 text-sm">${title}</td>
        <td class="px-4 py-3"><span class="px-2 py-0.5 rounded-full text-xs font-bold ${si.cls}">${si.label}</span></td>
        <td class="px-4 py-3 text-slate-500 text-sm hidden sm:table-cell">${dueDate}</td>
        <td class="px-4 py-3">${dlBtn}</td>
      </tr>`;
  }).join('');
}

function switchAdminTab(tab) {
  const isEmployees = tab === 'employees';
  document.getElementById('tab-employees').classList.toggle('hidden', !isEmployees);
  document.getElementById('tab-history').classList.toggle('hidden', isEmployees);
  document.getElementById('tab-employees-controls').classList.toggle('hidden', !isEmployees);
  document.getElementById('selection-bar').classList.toggle('hidden', !isEmployees || !selectedEmployees.size);

  const btnEmp  = document.getElementById('tab-btn-employees');
  const btnHist = document.getElementById('tab-btn-history');
  btnEmp.className  = isEmployees
    ? 'px-4 py-2 text-sm font-semibold rounded-lg bg-primary/10 text-primary transition-colors'
    : 'px-4 py-2 text-sm font-semibold rounded-lg text-slate-500 hover:bg-slate-100 transition-colors';
  btnHist.className = isEmployees
    ? 'px-4 py-2 text-sm font-semibold rounded-lg text-slate-500 hover:bg-slate-100 transition-colors'
    : 'px-4 py-2 text-sm font-semibold rounded-lg bg-primary/10 text-primary transition-colors';
}

function adminDownloadPdf(dealId) {
  const params = new URLSearchParams({ appraisal: String(dealId) });
  const current = new URLSearchParams(window.location.search);
  const domain = current.get('DOMAIN') || current.get('domain') || BX24App.getDomain() || '';
  if (domain) params.set('domain', domain);
  window.open(`appraisal-report-preview.html?${params.toString()}`, '_blank');
}

function onRowCheck(cb) {
  if (cb.checked) selectedEmployees.add(cb.value);
  else selectedEmployees.delete(cb.value);
  updateSelectionUI();
}

function toggleAll(masterCb) {
  document.querySelectorAll('#employee-table input[type=checkbox]').forEach(cb => {
    cb.checked = masterCb.checked;
    if (masterCb.checked) selectedEmployees.add(cb.value);
    else selectedEmployees.delete(cb.value);
  });
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = selectedEmployees.size;
  const bar = document.getElementById('selection-bar');
  const btn = document.getElementById('btn-start');
  document.getElementById('sel-count').textContent = n;
  bar.classList.toggle('hidden', n === 0);
  if (btn) btn.disabled = n === 0;
}

function filterEmployees() {
  const q = document.getElementById('emp-search').value.toLowerCase();
  document.querySelectorAll('#employee-table tr').forEach(row => {
    row.style.display = row.dataset.name?.includes(q) ? '' : 'none';
  });
}

function startAppraisal() {
  if (!selectedEmployees.size) return;
  sessionStorage.setItem('selectedEmployees', JSON.stringify([...selectedEmployees]));
  window.location.href = 'appraisal-start.html';
}

// ── Deal card configuration ───────────────────────────────────────────
async function applyDealCardConfig() {
  const categoryId = await BX24App.getCategoryId();
  if (!categoryId) { alert('Pipeline not found. Please reinstall the app.'); return; }
  const pad2 = n => String(n).padStart(2, '0');
  const responseElements = [];
  ['REVIEWEE', 'REVIEWER', 'PARTNER'].forEach(actor => {
    for (let i = 1; i <= 20; i += 1) {
      responseElements.push({ name: `UF_CRM_QUESTION_${i}_${actor}_RATING` });
      responseElements.push({ name: `UF_CRM_QUESTION_${i}_${actor}_COMMENT` });
    }
  });

  try {
    await BX24App.call('crm.deal.details.configuration.set', {
      scope: 'C',
      extras: { dealCategoryId: Number(categoryId) },
      data: [{
        name: 'main', title: 'Appraisal', type: 'section',
        elements: [
          { name: 'TITLE' },
          { name: 'STAGE_ID' },
          { name: 'ASSIGNED_BY_ID' },
          { name: 'UF_CRM_REVIEWEE' },
          { name: 'UF_CRM_REVIEWER' },
          { name: 'UF_CRM_PARTNER' },
          { name: 'CLOSEDATE' },
          { name: 'COMMENTS' },
        ].concat(responseElements)
      }]
    });
    showToast('Deal card fields configured.');
  } catch (e) {
    alert('Configuration failed: ' + e);
  }
}

// ── Toast helper ──────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 4000);
}
