#!/usr/bin/env node

/**
 * Backfill cycle metadata onto existing appraisal records.
 *
 * Commit 717325a provisioned UF_CRM_APPRAISAL_TYPE / TEAM / ROLE / YEAR /
 * REVIEWEE at install and taught every reader about them, but never wired the
 * launch flow to write them — so every record created before that fix has the
 * fields present and empty. The values still exist, split across two places:
 *
 *   TITLE     "Dilla Najid – Half Year Performance Appraisal H1 2026"
 *             → appraisal type, period, year
 *   COMMENTS  "[APPRAISIFY_TEMPLATE_ID:abc123]"
 *             → the template, which carries team and role
 *
 * This script recovers both and writes them back. It also creates the new
 * UF_CRM_PERIOD field, which did not exist before the same fix.
 *
 * Existing non-empty values are never overwritten.
 *
 * Runs against the deployed app over /api/bx-proxy, so it needs no Bitrix24
 * credentials of its own — the portal must simply have the app installed.
 * Handles both storage backends (deal pipeline and SPA).
 *
 * Usage:
 *   # dry run — prints what it would change, writes nothing
 *   node scripts/backfill-cycle-metadata.mjs --domain crm.eta-co.com.my
 *
 *   # apply
 *   node scripts/backfill-cycle-metadata.mjs --domain crm.eta-co.com.my --apply
 *
 * Options:
 *   --domain <d>     portal to backfill (required)
 *   --apply          actually write; omit for a dry run
 *   --limit <n>      stop after n records (useful for a cautious first pass)
 *   --base-url <u>   deployed app base URL (default: $APP_URL or production)
 *
 * Env:
 *   APPRAISIFY_SERVICE_TOKEN  shared secret identifying this as a trusted
 *                             server-side caller. Required once the app
 *                             enforces authentication (ENFORCE_AUTH=1).
 */

import { argv, env, exit } from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = env.APP_URL || 'https://appraisify-plus.vercel.app';

const SPA_ENTITY_TITLE = 'Performance Appraisal SPA';
const TEMPLATE_MARKER  = /\[APPRAISIFY_TEMPLATE_ID:([^\]]+)\]/;

// Must match the Period dropdown in views/appraisal-start.html.
// 'Full Year' first so it wins over a bare-word suffix match.
const PERIODS = ['Full Year', 'Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2'];

// The fields this script fills, in Deal (UPPERCASE) naming.
const TARGET_FIELDS = [
  'UF_CRM_APPRAISAL_TYPE',
  'UF_CRM_PERIOD',
  'UF_CRM_YEAR',
  'UF_CRM_TEAM',
  'UF_CRM_ROLE',
  'UF_CRM_REVIEWEE',
];

const PERIOD_FIELD_SPEC = { FIELD_NAME: 'PERIOD', LABEL: 'Period', USER_TYPE_ID: 'string' };

// ── args ────────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const out = { domain: '', apply: false, limit: 0, baseUrl: DEFAULT_BASE_URL };
  for (let i = 2; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--domain')   { out.domain  = String(args[++i] || '').split('/')[0].toLowerCase().trim(); continue; }
    if (a === '--base-url') { out.baseUrl = String(args[++i] || '').replace(/\/$/, '');                 continue; }
    if (a === '--limit')    { out.limit   = parseInt(args[++i] || '0', 10) || 0;                        continue; }
    if (a === '--apply')    { out.apply   = true;                                                       continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
  }
  return out;
}

function usage() {
  console.log(`
Backfill appraisal cycle metadata (type / period / year / team / role / reviewee).

  node scripts/backfill-cycle-metadata.mjs --domain <portal> [--apply] [--limit n]

Without --apply it is a dry run and writes nothing.
`.trim());
}

// ── transport ───────────────────────────────────────────────────────────────

let CALLS = 0;

