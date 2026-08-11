// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the council document format
 * (public/js/utils/council-document.js).
 *
 * Runs in the default Node environment on purpose: the module is required by
 * server code, so building, parsing, and slugging must work with no DOM at all
 * — and exportCouncilToFile must refuse to run there. The browser download path
 * is covered separately in council-document-export.test.js (jsdom).
 */

import { describe, it, expect, vi } from 'vitest';

const {
  COUNCIL_DOCUMENT_VERSION,
  buildCouncilDocument,
  parseCouncilDocument,
  slugifyCouncilName,
  councilFilenameStem,
  exportCouncilToFile
} = require('../../public/js/utils/council-document.js');
// The real validator, to prove the parse hook works against production code and
// not just against mocks.
const { validateCouncilConfig } = require('../../src/councils/council-validation.js');

const councilConfig = {
  voices: [{ provider: 'claude', model: 'opus', tier: 'thorough' }],
  levels: { 1: true, 2: true, 3: false },
  consolidation: { provider: 'claude', model: 'opus' }
};

const advancedConfig = {
  levels: {
    1: { enabled: true, voices: [{ provider: 'claude', model: 'sonnet' }] },
    2: { enabled: false, voices: [] }
  }
};

describe('COUNCIL_DOCUMENT_VERSION', () => {
  it('is 1', () => {
    expect(COUNCIL_DOCUMENT_VERSION).toBe(1);
  });
});

describe('buildCouncilDocument', () => {
  it('builds a voice-centric council document', () => {
    expect(buildCouncilDocument({ name: 'Dream Team', type: 'council', config: councilConfig })).toEqual({
      pair_review_council: 1,
      name: 'Dream Team',
      type: 'council',
      config: councilConfig
    });
  });

  it('builds an advanced council document', () => {
    expect(buildCouncilDocument({ name: 'Deep Dive', type: 'advanced', config: advancedConfig })).toEqual({
      pair_review_council: 1,
      name: 'Deep Dive',
      type: 'advanced',
      config: advancedConfig
    });
  });

  it('includes description when non-empty', () => {
    const doc = buildCouncilDocument({
      name: 'Dream Team',
      type: 'council',
      config: councilConfig,
      description: '  Three voices, one verdict  '
    });
    expect(doc.description).toBe('Three voices, one verdict');
  });

  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   ']
  ])('omits the description key when it is %s', (_label, description) => {
    const doc = buildCouncilDocument({ name: 'Dream Team', type: 'council', config: councilConfig, description });
    expect(doc).not.toHaveProperty('description');
  });

  it('trims the name', () => {
    expect(buildCouncilDocument({ name: '  Padded  ', type: 'council', config: councilConfig }).name).toBe('Padded');
  });

  it('keeps the config object by reference (no cloning)', () => {
    expect(buildCouncilDocument({ name: 'Dream Team', type: 'council', config: councilConfig }).config)
      .toBe(councilConfig);
  });

  it.each([
    ['missing name', { type: 'council', config: councilConfig }],
    ['empty name', { name: '', type: 'council', config: councilConfig }],
    ['whitespace name', { name: '  ', type: 'council', config: councilConfig }],
    ['non-string name', { name: 42, type: 'council', config: councilConfig }]
  ])('rejects %s', (_label, params) => {
    expect(() => buildCouncilDocument(params)).toThrow(/name is required/i);
  });

  it.each([
    ['missing type', { name: 'X', config: councilConfig }],
    ['unknown type', { name: 'X', type: 'ensemble', config: councilConfig }],
    ['null type', { name: 'X', type: null, config: councilConfig }]
  ])('rejects %s', (_label, params) => {
    expect(() => buildCouncilDocument(params)).toThrow(/"council" or "advanced"/);
  });

  it.each([
    ['missing config', { name: 'X', type: 'council' }],
    ['null config', { name: 'X', type: 'council', config: null }],
    ['string config', { name: 'X', type: 'council', config: '{}' }],
    ['array config', { name: 'X', type: 'council', config: [] }]
  ])('rejects %s', (_label, params) => {
    expect(() => buildCouncilDocument(params)).toThrow(/config must be an object/i);
  });

  it('rejects a call with no arguments at all', () => {
    expect(() => buildCouncilDocument()).toThrow(/name is required/i);
  });
});

