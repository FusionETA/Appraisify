#!/usr/bin/env node

/**
 * Import templates from nested appraisal JSON into one Appraisify tenant only.
 *
 * Usage:
 *   node scripts/import-appraisal-instance.mjs \
 *     --domain crm.eta-co.com.my \
 *     --input "/Users/rachel/Downloads/appraisal (1).json" \
 *     --dry-run
 *
 *   node scripts/import-appraisal-instance.mjs \
 *     --domain crm.eta-co.com.my \
 *     --input "/Users/rachel/Downloads/appraisal (1).json"
 */

import { readFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';

const ALLOWED_DOMAIN = 'crm.eta-co.com.my';
const DEFAULT_BASE_URL = env.APP_URL || 'https://appraisify-v2-123.vercel.app';

function usage() {
  console.log(
    'Usage: node scripts/import-appraisal-instance.mjs --domain crm.eta-co.com.my --input "/absolute/path/appraisal.json" [--base-url https://your-app] [--dry-run] [--concurrency 3]'
  );
}

function parseArgs(rawArgv) {
  const out = {
    domain: '',
    input: '',
    baseUrl: DEFAULT_BASE_URL,
    dryRun: false,
    concurrency: 3,
  };

  for (let i = 2; i < rawArgv.length; i += 1) {
    const a = rawArgv[i];
    if (a === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (a === '--domain') {
      out.domain = String(rawArgv[i + 1] || '').trim().toLowerCase();
      i += 1;
      continue;
    }
    if (a === '--input') {
      out.input = String(rawArgv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (a === '--base-url') {
      out.baseUrl = String(rawArgv[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (a === '--concurrency') {
      const n = Number(rawArgv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.concurrency = Math.min(10, Math.floor(n));
      i += 1;
      continue;
    }
    if (a === '--help' || a === '-h') {
      usage();
      exit(0);
    }
  }

  if (out.baseUrl.endsWith('/')) out.baseUrl = out.baseUrl.slice(0, -1);
  return out;
}

function requireSafeDomain(domain) {
  if (!domain) {
    throw new Error('Missing --domain');
  }
  if (domain !== ALLOWED_DOMAIN) {
    throw new Error(`Domain lock violation: this script only allows --domain ${ALLOWED_DOMAIN}`);
  }
}

function templateKey(type, team, role) {
  return `${String(type || '').trim().toLowerCase()}|${String(team || '').trim().toLowerCase()}|${String(role || '').trim().toLowerCase()}`;
}

function makeTemplateName(type, team, role) {
  return `${type} | ${team} | ${role}`;
}

function isEngagementSection(sectionName, sectionId) {
  const name = `${String(sectionName || '')} ${String(sectionId || '')}`.toLowerCase();
  return name.includes('engagement');
}

function sanitizeText(v) {
  return String(v == null ? '' : v).trim();
}

function ensureUniqueUid(rawUid, used, fallbackBase) {
  let uid = sanitizeText(rawUid) || fallbackBase;
  if (!uid) uid = `uid_${Math.random().toString(36).slice(2, 10)}`;

  if (!used.has(uid)) {
    used.add(uid);
    return uid;
  }

  let i = 2;
  while (used.has(`${uid}_${i}`)) i += 1;
  const unique = `${uid}_${i}`;
  used.add(unique);
  return unique;
}

function mapSourceToTemplates(source) {
  const appraisalTypes = Array.isArray(source?.appraisalTypes) ? source.appraisalTypes : [];
  const templates = [];

  for (const appType of appraisalTypes) {
    const type = sanitizeText(appType?.name || appType?.id);
    if (!type) continue;

    for (const teamObj of (Array.isArray(appType?.teams) ? appType.teams : [])) {
      const team = sanitizeText(teamObj?.name || teamObj?.id || 'all') || 'all';

      for (const roleObj of (Array.isArray(teamObj?.roles) ? teamObj.roles : [])) {
        const role = sanitizeText(roleObj?.name || roleObj?.id || 'all') || 'all';
        const usedUids = new Set();

        const payload = {
          name: makeTemplateName(type, team, role),
          type,
          team,
          role,
          scopeItems: [],
          sections: {
            scope: [],
            engagement: [],
          },
        };

        const sections = Array.isArray(roleObj?.sections) ? roleObj.sections : [];
        for (const section of sections) {
          const sectionLabel = sanitizeText(section?.name || section?.id || 'General');
          const targetWorkspace = isEngagementSection(section?.name, section?.id) ? 'engagement' : 'scope';
          const questions = Array.isArray(section?.questions) ? section.questions : [];

          questions.forEach((q, idx) => {
            const text = sanitizeText(q?.text);
            if (!text) return;

            const baseUid = sanitizeText(q?.id) || `${targetWorkspace}_${sectionLabel.replace(/\s+/g, '_').toLowerCase()}_${idx + 1}`;
            const _uid = ensureUniqueUid(baseUid, usedUids, baseUid);

            payload.sections[targetWorkspace].push({
              _uid,
              section: sectionLabel,
              text,
              desc: sanitizeText(q?.description),
            });
          });
        }

        templates.push(payload);
      }
    }
  }

  return templates;
}

function validateTemplateCounts(templates) {
  const violations = [];
  templates.forEach((tpl) => {
    const scopeCount = Array.isArray(tpl.sections?.scope) ? tpl.sections.scope.length : 0;
    const engagementCount = Array.isArray(tpl.sections?.engagement) ? tpl.sections.engagement.length : 0;
    if (scopeCount > 20) violations.push(`${tpl.name}: sections.scope=${scopeCount} exceeds 20`);
    if (engagementCount > 20) violations.push(`${tpl.name}: sections.engagement=${engagementCount} exceeds 20`);
  });
  return violations;
}

async function parseJson(resp) {
  let json = {};
  try {
    json = await resp.json();
  } catch (_) {}

  if (!resp.ok || json.error) {
    const detail = json.error_description || json.error || `HTTP ${resp.status}`;
    throw new Error(detail);
  }

  return json;
}

function buildTemplatesUrl(baseUrl, domain, id = '', includeArchived = false) {
  const params = new URLSearchParams();
  params.set('domain', domain);
  if (id) params.set('id', id);
  if (includeArchived) params.set('includeArchived', 'true');
  return `${baseUrl}/api/templates?${params.toString()}`;
}

async function listExistingTemplates(baseUrl, domain) {
  const url = buildTemplatesUrl(baseUrl, domain, '', true);
  const resp = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'x-appraisify-domain': domain,
    },
  });
  const json = await parseJson(resp);
  return Array.isArray(json.templates) ? json.templates : [];
}

async function createTemplate(baseUrl, domain, payload) {
  const url = buildTemplatesUrl(baseUrl, domain);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-appraisify-domain': domain,
    },
    body: JSON.stringify({ ...payload, domain }),
  });
  const json = await parseJson(resp);
  return json.template || null;
}

async function updateTemplate(baseUrl, domain, id, payload) {
  const url = buildTemplatesUrl(baseUrl, domain, id);
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-appraisify-domain': domain,
    },
    body: JSON.stringify({ ...payload, domain }),
  });
  const json = await parseJson(resp);
  return json.template || null;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runOne() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.max(1, concurrency); i += 1) {
    workers.push(runOne());
  }

  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(argv);
  if (!args.domain || !args.input) {
    usage();
    throw new Error('Missing required arguments: --domain and --input');
  }

  requireSafeDomain(args.domain);

  const raw = await readFile(args.input, 'utf8');
  const source = JSON.parse(raw);
  const mappedTemplates = mapSourceToTemplates(source);

  if (!mappedTemplates.length) {
    throw new Error('No templates were derived from input JSON.');
  }

  const violations = validateTemplateCounts(mappedTemplates);
  if (violations.length) {
    throw new Error(`Template validation failed:\n- ${violations.join('\n- ')}`);
  }

  const existingTemplates = await listExistingTemplates(args.baseUrl, args.domain);
  const existingByKey = new Map();
  for (const tpl of existingTemplates) {
    const key = templateKey(tpl.type, tpl.team, tpl.role);
    if (!existingByKey.has(key)) existingByKey.set(key, tpl);
  }

  const plan = mappedTemplates.map((payload) => {
    const key = templateKey(payload.type, payload.team, payload.role);
    const existing = existingByKey.get(key) || null;
    return {
      key,
      action: existing ? 'update' : 'create',
      id: existing?.id || null,
      payload,
    };
  });

  const createCount = plan.filter(p => p.action === 'create').length;
  const updateCount = plan.filter(p => p.action === 'update').length;

  console.log(`Target domain: ${args.domain}`);
  console.log(`Base URL: ${args.baseUrl}`);
  console.log(`Input file: ${args.input}`);
  console.log(`Templates mapped: ${mappedTemplates.length}`);
  console.log(`Plan: ${createCount} create, ${updateCount} update`);

  if (args.dryRun) {
    console.log('\nDry run complete. No API writes performed.');
    return;
  }

  const outcomes = await runPool(plan, args.concurrency, async (item) => {
    try {
      if (item.action === 'update' && item.id) {
        await updateTemplate(args.baseUrl, args.domain, item.id, item.payload);
        return { ok: true, action: 'updated', name: item.payload.name };
      }
      await createTemplate(args.baseUrl, args.domain, item.payload);
      return { ok: true, action: 'created', name: item.payload.name };
    } catch (e) {
      return {
        ok: false,
        action: item.action,
        name: item.payload.name,
        error: e?.message || String(e),
      };
    }
  });

  const summary = {
    created: outcomes.filter(o => o?.ok && o.action === 'created').length,
    updated: outcomes.filter(o => o?.ok && o.action === 'updated').length,
    failed: outcomes.filter(o => !o?.ok).length,
  };

  console.log('\nImport summary:');
  console.log(JSON.stringify(summary, null, 2));

  if (summary.failed > 0) {
    console.log('\nFailures:');
    outcomes
      .filter(o => !o?.ok)
      .forEach((f) => console.log(`- ${f.name}: ${f.error}`));
    exit(2);
  }
}

main().catch((err) => {
  console.error(`Import failed: ${err?.message || err}`);
  exit(1);
});
