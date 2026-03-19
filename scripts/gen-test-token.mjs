/**
 * Generate a test appraisal link token and print the URL.
 * Usage: UPSTASH_REDIS_REST_URL=xxx UPSTASH_REDIS_REST_TOKEN=xxx node scripts/gen-test-token.mjs
 *
 * Example:
 *   UPSTASH_REDIS_REST_URL=xxx UPSTASH_REDIS_REST_TOKEN=xxx node scripts/gen-test-token.mjs fusion.bitrix24.com 58114 self
 */

import { argv, env } from 'process';

const [,, domain, dealId, phase] = argv;

if (!domain || !dealId || !phase) {
  console.error('Usage: UPSTASH_REDIS_REST_URL=xxx UPSTASH_REDIS_REST_TOKEN=xxx node scripts/gen-test-token.mjs <domain> <dealId> <phase>');
  console.error('  phase: self | reviewer | partner');
  console.error('Example: UPSTASH_REDIS_REST_URL=xxx UPSTASH_REDIS_REST_TOKEN=xxx node scripts/gen-test-token.mjs fusion.bitrix24.com 58114 self');
  process.exit(1);
}

if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
  console.error('Error: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars required');
  process.exit(1);
}

const APP_URL = env.APP_URL || 'https://appraisify-v2-123.vercel.app';

// ─── Inline minimal Upstash Redis PUT ─────────────────────────────────────

async function blobPut(key, value) {
  const url  = env.UPSTASH_REDIS_REST_URL;
  const tok  = env.UPSTASH_REDIS_REST_TOKEN;
  const path = ['SET', key, JSON.stringify(value)]
    .map(a => encodeURIComponent(String(a))).join('/');
  const resp = await fetch(`${url}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}` },
  });
  const json = await resp.json();
  if (json.error) throw new Error(`Redis SET failed: ${json.error}`);
}

function makeHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
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
