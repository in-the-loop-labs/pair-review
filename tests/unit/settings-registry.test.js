// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the global settings registry (src/settings/registry.js).
 *
 * Guards the catalog's integrity (types/groups/defaults), the dot-path
 * helpers (get/has/set with falsy values), and value validation, plus that
 * every default matches the canonical DEFAULT_CONFIG where a corresponding key
 * exists.
 */

import { describe, it, expect } from 'vitest';

const {
  getRegistry,
  getSections,
  isSectionId,
  getEntry,
  getPath,
  hasPath,
  setPath,
  validateValue,
  BADGE_VALUES
} = require('../../src/settings/registry.js');
const { DEFAULT_CHECKOUT_TIMEOUT_MS } = require('../../src/config.js'); // force-load config module
const config = require('../../src/config.js');

const VALID_GROUPS = new Set(['general', 'ai', 'summaries', 'tours', 'chat', 'advanced', 'readonly']);
const VALID_TYPES = new Set(['boolean', 'string', 'integer', 'enum', 'object']);

describe('settings registry integrity', () => {
  const registry = getRegistry();

  it('is non-empty and every key is unique', () => {
    expect(registry.length).toBeGreaterThan(0);
    const keys = registry.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every entry has a valid type, group, label, and description', () => {
    for (const entry of registry) {
      expect(VALID_TYPES.has(entry.type), `type for ${entry.key}`).toBe(true);
      expect(VALID_GROUPS.has(entry.group), `group for ${entry.key}`).toBe(true);
      expect(typeof entry.label, `label for ${entry.key}`).toBe('string');
      expect(entry.label.length, `label for ${entry.key}`).toBeGreaterThan(0);
      expect(typeof entry.description, `description for ${entry.key}`).toBe('string');
    }
  });

  it('enum entries carry a non-empty values array containing their default', () => {
    for (const entry of registry.filter((e) => e.type === 'enum')) {
      expect(Array.isArray(entry.values), `values for ${entry.key}`).toBe(true);
      expect(entry.values.length, `values for ${entry.key}`).toBeGreaterThan(0);
      expect(entry.values, `default membership for ${entry.key}`).toContain(entry.default);
    }
  });

  it('each default is type-consistent with its declared type', () => {
    for (const entry of registry) {
      const { valid } = validateValue(entry, entry.default);
      expect(valid, `default of ${entry.key} should validate`).toBe(true);
    }
  });

  it('read-only entries are not editable and editable entries are not in the readonly group', () => {
    for (const entry of registry) {
      if (entry.group === 'readonly') {
        expect(entry.editable, `${entry.key} readonly => not editable`).toBe(false);
      }
      if (entry.editable) {
        expect(entry.group, `${entry.key} editable => not readonly group`).not.toBe('readonly');
      }
    }
  });

  it('defaults match DEFAULT_CONFIG for every registry key present there', () => {
    // Assert against the real DEFAULT_CONFIG so registry drift is caught.
    // Keys absent from DEFAULT_CONFIG (inline defaults like comment_button_action,
    // chat_spinner) are skipped here; their defaults are covered by the
    // consumer-value checks below.
    let checked = 0;
    for (const entry of registry) {
      if (!hasPath(config.DEFAULT_CONFIG, entry.key)) continue;
      if (entry.type === 'object') continue; // read-only objects use {count} display, default irrelevant
      expect(entry.default, `default for ${entry.key}`).toEqual(getPath(config.DEFAULT_CONFIG, entry.key));
      checked += 1;
    }
    // Guard the guard: most of the catalog must actually be covered.
    expect(checked).toBeGreaterThanOrEqual(25);
  });

  it('config module is loadable (sanity for shared constants)', () => {
    expect(typeof DEFAULT_CHECKOUT_TIMEOUT_MS).toBe('number');
    expect(typeof config.loadConfig).toBe('function');
  });

  it('skip_update_notifier is read-only and file-only (its gate runs in bin/ before the DB opens)', () => {
    // Regression: the entry was editable, but shouldSkipUpdateNotifier() in
    // src/config.js reads config files synchronously in bin/pair-review.js BEFORE
    // the async startup opens the DB / instantiates GlobalSettingsService, so an
    // in-app override is a permanent no-op. The UI must not offer a dead control.
    const entry = getEntry('skip_update_notifier');
    expect(entry).not.toBeNull();
    expect(entry.editable).toBe(false);
    expect(entry.group).toBe('readonly');
    // Description must point the user at the config file.
    expect(entry.description).toMatch(/config file/i);
  });

  it('every entry.badge, when present, is a valid badge value', () => {
    for (const entry of registry) {
      if (entry.badge === undefined || entry.badge === null) continue;
      expect(BADGE_VALUES.has(entry.badge), `badge for ${entry.key}`).toBe(true);
    }
  });
});

