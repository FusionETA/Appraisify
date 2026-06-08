/**
 * Appraisify – AI Question Assistant (Vercel Serverless Function)
 *
 * Proxies chat turns and single-question improvement requests to Groq.
 * Keeps the API key server-side.
 *
 * Env vars required:
 *   GROQ_API_KEY  — from console.groq.com (free tier available)
 */

import { loadTokens } from './_lib/auth.js';
import { parseBody, resolveDomain } from './_lib/utils.js';
import { logError, logAi } from './_lib/logger.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

function buildSystemPrompt(context) {
  const ctx  = context || {};
  const mode = ctx.mode || 'builder';

  if (mode === 'setup') {
    return `You are an expert HR consultant helping a company set up their complete performance appraisal system inside Appraisify.

Your goal is to understand the company and then generate a full suite of appraisal templates tailored to them.

PHASE 1 — Gather information (do this first, ask 2–3 questions at a time):
Ask about:
- Company industry / sector (e.g. tech, retail, healthcare, finance)
- Company size and structure (approximate headcount, main departments)
- Role levels used (e.g. Junior, Mid, Senior, Manager, Director, or custom levels)
- Types of reviews needed (Annual, Probation, Quarterly, PIP, 360°, etc.)
- Any specific performance focus areas or company values

Do NOT generate templates until you have enough information to make them specific and relevant. Ask follow-up questions if answers are vague. Aim for at least 3–4 exchanges before generating.

PHASE 2 — Propose a plan:
Once you have enough context, briefly list the templates you'll create (e.g. "I'll generate 6 templates: Annual Review for Engineering × Senior/Mid/Junior, Probation Review for Sales × Senior/Junior"). Ask for confirmation or adjustments before generating.

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

  if (!GROQ_API_KEY) {
    return res.status(503).json({
      error: 'ai_not_configured',
      error_description: 'GROQ_API_KEY is not set on the server.',
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
    // Groq uses OpenAI-compatible format — system prompt as a system message
    const groqMessages = [
      { role: 'system', content: buildSystemPrompt(context) },
      ...messages.map(m => ({ role: m.role, content: String(m.content || '') })),
    ];

    const response = await fetch(GROQ_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model:       GROQ_MODEL,
        messages:    groqMessages,
        temperature: 0.7,
        max_tokens:  1500,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      let groqErr = errText;
      try { groqErr = JSON.parse(errText)?.error?.message || errText; } catch {}
      const errDesc = `Groq ${response.status}: ${groqErr}`;
      logError(domain, { event: 'ai_error', source: 'ai-assist', error: 'groq_error', message: errDesc }).catch(() => {});
      logAi(domain, {
        event: 'ai_request',
        mode: context.mode || 'builder',
        context: { type: context.type, team: context.team, role: context.role },
        messageCount: messages.length,
        userMessage: lastUserMsg.slice(0, 500),
        success: false,
        error: errDesc,
        durationMs: Date.now() - startMs,
      }).catch(() => {});
      return res.status(502).json({ error: 'ai_request_failed', error_description: errDesc });
    }

    const data  = await response.json();
    const reply = data?.choices?.[0]?.message?.content || '';

    if (!reply) {
      return res.status(502).json({ error: 'empty_response', error_description: 'No content returned from Groq.' });
    }

    // Log successful interaction
    logAi(domain, {
      event: 'ai_request',
      mode: context.mode || 'builder',
      context: { type: context.type, team: context.team, role: context.role },
      messageCount: messages.length,
      userMessage: lastUserMsg.slice(0, 500),
      aiReply: reply.slice(0, 1000),
      success: true,
      durationMs: Date.now() - startMs,
    }).catch(() => {});

    return res.status(200).json({ reply });

  } catch (e) {
    logError(domain, { event: 'error', source: 'ai-assist', error: e.code || 'ai_failed', message: e.message }).catch(() => {});
    logAi(domain, {
      event: 'ai_request',
      mode: context.mode || 'builder',
      messageCount: messages.length,
      userMessage: lastUserMsg.slice(0, 500),
      success: false,
      error: e.message,
      durationMs: Date.now() - startMs,
    }).catch(() => {});
    return res.status(503).json({ error: 'ai_failed', error_description: e.message });
  }
}
