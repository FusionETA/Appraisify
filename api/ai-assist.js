/**
 * Appraisify – AI Question Assistant (Vercel Serverless Function)
 *
 * Primary: Google Gemini. Falls back to Groq on quota/rate errors.
 * Keeps all API keys server-side.
 *
 * Env vars required:
 *   GEMINI_API_KEY  — primary provider
 *   GROQ_API_KEY    — fallback provider (free tier)
 */

import { loadTokens } from './_lib/auth.js';
import { parseBody, resolveDomain } from './_lib/utils.js';
import { logError, logAi } from './_lib/logger.js';

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const GEMINI_MODEL    = 'gemini-2.5-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

// Returns { reply, provider } or throws
async function callGemini(systemPrompt, messages, maxTokens = 2000) {
  const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const geminiMessages = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }],
  }));
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents:           geminiMessages,
      generationConfig:   { temperature: 0.7, maxOutputTokens: maxTokens },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    let msg = errText;
    try { msg = JSON.parse(errText)?.error?.message || errText; } catch {}
    const err = new Error(`Gemini ${resp.status}: ${msg}`);
    err.status = resp.status;
    throw err;
  }
  const data  = await resp.json();
  const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!reply) throw new Error('Gemini returned empty response');
  return { reply, provider: 'gemini' };
}