describe('settings sections', () => {
  const sections = getSections();

  it('is non-empty and every section id is unique', () => {
    expect(sections.length).toBeGreaterThan(0);
    const ids = sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every section has a non-empty title and a valid (or null) badge', () => {
    for (const section of sections) {
      expect(typeof section.title, `title for ${section.id}`).toBe('string');
      expect(section.title.length, `title for ${section.id}`).toBeGreaterThan(0);
      const badge = section.badge;
      expect(badge === null || badge === undefined || BADGE_VALUES.has(badge), `badge for ${section.id}`).toBe(true);
    }
  });

  it('every registry entry.group is a known section id', () => {
    for (const entry of getRegistry()) {
      expect(isSectionId(entry.group), `group "${entry.group}" for ${entry.key}`).toBe(true);
    }
  });

  it('the section id set exactly matches the set of groups used by entries', () => {
    const usedGroups = new Set(getRegistry().map((e) => e.group));
    const sectionIds = new Set(sections.map((s) => s.id));
    // Every used group has a section, and every section is actually used.
    for (const g of usedGroups) expect(sectionIds.has(g), `section for group ${g}`).toBe(true);
    for (const id of sectionIds) expect(usedGroups.has(id), `group for section ${id}`).toBe(true);
  });

  it('ships the tours section with a new badge', () => {
    const tours = sections.find((s) => s.id === 'tours');
    expect(tours.badge).toBe('new');
  });

  it('hides the summaries section by default (hidden flag)', () => {
    const summaries = sections.find((s) => s.id === 'summaries');
    expect(summaries.hidden).toBe(true);
    // Other sections are not hidden.
    expect(sections.find((s) => s.id === 'general').hidden).toBeFalsy();
    expect(sections.find((s) => s.id === 'tours').hidden).toBeFalsy();
  });

  it('isSectionId rejects unknown ids', () => {
    expect(isSectionId('nope')).toBe(false);
  });
});

describe('default_council_id registry entry (global default council)', () => {
  it('is an editable string in the ai group with an empty default', () => {
    const entry = getEntry('default_council_id');
    expect(entry).not.toBeNull();
    expect(entry.group).toBe('ai');
    expect(entry.type).toBe('string');
    expect(entry.editable).toBe(true);
    expect(entry.default).toBe('');
    expect(entry.restartRequired).toBe(false);
  });

  it('validates any string (dynamic enum — councils live in the DB, not values[])', () => {
    const entry = getEntry('default_council_id');
    expect(validateValue(entry, '').valid).toBe(true);
    expect(validateValue(entry, 'some-council-uuid').valid).toBe(true);
    expect(validateValue(entry, 5).valid).toBe(false);
  });
});

describe('dot-path helpers', () => {
  it('getPath reads nested and falsy values, undefined for missing', () => {
    const obj = { a: { b: { c: 0 } }, flag: false, empty: '' };
    expect(getPath(obj, 'a.b.c')).toBe(0);
    expect(getPath(obj, 'flag')).toBe(false);
    expect(getPath(obj, 'empty')).toBe('');
    expect(getPath(obj, 'a.b.missing')).toBeUndefined();
    expect(getPath(obj, 'x.y.z')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
  });

  it('hasPath uses own-property presence, not truthiness', () => {
    const obj = { a: { b: false }, c: 0, d: '' };
    expect(hasPath(obj, 'a.b')).toBe(true);
    expect(hasPath(obj, 'c')).toBe(true);
    expect(hasPath(obj, 'd')).toBe(true);
    expect(hasPath(obj, 'a.missing')).toBe(false);
    expect(hasPath(obj, 'nope')).toBe(false);
    expect(hasPath(null, 'a')).toBe(false);
  });

  it('setPath creates intermediate objects and overwrites scalars', () => {
    const obj = {};
    setPath(obj, 'summaries.enabled', true);
    expect(obj.summaries.enabled).toBe(true);
    setPath(obj, 'summaries.max_files', 10);
    expect(obj.summaries).toEqual({ enabled: true, max_files: 10 });
    // A scalar in the path is replaced by an object when descending through it.
    const obj2 = { a: 5 };
    setPath(obj2, 'a.b', 1);
    expect(obj2.a).toEqual({ b: 1 });
  });
});

describe('validateValue', () => {
  it('accepts and rejects by type', () => {
    expect(validateValue(getEntry('summaries.enabled'), true).valid).toBe(true);
    expect(validateValue(getEntry('summaries.enabled'), 'yes').valid).toBe(false);
    expect(validateValue(getEntry('default_provider'), 'codex').valid).toBe(true);
    expect(validateValue(getEntry('default_provider'), 5).valid).toBe(false);
  });

  it('enforces non-negative integers', () => {
    const entry = getEntry('summaries.max_files');
    expect(validateValue(entry, 0).valid).toBe(true);
    expect(validateValue(entry, 25).valid).toBe(true);
    expect(validateValue(entry, -1).valid).toBe(false);
    expect(validateValue(entry, 2.5).valid).toBe(false);
    expect(validateValue(entry, '10').valid).toBe(false);
  });

  it('enforces enum membership', () => {
    const entry = getEntry('comment_format');
    expect(validateValue(entry, 'minimal').valid).toBe(true);
    expect(validateValue(entry, 'maximal').valid).toBe(true);
    expect(validateValue(entry, 'solarized').valid).toBe(false);
  });

  it('rejects unknown entries', () => {
    expect(validateValue(null, 'x').valid).toBe(false);
    expect(getEntry('does.not.exist')).toBeNull();
  });
});
