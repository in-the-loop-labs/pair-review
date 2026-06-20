// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for PRManager._buildWorktreeRecoveryUrl().
 *
 * The worktree-not-found recovery link must preserve auto-analyze state so a
 * retry re-triggers the SAME analysis. In particular it must carry the
 * `council` query param through, since _buildDefaultAnalysisConfig() treats
 * `?council=<id>` as the highest-priority analysis source — dropping it would
 * silently fall back to the repo/default analysis configuration on retry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { URLSearchParams as NativeURLSearchParams } from 'url';

const { PRManager } = require('../../public/js/pr.js');

let saved;

beforeEach(() => {
  saved = {
    window: globalThis.window,
    URLSearchParams: globalThis.URLSearchParams,
  };
  // Use the real URLSearchParams so query parsing/serialization behaves as in
  // the browser.
  globalThis.URLSearchParams = NativeURLSearchParams;
  globalThis.window = { location: { search: '' } };
});

afterEach(() => {
  globalThis.window = saved.window;
  globalThis.URLSearchParams = saved.URLSearchParams;
});

describe('PRManager._buildWorktreeRecoveryUrl', () => {
  let manager;

  beforeEach(() => {
    manager = Object.create(PRManager.prototype);
  });

  it('returns a bare PR URL when auto-analyze was not requested', () => {
    manager._autoAnalyzeRequested = false;
    globalThis.window.location.search = '?analyze=true&council=abc-123';

    const url = manager._buildWorktreeRecoveryUrl('acme', 'widgets', 42);

    expect(url).toBe('/pr/acme/widgets/42');
  });

  it('preserves the council param when auto-analyze was requested', () => {
    manager._autoAnalyzeRequested = true;
    globalThis.window.location.search = '?analyze=true&council=abc-123';

    const url = manager._buildWorktreeRecoveryUrl('acme', 'widgets', 42);

    expect(url).toContain('analyze=true');
    expect(url).toContain('council=abc-123');
  });

  it('preserves the analysisConfigId param when auto-analyze was requested', () => {
    manager._autoAnalyzeRequested = true;
    globalThis.window.location.search = '?analyze=true&analysisConfigId=cfg-7';

    const url = manager._buildWorktreeRecoveryUrl('acme', 'widgets', 42);

    expect(url).toContain('analyze=true');
    expect(url).toContain('analysisConfigId=cfg-7');
    expect(url).not.toContain('council=');
  });

  it('preserves both analysisConfigId and council together', () => {
    manager._autoAnalyzeRequested = true;
    globalThis.window.location.search = '?analyze=true&analysisConfigId=cfg-7&council=abc-123';

    const url = manager._buildWorktreeRecoveryUrl('acme', 'widgets', 42);

    expect(url).toContain('analyze=true');
    expect(url).toContain('analysisConfigId=cfg-7');
    expect(url).toContain('council=abc-123');
  });

  it('only includes analyze=true when no extra params are present', () => {
    manager._autoAnalyzeRequested = true;
    globalThis.window.location.search = '?analyze=true';

    const url = manager._buildWorktreeRecoveryUrl('acme', 'widgets', 42);

    expect(url).toBe('/pr/acme/widgets/42?analyze=true');
  });

  it('encodes owner, repo, and number path segments', () => {
    manager._autoAnalyzeRequested = false;
    globalThis.window.location.search = '';

    const url = manager._buildWorktreeRecoveryUrl('acme corp', 'wid/gets', 9);

    expect(url).toBe('/pr/acme%20corp/wid%2Fgets/9');
  });
});
