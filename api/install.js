/**
 * Appraisify – Install Handler (Vercel Serverless Function)
 *
 * Why this exists:
 * Bitrix24 opens the "Initial installation path" using an HTML form POST,
 * passing auth parameters (DOMAIN, APP_SID, LANG, etc.) in the request body.
 * Vercel's static file serving returns 405 for POST requests.
 * This serverless function accepts both GET and POST, then serves the install
 * HTML which calls BX24.installFinish() to complete the setup flow.
 *
 * Flow:
 *   1. BX24.init() fires → OAuth tokens stored → mode-selection screen shown
 *   2. Admin picks "Deal Pipeline" or "SPA Table", clicks Install
 *   3. Chosen install path runs (Deal or SPA), progress shown in log
 *   4. BX24.installFinish() called → frame reloads into main app
 */
import { storeTokens } from './_lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  // Bitrix24 POSTs proper OAuth tokens (with refresh_token) in the install request body.
  // Store them server-side immediately — BX24.getAuth() on the client does NOT include
  // refresh_token, so this server-side capture is the only way to get a long-lived token.
  if (req.method === 'POST') {
    const body = req.body || {};
    const access_token  = body.AUTH_ID   || body.access_token;
    const refresh_token = body.REFRESH_ID || body.refresh_token;
    const domain        = (body.DOMAIN   || body.domain || '').split('/')[0].toLowerCase().trim();
    const member_id     = body.member_id;
    if (access_token && refresh_token && domain) {
      try {
        await storeTokens(domain, { access_token, refresh_token, domain, member_id });
        console.log(`[install] Server-side OAuth tokens stored for ${domain} (member_id=${member_id})`);
      } catch (e) {
        console.error('[install] Failed to store server-side tokens:', e.message);
      }
    }
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Installing Appraisify\u2026</title>
  <script src="//api.bitrix24.com/api/v1/"></script>
  <style>
    body { margin: 0; font-family: 'Segoe UI', sans-serif; background: #f0f3f5;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .wrap { text-align: center; padding: 2rem; max-width: 32rem; width: 100%; }
    .icon { width: 4rem; height: 4rem; background: #136dec; border-radius: 1rem;
            margin: 0 auto 1.25rem; display: flex; align-items: center; justify-content: center; }
    .spinner { width: 2rem; height: 2rem; border: 3px solid rgba(255,255,255,0.3);
               border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { margin: 0 0 0.375rem; font-size: 1.125rem; color: #1e293b; font-weight: 700; }
    p  { margin: 0; font-size: 0.875rem; color: #64748b; }
    #log { margin-top: 1.25rem; text-align: left; font-family: monospace; font-size: 0.7rem;
           background: #1e293b; color: #94a3b8; border-radius: 0.5rem; padding: 0.75rem;
           max-height: 12rem; overflow-y: auto; }
    #log .ok  { color: #34d399; }
    #log .err { color: #f87171; }
    #log .info{ color: #60a5fa; }

    /* ── Mode selection ──────────────────────────────────────── */
    #mode-panel { text-align: left; }
    #mode-panel h2 { font-size: 1rem; font-weight: 700; color: #1e293b; margin: 0 0 0.25rem; }
    #mode-panel .sub { font-size: 0.8rem; color: #64748b; margin: 0 0 1.25rem; }
    .mode-cards { display: flex; gap: 0.875rem; margin-bottom: 1.25rem; }
    .mode-card {
      flex: 1; border: 2px solid #e2e8f0; border-radius: 0.75rem; padding: 1rem;
      cursor: pointer; transition: border-color 0.15s, background 0.15s; background: #fff;
      position: relative;
    }
    .mode-card:hover:not(.mode-card-disabled) { border-color: #93c5fd; background: #f0f7ff; }
    .mode-card-selected { border-color: #136dec !important; background: #eff6ff !important; }
    .mode-card-disabled { opacity: 0.5; cursor: not-allowed; }
    .mode-card h3 { font-size: 0.9rem; font-weight: 700; color: #1e293b; margin: 0 0 0.3rem; }
    .mode-card p  { font-size: 0.75rem; color: #64748b; margin: 0; line-height: 1.4; }
    .badge {
      display: inline-block; font-size: 0.6rem; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase; padding: 0.15rem 0.45rem; border-radius: 9999px;
      margin-bottom: 0.4rem;
    }
    .badge-blue   { background: #dbeafe; color: #1d4ed8; }
    .badge-purple { background: #ede9fe; color: #6d28d9; }
    .badge-gray   { background: #f1f5f9; color: #64748b; }
    .spa-probe { font-size: 0.7rem; color: #64748b; margin-top: 0.5rem; }
    .spa-unavail { font-size: 0.7rem; color: #ef4444; margin-top: 0.5rem; }
    #btn-install {
      width: 100%; padding: 0.65rem 1rem; background: #136dec; color: #fff;
      border: none; border-radius: 0.5rem; font-size: 0.875rem; font-weight: 600;
      cursor: pointer; transition: opacity 0.15s;
    }
    #btn-install:disabled { opacity: 0.4; cursor: not-allowed; }
    #btn-install:not(:disabled):hover { opacity: 0.88; }
  </style>
</head>
<body>
  <div class="wrap">
    <!-- Progress panel (shown while installing) -->
    <div id="progress-panel">
      <div class="icon"><div class="spinner" id="spinner"></div></div>
      <h1 id="status-title">Connecting to Bitrix24\u2026</h1>
      <p id="status-msg">Waiting for authorisation\u2026</p>
      <div id="log"></div>
    </div>

    <!-- Mode selection panel (shown after BX24.init fires) -->
    <div id="mode-panel" style="display:none">
      <div class="icon" style="background:#136dec">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>
      </div>
      <h2>Choose your storage mode</h2>
      <p class="sub">Select how Appraisify stores appraisal records in your Bitrix24 portal.</p>
      <div class="mode-cards">
        <div class="mode-card" id="card-deal" onclick="selectMode('deal')">
          <span class="badge badge-blue">All plans</span>
          <h3>Deal Pipeline</h3>
          <p>Stores each appraisal as a CRM Deal inside a dedicated pipeline. Works on all Bitrix24 plans.</p>
        </div>
        <div class="mode-card" id="card-spa" onclick="selectMode('spa')">
          <span class="badge badge-purple">Professional+</span>
          <h3>SPA Table</h3>
          <p>Stores appraisals in a Smart Process Automation entity. Requires Bitrix24 Professional or higher.</p>
          <div class="spa-probe" id="spa-probe">Checking availability\u2026</div>
        </div>
      </div>
      <button id="btn-install" disabled onclick="runInstall()">Install</button>
    </div>
  </div>

  <script>
    var logEl       = document.getElementById('log');
    var selectedMode = null;
    var spaAvailable = false;
    var _domain     = '';
    var _memberId   = '';

    function log(msg, type) {
      type = type || 'info';
      console.log('[Appraisify install] ' + msg);
      var line = document.createElement('div');
      line.className = type;
      line.textContent = '[' + new Date().toISOString().slice(11,23) + '] ' + msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(title, msg) {
      document.getElementById('status-title').textContent = title;
      document.getElementById('status-msg').textContent   = msg;
    }

    function showError(msg) {
      document.getElementById('spinner').style.animation = 'none';
      document.getElementById('spinner').style.borderColor = '#f87171';
      setStatus('Installation Error', msg);
    }

    function showProgressPanel() {
      document.getElementById('mode-panel').style.display     = 'none';
      document.getElementById('progress-panel').style.display = '';
    }

    window.onerror = function(msg, src, line, col, err) {
      log('Uncaught error: ' + msg + ' (' + src + ':' + line + ')', 'err');
      showError('A script error occurred \u2014 see log below.');
    };

    // ── Mode selection helpers ──────────────────────────────────────────────

    function selectMode(mode) {
      if (mode === 'spa' && !spaAvailable) return;
      selectedMode = mode;
      document.getElementById('card-deal').classList.toggle('mode-card-selected', mode === 'deal');
      document.getElementById('card-spa').classList.toggle('mode-card-selected',  mode === 'spa');
      document.getElementById('btn-install').disabled = false;
    }

    function probeSpa() {
      var probeEl = document.getElementById('spa-probe');
      BX24.callMethod('crm.type.list', { start: 0 }, function(r) {
        if (r.error()) {
          var code = String((r.error() && r.error().ex && r.error().ex.error) || r.error() || '').toLowerCase();
          var isFeatureError = code.indexOf('access') !== -1
            || code.indexOf('feature') !== -1
            || code.indexOf('limit')   !== -1
            || code.indexOf('403')     !== -1;
          if (isFeatureError) {
            spaAvailable = false;
            probeEl.className = 'spa-unavail';
            probeEl.textContent = 'Not available on your current plan.';
            document.getElementById('card-spa').classList.add('mode-card-disabled');
          } else {
            // Unknown error — still allow SPA (portal may have it, just odd error)
            spaAvailable = true;
            probeEl.textContent = '';
            log('SPA probe returned error but not a feature block: ' + r.error(), 'info');
          }
        } else {
          spaAvailable = true;
          probeEl.textContent = 'Available on this portal.';
          probeEl.style.color = '#10b981';
        }
      });
    }

    // ── storeModeInKV — fire-and-forget ─────────────────────────────────────

    function storeModeInKV(mode, opts) {
      var payload = Object.assign({ domain: _domain, member_id: _memberId, crm_mode: mode }, opts || {});
      fetch('/api/store-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.ok) { log('Mode config stored in KV \u2713', 'ok'); }
        else       { log('store-mode failed: ' + JSON.stringify(d), 'err'); }
      }).catch(function(e) { log('store-mode error: ' + e, 'err'); });
    }

    // ── Shared stage / field definitions ────────────────────────────────────

    // Title of the shared SPA entity (created by Appraizzie or by this install)
    var APPRAIZZIE_ENTITY_TITLE = 'Performance Appraisal SPA';

    // STATUS_IDs must be \u2264 18 characters (Bitrix24 hard limit)
    var STAGES = [
      { NAME: 'Initialized-Reviewee Pending', STATUS_ID: 'INITIALIZEDREVIEWEEPENDING', SORT: 5,  COLOR: '#F59E0B', SEMANTICS: '' },
      { NAME: 'Reviewer Pending',               STATUS_ID: 'REVIEWERPENDING',            SORT: 15, COLOR: '#2FC6F6', SEMANTICS: '' },
      { NAME: 'Partner Pending',                STATUS_ID: 'PARTNERPENDING',             SORT: 20, COLOR: '#8B5CF6', SEMANTICS: '' },
      { NAME: 'Submitted',                      STATUS_ID: 'SUBMITTED',                  SORT: 25, COLOR: '#10B981', SEMANTICS: '' },
    ];

    var MAX_Q_PER_PHASE = 20;

    function pad2(n) { return String(n).padStart(2, '0'); }

    function buildResponseFields() {
      var actors = ['REVIEWEE', 'REVIEWER', 'PARTNER'];
      var response = [];
      actors.forEach(function(actor) {
        for (var q = 1; q <= MAX_Q_PER_PHASE; q++) {
          response.push({
            FIELD_NAME:   'QUESTION_' + q + '_' + actor + '_RATING',
            LABEL:        'Q' + q + ' ' + actor + ' Rating',
            USER_TYPE_ID: 'double',
            SETTINGS:     { PRECISION: 2 },
          });
          response.push({
            FIELD_NAME:   'QUESTION_' + q + '_' + actor + '_COMMENT',
            LABEL:        'Q' + q + ' ' + actor + ' Comment',
            USER_TYPE_ID: 'string',
          });
        }
      });
      return response;
    }

    var META_FIELDS = [
      // ── Identity ──────────────────────────────────────────────────────────
      { FIELD_NAME: 'REVIEWEE',       LABEL: 'Reviewee',       USER_TYPE_ID: 'integer' },
      { FIELD_NAME: 'REVIEWER',       LABEL: 'Reviewer',       USER_TYPE_ID: 'integer' },
      { FIELD_NAME: 'PARTNER',        LABEL: 'Partner',        USER_TYPE_ID: 'integer' },
      { FIELD_NAME: 'REFERENCE_NO',   LABEL: 'Reference No',   USER_TYPE_ID: 'string'  },
      // ── Cycle metadata ────────────────────────────────────────────────────
      { FIELD_NAME: 'YEAR',           LABEL: 'Year',           USER_TYPE_ID: 'string'  },
      { FIELD_NAME: 'APPRAISAL_TYPE', LABEL: 'Appraisal Type', USER_TYPE_ID: 'string'  },
      { FIELD_NAME: 'TEAM',           LABEL: 'Team',           USER_TYPE_ID: 'string'  },
      { FIELD_NAME: 'ROLE',           LABEL: 'Role',           USER_TYPE_ID: 'string'  },
      // ── Section comments (Goals Review) ───────────────────────────────────
      { FIELD_NAME: 'GOALS_REVIEW_REVIEWEE_COMMENT', LABEL: 'Goals Review \u2013 Reviewee', USER_TYPE_ID: 'string' },
      { FIELD_NAME: 'GOALS_REVIEW_REVIEWER_COMMENT', LABEL: 'Goals Review \u2013 Reviewer', USER_TYPE_ID: 'string' },
      { FIELD_NAME: 'GOALS_REVIEW_PARTNER_COMMENT',  LABEL: 'Goals Review \u2013 Partner',  USER_TYPE_ID: 'string' },
      // ── Section comments (Overall Remarks) ────────────────────────────────
      { FIELD_NAME: 'OVERALL_REMARKS_REVIEWEE_COMMENT', LABEL: 'Overall Remarks \u2013 Reviewee', USER_TYPE_ID: 'string' },
      { FIELD_NAME: 'OVERALL_REMARKS_REVIEWER_COMMENT', LABEL: 'Overall Remarks \u2013 Reviewer', USER_TYPE_ID: 'string' },
      { FIELD_NAME: 'OVERALL_REMARKS_PARTNER_COMMENT',  LABEL: 'Overall Remarks \u2013 Partner',  USER_TYPE_ID: 'string' },
      // ── Section comments (Development Plans) ──────────────────────────────
      { FIELD_NAME: 'DEVELOPMENT_PLANS_REVIEWEE_COMMENT', LABEL: 'Development Plans \u2013 Reviewee', USER_TYPE_ID: 'string' },
      { FIELD_NAME: 'DEVELOPMENT_PLANS_REVIEWER_COMMENT', LABEL: 'Development Plans \u2013 Reviewer', USER_TYPE_ID: 'string' },
      { FIELD_NAME: 'DEVELOPMENT_PLANS_PARTNER_COMMENT',  LABEL: 'Development Plans \u2013 Partner',  USER_TYPE_ID: 'string' },
      // ── Origin ────────────────────────────────────────────────────────────
      { FIELD_NAME: 'SOURCE_APP', LABEL: 'Source App', USER_TYPE_ID: 'string' },
      // ── Aggregate scores ──────────────────────────────────────────────────
      { FIELD_NAME: 'REVIEWEE_RATING_SCORE',      LABEL: 'Reviewee Rating Score',      USER_TYPE_ID: 'string' },
      { FIELD_NAME: 'REVIEWER_RATING_SCORE',      LABEL: 'Reviewer Rating Score',      USER_TYPE_ID: 'string' },
      { FIELD_NAME: 'PARTNER_RATING_SCORE',       LABEL: 'Partner Rating Score',       USER_TYPE_ID: 'string' },
      { FIELD_NAME: 'TOTAL_AVERAGE_RATING_SCORE', LABEL: 'Total Average Rating Score', USER_TYPE_ID: 'string' },
    ];

    var ALL_FIELDS = META_FIELDS.concat(buildResponseFields());

    function buildResponseDealCardElements() {
      var actors = ['REVIEWEE', 'REVIEWER', 'PARTNER'];
      var elements = [];
      actors.forEach(function(actor) {
        for (var q = 1; q <= MAX_Q_PER_PHASE; q++) {
          elements.push({ name: 'UF_CRM_QUESTION_' + q + '_' + actor + '_RATING' });
          elements.push({ name: 'UF_CRM_QUESTION_' + q + '_' + actor + '_COMMENT' });
        }
      });
      return elements;
    }

    // ── finish() ────────────────────────────────────────────────────────────

    function finish() {
      try {
        log('Calling BX24.installFinish()...', 'info');
        BX24.installFinish();
        log('BX24.installFinish() called \u2014 waiting for Bitrix24 to reload frame', 'ok');
      } catch (e) {
        log('BX24.installFinish() threw: ' + e.message, 'err');
        showError('installFinish failed: ' + e.message);
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // DEAL INSTALL PATH
    // ════════════════════════════════════════════════════════════════════════

    function createDealPipeline() {
      log('Creating CRM pipeline...', 'info');
      BX24.callMethod('crm.dealcategory.add', {
        fields: { NAME: 'Performance Appraisal', SORT: 100, IS_LOCKED: 'N' }
      }, function (catResult) {
        if (catResult.error()) {
          log('Failed to create pipeline: ' + catResult.error(), 'err');
          finish();
          return;
        }
        var categoryId = catResult.data();
        log('Pipeline created, ID: ' + categoryId, 'ok');
        try { localStorage.setItem('appraisify_category_id', String(categoryId)); } catch(e) {}
        try { BX24.appOption.set('category_id', String(categoryId)); } catch(e) { log('appOption.set failed: ' + e, 'err'); }
        try { BX24.appOption.set('crm_mode', 'deal'); } catch(e) { log('appOption.set crm_mode failed: ' + e, 'err'); }
        storeModeInKV('deal', { category_id: String(categoryId) });

        // Remove all default stages Bitrix24 auto-creates on new pipelines
        setStatus('Cleaning up defaults\u2026', 'Removing default stages\u2026');
        BX24.callMethod('crm.status.list', {
          filter: { ENTITY_ID: 'DEAL_STAGE_' + categoryId }
        }, function (defaultsResult) {
          var defaults = defaultsResult.error() ? [] : (defaultsResult.data() || []);
          log('Removing ' + defaults.length + ' default stage(s)...', 'info');
          var delIndex = 0;
          function deleteNext() {
            if (delIndex >= defaults.length) { addDealStages(categoryId); return; }
            var d = defaults[delIndex++];
            BX24.callMethod('crm.status.delete', {
              id: d.ID, params: { FORCED: 'Y' }
            }, function () { deleteNext(); });
          }
          deleteNext();
        });
      });
    }

    function addDealStages(categoryId) {
      setStatus('Setting up stages\u2026', 'Creating appraisal stages\u2026');
      var stageIndex = 0;
      function createNextStage() {
        if (stageIndex >= STAGES.length) {
          log('All ' + STAGES.length + ' stages created', 'ok');
          createDealFields(categoryId);
          return;
        }
        var s = STAGES[stageIndex++];
        BX24.callMethod('crm.status.add', {
          fields: {
            ENTITY_ID: 'DEAL_STAGE_' + categoryId,
            STATUS_ID: s.STATUS_ID,
            NAME:      s.NAME,
            SORT:      s.SORT,
            COLOR:     s.COLOR,
            SEMANTICS: s.SEMANTICS,
          }
        }, function (r) {
          if (r.error()) { log('Stage "' + s.NAME + '" failed: ' + r.error(), 'err'); }
          else            { log('Stage created: ' + s.NAME, 'ok'); }
          createNextStage();
        });
      }
      createNextStage();
    }

    function createDealFields(categoryId) {
      setStatus('Setting up custom fields\u2026', 'Creating appraisal response fields\u2026');
      var fi = 0;
      function nextField() {
        if (fi >= ALL_FIELDS.length) {
          log('Custom fields ready (' + ALL_FIELDS.length + ')', 'ok');
          configureDealCard(categoryId);
          return;
        }
        var f = ALL_FIELDS[fi++];
        BX24.callMethod('crm.deal.userfield.add', { fields: f }, function (r) {
          if (r.error()) { log('Field UF_CRM_' + f.FIELD_NAME + ' skipped: ' + r.error(), 'info'); }
          else            { log('Field created: UF_CRM_' + f.FIELD_NAME, 'ok'); }
          nextField();
        });
      }
      nextField();
    }

    function configureDealCard(categoryId) {
      setStatus('Configuring deal card\u2026', 'Setting up deal field layout\u2026');
      var responseElements = buildResponseDealCardElements();
      BX24.callMethod('crm.deal.details.configuration.set', {
        scope: 'C',
        extras: { dealCategoryId: categoryId },
        data: [{
          name: 'main', title: 'Appraisal', type: 'section',
          elements: [
            { name: 'TITLE' }, { name: 'STAGE_ID' }, { name: 'ASSIGNED_BY_ID' },
            { name: 'UF_CRM_REVIEWEE' }, { name: 'UF_CRM_REVIEWER' }, { name: 'UF_CRM_PARTNER' },
            { name: 'UF_CRM_YEAR' }, { name: 'UF_CRM_APPRAISAL_TYPE' },
            { name: 'UF_CRM_TEAM' }, { name: 'UF_CRM_ROLE' },
            { name: 'CLOSEDATE' }, { name: 'COMMENTS' },
          ].concat(responseElements)
        }]
      }, function (r) {
        if (r.error()) { log('Deal card config skipped: ' + r.error(), 'info'); }
        else            { log('Deal card configured', 'ok'); }
        setStatus('Installation complete!', 'Appraisify is ready to use.');
        finish();
      });
    }

    function checkAndInstallDeal() {
      // Check if pipeline already exists
      BX24.callMethod('crm.category.list', { entityTypeId: 2 }, function (listResult) {
        if (listResult.error()) {
          log('Could not check pipelines: ' + listResult.error() + ' \u2014 skipping CRM setup', 'err');
          finish();
          return;
        }
        var data = listResult.data() || {};
        var categories = data.categories || [];
        var existing = null;
        for (var i = 0; i < categories.length; i++) {
          var catName = categories[i].NAME || categories[i].name || '';
          if (catName === 'Appraisify Testing') { existing = categories[i]; break; }
        }

        if (!existing) { createDealPipeline(); return; }

        var existingId = existing.ID || existing.id;
        if (!existingId) {
          log('Pipeline found but ID could not be resolved \u2014 recreating...', 'err');
          createDealPipeline();
          return;
        }

        log('Pipeline found (ID: ' + existingId + ') \u2014 checking stages...', 'info');
        BX24.callMethod('crm.status.list', {
          filter: { ENTITY_ID: 'DEAL_STAGE_' + existingId }
        }, function (stagesResult) {
          var count = stagesResult.error() ? 0 : (stagesResult.data() || []).length;
          if (count >= STAGES.length) {
            log('Pipeline fully configured (' + count + ' stages) \u2014 checking fields...', 'info');
            try { localStorage.setItem('appraisify_category_id', String(existingId)); } catch(e) {}
            try { BX24.appOption.set('category_id', String(existingId)); } catch(e) {}
            try { BX24.appOption.set('crm_mode', 'deal'); } catch(e) {}
            storeModeInKV('deal', { category_id: String(existingId) });
            createDealFields(existingId);
            return;
          }
          log('Pipeline incomplete (' + count + '/' + STAGES.length + ' stages) \u2014 deleting and recreating...', 'info');
          BX24.callMethod('crm.dealcategory.delete', { id: existingId }, function () {
            createDealPipeline();
          });
        });
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // SPA INSTALL PATH
    // ════════════════════════════════════════════════════════════════════════

    function createSpaEntity() {
      log('Checking for existing SPA entity...', 'info');
      BX24.callMethod('crm.type.list', { start: 0 }, function (listResult) {
        if (listResult.error()) {
          log('crm.type.list failed: ' + listResult.error(), 'err');
          finish();
          return;
        }
        var data  = listResult.data() || {};
        var types = data.types || [];
        var existing = null;
        for (var i = 0; i < types.length; i++) {
          var typeName = String(types[i].title || types[i].NAME || '').trim();
          if (typeName === APPRAIZZIE_ENTITY_TITLE) { existing = types[i]; break; }
        }

        if (existing) {
          var existingId  = String(existing.entityTypeId || existing.ENTITY_TYPE_ID || '');
          var existingTId = String(existing.id || existing.ID || '');
          if (!existingId) {
            log('SPA entity found but entityTypeId could not be resolved \u2014 recreating...', 'err');
            doCreateSpaEntity();
            return;
          }
          log('SPA entity found (entityTypeId: ' + existingId + ', typeId: ' + existingTId + ') \u2014 checking stages...', 'info');
          fetchSpaCategoryAndContinue(existingId, function(categoryId) {
            storeSpaIds(existingId, existingTId, categoryId);
            checkSpaStagesAndContinue(existingId, existingTId, categoryId);
          });
          return;
        }

        doCreateSpaEntity();
      });
    }

    function doCreateSpaEntity() {
      log('Creating SPA entity...', 'info');
      BX24.callMethod('crm.type.add', {
        fields: {
          title: APPRAIZZIE_ENTITY_TITLE,
          isCategoriesEnabled: false,
          isStagesEnabled: true,
          isKanbanEnabled: false,
          isBeginCloseDatesEnabled: true,
          isClientEnabled: false,
        }
      }, function (r) {
        if (r.error()) {
          log('Failed to create SPA entity: ' + r.error(), 'err');
          finish();
          return;
        }
        var result = r.data() || {};
        var type   = result.type || result;
        var entityTypeId = String(type.entityTypeId || type.ENTITY_TYPE_ID || '');
        var typeId       = String(type.id || type.ID || '');
        if (!entityTypeId) {
          log('SPA entity created but entityTypeId missing in response', 'err');
          finish();
          return;
        }
        log('SPA entity created, entityTypeId: ' + entityTypeId + ', typeId: ' + typeId, 'ok');
        fetchSpaCategoryAndContinue(entityTypeId, function(categoryId) {
          storeSpaIds(entityTypeId, typeId, categoryId);
          addSpaStages(entityTypeId, typeId, categoryId);
        });
      });
    }

    function storeSpaIds(entityTypeId, typeId, categoryId) {
      try { localStorage.setItem('appraisify_entity_type_id', entityTypeId); } catch(e) {}
      try { BX24.appOption.set('entity_type_id', entityTypeId); } catch(e) { log('appOption.set entity_type_id failed: ' + e, 'err'); }
      try { BX24.appOption.set('crm_mode', 'spa'); } catch(e) { log('appOption.set crm_mode failed: ' + e, 'err'); }
      if (typeId) {
        try { localStorage.setItem('appraisify_spa_type_id', typeId); } catch(e) {}
        try { BX24.appOption.set('spa_type_id', typeId); } catch(e) { log('appOption.set spa_type_id failed: ' + e, 'err'); }
      }
      if (categoryId) {
        try { localStorage.setItem('appraisify_spa_category_id', categoryId); } catch(e) {}
        try { BX24.appOption.set('spa_category_id', String(categoryId)); } catch(e) { log('appOption.set spa_category_id failed: ' + e, 'err'); }
      }
      storeModeInKV('spa', { entity_type_id: entityTypeId, spa_type_id: typeId || '', spa_category_id: categoryId || '' });
    }

    /**
     * Fetches the default SPA category ID for the given entityTypeId via crm.category.list,
     * then calls back with the resolved categoryId string (falls back to '0' on error).
     */
    function fetchSpaCategoryAndContinue(entityTypeId, callback) {
      BX24.callMethod('crm.category.list', { entityTypeId: Number(entityTypeId) }, function(catResult) {
        if (catResult.error()) {
          log('crm.category.list failed: ' + catResult.error() + ' \u2014 using fallback categoryId 0', 'err');
          callback('0');
          return;
        }
        var catData = catResult.data() || {};
        var categories = Array.isArray(catData.categories) ? catData.categories
                       : (Array.isArray(catData) ? catData : []);
        var defaultCat = categories.length ? categories[0] : null;
        var categoryId = defaultCat ? String(defaultCat.id || defaultCat.ID || '0') : '0';
        log('SPA default category ID: ' + categoryId, 'ok');
        callback(categoryId);
      });
    }

    function checkSpaStagesAndContinue(entityTypeId, typeId, categoryId) {
      BX24.callMethod('crm.status.list', {
        filter: { ENTITY_ID: 'DYNAMIC_' + entityTypeId + '_STAGE_' + categoryId }
      }, function (r) {
        var existing = r.error() ? [] : (r.data() || []);
        // Bitrix24 stores bare STATUS_IDs but returns them as DT{entityTypeId}_{categoryId}:{STATUS_ID}
        var existingIds = existing.map(function(s) { return s.STATUS_ID; });
        var expectedPrefix = 'DT' + entityTypeId + '_' + categoryId + ':';
        var allPresent = STAGES.every(function(s) {
          return existingIds.indexOf(expectedPrefix + s.STATUS_ID) >= 0;
        });
        if (allPresent) {
          log('SPA stages already present \u2014 checking fields...', 'info');
          createSpaFields(entityTypeId, typeId);
        } else {
          log('SPA stages incomplete \u2014 creating...', 'info');
          addSpaStages(entityTypeId, typeId, categoryId);
        }
      });
    }

    function addSpaStages(entityTypeId, typeId, categoryId) {
      setStatus('Setting up stages\u2026', 'Configuring SPA stages\u2026');
      var entityId = 'DYNAMIC_' + entityTypeId + '_STAGE_' + categoryId;
      var bxPrefix = 'DT' + entityTypeId + '_' + categoryId + ':';
      var BITRIX_DEFAULTS = ['NEW', 'WON', 'LOSE'];

      BX24.callMethod('crm.status.list', {
        filter: { ENTITY_ID: entityId }
      }, function (listResult) {
        var all = listResult.error() ? [] : (listResult.data() || []);

        // Classify existing stages into buckets:
        //   toDelete      — Bitrix24 auto-created placeholders (NEW/WON/LOSE) with no records
        //   appraisifyMap — our own APPRAISIFY_* stages (upsert these)
        //   everything else (Appraizzie's stages) — leave completely untouched
        var toDelete = [];
        var appraisifyMap = {};

        all.forEach(function(s) {
          var bare = s.STATUS_ID.indexOf(bxPrefix) === 0
            ? s.STATUS_ID.slice(bxPrefix.length)
            : s.STATUS_ID;
          if (BITRIX_DEFAULTS.indexOf(bare) >= 0) {
            toDelete.push(s);
          } else if (bare.indexOf('APPRAISIFY_') === 0 || STAGES.some(function(st) { return st.STATUS_ID === bare; })) {
            appraisifyMap[bare] = s;
          }
        });

        log(
          'Stages: ' + toDelete.length + ' Bitrix24 defaults to delete, ' +
          Object.keys(appraisifyMap).length + ' Appraisify stages found',
          'info'
        );

        // Step 1 — delete only the Bitrix24 auto-created placeholder stages
        var delIndex = 0;
        function deleteNextDefault() {
          if (delIndex >= toDelete.length) { upsertNextStage(); return; }
          var d = toDelete[delIndex++];
          BX24.callMethod('crm.status.delete', {
            id: d.ID, params: { FORCED: 'Y' }
          }, function () { deleteNextDefault(); });
        }

        // Step 2 — upsert each of the 4 Appraisify stages (update if exists, add if not)
        var stageIndex = 0;
        function upsertNextStage() {
          if (stageIndex >= STAGES.length) {
            log('All ' + STAGES.length + ' SPA stages configured', 'ok');
            createSpaFields(entityTypeId, typeId);
            return;
          }
          var s = STAGES[stageIndex++];
          var existing = appraisifyMap[s.STATUS_ID];

          if (existing) {
            var needsUpdate =
              existing.NAME      !== s.NAME      ||
              existing.COLOR     !== s.COLOR     ||
              existing.SEMANTICS !== s.SEMANTICS ||
              String(existing.SORT) !== String(s.SORT);

            if (needsUpdate) {
              BX24.callMethod('crm.status.update', {
                id: existing.ID,
                fields: { NAME: s.NAME, SORT: s.SORT, COLOR: s.COLOR, SEMANTICS: s.SEMANTICS }
              }, function (r) {
                if (r.error()) { log('SPA stage update "' + s.NAME + '" failed: ' + r.error(), 'err'); }
                else            { log('SPA stage updated: ' + s.NAME, 'ok'); }
                upsertNextStage();
              });
            } else {
              log('SPA stage already correct: ' + s.NAME, 'info');
              upsertNextStage();
            }
          } else {
            BX24.callMethod('crm.status.add', {
              fields: {
                ENTITY_ID: entityId,
                STATUS_ID: s.STATUS_ID,
                NAME:      s.NAME,
                SORT:      s.SORT,
                COLOR:     s.COLOR,
                SEMANTICS: s.SEMANTICS,
              }
            }, function (r) {
              if (r.error()) { log('SPA stage add "' + s.NAME + '" failed: ' + r.error(), 'err'); }
              else            { log('SPA stage created: ' + s.NAME, 'ok'); }
              upsertNextStage();
            });
          }
        }

        deleteNextDefault();
      });
    }

    function createSpaFields(entityTypeId, typeId) {
      setStatus('Setting up custom fields\u2026', 'Creating SPA appraisal fields\u2026');
      var fi = 0;
      function nextField() {
        if (fi >= ALL_FIELDS.length) {
          log('SPA custom fields ready (' + ALL_FIELDS.length + ')', 'ok');
          setStatus('Installation complete!', 'Appraisify (SPA mode) is ready to use.');
          finish();
          return;
        }
        var f = ALL_FIELDS[fi++];
        // SPA fields use userfieldconfig.add with the small type id (type.id, NOT entityTypeId)
        // entityId must be 'CRM_{typeId}' per Bitrix24 docs (the "SPA identifier")
        BX24.callMethod('userfieldconfig.add', {
          moduleId: 'crm',
          field: {
            entityId:      'CRM_' + typeId,
            fieldName:     'UF_CRM_' + typeId + '_' + f.FIELD_NAME,
            userTypeId:    f.USER_TYPE_ID,
            editFormLabel: { en: f.LABEL || f.FIELD_NAME },
            settings:      f.SETTINGS || {},
          }
        }, function (r) {
          if (r.error()) { log('SPA field ' + f.FIELD_NAME + ' skipped: ' + r.error(), 'info'); }
          else            { log('SPA field created: UF_CRM_' + typeId + '_' + f.FIELD_NAME, 'ok'); }
          nextField();
        });
      }
      nextField();
    }

    // ════════════════════════════════════════════════════════════════════════
    // ENTRY POINT — called when the Install button is clicked
    // ════════════════════════════════════════════════════════════════════════

    function runInstall() {
      if (!selectedMode) return;
      showProgressPanel();
      setStatus(
        selectedMode === 'spa' ? 'Setting up SPA entity\u2026' : 'Setting up CRM pipeline\u2026',
        selectedMode === 'spa' ? 'Creating Appraisify SPA entity\u2026' : 'Creating Appraisify pipeline\u2026'
      );
      log('Starting install in mode: ' + selectedMode, 'info');
      if (selectedMode === 'spa') {
        createSpaEntity();
      } else {
        checkAndInstallDeal();
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // INITIALISATION
    // ════════════════════════════════════════════════════════════════════════

    document.addEventListener('DOMContentLoaded', function () {
      log('DOMContentLoaded fired', 'info');
      log('BX24 available: ' + (typeof BX24 !== 'undefined'), typeof BX24 !== 'undefined' ? 'ok' : 'err');

      if (typeof BX24 === 'undefined') {
        showError('BX24 SDK not found \u2014 is this page open inside a Bitrix24 frame?');
        log('BX24 is undefined. Page must be loaded inside a Bitrix24 iframe.', 'err');
        return;
      }

      log('Calling BX24.init()...', 'info');

      try {
        BX24.init(function () {
          log('BX24.init() callback fired', 'ok');

          // Capture domain + member_id for storeModeInKV calls
          var auth = BX24.getAuth();
          if (auth) {
            _domain   = String(auth.domain   || '').split('/')[0].toLowerCase().trim();
            _memberId = String(auth.member_id || '');
          }

          // Store installer's OAuth tokens server-side
          if (auth && auth.access_token) {
            fetch('/api/store-auth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                access_token:  auth.access_token,
                refresh_token: auth.refresh_token,
                domain:        auth.domain,
                member_id:     auth.member_id,
                is_install:    true,
              }),
            }).then(function(r) { return r.json(); }).then(function(d) {
              if (d.ok) { log('System auth stored in KV \u2713', 'ok'); }
              else       { log('store-auth failed: ' + JSON.stringify(d), 'err'); }
            }).catch(function(e) { log('store-auth error: ' + e, 'err'); });
          } else {
            log('BX24.getAuth() returned no tokens \u2014 system auth not stored', 'err');
          }

          // Switch to mode selection screen and probe SPA availability
          document.getElementById('progress-panel').style.display = 'none';
          document.getElementById('mode-panel').style.display     = '';
          probeSpa();
        });
      } catch (e) {
        log('BX24.init() threw: ' + e.message, 'err');
        showError('BX24.init failed: ' + e.message);
      }
    });
  </script>
</body>
</html>`);
}
