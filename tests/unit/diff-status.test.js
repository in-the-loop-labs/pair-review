// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * The diff pane's status message.
 *
 * `#diff-status` (a sibling of `#diff-container`) shows loading, error and
 * empty messages; PRManager._setDiffStatus is its only writer and the only
 * code that hides or shows the diff's container. Nothing writes markup into
 * `#diff-container`: its children belong to the diff renderer, and a viewer
 * that owns the container would not notice it being wiped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const path = require('path');
const { makePageManager } = require('../utils/page-manager.js');

const PUBLIC = path.join(__dirname, '../../public');

function page({ withStatus = true } = {}) {
  document.body.innerHTML = `
    <main class="diff-view">
      ${withStatus ? '<div id="diff-status" class="diff-container diff-status"><div class="loading">Loading changes...</div></div>' : ''}
      <div id="diff-container" class="diff-container" hidden></div>
    </main>`;
  return {
    status: () => document.getElementById('diff-status'),
    container: document.getElementById('diff-container'),
  };
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { vi.restoreAllMocks(); });

describe('PRManager._setDiffStatus', () => {
  it('shows a message in place of the diff and hides the container', () => {
    const { status, container } = page();
    const manager = makePageManager();

    manager._setDiffStatus('<div class="no-diff">Error loading changes</div>', { hideScroller: true });

    expect(status().hidden).toBe(false);
    expect(status().querySelector('.no-diff').textContent).toBe('Error loading changes');
    expect(status().classList.contains('diff-status--with-diff')).toBe(false);
    expect(container.hidden).toBe(true);
  });

  it('shows an empty-diff message above the container, which stays (context files render into it)', () => {
    const { status, container } = page();
    const manager = makePageManager();

    manager._setDiffStatus('<div class="no-diff">No files changed</div>');

    expect(status().hidden).toBe(false);
    expect(status().classList.contains('diff-status--with-diff')).toBe(true);
    expect(container.hidden).toBe(false);
  });

  it('null clears the message and shows the diff; clearing twice is harmless', () => {
    const { status, container } = page();
    const manager = makePageManager();
    container.innerHTML = '<div class="d2h-file-wrapper"></div>';

    manager._setDiffStatus(null);
    manager._setDiffStatus(null);

    expect(status().hidden).toBe(true);
    expect(status().innerHTML).toBe('');
    expect(container.hidden).toBe(false);
    // The diff itself is never touched.
    expect(container.querySelectorAll('.d2h-file-wrapper')).toHaveLength(1);
  });

  it('never touches the container\'s children, whatever is shown', () => {
    const { container } = page();
    const manager = makePageManager();
    container.innerHTML = '<div class="d2h-file-wrapper" data-file-name="a.js"></div>';
    const wrapper = container.firstElementChild;

    manager._setDiffStatus('<div class="loading">Refreshing pull request...</div>', { hideScroller: true });
    manager._setDiffStatus('<div class="no-diff">No files changed</div>');
    manager._setDiffStatus(null);

    expect(container.firstElementChild).toBe(wrapper);
  });

  it('creates the status element before the container on a page that has none', () => {
    const { status, container } = page({ withStatus: false });
    const manager = makePageManager();

    manager._setDiffStatus(null);
    expect(status()).toBeNull();

    manager._setDiffStatus('<div class="no-diff">No files changed</div>');
    expect(status()).not.toBeNull();
    expect(status().nextElementSibling).toBe(container);
    expect(status().className).toContain('diff-status');
  });

  it('does not throw when the page has neither element', () => {
    const manager = makePageManager();
    expect(() => manager._setDiffStatus('<div class="no-diff">x</div>', { hideScroller: true })).not.toThrow();
    expect(() => manager._setDiffStatus(null)).not.toThrow();
  });
});

