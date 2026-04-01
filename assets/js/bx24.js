/**
 * Appraisify – BX24 SDK Wrapper
 * Provides a promise-based API around the Bitrix24 JS SDK.
 * Falls back to mock data when running outside of a Bitrix24 frame (local dev).
 *
 * Supports two CRM storage modes, selected at install time:
 *   'deal' — standard CRM Deal pipeline (crm.deal.*)
 *   'spa'  — Smart Process Automation entity (crm.item.*, crm.type.*)
 *
 * All public functions (createDeal, updateDeal, getDeal, listDeals) work
 * identically in both modes — callers never need to know which is active.
 * Field translation between UPPERCASE Deal format and camelCase SPA format
 * is handled internally by _dealToSpaFields() and _spaRecordToDealFormat().
 *
 * NOTE: _spaRecordToDealFormat() has a server-side counterpart in
 * api/_lib/bitrix.js (normalizeSpaItemToDeal). Keep the field mappings
 * in both files in sync when adding new custom fields.
 */

const BX24App = (() => {
  const DEV_MODE = !!window.__DEV_ROLE__ || !!localStorage.getItem('__appraisify_dev_role__');
  const MAX_Q_PER_PHASE = 20;
  const PHASE_CODES = ['S', 'R', 'P'];
  const RESPONSE_FIELDS_CACHE_KEY = 'appraisify_response_fields_ready_v2';
  const DEAL_CARD_CONFIG_CACHE_KEY = 'appraisify_deal_card_configured_v1';

  // ── Mock data for local development ──────────────────────────────────
  const MOCK_USER = {
    ID: '1',
    NAME: 'Alex Rivera',
    LAST_NAME: '',
    EMAIL: 'alex@example.com',
    PERSONAL_PHOTO: '',
    APP_ROLE: localStorage.getItem('__appraisify_dev_role__') || window.__DEV_ROLE__ || 'admin',
  };

  const MOCK_DEPARTMENTS = [
    { ID: '1', NAME: 'Engineering' },
    { ID: '2', NAME: 'Marketing' },
    { ID: '3', NAME: 'Operations' },
  ];

  const MOCK_USERS = [
    { ID: '2', NAME: 'Jordan', LAST_NAME: 'Lee', WORK_POSITION: 'Product Designer', UF_DEPARTMENT: [1], PERSONAL_PHOTO: '' },
    { ID: '3', NAME: 'Sam', LAST_NAME: 'Patel', WORK_POSITION: 'Frontend Developer', UF_DEPARTMENT: [1], PERSONAL_PHOTO: '' },
    { ID: '4', NAME: 'Morgan', LAST_NAME: 'Kim', WORK_POSITION: 'Marketing Manager', UF_DEPARTMENT: [2], PERSONAL_PHOTO: '' },
    { ID: '5', NAME: 'Taylor', LAST_NAME: 'Brooks', WORK_POSITION: 'QA Engineer', UF_DEPARTMENT: [1], PERSONAL_PHOTO: '' },
    { ID: '6', NAME: 'Casey', LAST_NAME: 'Wong', WORK_POSITION: 'DevOps Lead', UF_DEPARTMENT: [1, 3], PERSONAL_PHOTO: '' },
  ];

  const MOCK_DEALS = [
    { ID: 'dev-1', TITLE: 'Alex Rivera – Annual Q4 2024', STAGE_ID: 'APPRAISIFY_RVWEE', ASSIGNED_BY_ID: '1', UF_CRM_APR_REVIEWER: '2', UF_CRM_APR_PARTNER: '3', CLOSEDATE: '2025-01-31' },
    { ID: 'dev-2', TITLE: 'Jordan Lee – Annual Q4 2024', STAGE_ID: 'APPRAISIFY_RVWR', ASSIGNED_BY_ID: '2', UF_CRM_APR_REVIEWER: '1', UF_CRM_APR_PARTNER: '3', CLOSEDATE: '2025-01-31' },
    { ID: 'dev-3', TITLE: 'Sam Patel – Annual Q4 2024', STAGE_ID: 'APPRAISIFY_PART', ASSIGNED_BY_ID: '3', UF_CRM_APR_REVIEWER: '4', UF_CRM_APR_PARTNER: '1', CLOSEDATE: '2025-01-31' },
    { ID: 'dev-4', TITLE: 'Morgan Kim – Annual Q4 2024', STAGE_ID: 'APPRAISIFY_INIT', ASSIGNED_BY_ID: '4', UF_CRM_APR_REVIEWER: '2', UF_CRM_APR_PARTNER: '5', CLOSEDATE: '2025-01-31' },
    { ID: 'dev-5', TITLE: 'Taylor Brooks – Annual Q4 2024', STAGE_ID: 'APPRAISIFY_DONE', ASSIGNED_BY_ID: '5', UF_CRM_APR_REVIEWER: '6', UF_CRM_APR_PARTNER: '2', CLOSEDATE: '2025-01-31' },
  ];

  // ── Core helpers ──────────────────────────────────────────────────────
  function init(callback) {
    if (DEV_MODE) { console.info('[BX24App] Dev mode – BX24 SDK not present.'); callback(); return; }
    BX24.init(callback);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function getResponseFieldSpecs() {
    const specs = [];
    const labels = { S: 'Self', R: 'Reviewer', P: 'Partner' };
    PHASE_CODES.forEach(code => {
      for (let i = 1; i <= MAX_Q_PER_PHASE; i += 1) {
        const idx = pad2(i);
        specs.push({
          FIELD_NAME: `APR_S_${code}${idx}`,
          USER_TYPE_ID: 'double',
          LABEL: `Appraisify ${labels[code]} Score Q${i}`,
          SETTINGS: { PRECISION: 2 },
        });
        specs.push({
          FIELD_NAME: `APR_C_${code}${idx}`,
          USER_TYPE_ID: 'string',
          LABEL: `Appraisify ${labels[code]} Comment Q${i}`,
        });
      }
    });
    return specs;
  }

  function getResponseDealCardElements() {
    const elements = [];
    PHASE_CODES.forEach(code => {
      for (let i = 1; i <= MAX_Q_PER_PHASE; i += 1) {
        const idx = pad2(i);
        elements.push({ name: `UF_CRM_APR_S_${code}${idx}` });
        elements.push({ name: `UF_CRM_APR_C_${code}${idx}` });
      }
    });
    return elements;
  }

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (DEV_MODE) { resolve({}); return; }
      BX24.callMethod(method, params, (result) => {
        if (result.error()) {
          const e = result.error();
          console.error('[BX24App] Error in', method,
            '| code:', e && e.ex && e.ex.error,
            '| desc:', e && e.ex && e.ex.error_description,
            '| raw:', e);
          reject(e);
        } else resolve(result.data());
      });
    });
  }

  function callAll(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (DEV_MODE) { resolve([]); return; }
      const allData = [];
      BX24.callMethod(method, params, function handler(result) {
        if (result.error()) { reject(result.error()); return; }
        allData.push(...result.data());
        if (result.more()) {
          result.next();
        } else {
          resolve(allData);
        }
      });
    });
  }

  function _appendParams(fd, obj, prefix) {
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => _appendParams(fd, v, `${prefix}[${i}]`));
    } else if (obj !== null && typeof obj === 'object') {
      Object.entries(obj).forEach(([k, v]) => _appendParams(fd, v, prefix ? `${prefix}[${k}]` : k));
    } else if (obj !== undefined && obj !== null) {
      fd.append(prefix, String(obj));
    }
  }

  async function callAsCurrentUser(method, params = {}) {
    const auth = BX24.getAuth();
    const domain = String(auth.domain || '').split('/')[0].toLowerCase();
    const fd = new URLSearchParams();
    fd.append('auth', auth.access_token);
    Object.entries(params).forEach(([k, v]) => _appendParams(fd, v, k));

    const resp = await fetch(`https://${domain}/rest/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fd.toString(),
    });
    const json = await resp.json();
    if (json.error) {
      const err = new Error(json.error_description || json.error);
      err.code = json.error;
      throw err;
    }
    return json.result;
  }

  async function callAllAsCurrentUser(method, params = {}) {
    if (DEV_MODE) return [];
    const all = [];
    let start = 0;
    for (;;) {
      const auth = BX24.getAuth();
      const domain = String(auth.domain || '').split('/')[0].toLowerCase();
      const fd = new URLSearchParams();
      fd.append('auth', auth.access_token);
      fd.append('start', String(start));
      Object.entries(params).forEach(([k, v]) => _appendParams(fd, v, k));

      const resp = await fetch(`https://${domain}/rest/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: fd.toString(),
      });
      const json = await resp.json();
      if (!resp.ok || json.error) {
        console.error('[BX24App] callAllAsCurrentUser error in', method,
          '| HTTP:', resp.status,
          '| body:', JSON.stringify(json));
        const err = new Error(json.error_description || json.error || `HTTP ${resp.status}`);
        err.code = json.error || `HTTP_${resp.status}`;
        throw err;
      }
      if (Array.isArray(json.result)) all.push(...json.result);
      if (!json.next) break;
      start = json.next;
    }
    return all;
  }

  async function getUser() {
    if (DEV_MODE) return MOCK_USER;
    const [data, isAdmin] = await Promise.all([
      call('user.current'),
      call('user.admin'),
    ]);
    data.APP_ROLE = isAdmin ? 'admin' : 'employee';
    return data;
  }

  async function getUsers() {
    if (DEV_MODE) return MOCK_USERS;
    return callAll('user.get', {
      ACTIVE: true,
      USER_TYPE: 'employee',
      select: ['ID', 'NAME', 'LAST_NAME', 'WORK_POSITION', 'UF_DEPARTMENT', 'PERSONAL_PHOTO'],
    });
  }

  async function getDepartments() {
    if (DEV_MODE) return MOCK_DEPARTMENTS;
    return callAll('department.get');
  }

  // ── Mode helpers ──────────────────────────────────────────────────────

  /**
   * Returns the current CRM storage mode: 'deal' or 'spa'.
   * Reads from BX24 appOption (set during install). Defaults to 'deal'.
   */
  function getMode() {
    if (DEV_MODE) return 'deal';
    return BX24.appOption.get('crm_mode') || 'deal';
  }

  /**
   * Returns the SPA entity type ID stored during install, or null.
   * Checks appOption first, then localStorage as fallback.
   */
  async function getEntityTypeId() {
    if (DEV_MODE) return null;
    const fromOptions = BX24.appOption.get('entity_type_id');
    if (fromOptions) {
      const id = String(fromOptions);
      try { localStorage.setItem('appraisify_entity_type_id', id); } catch (_) {}
      return id;
    }
    const cached = localStorage.getItem('appraisify_entity_type_id');
    if (cached) return cached;
    return null;
  }

  /**
   * Returns the SPA default category ID stored during install, or null.
   * Needed to build the full stage ID format: DT{entityTypeId}_{categoryId}:{STATUS_ID}
   */
  async function getSpaCategoryId() {
    if (DEV_MODE) return null;
    const fromOptions = BX24.appOption.get('spa_category_id');
    if (fromOptions) {
      const id = String(fromOptions);
      try { localStorage.setItem('appraisify_spa_category_id', id); } catch (_) {}
      return id;
    }
    const cached = localStorage.getItem('appraisify_spa_category_id');
    if (cached) return cached;
    return null;
  }

  /**
   * Returns the SPA small type ID (type.id from crm.type.add) stored during install, or null.
   * This is the ID used as the entityId prefix in userfieldconfig.*:
   *   entityId: 'CRM_{typeId}', fieldName: 'UF_CRM_{typeId}_...'
   * Distinct from entityTypeId (large number) which is used for crm.item.* routing.
   */
  async function getSpaTypeId() {
    if (DEV_MODE) return null;
    const fromOptions = BX24.appOption.get('spa_type_id');
    if (fromOptions) {
      const id = String(fromOptions);
      try { localStorage.setItem('appraisify_spa_type_id', id); } catch (_) {}
      return id;
    }
    const cached = localStorage.getItem('appraisify_spa_type_id');
    if (cached) return cached;
    return null;
  }

  /**
   * Returns entity context for the current mode.
   * Deal mode: { mode: 'deal', categoryId }
   * SPA mode:  { mode: 'spa',  entityTypeId, typeId, categoryId }
   *   entityTypeId — large number used for crm.item.* routing and stage IDs
   *   typeId       — small number used for userfieldconfig entityId and field name prefix
   */
  async function _getEntityContext() {
    const mode = getMode();
    if (mode === 'spa') {
      const entityTypeId = await getEntityTypeId();
      const typeId       = await getSpaTypeId();
      const categoryId   = await getSpaCategoryId();
      return { mode: 'spa', entityTypeId, typeId, categoryId };
    }
    const categoryId = await getCategoryId();
    return { mode: 'deal', categoryId };
  }

  /**
   * Translates a Deal-format fields object (UPPERCASE keys) into the
   * camelCase SPA format expected by crm.item.add / crm.item.update / crm.item.list.
   *
   * Mapping:
   *   TITLE            → title
   *   ASSIGNED_BY_ID   → assignedById
   *   CLOSEDATE        → closeDate
   *   COMMENTS         → comments
   *   STAGE_ID         → stageId  (strips C{n}: prefix if present)
   *   CATEGORY_ID      → (omitted — scoping is via entityTypeId param)
   *   UF_CRM_APR_*     → ufCrm{typeId}Apr* (lowercase remainder)
   *
   * Any unrecognised key is passed through as-is.
   *
   * NOTE: server-side counterpart is normalizeSpaItemToDeal() in
   * api/_lib/bitrix.js. Keep mappings in sync.
   *
   * @param {object} fields        - UPPERCASE Deal-format fields
   * @param {string} entityTypeId  - large SPA type ID (e.g. '1242'), used for stage IDs
   * @param {string} typeId        - small SPA type ID (e.g. '16'), used for field name prefix
   * @param {string} categoryId    - SPA default category ID, used for stage IDs
   */
  function _dealToSpaFields(fields, entityTypeId, typeId, categoryId) {
    const STATIC_MAP = {
      TITLE:          'title',
      ASSIGNED_BY_ID: 'assignedById',
      CLOSEDATE:      'closeDate',
      COMMENTS:       'comments',
    };
    const out = {};
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'CATEGORY_ID') continue; // scoped by entityTypeId, not a field

      if (STATIC_MAP[key]) {
        out[STATIC_MAP[key]] = val;
        continue;
      }

      if (key === 'STAGE_ID') {
        // Strip deal pipeline prefix: 'C47:APPRAISIFY_RVWEE' → 'APPRAISIFY_RVWEE'
        const bare = String(val).includes(':') ? String(val).split(':')[1] : String(val);
        // Prepend full SPA stage prefix: 'DT1242_194:APPRAISIFY_RVWEE'
        out.stageId = categoryId ? `DT${entityTypeId}_${categoryId}:${bare}` : bare;
        continue;
      }

      if (key.startsWith('UF_CRM_')) {
        // 'UF_CRM_APR_REVIEWER' with typeId=16
        //   → strip 'UF_CRM_' → 'APR_REVIEWER'
        //   → lowercase        → 'apr_reviewer'
        //   → remove underscores, camelCase → 'aprReviewer'
        //   → prefix with typeId → 'ufCrm16AprReviewer'
        const suffix = key.slice('UF_CRM_'.length); // e.g. 'APR_REVIEWER'
        const camel  = suffix
          .toLowerCase()
          .replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()); // 'aprReviewer'
        out[`ufCrm${typeId}${camel.charAt(0).toUpperCase()}${camel.slice(1)}`] = val;
        // → 'ufCrm16AprReviewer'
        continue;
      }

      out[key] = val; // pass unknown keys through unchanged
    }
    return out;
  }

  /**
   * Normalises a crm.item.* response record back to UPPERCASE Deal format
   * so all callers (dashboard.js, appraisal.js, appraisal-pdf.js) work
   * without modification regardless of CRM mode.
   *
   * NOTE: server-side counterpart is normalizeSpaItemToDeal() in
   * api/_lib/bitrix.js. Keep mappings in sync.
   *
   * @param {object} item    - raw crm.item response object
   * @param {string} typeId  - small SPA type ID (e.g. '16'), used for field name prefix
   */
  function _spaRecordToDealFormat(item, typeId) {
    if (!item) return null;
    const STATIC_MAP = {
      id:           'ID',
      title:        'TITLE',
      stageId:      'STAGE_ID',
      assignedById: 'ASSIGNED_BY_ID',
      closeDate:    'CLOSEDATE',
      comments:     'COMMENTS',
    };
    const out = {};
    const ufPrefix = `ufCrm${typeId}`;

    for (const [key, val] of Object.entries(item)) {
      if (STATIC_MAP[key]) {
        out[STATIC_MAP[key]] = val;
        continue;
      }
      if (key.startsWith(ufPrefix)) {
        // 'ufCrm16AprReviewer' → 'APR_REVIEWER' → 'UF_CRM_APR_REVIEWER'
        const suffix = key.slice(ufPrefix.length); // 'AprReviewer'
        const snake  = suffix
          .replace(/([A-Z])/g, '_$1')
          .toUpperCase()
          .replace(/^_/, ''); // 'APR_REVIEWER'
        out[`UF_CRM_${snake}`] = val;
        continue;
      }
      out[key] = val; // preserve any other keys
    }
    return out;
  }

  // ── CRM Deal helpers ──────────────────────────────────────────────────

  /**
   * Returns the Appraisify pipeline category ID (Deal mode).
   * In SPA mode returns the sentinel string 'spa' so callers that build
   * stage prefixes (C{n}:STAGE) still work — _dealToSpaFields strips the prefix.
   * @returns {Promise<string|null>}
   */
  async function getCategoryId() {
    if (DEV_MODE) return 'dev';

    // Return sentinel when in SPA mode so stage-prefix logic still runs
    // in callers without needing changes there.
    if (getMode() === 'spa') return 'spa';

    // 1. BX24 app options — shared across ALL users, updated by every install.
    const fromOptions = BX24.appOption.get('category_id');
    if (fromOptions) {
      const id = String(fromOptions);
      console.log('[BX24App] getCategoryId: from appOption →', id);
      localStorage.setItem('appraisify_category_id', id);
      return id;
    }

    // 2. localStorage cache
    const cached = localStorage.getItem('appraisify_category_id');
    if (cached) {
      console.log('[BX24App] getCategoryId: from localStorage →', cached);
      return cached;
    }

    // 3. System proxy fallback
    try {
      const result = await callAsSystem('crm.category.list', { entityTypeId: 2 });
      const categories = (result && result.categories) ? result.categories : [];
      const found = categories.find(c => (c.NAME || c.name) === 'Appraisify Testing');
      if (found) {
        const id = String(found.ID || found.id);
        localStorage.setItem('appraisify_category_id', id);
        return id;
      }
    } catch (e) {
      console.warn('[BX24App] getCategoryId: crm.category.list via proxy failed:', e);
    }

    return null;
  }

  async function callAsSystem(method, params = {}) {
    if (DEV_MODE) {
      console.log('[BX24App DEV] callAsSystem:', method, params);
      return {};
    }

    const urlParams = new URLSearchParams(window.location.search);
    let domain = (urlParams.get('DOMAIN') || urlParams.get('domain') || '').split('/')[0].toLowerCase().trim();
    let member_id = '';

    if (typeof BX24 !== 'undefined' && BX24.getAuth) {
      try {
        const auth = BX24.getAuth();
        if (!domain && auth && auth.domain) domain = String(auth.domain).split('/')[0].toLowerCase().trim();
        if (auth && auth.member_id) member_id = String(auth.member_id);
      } catch (_) {}
    }

    const resp = await fetch('/api/bx-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params, domain, member_id }),
    });
    const json = await resp.json();
    if (json.error) {
      console.error('[BX24App] callAsSystem error in', method, '| code:', json.error, '| desc:', json.error_description);
      const err = new Error(json.error_description || json.error || 'Bitrix24 call failed');
      err.code = json.error || 'BX24_ERROR';
      err.description = json.error_description || '';
      throw err;
    }
    return json.result;
  }

  async function listDealUserFields() {
    if (DEV_MODE) return [];
    const data = await callAsSystem('crm.deal.userfield.list', {});
    return Array.isArray(data) ? data : [];
  }

  async function listSpaUserFields(entityTypeId, typeId) {
    if (DEV_MODE) return [];
    const data = await callAsSystem('userfieldconfig.list', {
      moduleId: 'crm',
      filter: { entityId: `CRM_${typeId}` },
    });
    const raw = Array.isArray(data) ? data : [];
    // Normalize FIELD_NAME to match spec keys (e.g. 'APR_S_S01').
    // Bitrix24 stores SPA fields as 'UF_CRM_{typeId}_{FIELD_NAME}'.
    return raw.map(f => ({
      ...f,
      FIELD_NAME: (f.fieldName || f.FIELD_NAME || '')
        .toUpperCase()
        .replace(new RegExp(`^UF_CRM_${typeId}_`), '')
        .replace(/^UF_CRM_/, ''),
    }));
  }

  async function addDealUserField(fields) {
    if (DEV_MODE) return true;
    return callAsSystem('crm.deal.userfield.add', { fields });
  }

  async function addSpaUserField(spec, entityTypeId, typeId) {
    if (DEV_MODE) return true;
    return callAsSystem('userfieldconfig.add', {
      moduleId: 'crm',
      field: {
        entityId:      `CRM_${typeId}`,
        fieldName:     `UF_CRM_${typeId}_${spec.FIELD_NAME}`,
        userTypeId:    spec.USER_TYPE_ID,
        editFormLabel: { en: spec.LABEL || spec.FIELD_NAME },
        settings:      spec.SETTINGS || {},
      },
    });
  }

  async function updateDealUserField(id, fields) {
    if (DEV_MODE) return true;
    return callAsSystem('crm.deal.userfield.update', { id: Number(id), fields });
  }

  function normalizedFieldName(name) {
    return String(name || '').replace(/^UF_CRM_/i, '').toUpperCase();
  }

  function getFieldPrecision(field) {
    const settings = field && typeof field === 'object' ? (field.SETTINGS || field.settings || {}) : {};
    const raw = settings.PRECISION ?? settings.precision ?? field?.PRECISION ?? field?.precision;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  }

  async function ensureAppraisalResponseFields() {
    if (DEV_MODE) return true;
    if (sessionStorage.getItem(RESPONSE_FIELDS_CACHE_KEY) === '1') return true;

    const ctx = await _getEntityContext();
    const required = getResponseFieldSpecs();

    // Fetch existing fields for the relevant entity
    let existing;
    if (ctx.mode === 'spa') {
      existing = await listSpaUserFields(ctx.entityTypeId, ctx.typeId);
    } else {
      existing = await listDealUserFields();
    }

    const existingNames   = new Set(existing.map(f => normalizedFieldName(f.FIELD_NAME)));
    const existingByName  = new Map(existing.map(f => [normalizedFieldName(f.FIELD_NAME), f]));

    try {
      for (const spec of required) {
        if (existingNames.has(spec.FIELD_NAME)) {
          // Only attempt precision update for Deal mode — SPA fields are set correctly at install time
          if (spec.USER_TYPE_ID === 'double' && ctx.mode !== 'spa') {
            const existingField    = existingByName.get(spec.FIELD_NAME);
            const currentPrecision = getFieldPrecision(existingField);
            if (currentPrecision !== 2) {
              const fieldId = existingField && (existingField.ID || existingField.id);
              if (fieldId) {
                await updateDealUserField(fieldId, {
                  SETTINGS: { ...(existingField.SETTINGS || {}), PRECISION: 2 },
                });
              }
            }
          }
          continue;
        }
        try {
          if (ctx.mode === 'spa') {
            await addSpaUserField(spec, ctx.entityTypeId, ctx.typeId);
          } else {
            await addDealUserField(spec);
          }
          existingNames.add(spec.FIELD_NAME);
        } catch (e) {
          const msg = String(
            (e && (e.description || e.message || e.code)) || e || ''
          ).toLowerCase();
          if (msg.includes('duplicate') || msg.includes('exists') || msg.includes('already')) {
            existingNames.add(spec.FIELD_NAME);
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      sessionStorage.removeItem(RESPONSE_FIELDS_CACHE_KEY);
      throw e;
    }

    sessionStorage.setItem(RESPONSE_FIELDS_CACHE_KEY, '1');
    return true;
  }

  async function ensureDealCardConfig() {
    if (DEV_MODE) return true;

    // SPA entities don't use crm.deal.details.configuration.set
    if (getMode() === 'spa') return true;

    if (sessionStorage.getItem(DEAL_CARD_CONFIG_CACHE_KEY) === '1') return true;

    const categoryId = await getCategoryId();
    if (!categoryId) throw new Error('No appraisal pipeline category found');

    await callAsSystem('crm.deal.details.configuration.set', {
      scope: 'C',
      extras: { dealCategoryId: Number(categoryId) },
      data: [{
        name: 'main',
        title: 'Appraisal',
        type: 'section',
        elements: [
          { name: 'TITLE' },
          { name: 'STAGE_ID' },
          { name: 'ASSIGNED_BY_ID' },
          { name: 'UF_CRM_APR_REVIEWER' },
          { name: 'UF_CRM_APR_PARTNER' },
          { name: 'CLOSEDATE' },
          { name: 'COMMENTS' },
          ...getResponseDealCardElements(),
        ],
      }],
    });

    sessionStorage.setItem(DEAL_CARD_CONFIG_CACHE_KEY, '1');
    return true;
  }

  /**
   * Creates a new appraisal record (Deal or SPA item).
   * @param {object} fields - UPPERCASE Deal-format fields
   * @returns {Promise<string>} - new record ID
   */
  async function createDeal(fields) {
    if (DEV_MODE) {
      const id = 'DEV-' + Date.now();
      console.log('[BX24App DEV] createDeal:', fields, '→ ID:', id);
      return id;
    }

    const ctx = await _getEntityContext();

    if (ctx.mode === 'spa') {
      const spaFields = _dealToSpaFields(fields, ctx.entityTypeId, ctx.typeId, ctx.categoryId);
      console.log('[BX24App] createDeal (SPA) entityTypeId:', ctx.entityTypeId, 'typeId:', ctx.typeId, 'fields:', spaFields);
      // Use current user's token — admins always have rights on items they create
      const result = await callAsCurrentUser('crm.item.add', {
        entityTypeId: Number(ctx.entityTypeId),
        fields: spaFields,
      });
      // crm.item.add returns { item: { id, ... } }
      return String(result && result.item ? result.item.id : result);
    }

    // Deal mode — use BX24.callMethod directly (admin context avoids CATEGORY_ID issues)
    return new Promise((resolve, reject) => {
      BX24.callMethod('crm.deal.add', { fields }, function(result) {
        if (result.error()) {
          reject(result.error());
        } else {
          resolve(result.data());
        }
      });
    });
  }

  /**
   * Updates an appraisal record's fields (e.g. advance stage, save responses).
   * Uses the system token so reviewers/partners can update deals they don't own.
   * @param {string|number} id
   * @param {object} fields - UPPERCASE Deal-format fields
   */
  async function updateDeal(id, fields) {
    if (DEV_MODE) {
      console.log('[BX24App DEV] updateDeal:', id, fields);
      return true;
    }

    const ctx = await _getEntityContext();

    if (ctx.mode === 'spa') {
      const spaFields = _dealToSpaFields(fields, ctx.entityTypeId, ctx.typeId, ctx.categoryId);
      console.log('[BX24App] updateDeal (SPA) id:', id, 'entityTypeId:', ctx.entityTypeId, 'typeId:', ctx.typeId, 'fields:', spaFields);
      return callAsSystem('crm.item.update', {
        entityTypeId: Number(ctx.entityTypeId),
        id: Number(id),
        fields: spaFields,
      });
    }

    return callAsSystem('crm.deal.update', { id: Number(id), fields });
  }

  /**
   * Fetches a single appraisal record by ID, including all custom fields.
   * Uses the system token so reviewers/partners can read records they don't own.
   * Response is always normalised to UPPERCASE Deal format.
   * @param {string|number} id
   * @returns {Promise<object|null>}
   */
  async function getDeal(id) {
    if (DEV_MODE) {
      return MOCK_DEALS.find(d => String(d.ID) === String(id)) || null;
    }

    const ctx = await _getEntityContext();

    if (ctx.mode === 'spa') {
      const result = await callAsSystem('crm.item.get', {
        entityTypeId: Number(ctx.entityTypeId),
        id: Number(id),
      });
      // crm.item.get returns { item: { ... } }
      const item = result && result.item ? result.item : result;
      return _spaRecordToDealFormat(item, ctx.typeId);
    }

    const result = await callAsSystem('crm.deal.get', { id: Number(id) });
    return result || null;
  }

  /**
   * Lists appraisal records with optional filter and field selection.
   * Paginates automatically. Response is always normalised to UPPERCASE Deal format.
   * @param {object} filter - UPPERCASE Deal-format filter keys
   * @param {Array}  select
   * @returns {Promise<Array>}
   */
  async function listDeals(filter = {}, select = []) {
    if (DEV_MODE) {
      return MOCK_DEALS.filter(d => {
        if (filter.ASSIGNED_BY_ID && String(d.ASSIGNED_BY_ID) !== String(filter.ASSIGNED_BY_ID)) return false;
        if (filter.STAGE_ID && d.STAGE_ID !== filter.STAGE_ID) return false;
        if (filter.UF_CRM_APR_REVIEWER && String(d.UF_CRM_APR_REVIEWER) !== String(filter.UF_CRM_APR_REVIEWER)) return false;
        if (filter.UF_CRM_APR_PARTNER && String(d.UF_CRM_APR_PARTNER) !== String(filter.UF_CRM_APR_PARTNER)) return false;
        return true;
      });
    }

    const ctx = await _getEntityContext();

    if (ctx.mode === 'spa') {
      // Translate filter keys to camelCase; CATEGORY_ID is dropped by _dealToSpaFields
      const spaFilter = _dealToSpaFields(filter, ctx.entityTypeId, ctx.typeId, ctx.categoryId);
      console.log('[BX24App] listDeals (SPA) entityTypeId:', ctx.entityTypeId, 'typeId:', ctx.typeId, 'categoryId:', ctx.categoryId, 'spaFilter:', JSON.stringify(spaFilter));
      const all = [];
      let start = 0;
      for (;;) {
        const result = await callAsSystem('crm.item.list', {
          entityTypeId: Number(ctx.entityTypeId),
          filter: spaFilter,
          select: ['*'],
          start,
        });
        // crm.item.list returns { items: [...] }
        const items = result && Array.isArray(result.items) ? result.items : [];
        console.log('[BX24App] listDeals (SPA) raw items count:', items.length, items.length > 0 ? 'first stageId:' : '', items.length > 0 ? items[0].stageId : '');
        all.push(...items.map(item => _spaRecordToDealFormat(item, ctx.typeId)));
        if (items.length < 50) break;
        start += 50;
      }
      console.log('[BX24App] listDeals (SPA) normalized count:', all.length, all.length > 0 ? 'first STAGE_ID:' : '', all.length > 0 ? all[0].STAGE_ID : '');
      return all;
    }

    // Deal mode
    const all = [];
    let start = 0;
    for (;;) {
      const result = await callAsSystem('crm.deal.list', { filter, select, start });
      const page = Array.isArray(result) ? result : [];
      all.push(...page);
      if (page.length < 50) break;
      start += 50;
    }
    return all;
  }

  function getDomain() {
    const urlParams = new URLSearchParams(window.location.search);
    let domain = (urlParams.get('DOMAIN') || urlParams.get('domain') || '').split('/')[0].toLowerCase().trim();
    if (!domain && typeof BX24 !== 'undefined' && BX24.getAuth) {
      try {
        const auth = BX24.getAuth();
        if (auth && auth.domain) domain = String(auth.domain).split('/')[0].toLowerCase().trim();
      } catch (_) {}
    }
    return domain;
  }

  function resizeFrame(height) {
    if (!DEV_MODE && BX24.resizeWindow) BX24.resizeWindow(800, height || 900);
  }

  function openPath(path) {
    window.location.href = path;
  }

  return {
    init, call, callAll, callAsSystem,
    getUser, getUsers, getDepartments,
    getMode, getEntityTypeId, getSpaTypeId, getSpaCategoryId,
    getCategoryId, createDeal, updateDeal, listDeals, getDeal,
    listDealUserFields, addDealUserField, ensureAppraisalResponseFields, ensureDealCardConfig,
    resizeFrame, openPath, getDomain, DEV_MODE,
  };
})();
