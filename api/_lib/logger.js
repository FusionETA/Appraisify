/**
 * Appraisify – Persistent activity logger (Upstash Redis backed)
 *
 * Log streams:
 *   portals/{domain}/logs/YYYY-MM-DD.json  — appraisal events per portal
 *   portals/{domain}/logs/ai/YYYY-MM-DD.json — AI interactions per portal
 *   logs/errors/YYYY-MM-DD.json            — API errors across all portals
 *   logs/installs/YYYY-MM-DD.json          — install/uninstall events (global)
 *
 * Each file is a JSON array of entries. Files rotate daily.
 * Files older than LOG_RETAIN_DAYS are automatically deleted when a new
 * daily file is created (runs at most once per day per log stream).
 */

import { blobFind, blobGet, blobPut, blobList, blobDelete } from './kv.js';

const LOG_RETAIN_DAYS = 30;

const today = () => new Date().toISOString().split('T')[0]; // YYYY-MM-DD

function cutoffDate() {
  const d = new Date();
  d.setDate(d.getDate() - LOG_RETAIN_DAYS);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD of the oldest file to keep
}

/** Delete log files under `prefix` that are older than LOG_RETAIN_DAYS. */
async function _cleanup(prefix) {
  try {
    const blobs = await blobList(prefix);
    const cutoff = cutoffDate();
    for (const blob of blobs) {
      const match = blob.pathname.match(/(\d{4}-\d{2}-\d{2})\.json$/);
      if (match && match[1] < cutoff) {
        await blobDelete(blob.url);
        console.log('[logger] Deleted old log:', blob.pathname);
      }
    }
  } catch (e) {
    console.error('[logger] Cleanup failed for', prefix, ':', e.message);
  }
}

/**
 * Append an entry to a daily JSON array log file.
 * When the file is brand-new (first write of the day), runs cleanup in the
 * background so old files are pruned at most once per day per stream.
 */
async function _append(path, prefix, entry) {
  let entries = [];
  let isNewFile = true;

  try {
    const blob = await blobFind(path);
    if (blob?.url) {
      isNewFile = false;
      const data = await blobGet(blob.url);
      if (Array.isArray(data)) entries = data;
    }
  } catch (_) { /* unreadable — start fresh */ }

  entries.push({ timestamp: new Date().toISOString(), ...entry });

  try {
    await blobPut(path, entries); // blobPut already JSON.stringifies
  } catch (e) {
    console.error('[logger] Failed to write log to', path, ':', e.message);
  }

  // Prune old files once per day (when today's file is first created)
  if (isNewFile) _cleanup(prefix).catch(() => {});
}

/**
 * Log an appraisal lifecycle event (submission, completion).
 * Stored per portal: portals/{domain}/logs/YYYY-MM-DD.json
 */
export async function logAppraisal(domain, entry) {
  if (!domain) return;
  const prefix = `portals/${domain}/logs/`;
  await _append(`${prefix}${today()}.json`, prefix, { domain, ...entry });
}

/**
 * Log an AI assist interaction per portal.
 * Stored per portal: portals/{domain}/logs/ai/YYYY-MM-DD.json
 * Fire-and-forget friendly — never throws.
 */
export async function logAi(domain, entry) {
  try {
    if (!domain) return;
    const prefix = `portals/${domain}/logs/ai/`;
    await _append(`${prefix}${today()}.json`, prefix, { domain, ...entry });
  } catch (_) {}
}

/**
 * Log an API error across all portals.
 * Stored globally: logs/errors/YYYY-MM-DD.json
 * Fire-and-forget friendly — never throws.
 */
export async function logError(domain, entry) {
  try {
    const prefix = 'logs/errors/';
    await _append(`${prefix}${today()}.json`, prefix, { domain: domain || 'unknown', ...entry });
  } catch (_) { /* never let logging break the caller */ }
}

/**
 * Log an install or uninstall event globally.
 * Stored globally: logs/installs/YYYY-MM-DD.json
 * Fire-and-forget friendly — never throws.
 */
export async function logInstall(domain, entry) {
  try {
    const prefix = 'logs/installs/';
    await _append(`${prefix}${today()}.json`, prefix, { domain: domain || 'unknown', ...entry });
  } catch (_) {}
}
