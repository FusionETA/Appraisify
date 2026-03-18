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

 */

import { storeTokens } from './_lib/auth.js';

// ---------------------------------------------------------------------------
// CRM custom field setup
// Each deal gets proper named fields instead of dumping everything in COMMENTS.
// Fields are created automatically on first install if they don't exist.
// Cached per Vercel cold-start so we only call crm.deal.userfield.list once.
// ---------------------------------------------------------------------------

let _fieldMap = null;

const FIELD_DEFS = [
  { key: 'application', name: 'APP_NAME',      label: 'Application',       type: 'string' },
  { key: 'domain',      name: 'APP_DOMAIN',    label: 'Bitrix Domain',     type: 'string' },
  { key: 'instanceId',  name: 'APP_INST_ID',   label: 'Instance Id',       type: 'string' },
  { key: 'installDate', name: 'APP_INST_DATE', label: 'Installation Date', type: 'date'   },
  { key: 'tier',        name: 'APP_TIER',      label: 'Tier',              type: 'string' },
];

async function getOrCreateDealFields(base) {
  if (_fieldMap) return _fieldMap;

  // Fetch all existing custom deal fields
  const listRes  = await fetch(`${base}/crm.deal.userfield.list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: 0 }),
  });
  const listData = await listRes.json();
  const existing = Array.isArray(listData.result) ? listData.result : [];
  const existingNames = new Set(existing.map(f => f.FIELD_NAME));

  const map = {};
  for (const def of FIELD_DEFS) {
    const fullName = `UF_CRM_${def.name}`;
    if (existingNames.has(fullName)) {
      map[def.key] = fullName;
      console.log(`[store-auth] CRM field exists: ${fullName} (${def.label})`);
    } else {
      const createRes  = await fetch(`${base}/crm.deal.userfield.add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            FIELD_NAME:        def.name,
            LABEL:             def.label,
            EDIT_FORM_LABEL:   { en: def.label },
            LIST_COLUMN_LABEL: { en: def.label },
            USER_TYPE_ID:      def.type,
            SHOW_IN_LIST:      'Y',
            EDIT_IN_LIST:      'Y',
            IS_SEARCHABLE:     'Y',
          },
        }),
      });
      const createData = await createRes.json();
      if (createData.result) {
        map[def.key] = fullName;
        console.log(`[store-auth] CRM field created: ${fullName} (${def.label})`);
      } else {
        console.warn(`[store-auth] Could not create field ${fullName}:`, JSON.stringify(createData));
      }
    }
  }

  _fieldMap = map;
  return map;
}

/**
 * Notify fusioneta's CRM of a new install by creating a deal in the
 * Appraisify Installs pipeline (category 56).
 * Never throws so it can't break the install flow.
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

    // 4. Create deal with proper custom fields
    const crmFields = await getOrCreateDealFields(base);
    const dealFields = {
      TITLE:       `New Install — ${domain}`,
      CATEGORY_ID: 56,
    };
    if (crmFields.application) dealFields[crmFields.application] = 'Appraisify';
    if (crmFields.domain)      dealFields[crmFields.domain]      = domain;
    if (crmFields.instanceId)  dealFields[crmFields.instanceId]  = member_id;
    if (crmFields.installDate) dealFields[crmFields.installDate] = now.split('T')[0]; // YYYY-MM-DD
    if (crmFields.tier)        dealFields[crmFields.tier]        = 'Free';
    if (contactId)             dealFields.CONTACT_IDS            = [contactId];

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
