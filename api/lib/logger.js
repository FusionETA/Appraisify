/**
 * Appraisify – Persistent activity logger (Vercel Blob backed)
 *
 * Two log streams:
 *   portals/{domain}/logs/YYYY-MM-DD.json  — appraisal events per portal
 *   logs/errors/YYYY-MM-DD.json            — API errors across all portals
 *
 * Each file is a JSON array of entries. Files rotate daily, keeping individual
 * files small and old data retained indefinitely in Blob at negligible cost.
 */

import { blobFind, blobGet, blobPut } from './blob.js';

const today = () => new Date().toISOString().split('T')[0]; // YYYY-MM-DD

async function _append(path, entry) {
  // Read existing entries (if file exists)
  let entries = [];
  try {
    const blob = await blobFind(path);
    if (blob?.url) {
      const data = await blobGet(blob.url);
      if (Array.isArray(data)) entries = data;
    }
  } catch (_) { /* new file or unreadable — start fresh */ }

  entries.push({ timestamp: new Date().toISOString(), ...entry });

  try {
    await blobPut(path, entries); // blobPut already JSON.stringifies
  } catch (e) {
    console.error('[logger] Failed to write log to', path, ':', e.message);
  }
}

/**
 * Log an appraisal lifecycle event (submission, completion).
 * Stored per portal: portals/{domain}/logs/YYYY-MM-DD.json
 */
export async function logAppraisal(domain, entry) {
  if (!domain) return;
  await _append(`portals/${domain}/logs/${today()}.json`, { domain, ...entry });
}

/**
 * Log an API error across all portals.
 * Stored globally: logs/errors/YYYY-MM-DD.json
 * Fire-and-forget friendly — never throws.
 */
export async function logError(domain, entry) {
  try {
    await _append(`logs/errors/${today()}.json`, { domain: domain || 'unknown', ...entry });
  } catch (_) { /* never let logging break the caller */ }
}