describe('parseCouncilDocument', () => {
  const validDoc = {
    pair_review_council: 1,
    name: 'Dream Team',
    type: 'council',
    config: councilConfig
  };

  it('parses a JSON string', () => {
    expect(parseCouncilDocument(JSON.stringify(validDoc))).toEqual({
      name: 'Dream Team',
      type: 'council',
      config: councilConfig,
      description: undefined
    });
  });

  it('parses an already-parsed object', () => {
    const result = parseCouncilDocument(validDoc);
    expect(result.name).toBe('Dream Team');
    expect(result.type).toBe('council');
    expect(result.config).toEqual(councilConfig);
  });

  it('parses an advanced document', () => {
    const result = parseCouncilDocument({
      pair_review_council: 1,
      name: 'Deep Dive',
      type: 'advanced',
      config: advancedConfig
    });
    expect(result.type).toBe('advanced');
    expect(result.config).toEqual(advancedConfig);
  });

  it('accepts a legacy advanced config using the orchestration key', () => {
    const legacyConfig = { ...advancedConfig, orchestration: { provider: 'claude', model: 'opus' } };
    const result = parseCouncilDocument({
      pair_review_council: 1,
      name: 'Legacy',
      type: 'advanced',
      config: legacyConfig
    });
    expect(result.config.orchestration).toEqual({ provider: 'claude', model: 'opus' });
  });

  it('returns the trimmed description when present', () => {
    const result = parseCouncilDocument({ ...validDoc, description: '  Notes  ' });
    expect(result.description).toBe('Notes');
  });

  it('returns undefined description when absent or blank', () => {
    expect(parseCouncilDocument(validDoc).description).toBeUndefined();
    expect(parseCouncilDocument({ ...validDoc, description: '   ' }).description).toBeUndefined();
  });

  it('trims the name', () => {
    expect(parseCouncilDocument({ ...validDoc, name: '  Padded  ' }).name).toBe('Padded');
  });

  it('round-trips a built document', () => {
    const doc = buildCouncilDocument({
      name: 'Dream Team',
      type: 'council',
      config: councilConfig,
      description: 'Notes'
    });
    expect(parseCouncilDocument(JSON.stringify(doc, null, 2))).toEqual({
      name: 'Dream Team',
      type: 'council',
      config: councilConfig,
      description: 'Notes'
    });
  });

  it('rejects unparseable JSON', () => {
    expect(() => parseCouncilDocument('{ not json')).toThrow(/not valid JSON/i);
  });

  it.each([
    ['null', null],
    ['a number', 7],
    ['an array', [validDoc]],
    ['a JSON array string', '[]']
  ])('rejects %s', (_label, input) => {
    expect(() => parseCouncilDocument(input)).toThrow(/must be a JSON object/i);
  });

  it('rejects a document missing the version field', () => {
    const { pair_review_council: _omitted, ...rest } = validDoc;
    expect(() => parseCouncilDocument(rest)).toThrow(/missing "pair_review_council"/);
  });

  it.each([
    ['a future version', 2],
    ['a string version', '1'],
    ['a null version', null]
  ])('rejects %s', (_label, version) => {
    expect(() => parseCouncilDocument({ ...validDoc, pair_review_council: version }))
      .toThrow(/[Uu]nsupported council document version/);
  });

  it.each([
    ['missing name', (doc) => { delete doc.name; }],
    ['empty name', (doc) => { doc.name = ''; }],
    ['whitespace name', (doc) => { doc.name = '   '; }],
    ['non-string name', (doc) => { doc.name = 42; }]
  ])('rejects %s', (_label, mutate) => {
    const doc = { ...validDoc };
    mutate(doc);
    expect(() => parseCouncilDocument(doc)).toThrow(/missing a "name"/);
  });

  it.each([
    ['missing type', (doc) => { delete doc.type; }],
    ['unknown type', (doc) => { doc.type = 'ensemble'; }]
  ])('rejects %s', (_label, mutate) => {
    const doc = { ...validDoc };
    mutate(doc);
    expect(() => parseCouncilDocument(doc)).toThrow(/"type" must be "council" or "advanced"/);
  });

  it.each([
    ['missing config', (doc) => { delete doc.config; }],
    ['null config', (doc) => { doc.config = null; }],
    ['string config', (doc) => { doc.config = 'nope'; }],
    ['array config', (doc) => { doc.config = []; }]
  ])('rejects %s', (_label, mutate) => {
    const doc = { ...validDoc };
    mutate(doc);
    expect(() => parseCouncilDocument(doc)).toThrow(/"config" must be an object/);
  });

  describe('validateConfig hook', () => {
    it('is called with the config and type', () => {
      const validateConfig = vi.fn(() => null);
      parseCouncilDocument(validDoc, { validateConfig });
      expect(validateConfig).toHaveBeenCalledTimes(1);
      expect(validateConfig).toHaveBeenCalledWith(councilConfig, 'council');
    });

    it('surfaces a returned error string as the thrown message', () => {
      const validateConfig = () => 'config.voices must be a non-empty array';
      expect(() => parseCouncilDocument(validDoc, { validateConfig }))
        .toThrow('config.voices must be a non-empty array');
    });

    it('accepts the document when the hook returns null', () => {
      expect(parseCouncilDocument(validDoc, { validateConfig: () => null }).name).toBe('Dream Team');
    });

    it('ignores a non-string, non-null return value', () => {
      expect(parseCouncilDocument(validDoc, { validateConfig: () => false }).name).toBe('Dream Team');
    });

    it('is not called when the document itself is malformed', () => {
      const validateConfig = vi.fn(() => null);
      expect(() => parseCouncilDocument({ ...validDoc, name: '' }, { validateConfig })).toThrow();
      expect(validateConfig).not.toHaveBeenCalled();
    });

    // Everything above drives the hook with a mock, which pins the wiring but
    // not the contract. This one uses the real validator so a signature or
    // return-shape change in council-validation.js is caught here.
    describe('with the real validateCouncilConfig', () => {
      it('accepts a document whose config the validator approves', () => {
        const result = parseCouncilDocument(validDoc, { validateConfig: validateCouncilConfig });
        expect(result.name).toBe('Dream Team');
        expect(result.config).toEqual(councilConfig);
      });

      it('rejects a document with the validator\'s own message', () => {
        // Voices-less council config: fails independently of provider registry state.
        const brokenDoc = { ...validDoc, config: { levels: { 1: true } } };
        expect(() => parseCouncilDocument(brokenDoc, { validateConfig: validateCouncilConfig }))
          .toThrow('config.voices must be a non-empty array');
      });

      it('dispatches on the document type, not the config shape', () => {
        // The same voices-less config is legal in the advanced format.
        const advancedDoc = {
          pair_review_council: 1,
          name: 'Deep Dive',
          type: 'advanced',
          config: advancedConfig
        };
        expect(parseCouncilDocument(advancedDoc, { validateConfig: validateCouncilConfig }).type)
          .toBe('advanced');
      });
    });
  });
});

