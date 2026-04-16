/**
 * Appraisify – Custom metadata options (type/team/role)
 * Stores custom select options in localStorage so admins can reuse them.
 */

const AppraisifyMetaOptions = (() => {
  const STORAGE_KEY = 'appraisify_custom_meta_options_v1';

  function readStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { type: [], team: [], role: [] };
      const parsed = JSON.parse(raw);
      return {
        type: Array.isArray(parsed.type) ? parsed.type : [],
        team: Array.isArray(parsed.team) ? parsed.team : [],
        role: Array.isArray(parsed.role) ? parsed.role : [],
      };
    } catch (_) {
      return { type: [], team: [], role: [] };
    }
  }

  function writeStore(store) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  function normalizeValue(label) {
    return String(label || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 48);
  }

  function ensureOption(selectEl, value, label) {
    if (!selectEl || !value || !label) return;
    const exists = Array.from(selectEl.options).some(o => o.value === value);
    if (exists) return;
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    opt.dataset.custom = '1';
    selectEl.appendChild(opt);
  }

  function load(selectId, kind) {
    const selectEl = document.getElementById(selectId);
    if (!selectEl) return;
    const store = readStore();
    (store[kind] || []).forEach(item => {
      ensureOption(selectEl, item.value, item.label);
    });
  }

  function addCustom(selectId, kind, promptLabel) {
    const selectEl = document.getElementById(selectId);
    if (!selectEl) return null;

    const label = window.prompt(`Enter custom ${promptLabel}:`);
    if (!label) return null;
    const trimmed = label.trim();
    if (!trimmed) return null;

    const value = normalizeValue(trimmed);
    if (!value) {
      alert(`Invalid ${promptLabel}. Please use letters and numbers.`);
      return null;
    }

    ensureOption(selectEl, value, trimmed);
    selectEl.value = value;

    const store = readStore();
    if (!Array.isArray(store[kind])) store[kind] = [];
    if (!store[kind].some(item => item.value === value)) {
      store[kind].push({ value, label: trimmed });
      writeStore(store);
    }

    return { value, label: trimmed };
  }

  function ensureValue(selectId, value, fallbackLabel) {
    const selectEl = document.getElementById(selectId);
    if (!selectEl || !value) return;
    const exists = Array.from(selectEl.options).some(o => o.value === value);
    if (!exists) ensureOption(selectEl, value, fallbackLabel || value);
    selectEl.value = value;
  }

  function ensureOptionValue(selectId, value, fallbackLabel) {
    const selectEl = document.getElementById(selectId);
    if (!selectEl || !value) return;
    const exists = Array.from(selectEl.options).some(o => o.value === value);
    if (!exists) ensureOption(selectEl, value, fallbackLabel || value);
  }

  function removeCustom(selectId, kind) {
    const selectEl = document.getElementById(selectId);
    if (!selectEl) return { ok: false, reason: 'missing_select' };

    const opt = selectEl.options[selectEl.selectedIndex];
    if (!opt) return { ok: false, reason: 'no_selection' };
    if (opt.dataset.custom !== '1') return { ok: false, reason: 'not_custom' };

    const value = opt.value;
    const store = readStore();
    if (!Array.isArray(store[kind])) store[kind] = [];
    store[kind] = store[kind].filter(item => item.value !== value);
    writeStore(store);

    selectEl.removeChild(opt);
    if (selectEl.options.length > 0) {
      selectEl.selectedIndex = 0;
    }

    return { ok: true, value };
  }

  function removeCustomByValue(selectId, kind, value) {
    const selectEl = document.getElementById(selectId);
    if (!selectEl || !value) return { ok: false, reason: 'missing_args' };

    const option = Array.from(selectEl.options).find(o => o.value === value);
    if (option && option.dataset.custom !== '1') {
      return { ok: false, reason: 'not_custom' };
    }
    const removed = removeCustomValue(kind, value);
    if (!removed.ok && removed.reason !== 'not_found') return removed;

    if (option) {
      const wasSelected = option.selected;
      selectEl.removeChild(option);
      if (wasSelected && selectEl.options.length > 0) {
        selectEl.selectedIndex = 0;
      }
    }

    return { ok: true, value };
  }

  function removeCustomValue(kind, value) {
    if (!kind || !value) return { ok: false, reason: 'missing_args' };
    const store = readStore();
    if (!Array.isArray(store[kind])) store[kind] = [];
    const before = store[kind].length;
    store[kind] = store[kind].filter(item => item.value !== value);
    if (store[kind].length === before) return { ok: false, reason: 'not_found' };
    writeStore(store);
    return { ok: true, value };
  }

  function listCustom(kind) {
    const store = readStore();
    return Array.isArray(store[kind]) ? store[kind] : [];
  }

  function seedDefaults(defaults) {
    const SEED_KEY = 'appraisify_defaults_seeded_v1';
    if (localStorage.getItem(SEED_KEY)) return;
    const store = readStore();
    ['type', 'team', 'role'].forEach((kind) => {
      if (!Array.isArray(defaults[kind])) return;
      if (!Array.isArray(store[kind])) store[kind] = [];
      defaults[kind].forEach(({ value, label }) => {
        if (!value || !label) return;
        if (!store[kind].some(item => item.value === value)) {
          store[kind].push({ value, label });
        }
      });
    });
    writeStore(store);
    localStorage.setItem(SEED_KEY, '1');
  }

  function addCustomValue(kind, label) {
    if (!kind) return { ok: false, reason: 'missing_kind' };
    const trimmed = String(label || '').trim();
    if (!trimmed) return { ok: false, reason: 'empty_label' };

    const value = normalizeValue(trimmed);
    if (!value) return { ok: false, reason: 'invalid_label' };

    const store = readStore();
    if (!Array.isArray(store[kind])) store[kind] = [];
    if (store[kind].some(item => item.value === value)) {
      return { ok: false, reason: 'duplicate', value, label: trimmed };
    }

    store[kind].push({ value, label: trimmed });
    writeStore(store);
    return { ok: true, value, label: trimmed };
  }

  return {
    load,
    addCustom,
    addCustomValue,
    seedDefaults,
    ensureValue,
    ensureOptionValue,
    removeCustom,
    removeCustomByValue,
    removeCustomValue,
    listCustom,
  };
})();
