/**
 * Appraisify – Template filtering helpers
 * Shared across pages that need template selection by type/team/role.
 */

const AppraisifyTemplateFilters = (() => {
  function normalizeValue(value) {
    return String(value || '')
      .trim()
      .toLowerCase();
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function matchesTeamOrRole(templateValue, selectedValue, includeGeneric) {
    const selected = normalizeValue(selectedValue);
    if (!selected) return true;

    const current = normalizeValue(templateValue) || 'all';
    if (current === selected) return true;
    if (includeGeneric && current === 'all') return true;
    return false;
  }

  function templateMatches(template, criteria = {}) {
    const selectedType = normalizeValue(criteria.type);
    const templateType = normalizeValue(template?.type);
    if (selectedType && templateType !== selectedType) return false;

    const includeGeneric = !!criteria.includeGeneric;
    if (!matchesTeamOrRole(template?.team, criteria.team, includeGeneric)) return false;
    if (!matchesTeamOrRole(template?.role, criteria.role, includeGeneric)) return false;

    return true;
  }

  function filterTemplates(templates = [], criteria = {}) {
    return templates.filter((template) => templateMatches(template, criteria));
  }

  function renderSelectOptions(selectEl, templates, {
    previousValue = '',
    placeholder = '— Select a template —',
    noMatchLabel = '— No templates match selected filters —',
  } = {}) {
    if (!selectEl) return '';

    const safePlaceholder = escapeHtml(placeholder);
    const hasMatches = Array.isArray(templates) && templates.length > 0;

    selectEl.innerHTML = `<option value="">${safePlaceholder}</option>`;

    if (!hasMatches) {
      selectEl.innerHTML += `<option value="" disabled>${escapeHtml(noMatchLabel)}</option>`;
      selectEl.value = '';
      return '';
    }

    selectEl.innerHTML += templates
      .map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)}</option>`)
      .join('');

    const canKeep = templates.some((template) => String(template.id) === String(previousValue));
    if (canKeep) {
      selectEl.value = String(previousValue);
      return String(previousValue);
    }

    selectEl.value = '';
    return '';
  }

  return {
    normalizeValue,
    filterTemplates,
    renderSelectOptions,
  };
})();
