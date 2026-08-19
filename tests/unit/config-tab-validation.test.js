// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `_validateConfig` on both council config tabs.
 *
 * The validator has one job: agree with the server about what is savable, so
 * the user learns about a bad config from the panel rather than from a 400.
 * It used to disagree in a specific, reachable way — it read the DOCUMENT while
 * the request carried the ARGUMENT:
 *
 *   - Voice counted `.vc-reviewer` DOM rows via `_getReviewerCount()`, but
 *     `_readConfigFromUI` keeps a reviewer only `if (provider && model)`. A row
 *     whose provider or model `<select>` is empty — the state a saved council
 *     lands in when its provider is no longer available, since
 *     `_populateProviderDropdown` filters unavailable providers out and
 *     `_applyConfigToUI` then assigns an id with no matching option — still
 *     counted. Validation passed, the POST sent `voices: []`, and the server
 *     answered 'config.voices must be a non-empty array'.
 *   - Advanced never checked voices at all, so an enabled level with no
 *     reviewers passed here and hit
 *     'levels.N.voices must be a non-empty array when enabled'.
 *
 * The rules mirrored below live in src/councils/council-validation.js
 * (`validateCouncilFormat` / `validateAdvancedFormat`).
 *
 * The validator also runs on EVERY keystroke, through
 * `_updateSaveButtonStates` → Save As / Export enablement, so it must stay
 * cheap and must never throw on a partial config.
 */

import { describe, it, expect } from 'vitest';

// Loads both tabs with `window.CouncilCrud` — a hard dependency of their shared
// methods, resolved at call time — already installed, and creates the `window`
// this node-env file otherwise lacks. See the helper's header for why.
const { VoiceCentricConfigTab, AdvancedConfigTab } = require('../utils/config-tab-modules.js');

const validate = (TabClass, config) => TabClass.prototype._validateConfig.call({}, config);

const VOICE = { provider: 'claude', model: 'sonnet-4.6' };

describe('VoiceCentricConfigTab._validateConfig', () => {
  const run = (config) => validate(VoiceCentricConfigTab, config);

  it('accepts a config with an enabled level and a voice', () => {
    expect(run({ voices: [VOICE], levels: { 1: true, 2: false, 3: false } }))
      .toEqual({ valid: true, error: null });
  });

  it('rejects a config with no enabled level', () => {
    expect(run({ voices: [VOICE], levels: { 1: false, 2: false, 3: false } }))
      .toEqual({ valid: false, error: 'At least one review level must be enabled.' });
  });

  it('rejects an empty voices list with a message that names the cause', () => {
    // This is the reviewer row whose model select is empty: on screen it exists,
    // in the request it does not.
    const result = run({ voices: [], levels: { 1: true } });

    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      'Add at least one reviewer with both a provider and a model selected.'
    );
  });

  it('rejects a missing voices key', () => {
    expect(run({ levels: { 1: true } }).valid).toBe(false);
  });

  it('ignores the DOM entirely', () => {
    // The old implementation called `this._getReviewerCount()`; a context with
    // no such method would have thrown. Passing the config is now sufficient.
    expect(() => VoiceCentricConfigTab.prototype._validateConfig.call(
      { modal: null },
      { voices: [VOICE], levels: { 1: true } }
    )).not.toThrow();
  });

  it('accepts the legacy object-shaped level values', () => {
    // `_validateConfig` is also handed level maps in the advanced shape when a
    // council is loaded from an older row.
    expect(run({ voices: [VOICE], levels: { 1: { enabled: true } } }).valid).toBe(true);
    expect(run({ voices: [VOICE], levels: { 1: { enabled: false } } }).valid).toBe(false);
  });

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['undefined', undefined],
    ['a config with no levels key', { voices: [VOICE] }],
    ['a config with a null levels key', { voices: [VOICE], levels: null }]
  ])('reports invalid rather than throwing for %s', (_label, config) => {
    let result;
    expect(() => { result = run(config); }).not.toThrow();
    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});

describe('AdvancedConfigTab._validateConfig', () => {
  const run = (config) => validate(AdvancedConfigTab, config);

  it('accepts an enabled level carrying a voice', () => {
    expect(run({
      levels: {
        1: { enabled: true, voices: [VOICE] },
        2: { enabled: false, voices: [] }
      }
    })).toEqual({ valid: true, error: null });
  });

  it('rejects a config with no enabled level', () => {
    expect(run({ levels: { 1: { enabled: false, voices: [] } } }))
      .toEqual({ valid: false, error: 'At least one review level must be enabled.' });
  });

  it('rejects an enabled level with no voices, naming the level', () => {
    const result = run({
      levels: {
        1: { enabled: true, voices: [VOICE] },
        2: { enabled: true, voices: [] }
      }
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe(
      'Level 2 needs at least one reviewer with both a provider and a model selected.'
    );
  });

  it('rejects an enabled level with a missing voices key', () => {
    expect(run({ levels: { 1: { enabled: true } } }).valid).toBe(false);
  });

  it('ignores a DISABLED level with no voices', () => {
    // The server only requires voices on enabled levels, and the panel wipes a
    // disabled level's row list.
    expect(run({
      levels: {
        1: { enabled: true, voices: [VOICE] },
        2: { enabled: false },
        3: { enabled: false, voices: [] }
      }
    }).valid).toBe(true);
  });

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['undefined', undefined],
    ['a null levels key', { levels: null }],
    ['a null level entry', { levels: { 1: null } }]
  ])('reports invalid rather than throwing for %s', (_label, config) => {
    let result;
    expect(() => { result = run(config); }).not.toThrow();
    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe('string');
  });
});

describe('_validateConfig agrees with the server validator', () => {
  const {
    validateCouncilFormat,
    validateAdvancedFormat
  } = require('../../src/councils/council-validation.js');

  // Executable providers are exempt from the level requirement server-side, so
  // inject a lookup that reports none — matching the analysis providers the
  // tabs actually offer.
  const noExecutables = { getProviderClass: () => undefined };

  it('Voice: a config the tab refuses is a config the server refuses', () => {
    const dropped = { voices: [], levels: { 1: true } };

    expect(VoiceCentricConfigTab.prototype._validateConfig.call({}, dropped).valid).toBe(false);
    expect(validateCouncilFormat(dropped, noExecutables))
      .toBe('config.voices must be a non-empty array');
  });

  it('Advanced: a config the tab refuses is a config the server refuses', () => {
    const dropped = {
      levels: {
        1: { enabled: true, voices: [VOICE] },
        2: { enabled: true, voices: [] }
      }
    };

    expect(AdvancedConfigTab.prototype._validateConfig.call({}, dropped).valid).toBe(false);
    expect(validateAdvancedFormat(dropped))
      .toBe('levels.2.voices must be a non-empty array when enabled');
  });

  it('and a config the tab accepts is one the server accepts', () => {
    expect(validateCouncilFormat({ voices: [VOICE], levels: { 1: true } }, noExecutables))
      .toBeNull();
    expect(validateAdvancedFormat({
      levels: {
        1: { enabled: true, voices: [VOICE] },
        2: { enabled: false, voices: [] }
      }
    })).toBeNull();
  });
});