async function callGroq(systemPrompt, messages, maxTokens = 2000) {
  const resp = await fetch(GROQ_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body:    JSON.stringify({
      model:       GROQ_MODEL,
      messages:    [{ role: 'system', content: systemPrompt }, ...messages.map(m => ({ role: m.role, content: String(m.content || '') }))],
      temperature: 0.7,
      max_tokens:  maxTokens,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    let msg = errText;
    try { msg = JSON.parse(errText)?.error?.message || errText; } catch {}
    throw new Error(`Groq ${resp.status}: ${msg}`);
  }
  const data  = await resp.json();
  const reply = data?.choices?.[0]?.message?.content || '';
  if (!reply) throw new Error('Groq returned empty response');
  return { reply, provider: 'groq' };
}

function buildSystemPrompt(context) {
  const ctx  = context || {};
  const mode = ctx.mode || 'builder';

  if (mode === 'setup') {
    const templatesGenerated = ctx.templatesGenerated || 0;
    const templatesRemaining = Math.max(0, 5 - templatesGenerated);

    return `You are an expert HR consultant helping a company set up their complete performance appraisal system inside Appraisify.

Your goal is to understand the company and then generate a full suite of appraisal templates tailored to them.

TEMPLATE LIMIT: You may generate a maximum of 5 templates per session. So far ${templatesGenerated} template(s) have been generated. You have ${templatesRemaining} template(s) remaining.
- If templatesRemaining is 0: Do NOT output any <template> blocks. Inform the user they have reached the 5-template limit for this session and should save their templates or start a new session.
- When proposing a plan, never propose more templates than the remaining slots allow.

PHASE 1 — Gather information (do this first, ask 2–3 questions at a time):
Ask about:
- Company industry / sector (e.g. tech, retail, healthcare, finance)
- Company size and structure (approximate headcount, main departments)
- Role levels used (e.g. Junior, Mid, Senior, Manager, Director, or custom levels)
- Types of reviews needed (Annual, Probation, Quarterly, PIP, 360°, etc.)
- Any specific performance focus areas or company values

Do NOT generate templates until you have enough information to make them specific and relevant. Ask follow-up questions if answers are vague. Aim for at least 3–4 exchanges before generating.

PHASE 2 — Propose a plan:
Once you have enough context, briefly list the templates you'll create (max ${templatesRemaining} more). Ask for confirmation or adjustments before generating.

PHASE 3 — Generate templates:
Output each complete template wrapped in <template> tags as a single JSON object. Here is the EXACT required structure:

<template>{"name":"Annual Review · Engineering · Senior","type":"Annual Review","team":"Engineering","role":"Senior","scopeItems":[{"text":"Code Quality","desc":"How well they write clean, maintainable code"},{"text":"Technical Leadership","desc":"How well they guide and mentor the team"}],"sections":{"scope":[{"section":"Code Quality","text":"How consistently does this employee write clean, well-documented code?","desc":"1 = frequent issues, 5 = consistently excellent"},{"section":"Code Quality","text":"How effectively does this employee handle code reviews?","desc":"1 = rarely reviews, 5 = thorough and constructive"},{"section":"Code Quality","text":"How well does this employee follow coding standards and best practices?","desc":"1 = ignores standards, 5 = champions best practices"},{"section":"Technical Leadership","text":"How effectively does this employee mentor junior team members?","desc":"1 = no mentoring, 5 = actively develops others"},{"section":"Technical Leadership","text":"How well does this employee drive technical decisions for the team?","desc":"1 = avoids decisions, 5 = leads with confidence"},{"section":"Technical Leadership","text":"How proactively does this employee identify and resolve technical risks?","desc":"1 = reactive only, 5 = proactively prevents issues"}],"engagement":[{"section":"Employee Engagement","text":"How satisfied are you with the support you receive from your manager?","desc":"1 = very unsatisfied, 5 = very satisfied"},{"section":"Employee Engagement","text":"How likely are you to recommend this company as a great place to work?","desc":"1 = not likely, 5 = very likely"},{"section":"Employee Engagement","text":"How well does the company support your professional growth?","desc":"1 = no support, 5 = excellent support"}]}}</template>

CRITICAL rules — you MUST follow these exactly:
- The JSON has TWO separate arrays: "sections.scope" (job performance questions) and "sections.engagement" (culture/engagement questions)
- "sections.scope" MUST NOT be empty — it must contain ALL the job performance questions
- "sections.engagement" contains questions about how the employee feels about the company
- For EACH scopeItem, add AT LEAST 3 questions into "sections.scope" using the scopeItem's "text" as the "section" name
- If you have 2 scopeItems, "sections.scope" must have at least 6 questions; 3 scopeItems = at least 9 scope questions
- Include 2–4 scopeItems per template
- Add 3–4 questions in "sections.engagement"
- Questions must be specific to the team and role level
- The "desc" field explains how to score on a 1–5 scale
- Generate all templates in one message, one after another`;
  }

  // Builder mode (single template assistant)
  const type      = ctx.type      || 'General';
  const team      = ctx.team      || 'All Teams';
  const role      = ctx.role      || 'All Roles';
  const workspace = ctx.workspace === 'engagement'
    ? 'employee engagement and company culture'
    : 'scope of work and job performance';

  return `You are an expert HR specialist helping design performance appraisal question sets inside Appraisify.

Current template context:
- Appraisal Type: ${type}
- Target Team: ${team}
- Role Level: ${role}
- Workspace focus: ${workspace}

Your job is to help the user create outstanding appraisal questions through friendly conversation.

IMPORTANT: When you suggest questions, you MUST wrap them in <questions> tags containing a JSON array, exactly like this:
<questions>[{"section":"Section Name","text":"The question text?","desc":"Optional scoring guidance for the reviewer"}]</questions>

Guidelines:
- Respond conversationally and concisely
- Ask clarifying questions when the request is vague
- Group questions into logical sections (3–5 questions per section is ideal)
- Questions must be clear, specific, and scoreable on a 1–5 scale
- The "desc" field should help reviewers understand how to score fairly
- When asked to refine or improve, output a brand new complete <questions> block
- Aim for 6–12 questions total unless the user specifies otherwise`;
}

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!GEMINI_API_KEY && !GROQ_API_KEY) {
    return res.status(503).json({
      error: 'ai_not_configured',
      error_description: 'No AI provider key is configured (GEMINI_API_KEY or GROQ_API_KEY).',
    });
  }

  const body     = parseBody(req);
  const domain   = resolveDomain(req, body);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const context  = body.context || {};
  const startMs  = Date.now();

  if (!domain) return res.status(400).json({ error: 'missing_domain' });
  if (!messages.length) return res.status(400).json({ error: 'missing_messages' });

  // Verify portal is installed
  try {
    const tokens = await loadTokens(domain);
    if (!tokens) return res.status(401).json({ error: 'portal_not_installed' });
  } catch {
    return res.status(401).json({ error: 'portal_not_installed' });
  }

  // Last user message for logging
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';

  try {
    const systemPrompt = buildSystemPrompt(context);
    let result = null;
    let providerError = null;

    // Setup mode generates many full templates — needs much higher token limit
    const maxTokens = (context.mode === 'setup') ? 8000 : 2000;

    // Try Gemini first
    if (GEMINI_API_KEY) {
      try {
        result = await callGemini(systemPrompt, messages, maxTokens);
      } catch (e) {
        providerError = e.message;
        // Fall back to Groq on quota/rate/auth errors
        const shouldFallback = e.status === 429 || e.status === 503 || e.status === 401 || e.status === 402;
        if (!shouldFallback) throw e;
        logError(domain, { event: 'ai_gemini_fallback', source: 'ai-assist', message: e.message }).catch(() => {});
      }
    }

    // Fall back to Groq if Gemini failed or not configured
    if (!result && GROQ_API_KEY) {
      result = await callGroq(systemPrompt, messages, maxTokens);
    }

    if (!result) {
      throw new Error(providerError || 'No AI provider available');
    }

    logAi(domain, {
      event:        'ai_request',
      provider:     result.provider,
      mode:         context.mode || 'builder',
      context:      { type: context.type, team: context.team, role: context.role },
      messageCount: messages.length,
      userMessage:  lastUserMsg.slice(0, 500),
      aiReply:      result.reply.slice(0, 1000),
      success:      true,
      durationMs:   Date.now() - startMs,
    }).catch(() => {});

    return res.status(200).json({ reply: result.reply, provider: result.provider });

  } catch (e) {
    logError(domain, { event: 'error', source: 'ai-assist', error: e.code || 'ai_failed', message: e.message }).catch(() => {});
    logAi(domain, {
      event:        'ai_request',
      mode:         context.mode || 'builder',
      messageCount: messages.length,
      userMessage:  lastUserMsg.slice(0, 500),
      success:      false,
      error:        e.message,
      durationMs:   Date.now() - startMs,
    }).catch(() => {});
    return res.status(503).json({ error: 'ai_failed', error_description: e.message });
  }
}
