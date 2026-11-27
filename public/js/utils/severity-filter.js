// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Severity sort and filter for AI suggestions in the Review panel.
 *
 * AI suggestions carry `severity` of "critical", "medium" or "minor"; praise
 * and older suggestions have none, which this module treats as "none".
 * The state is plain data so AIPanel can persist it per review:
 *   { sort: 'file' | 'severity', hidden: ['minor', 'none', ...] }
 * Only AI suggestions are filtered; user comments and external threads always
 * pass, and sort after every AI suggestion when sorting by severity.
 */
(function () {
  /** Severity levels, most severe first. "none" covers praise and unset. */
  const SEVERITY_LEVELS = ['critical', 'medium', 'minor', 'none'];

  const SEVERITY_LABELS = {
    critical: 'Critical',
    medium: 'Medium',
    minor: 'Minor',
    none: 'No severity'
  };

  const SORT_MODES = ['file', 'severity'];

  /**
   * Other names providers use for the three levels. Severity is free text
   * from the provider (executable providers pass a tool's own value through),
   * so "high" must not fall into "none" with praise.
   */
  const SEVERITY_ALIASES = {
    blocker: 'critical',
    severe: 'critical',
    high: 'critical',
    major: 'critical',
    error: 'critical',
    moderate: 'medium',
    warning: 'medium',
    low: 'minor',
    trivial: 'minor',
    info: 'minor',
    nit: 'minor'
  };

  /** @returns {'critical'|'medium'|'minor'|'none'} */
  function normalizeSeverity(severity) {
    const value = typeof severity === 'string' ? severity.trim().toLowerCase() : '';
    if (Object.hasOwn(SEVERITY_ALIASES, value)) return SEVERITY_ALIASES[value];
    return SEVERITY_LEVELS.includes(value) && value !== 'none' ? value : 'none';
  }

  /** @returns {{sort: string, hidden: string[]}} */
  function defaultSeverityState() {
    return { sort: 'file', hidden: [] };
  }

  /**
   * Validate state from storage or callers: unknown sort modes fall back to
   * 'file', unknown or repeated levels are dropped.
   * @param {*} raw - Object or JSON string
   * @returns {{sort: string, hidden: string[]}}
   */
  function parseSeverityState(raw) {
    let value = raw;
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw);
      } catch {
        return defaultSeverityState();
      }
    }
    if (!value || typeof value !== 'object') return defaultSeverityState();
    const sort = SORT_MODES.includes(value.sort) ? value.sort : 'file';
    const hiddenInput = Array.isArray(value.hidden) ? value.hidden : [];
    // Keep canonical order so equal states serialize the same way
    const hidden = SEVERITY_LEVELS.filter(level => hiddenInput.includes(level));
    return { sort, hidden };
  }

  /** True when the state differs from the default (file order, nothing hidden). */
  function isSeverityStateDefault(state) {
    const parsed = parseSeverityState(state);
    return parsed.sort === 'file' && parsed.hidden.length === 0;
  }

  function isFinding(item) {
    return item?._itemType === 'finding';
  }

  /**
   * Drop AI suggestions whose severity is hidden. Other items pass.
   * @param {Array} items - Items with _itemType
   * @param {{hidden: string[]}} state
   * @returns {{items: Array, hiddenCount: number}}
   */
  function filterBySeverity(items, state) {
    const hidden = new Set(parseSeverityState(state).hidden);
    const list = Array.isArray(items) ? items : [];
    if (hidden.size === 0) return { items: [...list], hiddenCount: 0 };
    const kept = list.filter(item => !isFinding(item) || !hidden.has(normalizeSeverity(item.severity)));
    return { items: kept, hiddenCount: list.length - kept.length };
  }

  /** Sort rank: severity index for AI suggestions, after all of them for anything else. */
  function severityRank(item) {
    if (!isFinding(item)) return SEVERITY_LEVELS.length;
    return SEVERITY_LEVELS.indexOf(normalizeSeverity(item.severity));
  }

  /**
   * Stable sort by severity, most severe first. Items of equal rank keep
   * their incoming order, so pass items already in file order.
   * @param {Array} items
   * @returns {Array} New array
   */
  function sortBySeverity(items) {
    const list = Array.isArray(items) ? items : [];
    return list
      .map((item, index) => ({ item, index, rank: severityRank(item) }))
      .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
      .map(entry => entry.item);
  }

  /**
   * Filter then (when state.sort is 'severity') sort.
   * @returns {{items: Array, hiddenCount: number}}
   */
  function applySeverityState(items, state) {
    const parsed = parseSeverityState(state);
    const result = filterBySeverity(items, parsed);
    if (parsed.sort === 'severity') result.items = sortBySeverity(result.items);
    return result;
  }

  const SeverityFilter = {
    SEVERITY_LEVELS,
    SEVERITY_LABELS,
    SORT_MODES,
    normalizeSeverity,
    defaultSeverityState,
    parseSeverityState,
    isSeverityStateDefault,
    filterBySeverity,
    sortBySeverity,
    applySeverityState
  };

  if (typeof window !== 'undefined') {
    window.SeverityFilter = SeverityFilter;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SeverityFilter;
  }
})();