describe('slugifyCouncilName', () => {
  it.each([
    ['Dream Team', 'dream-team'],
    ['  My Council  ', 'my-council'],
    ['Security_Review!!', 'security-review'],
    ['--Edge--', 'edge'],
    ['Council 2', 'council-2']
  ])('slugs %j to %j', (input, expected) => {
    expect(slugifyCouncilName(input)).toBe(expected);
  });

  it.each([
    ['unicode-only name', '審査会'],
    ['punctuation-only name', '!!!'],
    ['empty string', ''],
    ['whitespace', '   '],
    ['null', null],
    ['undefined', undefined]
  ])('returns the empty string (no fallback) for %s', (_label, input) => {
    expect(slugifyCouncilName(input)).toBe('');
  });

  it('is the only difference from councilFilenameStem: the fallback', () => {
    for (const name of ['Dream Team', 'Security & Perf!', '審査会', '', null]) {
      expect(councilFilenameStem(name)).toBe(slugifyCouncilName(name) || 'council');
    }
  });
});

describe('councilFilenameStem', () => {
  it.each([
    ['Dream Team', 'dream-team'],
    ['Dream  Team', 'dream-team'],
    ['Security & Perf!', 'security-perf'],
    ['  Leading and trailing  ', 'leading-and-trailing'],
    ['--Dashes--', 'dashes'],
    ['Council 2', 'council-2'],
    ['UPPER', 'upper'],
    ['snake_case_name', 'snake-case-name']
  ])('slugs %j to %j', (input, expected) => {
    expect(councilFilenameStem(input)).toBe(expected);
  });

  it.each([
    ['unicode-only name', '審査会'],
    ['punctuation-only name', '!!!'],
    ['empty string', ''],
    ['whitespace', '   '],
    ['null', null],
    ['undefined', undefined]
  ])('falls back to "council" for %s', (_label, input) => {
    expect(councilFilenameStem(input)).toBe('council');
  });
});

describe('exportCouncilToFile (no DOM)', () => {
  it('throws when called server-side', () => {
    expect(typeof document).toBe('undefined');
    expect(() => exportCouncilToFile({ name: 'Dream Team', type: 'council', config: councilConfig }))
      .toThrow(/browser-only/);
  });
});
