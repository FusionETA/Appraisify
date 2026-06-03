/**
 * Appraisify – PDF Report Generator (Vercel Serverless Function)
 *
 * Fetches deal data from Bitrix24 using per-tenant OAuth tokens,
 * loads the associated template from Upstash Redis, and generates a PDF report.
 *
 * Env vars required:

 *   BX24_CLIENT_ID         — for token refresh
 *   BX24_CLIENT_SECRET     — for token refresh
 */

import { blobGet, blobFind } from './_lib/kv.js';
import { fetchDeal } from './_lib/bitrix.js';
import { parseBody, resolveDomain } from './_lib/utils.js';
import { logError } from './_lib/logger.js';

function extractTemplateIdFromDeal(deal) {
  const comments = String(deal?.COMMENTS || '');
  const m = comments.match(/\[APPRAISIFY_TEMPLATE_ID:([A-Za-z0-9_-]+)\]/);
  return m ? m[1] : '';
}

function stageLabel(stageId) {
  const short = String(stageId || '').includes(':') ? String(stageId).split(':')[1] : String(stageId || '');
  const map = {
    INITIALIZED: 'Initialized - Reviewee Pending',
    REVIEWERPENDING:            'Reviewer Pending',
    PARTNERPENDING:             'Partner Pending',
    SUBMITTED:                  'Submitted',
  };
  return map[short] || short || '-';
}

function parseEmployeeName(title) {
  const t = String(title || '').trim();
  if (!t) return '-';
  return t.split(/\s*[–\-]\s*/)[0].trim() || '-';
}

function getField(deal, actor, idx) {
  // actor: 'REVIEWEE_RATING' | 'REVIEWEE_COMMENT' | 'REVIEWER_RATING' | etc.
  const key = `UF_CRM_QUESTION_${idx}_${actor}`;
  return deal ? deal[key] : null;
}

function scoreOrDash(value) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function textOrDash(value) {
  const out = String(value === null || value === undefined ? '' : value).trim();
  return out || '-';
}

function avgOrDash(values) {
  const nums = values.map(v => Number(v)).filter(v => Number.isFinite(v));
  if (!nums.length) return '-';
  return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
}

function normalizeQuestions(template) {
  const all = []
    .concat(Array.isArray(template?.sections?.scope) ? template.sections.scope : [])
    .concat(Array.isArray(template?.sections?.engagement) ? template.sections.engagement : []);

  return all.map((q, i) => ({
    index: i + 1,
    section: String(q?.section || 'General'),
    text: String(q?.text || ''),
  }));
}

function wrapText(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return ['-'];
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  });
  if (line) lines.push(line);
  return lines;
}

