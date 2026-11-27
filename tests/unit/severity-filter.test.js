// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const SeverityFilter = require('../../public/js/utils/severity-filter.js');
const {
  normalizeSeverity,
  defaultSeverityState,
  parseSeverityState,
  isSeverityStateDefault,
  filterBySeverity,
  sortBySeverity,
  applySeverityState
} = SeverityFilter;

const finding = (id, severity) => ({ id, severity, _itemType: 'finding' });
const comment = (id) => ({ id, _itemType: 'comment' });
const ids = (items) => items.map(i => i.id);

describe('normalizeSeverity', () => {
  it('maps known levels case-insensitively', () => {
    expect(normalizeSeverity('critical')).toBe('critical');
    expect(normalizeSeverity(' Medium ')).toBe('medium');
    expect(normalizeSeverity('MINOR')).toBe('minor');
  });

  it('treats missing or unknown severity as "none"', () => {
    expect(normalizeSeverity(undefined)).toBe('none');
    expect(normalizeSeverity(null)).toBe('none');
    expect(normalizeSeverity('')).toBe('none');
    expect(normalizeSeverity('blocker')).toBe('none');
    expect(normalizeSeverity(3)).toBe('none');
  });
});

describe('parseSeverityState', () => {
  it('accepts a valid object or JSON string', () => {
    expect(parseSeverityState({ sort: 'severity', hidden: ['minor'] }))
      .toEqual({ sort: 'severity', hidden: ['minor'] });
    expect(parseSeverityState('{"sort":"file","hidden":["none","critical"]}'))
      .toEqual({ sort: 'file', hidden: ['critical', 'none'] });
  });

  it('drops unknown and repeated levels, and unknown sort modes', () => {
    expect(parseSeverityState({ sort: 'random', hidden: ['minor', 'minor', 'bogus'] }))
      .toEqual({ sort: 'file', hidden: ['minor'] });
  });

  it('falls back to the default for invalid input', () => {
    expect(parseSeverityState('not json')).toEqual(defaultSeverityState());
    expect(parseSeverityState(null)).toEqual(defaultSeverityState());
    expect(parseSeverityState(42)).toEqual(defaultSeverityState());
    expect(parseSeverityState({ hidden: 'minor' })).toEqual(defaultSeverityState());
  });
});

describe('isSeverityStateDefault', () => {
  it('is true only for file order with nothing hidden', () => {
    expect(isSeverityStateDefault(defaultSeverityState())).toBe(true);
    expect(isSeverityStateDefault({ sort: 'severity', hidden: [] })).toBe(false);
    expect(isSeverityStateDefault({ sort: 'file', hidden: ['none'] })).toBe(false);
  });
});

describe('filterBySeverity', () => {
  const items = [finding(1, 'critical'), finding(2, 'minor'), comment(3), finding(4, undefined), finding(5, 'medium')];

  it('passes everything when nothing is hidden', () => {
    const result = filterBySeverity(items, defaultSeverityState());
    expect(ids(result.items)).toEqual([1, 2, 3, 4, 5]);
    expect(result.hiddenCount).toBe(0);
    expect(result.items).not.toBe(items);
  });

  it('hides AI suggestions of hidden levels and never hides other items', () => {
    const result = filterBySeverity(items, { hidden: ['minor', 'none'] });
    expect(ids(result.items)).toEqual([1, 3, 5]);
    expect(result.hiddenCount).toBe(2);
  });

  it('handles a missing list', () => {
    expect(filterBySeverity(undefined, { hidden: ['minor'] })).toEqual({ items: [], hiddenCount: 0 });
  });
});

describe('sortBySeverity', () => {
  it('orders most severe first, keeps file order within a level, and puts non-AI items last', () => {
    const items = [
      comment('c1'), finding('m1', 'minor'), finding('n1', undefined), finding('k1', 'critical'),
      finding('d1', 'medium'), finding('k2', 'CRITICAL'), comment('c2'), finding('m2', 'minor')
    ];
    expect(ids(sortBySeverity(items))).toEqual(['k1', 'k2', 'd1', 'm1', 'm2', 'n1', 'c1', 'c2']);
  });

  it('does not modify the input', () => {
    const items = [finding(1, 'minor'), finding(2, 'critical')];
    sortBySeverity(items);
    expect(ids(items)).toEqual([1, 2]);
  });
});

describe('applySeverityState', () => {
  const items = [finding(1, 'minor'), finding(2, 'critical'), finding(3, 'medium')];

  it('filters only, in file order, by default sort', () => {
    expect(ids(applySeverityState(items, { sort: 'file', hidden: ['medium'] }).items)).toEqual([1, 2]);
  });

  it('filters then sorts by severity', () => {
    const result = applySeverityState(items, { sort: 'severity', hidden: ['minor'] });
    expect(ids(result.items)).toEqual([2, 3]);
    expect(result.hiddenCount).toBe(1);
  });
});
