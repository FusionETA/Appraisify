const TemplatesAPI = (() => {
  function normalizeDomain(raw) {
    if (!raw) return '';
    let value = String(raw).trim().toLowerCase();
    if (!value) return '';

    if (value.includes('://')) {
      try {
        value = new URL(value).hostname.toLowerCase();
      } catch (_) {}
    }

    value = value.split('/')[0];
    value = value.split('?')[0];
    return value;
  }

  function getDomainFromContext() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = normalizeDomain(params.get('DOMAIN') || params.get('domain'));
    if (fromUrl) {
      localStorage.setItem('appraisify_domain', fromUrl);
      return fromUrl;
    }

    if (typeof BX24 !== 'undefined' && BX24.getAuth) {
      try {
        const auth = BX24.getAuth();
        const fromAuth = normalizeDomain(auth && auth.domain);
        if (fromAuth) {
          localStorage.setItem('appraisify_domain', fromAuth);
          return fromAuth;
        }
      } catch (_) {}
    }

    const fromStorage = normalizeDomain(localStorage.getItem('appraisify_domain'));
    if (fromStorage) return fromStorage;

    return '';
  }

  function buildUrl(id, includeArchived) {
    const domain = getDomainFromContext();
    if (!domain) {
      const err = new Error('Unable to resolve portal domain context. Open the app from Bitrix24 and retry.');
      err.code = 'tenant_context_missing';
      throw err;
    }

    const params = new URLSearchParams();
    params.set('domain', domain);
    if (id) params.set('id', String(id));
    if (includeArchived) params.set('includeArchived', 'true');
    return `/api/templates?${params.toString()}`;
  }

  async function parseJson(resp) {
    let json = {};
    try {
      json = await resp.json();
    } catch (_) {}

    if (!resp.ok || json.error) {
      const msg = json.error_description || json.error || `Request failed (${resp.status})`;
      const err = new Error(msg);
      err.code = json.error || `http_${resp.status}`;
      err.status = resp.status;
      throw err;
    }

    return json;
  }

  async function listTemplates(opts = {}) {
    const resp = await fetch(buildUrl('', !!opts.includeArchived));
    const json = await parseJson(resp);
    return Array.isArray(json.templates) ? json.templates : [];
  }

  async function getTemplate(id) {
    const resp = await fetch(buildUrl(id));
    const json = await parseJson(resp);
    return json.template || null;
  }

  async function createTemplate(payload) {
    const url = buildUrl('');
    const domain = new URL(url, window.location.origin).searchParams.get('domain');
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-appraisify-domain': domain,
      },
      body: JSON.stringify({ ...payload, domain }),
    });
    const json = await parseJson(resp);
    return json.template || null;
  }

  async function updateTemplate(id, payload) {
    const url = buildUrl(id);
    const domain = new URL(url, window.location.origin).searchParams.get('domain');
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-appraisify-domain': domain,
      },
      body: JSON.stringify({ ...payload, domain }),
    });
    const json = await parseJson(resp);
    return json.template || null;
  }

  async function deleteTemplate(id) {
    const url = buildUrl(id);
    const domain = new URL(url, window.location.origin).searchParams.get('domain');
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'x-appraisify-domain': domain,
      },
      body: JSON.stringify({ domain }),
    });
    const json = await parseJson(resp);
    return json.ok === true;
  }

  async function resetToDefaults() {
    const url = buildUrl('');
    const domain = new URL(url, window.location.origin).searchParams.get('domain');
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-appraisify-domain': domain,
      },
      body: JSON.stringify({ action: 'reset_to_defaults', domain }),
    });
    const json = await parseJson(resp);
    return Array.isArray(json.templates) ? json.templates : [];
  }

  async function getTemplateForDeal(dealId) {
    const url = buildUrl('');
    const domain = new URL(url, window.location.origin).searchParams.get('domain');
    const resp = await fetch(`/api/appraisal-template?dealId=${encodeURIComponent(dealId)}&domain=${encodeURIComponent(domain)}`, {
      headers: { 'x-appraisify-domain': domain },
    });
    return parseJson(resp);
  }

  async function setTemplateForDeal(dealId, templateId, meta = {}) {
    const url = buildUrl('');
    const domain = new URL(url, window.location.origin).searchParams.get('domain');
    const resp = await fetch('/api/appraisal-template', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-appraisify-domain': domain,
      },
      body: JSON.stringify({ dealId, templateId, domain, ...meta }),
    });
    const json = await parseJson(resp);
    return json.ok === true;
  }

  return {
    listTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    resetToDefaults,
    getTemplateForDeal,
    setTemplateForDeal,
    getDomainFromContext,
  };
})();
