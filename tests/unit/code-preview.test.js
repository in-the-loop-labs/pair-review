// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const CodePreview = require('../../public/js/components/CodePreview');
const { PRManager } = require('../../public/js/pr');

describe('CodePreview', () => {
  let manager, preview, fetchMock, trigger;
  const data = {fileName: 'src/helper.js', lines: Array.from({length: 90}, (_, i) => `const value${i + 1} = ${i + 1};`), totalLines: 90, source: 'Review head', revision: 'abcdef1234567890'};
  const response = (body = data, ok = true) => ({ok, json: async () => body});
  beforeEach(() => {
    document.body.innerHTML = '<main class="diff-view"><div id="diff-container"><textarea>comment draft</textarea></div></main><button id="trigger">View code</button>';
    trigger = document.getElementById('trigger');
    manager = {currentPR: {id: 1}, ensureContextFile: vi.fn().mockResolvedValue({type: 'context', contextFile: {id: 9}})};
    fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetchMock);
    preview = new CodePreview(manager);
  });
  afterEach(() => { preview.close(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

  it('opens a temporary preview, highlights the range, and preserves the diff DOM', async () => {
    const diff = document.getElementById('diff-container');
    await preview.open('src/helper.js', 42, 48, trigger);
    expect(fetchMock).toHaveBeenCalledWith('/api/reviews/1/code-preview/src%2Fhelper.js');
    expect(document.querySelectorAll('.code-preview__highlight')).toHaveLength(7);
    expect(document.querySelector('[data-preview-source]').textContent).toBe('Review head · abcdef12');
    expect(manager.ensureContextFile).not.toHaveBeenCalled();
    expect(document.getElementById('diff-container')).toBe(diff);
    expect(diff.querySelector('textarea').value).toBe('comment draft');
  });
  it('restores scroll position and focus on return', async () => {
    const scroller = document.querySelector('.diff-view');
    scroller.scrollTop = 420; scroller.scrollLeft = 23;
    await preview.open('src/helper.js', 42, null, trigger);
    document.querySelector('[data-preview-back]').click();
    expect(document.querySelector('.code-preview')).toBeNull();
    expect(scroller.scrollTop).toBe(420);
    expect(scroller.scrollLeft).toBe(23);
    expect(document.activeElement).toBe(trigger);
  });
  it('keeps only on explicit action and prevents duplicate clicks', async () => {
    await preview.open('src/helper.js', 42, 48);
    let finish;
    manager.ensureContextFile.mockReturnValue(new Promise(resolve => {finish = resolve;}));
    const keeping = preview.keep();
    await preview.keep();
    expect(manager.ensureContextFile).toHaveBeenCalledTimes(1);
    expect(manager.ensureContextFile).toHaveBeenCalledWith('src/helper.js', 42, 48);
    finish({type: 'context'}); await keeping;
    expect(document.querySelector('[data-preview-keep]').textContent).toBe('Kept in review');
  });
  it('allows retry after a keep failure', async () => {
    await preview.open('src/helper.js', 42);
    manager.ensureContextFile.mockResolvedValue(null);
    await preview.keep();
    expect(document.querySelector('[data-preview-keep]').disabled).toBe(false);
    expect(document.querySelector('[role="status"]').textContent).toContain('Could not keep');
  });
  it('shows a useful load error and a retry action', async () => {
    fetchMock.mockResolvedValueOnce(response({error: 'File not found at the review commit.'}, false));
    await preview.open('src/helper.js', 42);
    expect(document.querySelector('[role="status"]').textContent).toContain('File not found');
    document.querySelector('.code-preview__actions button').click();
    await vi.waitFor(() => expect(document.querySelector('[data-preview-keep]').disabled).toBe(false));
  });
  it('does not mount an old response after another reference opens', async () => {
    let finish;
    fetchMock.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
    const old = preview.open('old.js');
    await preview.open('new.js', 5);
    finish(response({...data, fileName: 'old.js'})); await old;
    expect(document.querySelector('[data-preview-file]').textContent).toBe('src/helper.js');
    expect(preview.lineStart).toBe(5);
  });
  it('does not reopen after return while a request is pending', async () => {
    let finish;
    fetchMock.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
    const opening = preview.open('src/helper.js');
    preview.close(); finish(response()); await opening;
    expect(document.querySelector('.code-preview')).toBeNull();
  });
  it('discards responses for a different review', async () => {
    let finish;
    fetchMock.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
    const opening = preview.open('src/helper.js');
    manager.currentPR.id = 2; finish(response()); await opening;
    expect(document.querySelector('.code-preview__table')).toBeNull();
  });
  it('renders source text safely and expands more lines', async () => {
    fetchMock.mockResolvedValue(response({...data, lines: ['<img src=x onerror=alert(1)>', ...data.lines.slice(1)]}));
    await preview.open('src/helper.js');
    expect(document.querySelector('.code-preview img')).toBeNull();
    expect(document.querySelectorAll('[data-preview-line]')).toHaveLength(40);
    document.querySelector('.code-preview__expand').click();
    expect(document.querySelectorAll('[data-preview-line]')).toHaveLength(90);
  });
  it('reports a stale line number without inventing a match', async () => {
    await preview.open('src/helper.js', 1000);
    expect(document.querySelector('[role="status"]').textContent).toContain('Line 1000 is outside this file');
    expect(document.querySelector('.code-preview__highlight')).toBeNull();
    expect(document.querySelector('[data-preview-keep]').disabled).toBe(true);
    await preview.keep();
    expect(manager.ensureContextFile).not.toHaveBeenCalled();
  });
  it('leaves Escape in chat inputs alone', async () => {
    await preview.open('src/helper.js');
    const input = document.createElement('textarea'); document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(document.querySelector('.code-preview')).not.toBeNull();
    document.querySelector('[data-preview-back]').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(document.querySelector('.code-preview')).toBeNull();
  });
  it('handles Escape in the preview before the chat handler', async () => {
    const chatEscape = vi.fn();
    document.addEventListener('keydown', chatEscape);
    try {
      await preview.open('src/helper.js');
      document.querySelector('[data-preview-back]').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
      expect(document.querySelector('.code-preview')).toBeNull();
      expect(chatEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', chatEscape);
    }
  });
  it('routes a normalized diff alias to the existing review', async () => {
    manager.diffFiles = [{file: 'src/helper.js'}];
    manager.scrollToFile = vi.fn();
    const previousChatPanel = window.chatPanel;
    window.chatPanel = {_scrollToLine: vi.fn()};
    try {
      await preview.open('./src/helper.js', 42, 48);
      expect(document.querySelector('.code-preview')).toBeNull();
      expect(manager.scrollToFile).toHaveBeenCalledWith('src/helper.js');
      expect(window.chatPanel._scrollToLine).toHaveBeenCalledWith('src/helper.js', 42, 48);
      expect(manager.ensureContextFile).not.toHaveBeenCalled();
    } finally {
      window.chatPanel = previousChatPanel;
    }
  });
  it('does not highlight an old alias after another preview opens', async () => {
    manager.diffFiles = [{file: 'src/helper.js'}];
    let finishScroll;
    manager.scrollToFile = vi.fn(() => new Promise(resolve => { finishScroll = resolve; }));
    const previousChatPanel = window.chatPanel;
    window.chatPanel = {_scrollToLine: vi.fn()};
    fetchMock.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({...data, fileName: 'other.js'}));
    try {
      const old = preview.open('./src/helper.js', 3, 5);
      await vi.waitFor(() => expect(manager.scrollToFile).toHaveBeenCalledWith('src/helper.js'));
      await preview.open('other.js', 42, 48);
      finishScroll();
      await old;
      expect(document.querySelector('[data-preview-file]').textContent).toBe('other.js');
      expect(window.chatPanel._scrollToLine).not.toHaveBeenCalled();
    } finally {
      window.chatPanel = previousChatPanel;
    }
  });
  it('does not claim a diff was saved as context', async () => {
    manager.scrollToFile = vi.fn();
    await preview.open('src/helper.js', 42);
    manager.ensureContextFile.mockResolvedValue({type: 'diff'});
    await preview.keep();
    expect(document.querySelector('.code-preview')).toBeNull();
    expect(manager.scrollToFile).toHaveBeenCalledWith('src/helper.js');
  });
  it('uses the same current-version source for pinned context expansion', async () => {
    manager.contextFiles = [{file: 'src/helper.js'}];
    manager.diffFiles = [];
    await PRManager.prototype.fetchFileContent.call(manager, 'src/helper.js');
    expect(fetchMock).toHaveBeenCalledWith('/api/reviews/1/code-preview/src%2Fhelper.js');
  });
  it('keeps original-side expansion for changed files', async () => {
    manager.contextFiles = [{file: 'src/helper.js'}];
    manager.diffFiles = [{file: 'src/helper.js'}];
    await PRManager.prototype.fetchFileContent.call(manager, 'src/helper.js');
    expect(fetchMock).toHaveBeenCalledWith('/api/reviews/1/file-content/src%2Fhelper.js');
  });
});
