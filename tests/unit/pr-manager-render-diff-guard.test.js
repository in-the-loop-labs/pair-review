// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * Task #19: renderDiff empty-placeholder guard.
 *
 * A payload with NO file list (changed_files/files undefined, null, or missing)
 * means "unknown — keep the currently rendered diff", NOT an empty diff. The
 * guard bails at the very top, BEFORE any teardown/abort, so a partial refresh
 * response (e.g. /refresh without changed_files) never wipes the rendered files
 * into the "No files changed" placeholder. Only an explicit array (including [])
 * is authoritative and renders (with [] showing the placeholder).
 *
 * This is the fix for the stale-badge e2e where a /refresh payload lacking
 * changed_files blanked the diff.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

// A manager whose renderDiff can run all the way through on the CodeView path,
// with the heavy render + async follow-ups stubbed. Teardown side effects
// (_fileContentsAbort.abort, pierreBridge.destroyAll) and the render entry
// (_renderDiffWithCodeView) are spies so the guard's before/after can be asserted.
function renderableManager() {
  document.body.innerHTML = '<div id="diff-container"></div>';
  const m = Object.create(PRManager.prototype);
  m.generatedFiles = new Map();
  m.pierreBridge = { destroyAll: vi.fn(), renderAll: vi.fn(), _disabled: false };
  m._fileContentsAbort = { abort: vi.fn() };
  m._usesPierreCodeView = () => true;
  m._teardownFileBodyObserver = vi.fn();
  m._createPierreRenderBudget = vi.fn(() => ({}));
  m._renderDiffWithCodeView = vi.fn();
  m.loadContextFiles = vi.fn();
  // hunkSummaryRenderer / _toursEnabled / _tourIsActive stay undefined → skipped.
  return m;
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('PRManager.renderDiff — file-list guard', () => {
  it('renders an explicit file array (teardown runs, renderer gets the files)', () => {
    const m = renderableManager();
    const f1 = { file: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' };
    const f2 = { file: 'b.js', patch: '@@ -1 +1 @@\n-c\n+d\n' };

    m.renderDiff({ changed_files: [f1, f2] });

    expect(m._fileContentsAbort).toBeNull();            // teardown ran (abort + nulled)
    expect(m.pierreBridge.destroyAll).toHaveBeenCalled();
    expect(m._renderDiffWithCodeView).toHaveBeenCalledWith([f1, f2]);
  });

  it('renders an explicit empty array (proceeds; renderer gets [])', () => {
    const m = renderableManager();
    m.renderDiff({ changed_files: [] });

    expect(m.pierreBridge.destroyAll).toHaveBeenCalled();
    expect(m._renderDiffWithCodeView).toHaveBeenCalledWith([]);
  });

  it('accepts the legacy `files` key too', () => {
    const m = renderableManager();
    const f1 = { file: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b\n' };
    m.renderDiff({ files: [f1] });
    expect(m._renderDiffWithCodeView).toHaveBeenCalledWith([f1]);
  });

  it('BAILS on an undefined file list — keeps the current diff, no teardown', () => {
    const m = renderableManager();
    m.renderDiff({ title: 'x' }); // changed_files undefined

    expect(m.pierreBridge.destroyAll).not.toHaveBeenCalled();
    expect(m._fileContentsAbort.abort).not.toHaveBeenCalled();
    expect(m._fileContentsAbort).not.toBeNull();        // NOT torn down
    expect(m._renderDiffWithCodeView).not.toHaveBeenCalled();
  });

  it('BAILS on a null file list', () => {
    const m = renderableManager();
    m.renderDiff({ changed_files: null });

    expect(m.pierreBridge.destroyAll).not.toHaveBeenCalled();
    expect(m._fileContentsAbort.abort).not.toHaveBeenCalled();
    expect(m._renderDiffWithCodeView).not.toHaveBeenCalled();
  });

  it('BAILS on a completely missing payload key', () => {
    const m = renderableManager();
    m.renderDiff({});

    expect(m.pierreBridge.destroyAll).not.toHaveBeenCalled();
    expect(m._renderDiffWithCodeView).not.toHaveBeenCalled();
  });

  it('the guard is BEFORE teardown: neither abort nor destroyAll fires on the undefined path', () => {
    const m = renderableManager();
    m.renderDiff(undefined);        // even a null-ish pr
    m.renderDiff({ changed_files: undefined });

    expect(m._fileContentsAbort.abort).not.toHaveBeenCalled();
    expect(m.pierreBridge.destroyAll).not.toHaveBeenCalled();
  });
});

describe('PRManager._togglePierreEmptyPlaceholder', () => {
  it('adds the .no-diff placeholder when empty and removes it when not', () => {
    const m = Object.create(PRManager.prototype);
    const container = document.createElement('div');

    m._togglePierreEmptyPlaceholder(container, true);
    const placeholder = container.querySelector(':scope > .no-diff');
    expect(placeholder).not.toBeNull();
    expect(placeholder.textContent).toBe('No files changed');

    m._togglePierreEmptyPlaceholder(container, false);
    expect(container.querySelector(':scope > .no-diff')).toBeNull();
  });

  it('does not duplicate the placeholder across repeated empty toggles', () => {
    const m = Object.create(PRManager.prototype);
    const container = document.createElement('div');
    m._togglePierreEmptyPlaceholder(container, true);
    m._togglePierreEmptyPlaceholder(container, true);
    expect(container.querySelectorAll(':scope > .no-diff')).toHaveLength(1);
  });
});

// refreshPR under CodeView must NOT wipe #diff-container with a transient
// spinner: the bridge owns #diff-container (its managed container is a child),
// and the re-render's destroyAll preserves the CodeView↔root binding, so an
// innerHTML wipe would detach that container and leave the spinner up forever.
// The refresh button shows its own spinning state. Legacy mode still shows it.
describe('PRManager.refreshPR — diff-container spinner wipe', () => {
  function manager(usesCodeView) {
    document.body.innerHTML = '<div id="diff-container">EXISTING</div>';
    const m = Object.create(PRManager.prototype);
    m.currentPR = { owner: 'o', repo: 'r', number: 1 };
    m._usesPierreCodeView = () => usesCodeView;
    // Never-resolving fetch: refreshPR runs its SYNCHRONOUS spinner branch and
    // then suspends at the await, so the DOM reflects only that branch.
    global.fetch = vi.fn(() => new Promise(() => {}));
    return m;
  }

  afterEach(() => { delete global.fetch; });

  it('does NOT wipe #diff-container under CodeView (rendered diff preserved)', () => {
    const m = manager(true);
    m.refreshPR().catch(() => {});
    expect(document.getElementById('diff-container').innerHTML).toBe('EXISTING');
  });

  it('shows the loading spinner in legacy mode', () => {
    const m = manager(false);
    m.refreshPR().catch(() => {});
    const container = document.getElementById('diff-container');
    expect(container.querySelector('.loading')).not.toBeNull();
    expect(container.textContent).toContain('Refreshing pull request...');
  });
});