describe('PRManager._clearDiffStatus', () => {
  it('takes down the message its token put up', () => {
    const { status, container } = page();
    const manager = makePageManager();
    const token = manager._setDiffStatus('<div class="loading">Refreshing pull request...</div>', { hideScroller: true });

    expect(manager._clearDiffStatus(token)).toBe(true);
    expect(status().hidden).toBe(true);
    expect(container.hidden).toBe(false);
  });

  it('leaves a message that a later call put up, and a diff that a later render showed', () => {
    const { status, container } = page();
    const manager = makePageManager();
    const token = manager._setDiffStatus('<div class="loading">Refreshing pull request...</div>', { hideScroller: true });

    // The refreshed diff turned out empty: renderDiff replaced the message.
    manager._setDiffStatus('<div class="no-diff">No files changed</div>');
    expect(manager._clearDiffStatus(token)).toBe(false);
    expect(status().textContent).toBe('No files changed');

    // Or it rendered files: the message is gone and stays gone.
    const second = manager._setDiffStatus('<div class="loading">Refreshing pull request...</div>', { hideScroller: true });
    manager._setDiffStatus(null);
    expect(manager._clearDiffStatus(second)).toBe(false);
    expect(container.hidden).toBe(false);
    expect(manager._clearDiffStatus(undefined)).toBe(false);
  });
});

