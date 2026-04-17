/**
 * Appraisify – Appraisal Templates CRUD (Vercel Serverless Function)
 *
 * Multi-tenant: all data is scoped per portal under portals/{domain}/templates/
 *
 * Redis keys:
 *   portals/{domain}/templates/{id}.json  — individual template
 *
 * Env vars required:

 */

import { blobPut, blobGet, blobFind, blobList } from './_lib/kv.js';
import { normalizeDomain, parseBody, resolveDomain } from './_lib/utils.js';

const MAX_QUESTIONS_PER_WORKSPACE = 20;

function parseBody_(req) { return parseBody(req); }

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `tpl_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  }
  return `tpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function templatePath(domain, id) {
  return `portals/${domain}/templates/${id}.json`;
}

function templatePrefix(domain) {
  return `portals/${domain}/templates/`;
}

function validateQuestion(q, idx, workspace, errors) {
  if (!q || typeof q !== 'object') {
    errors.push(`${workspace}[${idx}] must be an object`);
    return;
  }

  const section = String(q.section || '').trim();
  const text = String(q.text || '').trim();
  if (!section) errors.push(`${workspace}[${idx}].section is required`);
  if (!text) errors.push(`${workspace}[${idx}].text is required`);

  if (q.desc !== undefined && q.desc !== null && typeof q.desc !== 'string') {
    errors.push(`${workspace}[${idx}].desc must be a string`);
  }
}

function validateTemplatePayload(payload, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'name')) {
    const name = String(payload.name || '').trim();
    if (!name) errors.push('name is required');
    if (name.length > 120) errors.push('name must be 120 chars or fewer');
    out.name = name;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'type')) {
    const type = String(payload.type || '').trim();
    if (!type) errors.push('type is required');
    if (type.length > 60) errors.push('type must be 60 chars or fewer');
    out.type = type;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'team')) {
    const team = String(payload.team || 'all').trim() || 'all';
    if (team.length > 60) errors.push('team must be 60 chars or fewer');
    out.team = team;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'role')) {
    const role = String(payload.role || 'all').trim() || 'all';
    if (role.length > 60) errors.push('role must be 60 chars or fewer');
    out.role = role;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'scopeItems')) {
    const items = Array.isArray(payload.scopeItems) ? payload.scopeItems : [];
    out.scopeItems = items
      .map(i => String(i || '').trim())
      .filter(Boolean)
      .slice(0, 100);
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'sections')) {
    const sections = payload.sections || {};
    const scope = Array.isArray(sections.scope) ? sections.scope : [];
    const engagement = Array.isArray(sections.engagement) ? sections.engagement : [];

    if (scope.length > MAX_QUESTIONS_PER_WORKSPACE) {
      errors.push(`sections.scope exceeds max ${MAX_QUESTIONS_PER_WORKSPACE}`);
    }
    if (engagement.length > MAX_QUESTIONS_PER_WORKSPACE) {
      errors.push(`sections.engagement exceeds max ${MAX_QUESTIONS_PER_WORKSPACE}`);
    }

    scope.forEach((q, idx) => validateQuestion(q, idx, 'sections.scope', errors));
    engagement.forEach((q, idx) => validateQuestion(q, idx, 'sections.engagement', errors));

    out.sections = {
      scope: scope.map(q => ({
        _uid: String(q._uid || '').trim() || makeId(),
        section: String(q.section || '').trim(),
        text: String(q.text || '').trim(),
        desc: q.desc == null ? '' : String(q.desc),
      })),
      engagement: engagement.map(q => ({
        _uid: String(q._uid || '').trim() || makeId(),
        section: String(q.section || '').trim(),
        text: String(q.text || '').trim(),
        desc: q.desc == null ? '' : String(q.desc),
      })),
    };
  }

  return { ok: errors.length === 0, errors, value: out };
}

function fromStoredTemplate(raw, domain) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: String(raw.id || ''),
    name: String(raw.name || ''),
    type: String(raw.type || 'annual'),
    team: String(raw.team || 'all'),
    role: String(raw.role || 'all'),
    scopeItems: Array.isArray(raw.scopeItems) ? raw.scopeItems : [],
    sections: {
      scope: Array.isArray(raw.sections?.scope) ? raw.sections.scope : [],
      engagement: Array.isArray(raw.sections?.engagement) ? raw.sections.engagement : [],
    },
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    archived: !!raw.archived,
    version: Number(raw.version || 1),
    domain,
  };
}

function scopeQuestions(section, questions) {
  return questions.map((text) => ({ section, text, desc: '' }));
}