async function bx(cfg, method, params = {}) {
  CALLS += 1;
  const resp = await fetch(`${cfg.baseUrl}/api/bx-proxy`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      // A script has no Bitrix24 session, so it presents the shared service
      // secret instead. Required once ENFORCE_AUTH is on; ignored before that.
      ...(env.APPRAISIFY_SERVICE_TOKEN ? { 'x-appraisify-service-token': env.APPRAISIFY_SERVICE_TOKEN } : {}),
    },
    body:    JSON.stringify({ method, params, domain: cfg.domain }),
  });

  let json = {};
  try { json = await resp.json(); } catch (_) {}

  if (!resp.ok)  throw new Error(`${method}: HTTP ${resp.status} ${JSON.stringify(json)}`);
  if (json.error) {
    const err = new Error(`${method}: ${json.error} ${json.error_description || ''}`.trim());
    err.bitrixError = json.error;
    throw err;
  }
  return json;
}

/** Page through a list method that uses Bitrix24's `start` / `next` cursor. */
async function bxList(cfg, method, params, pluck) {
  const all = [];
  let start = 0;
  for (;;) {
    const json = await bx(cfg, method, { ...params, start });
    const page = pluck(json.result);
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (json.next == null) break;
    start = json.next;
  }
  return all;
}

/**
 * The stored deal→template mapping — step one of the app's own resolution chain.
 * Required in SPA mode: crm.item.* does not return `comments`, so the
 * [APPRAISIFY_TEMPLATE_ID:...] marker cannot be read off the record there.
 */
