/**
 * Generate a test appraisal link token and print the URL.
 * Usage: BLOB_READ_WRITE_TOKEN=xxx node scripts/gen-test-token.mjs
 *
 * Example:
 *   BLOB_READ_WRITE_TOKEN=xxx node scripts/gen-test-token.mjs fusion.bitrix24.com 58114 self
 */

import { argv, env } from 'process';

const [,, domain, dealId, phase] = argv;

if (!domain || !dealId || !phase) {
  console.error('Usage: BLOB_READ_WRITE_TOKEN=xxx node scripts/gen-test-token.mjs <domain> <dealId> <phase>');
  console.error('  phase: self | reviewer | partner');
  console.error('Example: BLOB_READ_WRITE_TOKEN=xxx node scripts/gen-test-token.mjs fusion.bitrix24.com 58114 self');
  process.exit(1);
}

if (!env.BLOB_READ_WRITE_TOKEN) {
  console.error('Error: BLOB_READ_WRITE_TOKEN env var required');
  process.exit(1);
}

const APP_URL = env.APP_URL || 'https://appraisify-v2-123.vercel.app';

// ─── Inline minimal token generator ───────────────────────────────────────

const BLOB_BASE = 'https://blob.vercel-storage.com';

function makeHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function blobPut(pathname, value) {
  const resp = await fetch(`${BLOB_BASE}/${pathname}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.BLOB_READ_WRITE_TOKEN}`,
      'x-api-version': '7',
      'Content-Type': 'application/json',
      'x-add-random-suffix': '0',
    },
    body: JSON.stringify(value),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Blob PUT failed: HTTP ${resp.status} — ${text}`);
  }
  return resp.json();
}

const TOKEN_TTL_DAYS = 7;

async function generateToken(domain, dealId, phase) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = makeHex(bytes);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await blobPut(`tokens/${token}.json`, { domain, dealId: Number(dealId), phase, expiresAt, usedAt: null });
  return token;
}

// ─── Main ──────────────────────────────────────────────────────────────────

const token = await generateToken(domain, dealId, phase);

console.log('\n✅ Test token generated!\n');
console.log('Token:', token);
console.log('\nForm URL:');
console.log(`  ${APP_URL}/appraisal?token=${token}`);
console.log('\nDirect link API test:');
console.log(`  curl "${APP_URL}/api/appraisal-link?token=${token}"`);
console.log('\nToken expires: 7 days from now');
console.log('');