function getDefaultTemplateSeeds() {
  return [
    // ── Annual Review ────────────────────────────────────────────────────────
    // Generic template suitable for all teams and roles.
    // For mid-year / quarterly cycles, use the Year field (e.g. "2026 H1", "2026 Q3")
    // rather than creating separate template types.
    {
      name: 'Annual Review',
      type: 'Annual',
      team: 'all',
      role: 'all',
      scopeItems: [],
      sections: {
        scope: [
          ...scopeQuestions('Core Performance', [
            'Consistently delivers work that meets or exceeds quality standards.',
            'Completes tasks on time and follows through on commitments.',
            'Takes ownership of outcomes and holds themselves accountable.',
            'Adapts effectively to changing priorities and circumstances.',
          ]),
          ...scopeQuestions('Collaboration & Communication', [
            'Communicates clearly and proactively with the team and stakeholders.',
            'Contributes positively to team goals and supports colleagues.',
            'Gives and receives feedback constructively.',
            'Maintains professional conduct and a reliable work ethic.',
          ]),
          ...scopeQuestions('Growth & Initiative', [
            'Identifies problems early and proposes practical solutions.',
            'Continuously develops skills relevant to the role.',
            'Shows initiative beyond core responsibilities when appropriate.',
          ]),
        ],
        engagement: scopeQuestions('Employee Engagement', [
          'Feels motivated and engaged in day-to-day work.',
          'Has the tools and resources needed to perform effectively.',
          'Feels their contributions are recognised and valued.',
          'Would recommend this organisation as a great place to work.',
        ]),
      },
    },

    // ── Probation Review ─────────────────────────────────────────────────────
    // Used for employees completing their probationary period.
    {
      name: 'Probation Review',
      type: 'Probation',
      team: 'all',
      role: 'all',
      scopeItems: [],
      sections: {
        scope: [
          ...scopeQuestions('Role Readiness', [
            'Demonstrates a clear understanding of role responsibilities.',
            'Completes assigned tasks independently within expected timeframes.',
            'Has acquired the foundational knowledge and skills required for the role.',
            'Shows progress toward meeting full role competency benchmarks.',
          ]),
          ...scopeQuestions('Workplace Integration', [
            'Adapts to company culture, processes, and ways of working.',
            'Collaborates effectively with teammates and cross-functional colleagues.',
            'Communicates proactively with their manager and team.',
            'Receives and acts on feedback in a constructive manner.',
          ]),
          ...scopeQuestions('Reliability & Conduct', [
            'Maintains acceptable attendance, punctuality, and responsiveness.',
            'Demonstrates alignment with company values and professional standards.',
            'Shows initiative in learning and asking the right questions.',
          ]),
        ],
        engagement: [],
      },
    },

    // ── PIP Review ───────────────────────────────────────────────────────────
    // Used during a Performance Improvement Plan cycle.
    {
      name: 'PIP Review',
      type: 'PIP',
      team: 'all',
      role: 'all',
      scopeItems: [],
      sections: {
        scope: [
          ...scopeQuestions('PIP Progress', [
            'Shows measurable progress on the goals defined in the PIP.',
            'Completes agreed action items by their target dates.',
            'Demonstrates consistent improvement in the identified areas of concern.',
            'Applies recommended process or behaviour changes consistently.',
          ]),
          ...scopeQuestions('Accountability & Conduct', [
            'Takes ownership and accountability for commitments made.',
            'Responds constructively to coaching and managerial feedback.',
            'Improves communication and follow-through with manager and stakeholders.',
            'Reduces recurrence of issues previously identified.',
          ]),
          ...scopeQuestions('Outcome Assessment', [
            'Meets the minimum performance expectations defined for the role.',
            'Shows reliability in attendance, responsiveness, and delivery.',
            'Demonstrates readiness to exit the PIP and return to standard performance management.',
          ]),
        ],
        engagement: [],
      },
    },
  ];
}

async function createTemplateForDomain(domain, payload) {
  const parsed = validateTemplatePayload(payload, { partial: false });
  if (!parsed.ok) {
    const err = new Error(`default_template_invalid: ${parsed.errors.join(', ')}`);
    err.code = 'invalid_default_template';
    throw err;
  }

  const id = makeId();
  const now = new Date().toISOString();
  const doc = {
    id,
    ...parsed.value,
    createdAt: now,
    updatedAt: now,
    archived: false,
    version: 1,
  };

  await blobPut(templatePath(domain, id), doc);
  return fromStoredTemplate(doc, domain);
}