async function fetchTemplateIdForRecord(cfg, recordId) {
  try {
    const resp = await fetch(
      `${cfg.baseUrl}/api/appraisal-template?dealId=${encodeURIComponent(recordId)}`
      + `&domain=${encodeURIComponent(cfg.domain)}`,
      { headers: { 'x-appraisify-domain': cfg.domain } },
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    return json.templateId ? String(json.templateId) : null;
  } catch (_) {
    return null;
  }
}

async function fetchTemplates(cfg) {
  const resp = await fetch(`${cfg.baseUrl}/api/templates?domain=${encodeURIComponent(cfg.domain)}`);
  let json = {};
  try { json = await resp.json(); } catch (_) {}
  if (!resp.ok || json.error) throw new Error(`templates: ${json.error || resp.status}`);
  const byId = new Map();
  (Array.isArray(json.templates) ? json.templates : []).forEach(t => byId.set(String(t.id), t));
  return byId;
}

// ── mode detection ──────────────────────────────────────────────────────────

/**
 * Decide which storage backend this portal uses by looking for the SPA entity.
 * Mirrors the detection install.js does by entity title.
 */
async function detectMode(cfg) {
  let types = [];
  try {
    const json = await bx(cfg, 'crm.type.list', {});
    types = json.result?.types || [];
  } catch (e) {
    // Portals on the deal backend may not expose crm.type.* at all.
    console.log(`  crm.type.list unavailable (${e.bitrixError || e.message}) — assuming deal mode`);
    return { mode: 'deal' };
  }

  const match = types.find(t => String(t.title || '').trim() === SPA_ENTITY_TITLE);
  if (!match) return { mode: 'deal' };

  const entityTypeId = String(match.entityTypeId || '');
  const typeId       = String(match.id || '');
  if (!entityTypeId) {
    throw new Error(`Found "${SPA_ENTITY_TITLE}" but it has no entityTypeId — portal may need a reinstall`);
  }
  return { mode: 'spa', entityTypeId, typeId: typeId || entityTypeId };
}

// ── SPA field-name translation ──────────────────────────────────────────────
// Mirrors _dealToSpaFields() / normalizeSpaItemToDeal(). Every field this
// script touches has a digit-free suffix, so only the camelCase form applies.

function toSpaFieldName(dealName, typeId) {
  const suffix = dealName.slice('UF_CRM_'.length);
  const camel  = suffix.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return `ufCrm${typeId}${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

/** Read a Deal-named field off a record in either backend. */
function readField(record, dealName, ctx) {
  if (ctx.mode !== 'spa') return record[dealName];
  return record[toSpaFieldName(dealName, ctx.typeId)]
      ?? record[`UF_CRM_${ctx.typeId}_${dealName.slice('UF_CRM_'.length)}`];
}

/**
 * Is this record ours?
 *
 * Appraisify shares the SPA entity with Appraizzie, its predecessor — install.js
 * reuses the 'Performance Appraisal SPA' entity when it already exists. Both
 * apps' records therefore sit side by side, and UF_CRM_SOURCE_APP (commit
 * 41707cd) is what separates them.
 *
 * The list queries already filter on this marker, but a filter is a request,
 * not a guarantee: Bitrix24 silently returns everything when it does not
 * recognise a filter key, which is precisely how the first run of this script
 * proposed writes to 173 Appraizzie records. So every record is re-checked here,
 * from its own data, immediately before anything is written.
 */
function isAppraisifyRecord(record, ctx) {
  return readField(record, 'UF_CRM_SOURCE_APP', ctx) === 'APPRAISIFY';
}

// ── value recovery ──────────────────────────────────────────────────────────

/**
 * Split a launch-generated title back into its parts.
 * Built by appraisal-start.html as `${fullName} – ${typeLabel} ${period} ${year}`.
 */
export function parseTitle(title) {
  const raw = String(title || '').trim();
  const sep = raw.indexOf(' – '); // en dash, as written by the launch flow
  if (sep === -1) return {};

  let rest = raw.slice(sep + 3).trim();

  const yearMatch = rest.match(/\s(\d{4})$/);
  if (!yearMatch) return { type: rest || undefined };
  const year = yearMatch[1];
  rest = rest.slice(0, rest.length - yearMatch[0].length).trim();

  let period;
  for (const p of PERIODS) {
    if (rest.toLowerCase().endsWith(p.toLowerCase())) {
      period = p;
      rest = rest.slice(0, rest.length - p.length).trim();
      break;
    }
  }

  return { type: rest || undefined, period, year };
}

/** Work out which target fields are empty and what should go in them. */
function planRecord(record, ctx, templates, resolvedTemplateId) {
  const title    = record.TITLE ?? record.title ?? '';
  const assignee = record.ASSIGNED_BY_ID ?? record.assignedById ?? '';

  const parsed     = parseTitle(title);
  const templateId = resolvedTemplateId || null;
  const template   = templateId ? templates.get(String(templateId)) : null;

  const candidates = {
    UF_CRM_APPRAISAL_TYPE: parsed.type   || template?.type || '',
    UF_CRM_PERIOD:         parsed.period || '',
    UF_CRM_YEAR:           parsed.year   || '',
    UF_CRM_TEAM:           template?.team || '',
    UF_CRM_ROLE:           template?.role || '',
    UF_CRM_REVIEWEE:       assignee ? parseInt(assignee, 10) : '',
  };

  const updates = {};
  const kept    = [];
  for (const name of TARGET_FIELDS) {
    const value = candidates[name];
    if (value === '' || value == null || Number.isNaN(value)) continue;

    const current = readField(record, name, ctx);
    const isEmpty = current === undefined || current === null || String(current).trim() === ''
                 || (name === 'UF_CRM_REVIEWEE' && String(current) === '0');
    if (!isEmpty) { kept.push(name); continue; }

    updates[name] = value;
  }

  return { updates, kept, templateId, hasTemplate: !!template };
}

// ── ensure the PERIOD field exists ──────────────────────────────────────────

async function ensurePeriodField(cfg, ctx) {
  if (ctx.mode === 'spa') {
    try {
      await bx(cfg, 'userfieldconfig.add', {
        moduleId: 'crm',
        field: {
          entityId:      `CRM_${ctx.typeId}`,
          fieldName:     `UF_CRM_${ctx.typeId}_${PERIOD_FIELD_SPEC.FIELD_NAME}`,
          userTypeId:    PERIOD_FIELD_SPEC.USER_TYPE_ID,
          editFormLabel: { en: PERIOD_FIELD_SPEC.LABEL },
          settings:      {},
        },
      });
      return 'created';
    } catch (e) {
      return `skipped (${e.bitrixError || e.message})`; // already exists
    }
  }

  try {
    await bx(cfg, 'crm.deal.userfield.add', { fields: PERIOD_FIELD_SPEC });
    return 'created';
  } catch (e) {
    return `skipped (${e.bitrixError || e.message})`;
  }
}

// ── record listing / writing ────────────────────────────────────────────────

async function listRecords(cfg, ctx) {
  if (ctx.mode === 'spa') {
    // select:['*'] is required — without it crm.item.list omits every UF field,
    // which would make already-populated records look empty and get overwritten.
    // The SOURCE_APP filter is equally required: a portal's SPA entity can hold
    // records created by other tools (crm.eta-co.com.my has ~200 "Employee
    // Feedback Record" items with sourceApp null), and those are not ours to
    // touch. Both match listDeals() in bx24.js.
    return bxList(
      cfg,
      'crm.item.list',
      {
        entityTypeId: Number(ctx.entityTypeId),
        filter: { [toSpaFieldName('UF_CRM_SOURCE_APP', ctx.typeId)]: 'APPRAISIFY' },
        select: ['*'],
      },
      r => r?.items,
    );
  }

  // Same app-origin marker the dashboard filters on. Records created before
  // SOURCE_APP existed (commit 41707cd) carry no marker and are skipped — they
  // are already invisible to the app's own dashboard for the same reason.
  return bxList(
    cfg,
    'crm.deal.list',
    {
      filter: { UF_CRM_SOURCE_APP: 'APPRAISIFY' },
      select: ['ID', 'TITLE', 'COMMENTS', 'ASSIGNED_BY_ID', 'UF_CRM_SOURCE_APP', ...TARGET_FIELDS],
    },
    r => r,
  );
}

async function writeRecord(cfg, ctx, id, updates) {
  if (ctx.mode === 'spa') {
    const fields = {};
    for (const [name, value] of Object.entries(updates)) {
      fields[toSpaFieldName(name, ctx.typeId)] = value;
    }
    return bx(cfg, 'crm.item.update', {
      entityTypeId: Number(ctx.entityTypeId),
      id:           Number(id),
      fields,
    });
  }
  return bx(cfg, 'crm.deal.update', { id: Number(id), fields: updates });
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = parseArgs(argv);

  if (cfg.help) { usage(); return; }
  if (!cfg.domain) { usage(); throw new Error('Missing --domain'); }

  console.log(`\nPortal:  ${cfg.domain}`);
  console.log(`App:     ${cfg.baseUrl}`);
  console.log(`Mode:    ${cfg.apply ? 'APPLY — records will be written' : 'DRY RUN — nothing will be written'}\n`);

  const ctx = await detectMode(cfg);
  console.log(`Backend: ${ctx.mode}${ctx.mode === 'spa' ? ` (entityTypeId=${ctx.entityTypeId}, typeId=${ctx.typeId})` : ''}`);

  if (cfg.apply) {
    const status = await ensurePeriodField(cfg, ctx);
    console.log(`PERIOD field: ${status}`);
  } else {
    console.log('PERIOD field: would create if missing');
  }

  const templates = await fetchTemplates(cfg);
  console.log(`Templates: ${templates.size} loaded`);

  const records = await listRecords(cfg, ctx);
  console.log(`Records:   ${records.length} found`);

  // Safety: in SPA mode the field prefix is the small type id, which older
  // portals may not have stored (bitrix.js falls back to entity_type_id for
  // exactly this reason). If the prefix we derived matches nothing on any
  // record, every field would read as empty and we would overwrite live data.
  // Stop instead of guessing.
  if (ctx.mode === 'spa' && records.length > 0) {
    const prefix  = `ufCrm${ctx.typeId}`;
    const anyMatch = records.some(r => Object.keys(r).some(k => k.startsWith(prefix)));
    if (!anyMatch) {
      const seen = [...new Set(
        records.flatMap(r => Object.keys(r))
               .map(k => (k.match(/^ufCrm\d+/) || [])[0])
               .filter(Boolean),
      )];
      throw new Error(
        `No record carries the expected field prefix "${prefix}".\n`
        + `  Prefixes actually present: ${seen.length ? seen.join(', ') : '(none — select may have failed)'}\n`
        + `  Refusing to continue: every field would look empty and existing values could be overwritten.`,
      );
    }
  }
  console.log('');

  const stats  = { changed: 0, alreadyFilled: 0, noValues: 0, noTemplate: 0, failed: 0, foreign: 0 };
  const foreignSample = [];
  let processed = 0;

  for (const record of records) {
    if (cfg.limit && processed >= cfg.limit) {
      console.log(`\n--limit ${cfg.limit} reached — stopping.`);
      break;
    }
    processed += 1;

    const id    = record.ID ?? record.id;
    const title = record.TITLE ?? record.title ?? '(untitled)';

    if (!isAppraisifyRecord(record, ctx)) {
      stats.foreign += 1;
      foreignSample.push(`${id}: ${title}`);
      continue;
    }

    // Deal mode carries the marker inline; SPA has to ask for the stored mapping.
    const comments   = record.COMMENTS ?? record.comments ?? '';
    const fromMarker = (String(comments).match(TEMPLATE_MARKER) || [])[1];
    const templateId0 = fromMarker || await fetchTemplateIdForRecord(cfg, id);

    const { updates, templateId, hasTemplate } = planRecord(record, ctx, templates, templateId0);

    if (templateId && !hasTemplate) stats.noTemplate += 1;

    const names = Object.keys(updates);
    if (names.length === 0) {
      const parsed = parseTitle(title);
      if (!parsed.type && !parsed.year) { stats.noValues += 1; console.log(`  ~ ${id}  unparseable title, nothing to recover: "${title}"`); }
      else stats.alreadyFilled += 1;
      continue;
    }

    const summary = names.map(n => `${n.slice('UF_CRM_'.length)}=${JSON.stringify(updates[n])}`).join(' ');
    if (!cfg.apply) {
      console.log(`  → ${id}  ${summary}`);
      stats.changed += 1;
      continue;
    }

    try {
      await writeRecord(cfg, ctx, id, updates);
      console.log(`  ✓ ${id}  ${summary}`);
      stats.changed += 1;
    } catch (e) {
      console.error(`  ✗ ${id}  ${e.message}`);
      stats.failed += 1;
    }
  }

  console.log('\n── Summary ─────────────────────────────');
  console.log(`  ${cfg.apply ? 'updated' : 'would update'}:   ${stats.changed}`);
  console.log(`  already filled:  ${stats.alreadyFilled}`);
  console.log(`  nothing to fill: ${stats.noValues}`);
  if (stats.noTemplate) console.log(`  template missing: ${stats.noTemplate} (team/role skipped)`);
  if (stats.foreign) {
    console.log(`  NOT ours, skipped: ${stats.foreign} (no SOURCE_APP=APPRAISIFY — Appraizzie or other)`);
    foreignSample.slice(0, 5).forEach(x => console.log(`      ${x}`));
    if (stats.foreign > 5) console.log(`      … and ${stats.foreign - 5} more`);
    console.log('    These reached the loop despite the list filter — the filter did not apply.');
  }
  if (stats.failed)     console.log(`  failed:          ${stats.failed}`);
  console.log(`  API calls:       ${CALLS}`);

  if (!cfg.apply && stats.changed > 0) {
    console.log('\nRe-run with --apply to write these changes.');
  }

  if (stats.failed) exit(1);
}

// Only run when executed directly, so parseTitle() can be imported in a test
// without the script trying to talk to a portal.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((e) => {
    console.error(`\nError: ${e.message}`);
    exit(1);
  });
}
