/**
 * Appraisify – Bitrix24 Install Handler (Vercel Serverless Function)
 *
 * Why this exists:
 * Bitrix24 opens the "Initial installation path" using an HTML form POST,
 * passing auth parameters (DOMAIN, APP_SID, LANG, etc.) in the request body.
 * Vercel's static file serving returns 405 for POST requests.
 * This serverless function accepts both GET and POST, then serves the install
 * HTML which calls BX24.installFinish() to complete the setup flow.
 *
 * After BX24.installFinish() the frame reloads into the main app (handler path).
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
    .wrap { text-align: center; padding: 2rem; max-width: 28rem; }
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
  </style>
</head>
<body>
  <div class="wrap">
    <div class="icon"><div class="spinner" id="spinner"></div></div>
    <h1 id="status-title">Installing Appraisify</h1>
    <p id="status-msg">Setting up your performance appraisal workspace\u2026</p>
    <div id="log"></div>
  </div>
  <script>
    var logEl = document.getElementById('log');

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

    window.onerror = function(msg, src, line, col, err) {
      log('Uncaught error: ' + msg + ' (' + src + ':' + line + ')', 'err');
      showError('A script error occurred \u2014 see log below.');
    };

    document.addEventListener('DOMContentLoaded', function () {
      log('DOMContentLoaded fired', 'info');
      log('BX24 available: ' + (typeof BX24 !== 'undefined'), typeof BX24 !== 'undefined' ? 'ok' : 'err');

      if (typeof BX24 === 'undefined') {
        showError('BX24 SDK not found \u2014 is this page open inside a Bitrix24 frame?');
        log('BX24 is undefined. Page must be loaded inside a Bitrix24 iframe.', 'err');
        return;
      }

      log('Calling BX24.init()...', 'info');
      setStatus('Connecting to Bitrix24\u2026', 'Waiting for authorisation\u2026');

      try {
        BX24.init(function () {
          log('BX24.init() callback fired', 'ok');
          setStatus('Setting up CRM pipeline\u2026', 'Creating Appraisify pipeline\u2026');

          // Store installer's OAuth tokens in Vercel KV so any user of this portal can
          // trigger privileged CRM calls via /api/bx-proxy (installer has admin CRM rights).
          // BX24.getAuth() returns { access_token, refresh_token, domain, member_id, expires_in }
          var auth = BX24.getAuth();
          if (auth && auth.access_token) {
            fetch('/api/store-auth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                access_token:  auth.access_token,
                refresh_token: auth.refresh_token,
                domain:        auth.domain,
                member_id:     auth.member_id,
              }),
            }).then(function(r) { return r.json(); }).then(function(d) {
              if (d.ok) { log('System auth stored in KV \u2713', 'ok'); }
              else       { log('store-auth failed: ' + JSON.stringify(d), 'err'); }
            }).catch(function(e) { log('store-auth error: ' + e, 'err'); });
          } else {
            log('BX24.getAuth() returned no tokens \u2014 system auth not stored', 'err');
          }

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

          // STATUS_IDs must be \u2264 18 characters (Bitrix24 hard limit)
          var STAGES = [
            { NAME: 'Initialized',      STATUS_ID: 'APPRAISIFY_INIT',  SORT: 10, COLOR: '#94A3B8', SEMANTICS: '' },
            { NAME: 'Reviewee Pending', STATUS_ID: 'APPRAISIFY_RVWEE', SORT: 20, COLOR: '#F59E0B', SEMANTICS: '' },
            { NAME: 'Reviewer Pending', STATUS_ID: 'APPRAISIFY_RVWR',  SORT: 30, COLOR: '#2FC6F6', SEMANTICS: '' },
            { NAME: 'Partner Pending',  STATUS_ID: 'APPRAISIFY_PART',  SORT: 40, COLOR: '#8B5CF6', SEMANTICS: '' },
            { NAME: 'Submitted',        STATUS_ID: 'APPRAISIFY_DONE',  SORT: 50, COLOR: '#10B981', SEMANTICS: '' },
          ];

          function buildResponseDealCardElements() {
            var elements = [];
            var phases = ['S', 'R', 'P'];
            function pad2(n) { return String(n).padStart(2, '0'); }
            for (var p = 0; p < phases.length; p++) {
              for (var q = 1; q <= 20; q++) {
                var idx = pad2(q);
                elements.push({ name: 'UF_CRM_APR_S_' + phases[p] + idx });
                elements.push({ name: 'UF_CRM_APR_C_' + phases[p] + idx });
              }
            }
            return elements;
          }

          function createPipeline() {
            log('Creating CRM pipeline...', 'info');
            BX24.callMethod('crm.dealcategory.add', {
              fields: { NAME: 'Appraisify Appraisals', SORT: 100, IS_LOCKED: 'N' }
            }, function (catResult) {
              if (catResult.error()) {
                log('Failed to create pipeline: ' + catResult.error(), 'err');
                finish();
                return;
              }
              var categoryId = catResult.data();
              log('Pipeline created, ID: ' + categoryId, 'ok');
              // Cache pipeline ID locally AND globally (appOption readable by all users)
              try { localStorage.setItem('appraisify_category_id', String(categoryId)); } catch(e) {}
              try { BX24.appOption.set('category_id', String(categoryId)); } catch(e) { log('appOption.set failed: ' + e, 'err'); }

              // Remove all default stages Bitrix24 auto-creates on new pipelines
              setStatus('Cleaning up defaults\u2026', 'Removing default stages\u2026');
              BX24.callMethod('crm.status.list', {
                filter: { ENTITY_ID: 'DEAL_STAGE_' + categoryId }
              }, function (defaultsResult) {
                var defaults = defaultsResult.error() ? [] : (defaultsResult.data() || []);
                log('Removing ' + defaults.length + ' default stage(s)...', 'info');
                var delIndex = 0;
                function deleteNext() {
                  if (delIndex >= defaults.length) {
                    addOurStages(categoryId);
                    return;
                  }
                  var d = defaults[delIndex++];
                  BX24.callMethod('crm.status.delete', {
                    id: d.ID, params: { FORCED: 'Y' }
                  }, function () { deleteNext(); });
                }
                deleteNext();
              });
            });
          }

          function createCustomFields(categoryId) {
            // Create assignment + response fields on each appraisal deal.
            // FIELD_NAME max = 13 chars (prefixed with UF_CRM_ by Bitrix24).
            // If the field already exists (reinstall), Bitrix24 returns an error we log and skip.
            setStatus('Setting up custom fields\u2026', 'Creating appraisal response fields\u2026');
            var MAX_Q_PER_PHASE = 20;
            var PHASES = [
              { code: 'S', label: 'Self' },
              { code: 'R', label: 'Reviewer' },
              { code: 'P', label: 'Partner' },
            ];
            function pad2(n) {
              return String(n).padStart(2, '0');
            }
            function buildResponseFields() {
              var response = [];
              for (var p = 0; p < PHASES.length; p++) {
                var phase = PHASES[p];
                for (var q = 1; q <= MAX_Q_PER_PHASE; q++) {
                  var idx = pad2(q);
                  response.push({
                    FIELD_NAME: 'APR_S_' + phase.code + idx,
                    LABEL: 'Appraisify ' + phase.label + ' Score Q' + q,
                    USER_TYPE_ID: 'double',
                    SETTINGS: { PRECISION: 2 },
                  });
                  response.push({
                    FIELD_NAME: 'APR_C_' + phase.code + idx,
                    LABEL: 'Appraisify ' + phase.label + ' Comment Q' + q,
                    USER_TYPE_ID: 'string',
                  });
                }
              }
              return response;
            }
            var FIELDS = [
              { FIELD_NAME: 'APR_REVIEWER', LABEL: 'Appraisify Reviewer', USER_TYPE_ID: 'integer' },
              { FIELD_NAME: 'APR_PARTNER',  LABEL: 'Appraisify Partner',  USER_TYPE_ID: 'integer' },
            ].concat(buildResponseFields());
            var fi = 0;
            function nextField() {
              if (fi >= FIELDS.length) {
                log('Custom fields ready (' + FIELDS.length + ')', 'ok');
                configureDealCard(categoryId);
                return;
              }
              var f = FIELDS[fi++];
              BX24.callMethod('crm.deal.userfield.add', { fields: f }, function (r) {
                if (r.error()) {
                  log('Field UF_CRM_' + f.FIELD_NAME + ' skipped: ' + r.error(), 'info');
                } else {
                  log('Field created: UF_CRM_' + f.FIELD_NAME, 'ok');
                }
                nextField();
              });
            }
            nextField();
          }

          function configureDealCard(categoryId) {
            // Configure the deal detail card to show only appraisal-relevant fields,
            // hiding default CRM fields (Opportunity, Currency, Source, etc.).
            // scope:'C' = common/general settings for all users.
            // extras.dealCategoryId scopes the configuration to this pipeline only.
            setStatus('Configuring deal card\u2026', 'Setting up deal field layout\u2026');
            var responseElements = buildResponseDealCardElements();
            BX24.callMethod('crm.deal.details.configuration.set', {
              scope: 'C',
              extras: { dealCategoryId: categoryId },
              data: [
                {
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
                  ].concat(responseElements)
                }
              ]
            }, function (r) {
              if (r.error()) {
                log('Deal card config skipped: ' + r.error(), 'info');
              } else {
                log('Deal card configured', 'ok');
              }
              setStatus('Installation complete!', 'Appraisify is ready to use.');
              finish();
            });
          }

          function addOurStages(categoryId) {
            setStatus('Setting up stages\u2026', 'Creating appraisal stages\u2026');
            var stageIndex = 0;
            function createNextStage() {
              if (stageIndex >= STAGES.length) {
                log('All ' + STAGES.length + ' stages created successfully', 'ok');
                createCustomFields(categoryId);
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
              }, function (stageResult) {
                if (stageResult.error()) {
                  log('Stage "' + s.NAME + '" failed: ' + stageResult.error(), 'err');
                } else {
                  log('Stage created: ' + s.NAME, 'ok');
                }
                createNextStage();
              });
            }
            createNextStage();
          }

          // Step 1: Check if pipeline already exists
          // crm.dealcategory.list is deprecated and returns 400 in newer Bitrix24.
          // crm.category.list (entityTypeId: 2) is the modern replacement.
          // Response shape: { categories: [...] } not a plain array.
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
              // crm.category.list (entityTypeId:2) returns lowercase keys via the new CRM API;
              // legacy crm.dealcategory.list returned uppercase. Handle both.
              var catName = categories[i].NAME || categories[i].name || '';
              if (catName === 'Appraisify Appraisals') {
                existing = categories[i];
                break;
              }
            }

            if (!existing) {
              createPipeline();
              return;
            }

            // Normalise ID — new CRM API returns lowercase 'id', legacy returns uppercase 'ID'
            var existingId = existing.ID || existing.id;
            if (!existingId) {
              log('Pipeline found but ID could not be resolved \u2014 recreating...', 'err');
              createPipeline();
              return;
            }

            // Pipeline exists \u2014 check if fully configured (all stages present)
            log('Pipeline found (ID: ' + existingId + ') \u2014 checking stages...', 'info');
            BX24.callMethod('crm.status.list', {
              filter: { ENTITY_ID: 'DEAL_STAGE_' + existingId }
            }, function (stagesResult) {
              var count = stagesResult.error() ? 0 : (stagesResult.data() || []).length;
              if (count >= STAGES.length) {
                log('Pipeline fully configured (' + count + ' stages) \u2014 checking custom fields...', 'info');
                // Refresh global appOption so non-admin users can always resolve the pipeline ID
                try { localStorage.setItem('appraisify_category_id', String(existingId)); } catch(e) {}
                try { BX24.appOption.set('category_id', String(existingId)); } catch(e) { log('appOption.set failed: ' + e, 'err'); }
                // Always run createCustomFields so response fields are created even on reinstall
                // or if the app was first installed before response field code was added.
                createCustomFields(existingId);
                return;
              }
              // Incomplete pipeline (e.g. prior install failed) \u2014 delete and recreate
              log('Pipeline incomplete (' + count + '/' + STAGES.length + ' stages) \u2014 deleting and recreating...', 'info');
              BX24.callMethod('crm.dealcategory.delete', { id: existingId }, function () {
                createPipeline();
              });
            });
          });
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