async function listTemplatesForDomain(domain, { includeArchived = false } = {}) {
  const blobs = await blobList(templatePrefix(domain));
  if (!blobs.length) return [];

  const docs = await Promise.all(
    blobs.map(async (blob) => {
      try {
        const raw = await blobGet(blob.url);
        return raw ? fromStoredTemplate(raw, domain) : null;
      } catch (e) {
        console.warn('[templates] Skipping unreadable blob', blob.pathname, e.message);
        return null;
      }
    })
  );

  return docs
    .filter(Boolean)
    .filter(tpl => includeArchived || !tpl.archived)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

async function seedDefaultTemplatesIfEmpty(domain) {
  const blobs = await blobList(templatePrefix(domain));

  if (blobs.length > 0) {
    // Check if any active (non-archived) templates exist
    const docs = await Promise.all(blobs.map(b => blobGet(b.url).catch(() => null)));
    const hasActive = docs.some(doc => doc && doc.archived !== true);
    if (hasActive) return;
  }

  const defaults = getDefaultTemplateSeeds();
  for (const tpl of defaults) {
    await createTemplateForDomain(domain, tpl);
  }
}

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  const body = parseBody_(req);
  const domain = resolveDomain(req, body);
  if (!domain) {
    return res.status(400).json({
      error: 'tenant_context_missing',
      error_description: 'Could not resolve portal domain from request context.',
    });
  }

  const method = req.method;
  const id = String(req.query?.id || body.id || '').trim();
  const includeArchived = String(req.query?.includeArchived || '').toLowerCase() === 'true';

  try {
    if (method === 'GET') {
      if (id) {
        const blob = await blobFind(templatePath(domain, id));
        if (!blob) return res.status(404).json({ error: 'template_not_found' });
        const raw = await blobGet(blob.url);
        if (!raw) return res.status(404).json({ error: 'template_not_found' });
        return res.status(200).json({ template: fromStoredTemplate(raw, domain) });
      }

      await seedDefaultTemplatesIfEmpty(domain);
      const templates = await listTemplatesForDomain(domain, { includeArchived });
      return res.status(200).json({ templates });
    }

    if (method === 'POST' && body.action === 'reset_to_defaults') {
      // Archive every active template for this domain, then re-seed defaults
      const allBlobs = await blobList(templatePrefix(domain));
      if (allBlobs.length > 0) {
        const docs = await Promise.all(allBlobs.map(b => blobGet(b.url).catch(() => null)));
        await Promise.all(docs.map(async (doc) => {
          if (doc && !doc.archived) {
            await blobPut(templatePath(domain, doc.id), {
              ...doc,
              archived: true,
              updatedAt: new Date().toISOString(),
              version: Number(doc.version || 1) + 1,
            });
          }
        }));
      }
      await seedDefaultTemplatesIfEmpty(domain);
      const templates = await listTemplatesForDomain(domain);
      return res.status(200).json({ ok: true, templates });
    }

    if (method === 'POST') {
      const template = await createTemplateForDomain(domain, body);
      return res.status(200).json({ template });
    }

    if (method === 'PATCH') {
      if (!id) {
        return res.status(400).json({ error: 'missing_id', error_description: 'id is required' });
      }

      const blob = await blobFind(templatePath(domain, id));
      if (!blob) return res.status(404).json({ error: 'template_not_found' });
      const existing = await blobGet(blob.url);
      if (!existing) return res.status(404).json({ error: 'template_not_found' });

      const parsed = validateTemplatePayload(body, { partial: true });
      if (!parsed.ok) {
        return res.status(400).json({ error: 'invalid_payload', errors: parsed.errors });
      }

      const updated = {
        ...existing,
        ...parsed.value,
        id,
        updatedAt: new Date().toISOString(),
        version: Number(existing.version || 1) + 1,
      };

      await blobPut(templatePath(domain, id), updated);
      return res.status(200).json({ template: fromStoredTemplate(updated, domain) });
    }

    if (method === 'DELETE') {
      if (!id) {
        return res.status(400).json({ error: 'missing_id', error_description: 'id is required' });
      }

      const blob = await blobFind(templatePath(domain, id));
      if (!blob) return res.status(404).json({ error: 'template_not_found' });
      const existing = await blobGet(blob.url);
      if (!existing) return res.status(404).json({ error: 'template_not_found' });

      const archived = {
        ...existing,
        archived: true,
        updatedAt: new Date().toISOString(),
        version: Number(existing.version || 1) + 1,
      };

      await blobPut(templatePath(domain, id), archived);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'method_not_allowed' });

  } catch (e) {
    const code = e && e.code;
    const status = code === 'storage_not_configured' ? 500 : 503;
    return res.status(status).json({
      error: code || 'storage_error',
      error_description: e.message || 'Storage operation failed',
    });
  }
}
