/**
 * Appraisify – Store installer OAuth tokens in Vercel Blob (Vercel Serverless Function)
 *
 * Called from the install page right after BX24.init() fires.
 * Stores the installer's OAuth tokens per portal so any user of that portal
 * can trigger privileged CRM calls via /api/bx-proxy.
 *
 * Tokens are stored at: portals/{domain}/auth.json
 *
 * Env vars required:
 *   BLOB_READ_WRITE_TOKEN — from Vercel dashboard → Storage → Blob → Connect
 */

import { storeTokens } from './lib/auth.js';

/**
 * Notify fusioneta's CRM of a new install by creating a deal in the
 * Appraisify Installs pipeline (category 56).
 * Fires-and-forgets — never throws so it can't break the install flow.
 */
async function notifyInstall(domain, member_id, access_token) {
  const webhookBase = process.env.INSTALL_NOTIFY_WEBHOOK;
  if (!webhookBase) {
    console.warn('[store-auth] INSTALL_NOTIFY_WEBHOOK not set — skipping install notify');
    return;
  }

  try {
    // 1. Fetch installer's profile from their own portal
    let firstName = '', lastName = '', email = '', phone = '', position = '';
    try {
      const profileRes = await fetch(
        `https://${domain}/rest/user.current?auth=${encodeURIComponent(access_token)}`
      );
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        const u  = profileData.result || {};
        firstName = u.NAME      || '';
        lastName  = u.LAST_NAME || '';
        email     = Array.isArray(u.EMAIL)          ? (u.EMAIL[0]?.VALUE          || '') : (u.EMAIL          || '');
        phone     = Array.isArray(u.PERSONAL_PHONE) ? (u.PERSONAL_PHONE[0]?.VALUE || '') : (u.PERSONAL_PHONE || '');
        position  = u.WORK_POSITION || '';
      }
    } catch (profileErr) {
      console.warn('[store-auth] Install notify: could not fetch installer profile:', profileErr.message);
    }

    const base = webhookBase.replace(/\/$/, '');
    const now  = new Date().toISOString();

    // 2. Check if a deal already exists for this domain (reinstall case)
    const searchRes = await fetch(`${base}/crm.deal.list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: { CATEGORY_ID: 56, '%TITLE': domain },
        select: ['ID', 'TITLE'],
        order:  { ID: 'ASC' },
      }),
    });
    const searchData = await searchRes.json();
    const existing   = Array.isArray(searchData.result) ? searchData.result[0] : null;

    if (existing) {
      // Reinstall — add a timeline comment to the existing deal
      const fullName = [firstName, lastName].filter(Boolean).join(' ');
      const commentRes = await fetch(`${base}/crm.timeline.comment.add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            ENTITY_TYPE: 'deal',
            ENTITY_ID:   existing.ID,
            COMMENT:     `♻️ Reinstalled on ${now}\nInstaller: ${fullName || '(unknown)'} | ${email || '(unknown)'}`,
          },
        }),
      });
      const commentData = await commentRes.json();
      console.log(`[store-auth] Install notify: reinstall comment added to deal #${existing.ID} for ${domain} (comment id=${commentData.result})`);
      return;
    }

    // 3. New install — create installer as a Contact (if we have enough info)
    let contactId = null;
    if (firstName || lastName || email) {
      const contactFields = {
        NAME:      firstName,
        LAST_NAME: lastName,
        POST:      position,
        WEB:       [{ VALUE: `https://${domain}`, VALUE_TYPE: 'WORK' }],
      };
      if (email) contactFields.EMAIL = [{ VALUE: email, VALUE_TYPE: 'WORK' }];
      if (phone) contactFields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'WORK' }];

      const contactRes  = await fetch(`${base}/crm.contact.add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: contactFields }),
      });
      const contactData = await contactRes.json();
      if (contactData.result) {
        contactId = contactData.result;
        console.log(`[store-auth] Install notify: contact #${contactId} created for ${firstName} ${lastName} (${domain})`);
      } else {
        console.warn('[store-auth] Install notify: contact creation returned:', JSON.stringify(contactData));
      }
    }

    // 4. Create deal with each piece of info in its own field
    const dealFields = {
      TITLE:              `New Install — ${domain}`,
      CATEGORY_ID:        56,
      SOURCE_DESCRIPTION: `https://${domain}`,
      ADDITIONAL_INFO:    `Member ID: ${member_id}\nInstalled: ${now}`,
    };
    if (contactId) dealFields.CONTACT_IDS = [contactId];

    const dealRes  = await fetch(`${base}/crm.deal.add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: dealFields }),
    });
    const dealData = await dealRes.json();
    if (dealData.result) {
      const linked = contactId ? `contact #${contactId} linked` : 'no contact — missing name+email';
      console.log(`[store-auth] Install notify: deal #${dealData.result} created for ${domain} (${linked})`);
    } else {
      console.warn('[store-auth] Install notify: deal creation returned:', JSON.stringify(dealData));
    }

  } catch (e) {
    console.error('[store-auth] Install notify failed (non-fatal):', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { access_token, refresh_token, domain, member_id } = req.body || {};

  if (!access_token || !member_id || !domain) {
    return res.status(400).json({
      error: 'missing_params',
      error_description: 'access_token, member_id and domain are required',
    });
  }

  try {
    await storeTokens(domain, { access_token, refresh_token, domain, member_id });
    console.log(`[store-auth] Stored tokens for ${domain} (member_id=${member_id})`);

    await notifyInstall(domain, member_id, access_token);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[store-auth] Failed:', e.message);
    const status = e.code === 'storage_not_configured' ? 500 : 503;
    return res.status(status).json({
      error: e.code || 'storage_error',
      error_description: e.message,
    });
  }
}
