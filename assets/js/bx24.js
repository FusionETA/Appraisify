/**
 * Appraisify – BX24 SDK Wrapper
 * Provides a promise-based API around the Bitrix24 JS SDK.
 * Falls back to mock data when running outside of a Bitrix24 frame (local dev).
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
    // Role reads from localStorage first (set by dev role switcher), then page-level override
    APP_ROLE: localStorage.getItem('__appraisify_dev_role__') || window.__DEV_ROLE__ || 'admin',
  };

  // Mock data matches real Bitrix24 API structure:
  // - NAME / LAST_NAME are separate fields
  // - UF_DEPARTMENT is an array of integer IDs (resolved via department.get)
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

  // Mock deals – simulate a launched appraisal cycle
  // ASSIGNED_BY_ID = employee, UF_CRM_APR_REVIEWER = reviewer, UF_CRM_APR_PARTNER = partner
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
          // Log full error details so we can diagnose 400s
          console.error('[BX24App] Error in', method,
            '| code:', e && e.ex && e.ex.error,
            '| desc:', e && e.ex && e.ex.error_description,
            '| raw:', e);
          reject(e);
        } else resolve(result.data());
      });
    });
  }

  /**
   * Fetches ALL pages of a paginated BX24 REST method.
   * Uses result.more() + result.next() to iterate through 50-record pages.
   * @param {string} method  - e.g. 'user.get', 'department.get'
   * @param {object} params  - filter/select params passed to BX24.callMethod
   * @returns {Promise<Array>} - all records concatenated across all pages
   */
  function callAll(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (DEV_MODE) { resolve([]); return; }
      const allData = [];
      BX24.callMethod(method, params, function handler(result) {
        if (result.error()) { reject(result.error()); return; }
        allData.push(...result.data());
        if (result.more()) {
          result.next(); // same handler fires again for next page
        } else {
          resolve(allData);
        }
      });
    });
  }

  /**
   * Serialises a nested params object into a URLSearchParams instance.
   * Handles nested objects and arrays using bracket notation, e.g.
   *   { filter: { ID: 1 }, select: ['ID'] }
   *   → filter[ID]=1&select[0]=ID
   */
  function _appendParams(fd, obj, prefix) {
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => _appendParams(fd, v, `${prefix}[${i}]`));
    } else if (obj !== null && typeof obj === 'object') {
      Object.entries(obj).forEach(([k, v]) => _appendParams(fd, v, prefix ? `${prefix}[${k}]` : k));
    } else if (obj !== undefined && obj !== null) {
      fd.append(prefix, String(obj));
    }
  }

  /**
   * Makes a single Bitrix24 REST call using the CURRENT USER's session token
   * obtained from BX24.getAuth(). This bypasses both the system proxy (which
   * uses the installer's OAuth token and may have restricted CRM access) and
   * BX24.callMethod (which is subject to the app's declared client-side scopes).
   *
   * The user's own access_token is always valid for deals they are assigned to
   * (employees) or all CRM deals (admins).
   *
   * @param {string} method - Bitrix24 REST method name
   * @param {object} params - method parameters
   * @returns {Promise<any>} - raw Bitrix24 result value
   */
  async function callAsCurrentUser(method, params = {}) {
    const auth = BX24.getAuth();
    const domain = String(auth.domain || '').split('/')[0].toLowerCase();
    const fd = new URLSearchParams();
    fd.append('auth', auth.access_token);
    // Append all nested params in bracket notation
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

  /**
   * Fetches ALL pages of a paginated Bitrix24 REST method using the current
   * user's session token (callAsCurrentUser). Handles the REST API's cursor-
   * based pagination via the `next` field in the response.
   *
   * @param {string} method - Bitrix24 REST method name
   * @param {object} params - method parameters (filter, select, order, etc.)
   * @returns {Promise<Array>}
   */
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
    // Call both in parallel: user.current for profile data, user.admin for role
    const [data, isAdmin] = await Promise.all([
      call('user.current'),
      call('user.admin'),   // returns boolean – true if portal admin
    ]);
    data.APP_ROLE = isAdmin ? 'admin' : 'employee';
    return data;
  }

  /**
   * Retrieves ALL active employees from the Bitrix24 instance (all pages).
   * Scope required: user
   * Returns: [{ ID, NAME, LAST_NAME, WORK_POSITION, UF_DEPARTMENT: [int], PERSONAL_PHOTO }]
   */
  async function getUsers() {
    if (DEV_MODE) return MOCK_USERS;
    return callAll('user.get', {
      ACTIVE: true,
      USER_TYPE: 'employee', // excludes bots, extranet, email, Open Channel users
      select: ['ID', 'NAME', 'LAST_NAME', 'WORK_POSITION', 'UF_DEPARTMENT', 'PERSONAL_PHOTO'],
    });
  }

  /**
   * Retrieves ALL departments from the Bitrix24 instance (all pages).
   * Scope required: department
   * Returns: [{ ID: string, NAME: string, ... }]
   */
  async function getDepartments() {
    if (DEV_MODE) return MOCK_DEPARTMENTS;
    return callAll('department.get');
  }

  // ── CRM Deal helpers ──────────────────────────────────────────────────

  /**
   * Returns the Appraisify pipeline category ID.
   * Checks localStorage cache first; otherwise queries crm.category.list.
   * @returns {Promise<string|null>}
   */
  async function getCategoryId() {
    if (DEV_MODE) return 'dev';

    // 1. BX24 app options — shared across ALL users, updated by every install/reinstall.
    //    Must be checked FIRST so stale localStorage values from old pipelines are overwritten.
    //    BX24.appOption.get() is synchronous after BX24.init() has run.
    const fromOptions = BX24.appOption.get('category_id');
    if (fromOptions) {
      const id = String(fromOptions);
      console.log('[BX24App] getCategoryId: from appOption →', id);
      localStorage.setItem('appraisify_category_id', id);
      return id;
    }

    // 2. localStorage cache — fallback if appOption was not set (e.g. install failed partway)
    const cached = localStorage.getItem('appraisify_category_id');
    if (cached) {
      console.log('[BX24App] getCategoryId: from localStorage →', cached);
      return cached;
    }

    // 3. System proxy fallback — works for ALL users regardless of CRM permissions.
    //    Routes through /api/bx-proxy using the webhook so non-admin users can look
    //    up the pipeline ID without needing CRM admin rights.
    try {
      const result = await callAsSystem('crm.category.list', { entityTypeId: 2 });
      const categories = (result && result.categories) ? result.categories : [];
      // Webhook returns lowercase keys (id, name); BX24 SDK returns uppercase (ID, NAME)
      const found = categories.find(c => (c.NAME || c.name) === 'Appraisify Appraisals');
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

  /**
   * Makes a privileged Bitrix24 API call through the server-side proxy (/api/bx-proxy).
   * Uses the installer's stored OAuth tokens (system user) instead of the current user's
   * session, so operations succeed regardless of the current user's CRM permissions.
   *
   * Allowed methods: crm.deal.add, crm.deal.update, crm.timeline.comment.add
   *
   * @param {string} method - Bitrix24 REST method name
   * @param {object} params - method parameters
   */
  async function callAsSystem(method, params = {}) {
    if (DEV_MODE) {
      console.log('[BX24App DEV] callAsSystem:', method, params);
      return {};
    }

    // Resolve domain and member_id for multi-tenant routing.
    // Bitrix24 passes DOMAIN in the iframe URL query string.
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

  async function addDealUserField(fields) {
    if (DEV_MODE) return true;
    return callAsSystem('crm.deal.userfield.add', { fields });
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

    const existing = await listDealUserFields();
    // crm.deal.userfield.list returns FIELD_NAME with the UF_CRM_ prefix (e.g. "UF_CRM_APR_S_S01"),
    // but getResponseFieldSpecs() uses bare names (e.g. "APR_S_S01"). Strip the prefix so the
    // has() check correctly identifies fields that already exist.
    const existingNames = new Set(existing.map(f => normalizedFieldName(f.FIELD_NAME)));
    const existingByName = new Map(existing.map(f => [normalizedFieldName(f.FIELD_NAME), f]));
    const required = getResponseFieldSpecs();

    try {
      for (const spec of required) {
        if (existingNames.has(spec.FIELD_NAME)) {
          if (spec.USER_TYPE_ID === 'double') {
            const existingField = existingByName.get(spec.FIELD_NAME);
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
          await addDealUserField(spec);
          existingNames.add(spec.FIELD_NAME);
        } catch (e) {
          const msg = String(
            (e && (e.description || e.message || e.code)) || e || ''
          ).toLowerCase();
          // Field may have been created concurrently by another submit.
          if (msg.includes('duplicate') || msg.includes('exists') || msg.includes('already')) {
            existingNames.add(spec.FIELD_NAME);
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      // Clear cache so the next session retries instead of assuming fields are ready.
      sessionStorage.removeItem(RESPONSE_FIELDS_CACHE_KEY);
      throw e;
    }

    sessionStorage.setItem(RESPONSE_FIELDS_CACHE_KEY, '1');
    return true;
  }

  async function ensureDealCardConfig() {
    if (DEV_MODE) return true;
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
   * Creates a new CRM deal.
   * Runs as the system user (installer) so no per-user CRM permissions needed.
   * @param {object} fields - crm.deal.add fields (TITLE, CATEGORY_ID, STAGE_ID, etc.)
   * @returns {Promise<string>} - new deal ID
   */
  async function createDeal(fields) {
    if (DEV_MODE) {
      const id = 'DEV-' + Date.now();
      console.log('[BX24App DEV] createDeal:', fields, '→ ID:', id);
      return id;
    }
    // crm.deal.add is only called by admins (cycle launch), who always have CRM
    // permissions, so we can use BX24.callMethod directly instead of the proxy.
    // This avoids server-to-server issues where Bitrix24 ignores CATEGORY_ID.
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
   * Updates a CRM deal's fields (e.g. advance STAGE_ID).
   * Runs as the system user (installer) so employees/reviewers/partners can advance
   * deal stages without needing CRM edit permissions in Bitrix24.
   * @param {string|number} id - deal ID
   * @param {object} fields    - fields to update
   */
  async function updateDeal(id, fields) {
    if (DEV_MODE) {
      console.log('[BX24App DEV] updateDeal:', id, fields);
      return true;
    }
    // Use the current user's own session token so the deal update is always
    // authorised (employees can always edit deals they are participating in).
    return callAsCurrentUser('crm.deal.update', { id: Number(id), fields });
  }

  /**
   * Fetches a single CRM deal by ID, including all custom UF_CRM_* fields.
   * Runs through the system proxy so non-admin users can read deal data.
   * @param {string|number} id - deal ID
   * @returns {Promise<object|null>}
   */
  async function getDeal(id) {
    if (DEV_MODE) {
      return MOCK_DEALS.find(d => String(d.ID) === String(id)) || null;
    }
    const result = await callAsSystem('crm.deal.get', { id: Number(id) });
    return result || null;
  }

  /**
   * Lists CRM deals with optional filter and field selection (all pages).
   * In DEV_MODE, returns filtered MOCK_DEALS matching ASSIGNED_BY_ID / STAGE_ID /
   * UF_CRM_APR_REVIEWER / UF_CRM_APR_PARTNER from the filter object.
   * @param {object} filter  - crm.deal.list filter params
   * @param {Array}  select  - fields to return (ignored in DEV_MODE)
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
    const result = await callAsSystem('crm.deal.list', { filter, select });
    return Array.isArray(result) ? result : [];
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
    getCategoryId, createDeal, updateDeal, listDeals, getDeal,
    listDealUserFields, addDealUserField, ensureAppraisalResponseFields, ensureDealCardConfig,
    resizeFrame, openPath, getDomain, DEV_MODE,
  };
})();
