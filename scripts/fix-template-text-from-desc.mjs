#!/usr/bin/env node

import { argv, env, exit } from 'node:process';

const ALLOWED_DOMAIN = 'crm.eta-co.com.my';
const BASE_URL = env.APP_URL || 'https://appraisify-v2-123.vercel.app';

function parseArgs(args) {
  const out = { domain: '', apply: false, includeArchived: false };
  for (let i = 2; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--domain') {
      out.domain = String(args[i + 1] || '').trim().toLowerCase();
      i += 1;
      continue;
    }
    if (a === '--apply') {
      out.apply = true;
      continue;
    }
    if (a === '--include-archived') {
      out.includeArchived = true;
      continue;
    }
  }
  return out;
}

function ensureDomain(domain) {
  if (!domain) throw new Error('Missing --domain');
  if (domain !== ALLOWED_DOMAIN) throw new Error(`Domain lock violation: only ${ALLOWED_DOMAIN} allowed`);
}

function buildUrl(domain, id = '', includeArchived = false) {
  const p = new URLSearchParams();
  p.set('domain', domain);
  if (id) p.set('id', id);
  if (includeArchived) p.set('includeArchived', 'true');
  return `${BASE_URL}/api/templates?${p.toString()}`;
}

async function parseJson(resp) {
  let json = {};
  try { json = await resp.json(); } catch (_) {}
  if (!resp.ok || json.error) {
    throw new Error(json.error_description || json.error || `HTTP ${resp.status}`);
  }
  return json;
}

async function listTemplates(domain, includeArchived) {
  const resp = await fetch(buildUrl(domain, '', includeArchived), {
    headers: {
      'Content-Type': 'application/json',
      'x-appraisify-domain': domain,
    },
  });
  const json = await parseJson(resp);
  return Array.isArray(json.templates) ? json.templates : [];
}

function shouldSwap(q) {
  const text = String(q?.text || '').trim();
  const desc = String(q?.desc || '').trim();
  return /^\d+$/.test(text) && !!desc;
}

function migrateTemplate(tpl) {
  let changed = 0;
  const next = JSON.parse(JSON.stringify(tpl));

  for (const ws of ['scope', 'engagement']) {
    const arr = Array.isArray(next?.sections?.[ws]) ? next.sections[ws] : [];
    arr.forEach((q) => {
      if (shouldSwap(q)) {
        q.text = String(q.desc || '').trim();
        changed += 1;
      }
    });
  }

  return { changed, payload: {
    name: next.name,
    type: next.type,
    team: next.team,
    role: next.role,
    scopeItems: Array.isArray(next.scopeItems) ? next.scopeItems : [],
    sections: {
      scope: Array.isArray(next?.sections?.scope) ? next.sections.scope : [],
      engagement: Array.isArray(next?.sections?.engagement) ? next.sections.engagement : [],
    },
  }};
}

async function patchTemplate(domain, id, payload) {
  const resp = await fetch(buildUrl(domain, id), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-appraisify-domain': domain,
    },
    body: JSON.stringify({ ...payload, domain }),
  });
  await parseJson(resp);
}

async function main() {
  const args = parseArgs(argv);
  ensureDomain(args.domain);

  const templates = await listTemplates(args.domain, args.includeArchived);
  const plan = templates
    .filter(t => !t.archived)
    .map((tpl) => ({ tpl, ...migrateTemplate(tpl) }))
    .filter(x => x.changed > 0);

  const questionCount = plan.reduce((sum, x) => sum + x.changed, 0);

  console.log(`Target domain: ${args.domain}`);
  console.log(`Templates scanned: ${templates.filter(t => !t.archived).length}`);
  console.log(`Templates to update: ${plan.length}`);
  console.log(`Questions to rewrite (text <- desc): ${questionCount}`);

  if (!args.apply) {
    console.log('\nDry run only. No updates performed.');
    return;
  }

  let updated = 0;
  for (const item of plan) {
    await patchTemplate(args.domain, item.tpl.id, item.payload);
    updated += 1;
  }

  console.log('\nUpdate complete.');
  console.log(JSON.stringify({ templatesUpdated: updated, questionsRewritten: questionCount }, null, 2));
}

main().catch((e) => {
  console.error(`Failed: ${e?.message || e}`);
  exit(1);
});