describe('PRManager.refreshPR and the status message', () => {
  function refreshing(fetchImpl) {
    const { status, container } = page();
    container.hidden = false;
    container.innerHTML = '<div class="d2h-file-wrapper" data-file-name="a.js"></div>';
    const manager = makePageManager({
      currentPR: { id: 1, owner: 'acme', repo: 'widget', number: 7, head_sha: 'abc' },
      showError: vi.fn(),
    });
    manager._setDiffStatus(null);
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    return { manager, status, container };
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it('hides the diff behind "Refreshing pull request..." while the refresh runs, and never empties it', async () => {
    let respond;
    const { manager, status, container } = refreshing(() => new Promise((resolve) => { respond = resolve; }));

    const refresh = manager.refreshPR();
    expect(status().hidden).toBe(false);
    expect(status().textContent).toBe('Refreshing pull request...');
    expect(container.hidden).toBe(true);
    expect(container.querySelectorAll('.d2h-file-wrapper')).toHaveLength(1);

    // The refresh ends without new data to render.
    respond({ ok: true, json: async () => ({ success: false }) });
    await refresh;

    // Its own message is taken down and the diff that was there is back.
    expect(status().hidden).toBe(true);
    expect(container.hidden).toBe(false);
    expect(container.querySelectorAll('.d2h-file-wrapper')).toHaveLength(1);
    expect(manager.showError).not.toHaveBeenCalled();
  });

  it('takes its message down when the refresh fails, after reporting the error', async () => {
    const { manager, status, container } = refreshing(async () => ({ ok: false, json: async () => ({ error: 'rate limited' }) }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await manager.refreshPR();

    expect(manager.showError).toHaveBeenCalledWith('rate limited');
    expect(status().hidden).toBe(true);
    expect(container.hidden).toBe(false);
  });

  it('leaves a message that the refreshed diff put up in its place', async () => {
    const { manager, status, container } = refreshing(async () => ({
      ok: true,
      json: async () => ({ success: true, data: { id: 1, owner: 'acme', repo: 'widget', number: 7, head_sha: 'abc' } }),
    }));
    Object.assign(manager, {
      _syncWorktreeDropdown: vi.fn(),
      renderPRHeader: vi.fn(),
      // The refreshed diff is empty: what renderDiff does for no files.
      loadAndDisplayFiles: vi.fn(async () => {
        manager._removeRenderedFiles();
        manager._setDiffStatus(null);
        manager._setDiffStatus('<div class="no-diff">No files changed</div>', { hideScroller: false });
      }),
      _rerenderAllOverlays: vi.fn(async () => {}),
      _hideStaleBadge: vi.fn(),
    });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0);

    await manager.refreshPR();

    expect(status().hidden).toBe(false);
    expect(status().textContent).toBe('No files changed');
    expect(container.hidden).toBe(false);
    expect(container.children).toHaveLength(0);
  });
});

describe('PRManager._removeRenderedFiles', () => {
  it('empties the container and forgets the file-comment zones', () => {
    const { container } = page();
    container.innerHTML = '<div class="d2h-file-wrapper"></div><div class="d2h-file-wrapper context-file"></div>';
    const releaseAllZones = vi.fn();
    const manager = makePageManager({ fileCommentManager: { releaseAllZones } });

    manager._removeRenderedFiles();

    expect(container.childNodes).toHaveLength(0);
    expect(releaseAllZones).toHaveBeenCalledTimes(1);
  });

  it('does not throw without a container or a file comment manager', () => {
    const manager = makePageManager();
    expect(() => manager._removeRenderedFiles()).not.toThrow();
    expect(() => manager._removeRenderedFiles(null)).not.toThrow();
  });
});

describe('the pages and the sources', () => {
  it.each(['pr.html', 'local.html'])('%s has #diff-status right before an empty, hidden #diff-container', (file) => {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf-8');
    document.body.innerHTML = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
    const status = document.getElementById('diff-status');
    const container = document.getElementById('diff-container');

    expect(status).not.toBeNull();
    expect(container).not.toBeNull();
    expect(status.nextElementSibling).toBe(container);
    expect(status.querySelector('.loading')).not.toBeNull();
    expect(container.hidden).toBe(true);
    expect(container.children).toHaveLength(0);
  });

  /** Every application script (the vendor bundle is not ours). */
  function sources() {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'vendor') walk(full);
        } else if (entry.name.endsWith('.js')) {
          out.push({ file: path.relative(PUBLIC, full), text: fs.readFileSync(full, 'utf-8') });
        }
      }
    };
    walk(path.join(PUBLIC, 'js'));
    return out;
  }

  it('nothing writes markup into the diff container', () => {
    const offenders = [];
    for (const { file, text } of sources()) {
      text.split('\n').forEach((line, index) => {
        const names = /\b(diffContainer|diffContainerEl)\b|getElementById\(\s*['"]diff-container['"]\s*\)|['"]#diff-container['"]\s*\)/;
        const writes = /\.(innerHTML|outerHTML|textContent|innerText)\s*[+]?=(?!=)|\.(replaceChildren|insertAdjacentHTML)\s*\(/;
        if (names.test(line) && writes.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('only _setDiffStatus writes the status element, and only _removeRenderedFiles empties the container', () => {
    const pr = sources().find(source => source.file === path.join('js', 'pr.js')).text;
    const all = sources().map(source => source.text).join('\n');

    // One lookup of the status element in the application: inside _setDiffStatus.
    expect(all.match(/getElementById\(\s*['"]diff-status['"]\s*\)/g)).toHaveLength(1);
    const setStatus = pr.slice(pr.indexOf('  _setDiffStatus(html'), pr.indexOf('  _clearDiffStatus(token)'));
    expect(setStatus).toContain("getElementById('diff-status')");

    // One loop that removes the container's children: inside _removeRenderedFiles.
    expect(all.match(/container\.removeChild\(container\.firstChild\)/g)).toHaveLength(1);
    const remove = pr.slice(pr.indexOf('  _removeRenderedFiles(container'), pr.indexOf('  _contextStateKey(filePath)'));
    expect(remove).toContain('container.removeChild(container.firstChild)');
  });

  it('the status messages of both modes go through _setDiffStatus', () => {
    const texts = Object.fromEntries(sources().map(source => [source.file, source.text]));
    const pr = texts[path.join('js', 'pr.js')];
    const local = texts[path.join('js', 'local.js')];
    for (const message of ['No files changed', 'Failed to load changes', 'Error loading changes', 'Refreshing pull request...']) {
      expect(pr).toMatch(new RegExp(`_setDiffStatus\\(\\s*'<div class="(?:no-diff|loading)">${message.replace(/\./g, '\\.')}</div>'`));
    }
    expect(local).toContain('manager._setDiffStatus(`<div class="no-diff">No changes in ${scopeLabel} scope.</div>`');
    expect(local).toContain("manager._setDiffStatus('<div class=\"no-diff\">Error loading changes</div>'");
    expect(local.match(/manager\._setDiffStatus\(/g)).toHaveLength(3);
  });
});