function escapePdfText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildSimplePdf(lines) {
  const pageWidth = 612;
  const pageHeight = 792;
  const marginX = 42;
  const topY = 760;
  const bottomY = 40;
  const lineHeight = 14;

  const pages = [];
  let current = [];
  let y = topY;

  lines.forEach((line) => {
    if (y < bottomY) {
      pages.push(current);
      current = [];
      y = topY;
    }
    current.push({ y, text: line.text, size: line.size || 10 });
    y -= line.height || lineHeight;
  });
  if (current.length) pages.push(current);

  const objects = [];
  const addObj = (src) => { objects.push(src); return objects.length; };

  const fontObj = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageObjIds = [];
  pages.forEach((pageLines) => {
    const contentParts = ['BT'];
    contentParts.push(`/F1 10 Tf`);
    pageLines.forEach((ln) => {
      contentParts.push(`/F1 ${ln.size} Tf`);
      contentParts.push(`1 0 0 1 ${marginX} ${ln.y} Tm`);
      contentParts.push(`(${escapePdfText(ln.text)}) Tj`);
    });
    contentParts.push('ET');
    const contentStream = contentParts.join('\n');
    const contentObj = addObj(`<< /Length ${Buffer.byteLength(contentStream, 'utf8')} >>\nstream\n${contentStream}\nendstream`);
    const pageObj = addObj(`<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`);
    pageObjIds.push(pageObj);
  });

  const kids = pageObjIds.map(id => `${id} 0 R`).join(' ');
  const pagesObj = addObj(`<< /Type /Pages /Kids [${kids}] /Count ${pageObjIds.length} >>`);
  const catalogObj = addObj(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

  pageObjIds.forEach((id) => {
    objects[id - 1] = objects[id - 1].replace('PAGES_REF', `${pagesObj} 0 R`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, idx) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  return Buffer.from(pdf, 'utf8');
}

async function loadTemplateForDeal(domain, deal) {
  const dealId = String(deal?.ID || '').trim();
  if (!dealId) {
    const err = new Error('missing_deal_id');
    err.code = 'missing_deal_id';
    throw err;
  }

  // Try the Redis-stored deal-to-template mapping first
  let templateId = null;
  const mappingBlob = await blobFind(`portals/${domain}/appraisal-templates/${dealId}.json`);
  if (mappingBlob) {
    const mapping = await blobGet(mappingBlob.url);
    if (mapping && mapping.templateId) templateId = mapping.templateId;
  }

  // Fall back to template ID embedded in the deal's COMMENTS field
  if (!templateId) {
    templateId = extractTemplateIdFromDeal(deal);
  }

  if (!templateId) {
    const err = new Error('template_mapping_not_found');
    err.code = 'template_mapping_not_found';
    throw err;
  }

  const tplBlob = await blobFind(`portals/${domain}/templates/${templateId}.json`);
  if (!tplBlob) {
    const err = new Error('template_not_found');
    err.code = 'template_not_found';
    throw err;
  }

  const parsed = await blobGet(tplBlob.url);
  if (!parsed) {
    const err = new Error('template_not_found');
    err.code = 'template_not_found';
    throw err;
  }

  return parsed;
}

function buildReportLines(deal, domain, template) {
  const lines = [];
  const questions = normalizeQuestions(template);
  const selfScores = [];
  const reviewerScores = [];
  const partnerScores = [];

  lines.push({ text: 'Appraisify Performance Appraisal Report', size: 16, height: 20 });
  lines.push({ text: `Generated: ${new Date().toISOString()}`, size: 9, height: 16 });
  lines.push({ text: `Domain: ${domain}`, size: 10 });
  lines.push({ text: `Deal ID: ${deal.ID || '-'}`, size: 10 });
  lines.push({ text: `Employee: ${parseEmployeeName(deal.TITLE)}`, size: 10 });
  lines.push({ text: `Cycle: ${textOrDash(deal.TITLE)}`, size: 10 });
  lines.push({ text: `Status: ${stageLabel(deal.STAGE_ID)}`, size: 10, height: 18 });
  lines.push({ text: `Template: ${textOrDash(template.name || template.id)}`, size: 10, height: 18 });

  questions.forEach((q) => {
    const selfRaw = getField(deal, 'REVIEWEE_RATING', q.index);
    const revRaw  = getField(deal, 'REVIEWER_RATING', q.index);
    const partRaw = getField(deal, 'PARTNER_RATING',  q.index);
    if (selfRaw !== null && selfRaw !== undefined && selfRaw !== '') selfScores.push(selfRaw);
    if (revRaw !== null && revRaw !== undefined && revRaw !== '') reviewerScores.push(revRaw);
    if (partRaw !== null && partRaw !== undefined && partRaw !== '') partnerScores.push(partRaw);
  });

  const selfAvg = avgOrDash(selfScores);
  const reviewerAvg = avgOrDash(reviewerScores);
  const partnerAvg = avgOrDash(partnerScores);
  const totalAvg = avgOrDash([selfAvg, reviewerAvg, partnerAvg].filter(v => v !== '-'));
  lines.push({ text: `Averages -> Self: ${selfAvg} | Reviewer: ${reviewerAvg} | Partner: ${partnerAvg} | Total: ${totalAvg}`, size: 10 });
  function fmtTs(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
  }
  lines.push({ text: `Self Submitted: ${fmtTs(deal.UF_CRM_REVIEWEE_SUBMITTED_AT)} | Reviewer Submitted: ${fmtTs(deal.UF_CRM_REVIEWER_SUBMITTED_AT)} | Partner Submitted: ${fmtTs(deal.UF_CRM_PARTNER_SUBMITTED_AT)}`, size: 9, height: 20 });

  questions.forEach((q) => {
    lines.push({ text: `Q${q.index} [${textOrDash(q.section)}]`, size: 11, height: 16 });
    wrapText(`Question: ${textOrDash(q.text)}`, 90).forEach(t => lines.push({ text: t, size: 10 }));

    const selfScore     = scoreOrDash(getField(deal, 'REVIEWEE_RATING',  q.index));
    const reviewerScore = scoreOrDash(getField(deal, 'REVIEWER_RATING',  q.index));
    const partnerScore  = scoreOrDash(getField(deal, 'PARTNER_RATING',   q.index));
    lines.push({ text: `Self Score: ${selfScore} | Reviewer Score: ${reviewerScore} | Partner Score: ${partnerScore}`, size: 10 });

    wrapText(`Self Comment: ${textOrDash(getField(deal, 'REVIEWEE_COMMENT', q.index))}`, 90).forEach(t => lines.push({ text: t, size: 10 }));
    wrapText(`Reviewer Comment: ${textOrDash(getField(deal, 'REVIEWER_COMMENT', q.index))}`, 90).forEach(t => lines.push({ text: t, size: 10 }));
    wrapText(`Partner Comment: ${textOrDash(getField(deal, 'PARTNER_COMMENT',  q.index))}`, 90).forEach(t => lines.push({ text: t, size: 10 }));
    lines.push({ text: ' ', size: 10, height: 10 });
  });

  if (!questions.length) {
    lines.push({ text: 'No template questions were found for this appraisal.', size: 10 });
  }

  return lines;
}

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = parseBody(req);
  const dealId = String(req.query?.dealId || body.dealId || '').trim();
  const domain = resolveDomain(req, body);

  if (!dealId) {
    return res.status(400).json({ error: 'missing_deal_id' });
  }
  if (!domain) {
    return res.status(400).json({
      error: 'tenant_context_missing',
      error_description: 'Could not resolve portal domain from request context.',
    });
  }

  try {
    const deal = await fetchDeal(domain, dealId);
    if (!deal) {
      return res.status(404).json({ error: 'deal_not_found' });
    }

    const template = await loadTemplateForDeal(domain, deal);
    const lines = buildReportLines(deal, domain, template);
    const pdf = buildSimplePdf(lines);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="appraisal-${dealId}.pdf"`);
    return res.status(200).send(pdf);

  } catch (e) {
    const code = e.code || 'pdf_generation_failed';
    logError(domain, { event: 'error', source: 'appraisal-pdf', error: code, message: e.message, dealId: dealId || null }).catch(() => {});
    const status = code === 'template_mapping_not_found' || code === 'template_not_found' || code === 'deal_not_found'
      ? 404
      : code === 'tenant_context_missing' || code === 'missing_deal_id'
      ? 400
      : 503;

    return res.status(status).json({
      error: code,
      error_description: e.message || 'Failed to generate appraisal PDF',
    });
  }
}
