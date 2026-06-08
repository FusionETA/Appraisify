/**
 * Appraisify – AI Question Assistant (Vercel Serverless Function)
 *
 * Proxies chat turns and single-question improvement requests to the
 * Google Gemini API. Keeps the API key server-side.
 *
 * Env vars required:
 *   GEMINI_API_KEY  — from Google AI Studio (aistudio.google.com/apikey)
 */

import { loadTokens } from './_lib/auth.js';
import { parseBody, resolveDomain } from './_lib/utils.js';
import { logError } from './_lib/logger.js';

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const GEMINI_MODEL    = 'gemini-2.0-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

function buildSystemPrompt(context) {
  const ctx       = context || {};
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

  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      error: 'ai_not_configured',
      error_description: 'GEMINI_API_KEY is not set on the server.',
    });
  }

  const body     = parseBody(req);
  const domain   = resolveDomain(req, body);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const context  = body.context || {};

  if (!domain) return res.status(400).json({ error: 'missing_domain' });
  if (!messages.length) return res.status(400).json({ error: 'missing_messages' });

  // Verify portal is installed
  try {
    const tokens = await loadTokens(domain);
    if (!tokens) return res.status(401).json({ error: 'portal_not_installed' });
  } catch {
    return res.status(401).json({ error: 'portal_not_installed' });
  }

  try {
    // Map client message format → Gemini format (assistant → model)
    const geminiMessages = messages.map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    }));

    const geminiBody = {
      system_instruction: { parts: [{ text: buildSystemPrompt(context) }] },
      contents: geminiMessages,
      generationConfig: { temperature: 0.7, maxOutputTokens: 1500 },
    };

    const GEMINI_URL = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(GEMINI_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(geminiBody),
    });

    if (!response.ok) {
      const errText = await response.text();
      logError(domain, { event: 'ai_error', source: 'ai-assist', error: 'gemini_error', message: errText }).catch(() => {});
      let geminiErr = errText;
      try { geminiErr = JSON.parse(errText)?.error?.message || errText; } catch {}
      return res.status(502).json({ error: 'ai_request_failed', error_description: `Gemini ${response.status}: ${geminiErr}` });
    }

    const data  = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!reply) {
      return res.status(502).json({ error: 'empty_response', error_description: 'No content returned from Gemini.' });
    }

    return res.status(200).json({ reply });

  } catch (e) {
    logError(domain, { event: 'error', source: 'ai-assist', error: e.code || 'ai_failed', message: e.message }).catch(() => {});
    return res.status(503).json({ error: 'ai_failed', error_description: e.message });
  }
}
