// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the PRManager methods added for the Rendered
 * Markdown view: eligibility, the Diff/Rendered toggle, lazy fetch +
 * stale-generation guarding, cross-file internal link navigation, the
 * Outline sidebar, and comment-list refresh. pr.js is loaded via `vm`
 * (it's a large global-scope script, not a module) — same pattern as
 * tests/unit/pr-manager-set-loading.test.js — with a real jsdom document so
 * DiffRenderer/RenderedDocumentView (loaded as the REAL production modules,
 * not duplicated) operate on real DOM.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const markdownit = require('markdown-it');
const createDOMPurify = require('dompurify');
const { configureMarkdownIt, createRenderMarkdown, escapeHtmlAttribute } = require('../../public/js/utils/markdown.js');
const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');
const RenderedMarkdown = require('../../public/js/modules/rendered-markdown.js');
const { RenderedDocumentView } = require('../../public/js/modules/rendered-document-view.js');
// comment-manager.js and line-tracker.js assign to `window` unconditionally
// at module-load time (unlike DiffRenderer/RenderedDocumentView above, which
// guard with `typeof window !== 'undefined'`) — give them a stub object now
// so requiring them below doesn't throw. Each test's beforeEach swaps in the
// real jsdom `window` before exercising any of this module's behavior.
// Same workaround already used by tests/unit/comment-manager-getcodefromlines.test.js.
global.window = global.window || {};
const { CommentManager } = require('../../public/js/modules/comment-manager.js');
const { LineTracker } = require('../../public/js/modules/line-tracker.js');
const { HunkParser } = require('../../public/js/modules/hunk-parser.js');
const GapCoordinates = require('../../public/js/modules/gap-coordinates.js');
const CommentCount = require('../../public/js/utils/comment-count.js');
// Only `_renderCommentAnnotation` is used (via the prototype, with no `this`
// dependency) — it is the REAL production function that builds the
// light-DOM `.user-comment-row` container PierreBridge slots into
// @pierre/diffs, so the Pierre-engine tests below assert against genuine
// production comment DOM instead of a hand-rolled imitation of it.
const PierreBridge = require('../../public/js/modules/pierre-bridge.js');

function loadPRManager(sandboxExtra) {
  const code = fs.readFileSync(path.join(__dirname, '../../public/js/pr.js'), 'utf8');
  const moduleExports = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    module: { exports: moduleExports },
    // A no-op stub at LOAD time only, so pr.js's bottom-of-file
    // `document.addEventListener('DOMContentLoaded', () => new PRManager())`
    // bootstrap can't fire a real construction (which needs many globals we
    // don't stub, e.g. window.PairReviewTheme). The real jsdom document is
    // swapped in by the caller immediately after this returns — every
    // PRManager method resolves `document` fresh at call time, so the swap
    // is picked up transparently. Mirrors pr-manager-set-loading.test.js.
    document: { addEventListener() {} }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  Object.assign(sandbox, sandboxExtra);
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: 'pr.js' });
  return { PRManager: sandbox.module.exports.PRManager, sandbox };
}

describe('PRManager Rendered Markdown view', () => {
  let dom, PRManager, mgr, sandbox;

  beforeEach(() => {
    dom = new JSDOM(
      `<!doctype html><body>
        <div id="diff-container"></div>
        <nav id="file-list"></nav>
        <nav id="outline-list" hidden></nav>
        <button id="sidebar-tab-files" class="active"></button>
        <button id="sidebar-tab-outline"></button>
        <button id="review-button"><span class="review-button-text">0 comments</span></button>
        <button id="clear-comments-btn" disabled></button>
      </body>`,
      { url: 'http://localhost/' }
    );
    // scrollIntoView isn't implemented by jsdom.
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};

    global.window = dom.window;
    global.document = dom.window.document;

    const purify = createDOMPurify(dom.window);
    const md = configureMarkdownIt(markdownit, { html: true });
    const renderMarkdown = createRenderMarkdown({ md, purify });
    // CommentManager (required directly above, not vm-sandboxed like pr.js)
    // reads `window.renderMarkdown`/`window.escapeHtmlAttribute` off the
    // REAL jsdom window — give it the exact same real, sanitized renderer
    // instance the vm sandbox below also uses, so legacy-row markdown
    // rendering in cross-surface tests is genuine, not a stub.
    dom.window.renderMarkdown = renderMarkdown;
    dom.window.escapeHtmlAttribute = escapeHtmlAttribute;
    // DiffRenderer/HunkParser are required directly (not vm-sandboxed) and
    // resolve their own collaborators off the REAL jsdom window.
    dom.window.HunkParser = HunkParser;
    dom.window.DiffRenderer = DiffRenderer;
    dom.window.GapCoordinates = GapCoordinates;
    dom.window.CommentCount = CommentCount;

    ({ PRManager, sandbox } = loadPRManager({
      DiffRenderer,
      RenderedMarkdown,
      RenderedDocumentView,
      // editUserComment references the bare identifier `CommentManager`
      // (its static SVG icon constants) — since pr.js runs as a vm-sandboxed
      // global script, that resolves through the sandbox's global scope,
      // not through `window.CommentManager` set directly on the real
      // jsdom `dom.window` above.
      CommentManager,
      // Real production modules the legacy Diff-surface machinery
      // (renderPatch / validatePendingEofGaps / expandForSuggestion /
      // expandGapRange) resolves off `window` — needed by the out-of-hunk
      // tests, which drive genuine hunk-gap expansion rather than
      // hand-placing the target row.
      HunkParser,
      GapCoordinates,
      // The shared draft-comment counter updateCommentCount()/submitReview()
      // and ReviewModal all delegate to.
      CommentCount,
      markdownRenderer: md,
      renderMarkdown,
      escapeHtmlAttribute
    }));
    // Swap in the real jsdom document now that the load-time bootstrap has
    // safely no-op'd. Every PRManager method below resolves `document` at
    // call time, so this is picked up transparently.
    sandbox.document = dom.window.document;

    mgr = Object.create(PRManager.prototype);
    mgr.currentPR = { id: 1, head_sha: 'headsha123' };
    mgr.changedFilesByPath = new Map();
    mgr._renderGen = 0;
    mgr._renderedDocuments = new Map();
    mgr._renderedDocumentPromises = new Map();
    mgr._fileViewMode = new Map();
    mgr._activeRenderedFile = null;
    mgr.userComments = [];
    mgr._clientId = 'test-client';
    // Real production collaborators for the legacy Diff-view comment row
    // path (displayUserComment/editUserComment/saveEditedUserComment/
    // deleteUserComment delegate to these) — needed by the cross-surface
    // comment-CRUD-sync tests below. Not needed by the other describe
    // blocks in this file, but harmless to always set up.
    mgr.commentManager = new CommentManager(mgr);
    mgr.lineTracker = new LineTracker();
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  function addFileWrapper(filePath) {
    const wrapper = document.createElement('div');
    wrapper.className = 'd2h-file-wrapper';
    wrapper.dataset.fileName = filePath;
    const header = document.createElement('div');
    header.className = 'd2h-file-header';
    wrapper.appendChild(header);
    const renderedContainer = document.createElement('div');
    renderedContainer.className = 'rendered-markdown-container';
    wrapper.appendChild(renderedContainer);
    document.getElementById('diff-container').appendChild(wrapper);
    mgr._addRenderedViewToggle({ file: filePath }, header, wrapper);
    return { wrapper, header, renderedContainer };
  }

  /**
   * Build a minimal legacy Diff-view `<tr>` for a NEW-file line number,
   * inside the given file wrapper — stands in for the real diff table body
   * (produced by DiffRenderer at full render time, out of scope here).
   * `LineTracker.getLineNumber(row, 'RIGHT')` reads `data-new-line-number`
   * as its first-priority lookup, so this is read by REAL production
   * line-lookup code, not a re-implementation of it.
   * @param {HTMLElement} wrapper
   * @param {number} lineNumber
   * @returns {HTMLTableRowElement}
   */
  function addLegacyDiffRow(wrapper, lineNumber) {
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    const tr = document.createElement('tr');
    tr.dataset.newLineNumber = String(lineNumber);
    tbody.appendChild(tr);
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return tr;
  }

  describe('_isMarkdownRenderEligible', () => {
    it('is true for a modified markdown file', () => {
      expect(mgr._isMarkdownRenderEligible({ file: 'docs/guide.md', insertions: 1, deletions: 1 })).toBe(true);
    });

    it('is false for a non-markdown file', () => {
      expect(mgr._isMarkdownRenderEligible({ file: 'src/utils.js', insertions: 1, deletions: 1 })).toBe(false);
    });

    it('is false for a binary file (even with a .md extension)', () => {
      expect(mgr._isMarkdownRenderEligible({ file: 'docs/guide.md', binary: true })).toBe(false);
    });

    it('is false for a deleted markdown file — Diff remains the only mode', () => {
      expect(mgr._isMarkdownRenderEligible({ file: 'docs/gone.md', insertions: 0, deletions: 10 })).toBe(false);
    });

    it('is false for a falsy/missing file', () => {
      expect(mgr._isMarkdownRenderEligible(null)).toBe(false);
    });
  });

  describe('_getChangedMarkdownPaths', () => {
    it('returns only markdown paths from changedFilesByPath', () => {
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md' });
      mgr.changedFilesByPath.set('src/utils.js', { file: 'src/utils.js' });
      // Compare via Array.from — the Set instance is constructed inside the
      // vm sandbox's own realm, so a cross-realm `toEqual(new Set(...))`
      // comparison against this test file's Set can spuriously fail.
      expect(Array.from(mgr._getChangedMarkdownPaths())).toEqual(['docs/guide.md']);
    });
  });

  describe('setFileRenderMode / _ensureRenderedDocument', () => {
    it('fetches file contents, builds the RenderedDocumentView, and toggles wrapper + button state', async () => {
      const { wrapper, renderedContainer } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: '# Title\n\nHello.\n' }) }));

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');

      expect(wrapper.classList.contains('rendered-mode-active')).toBe(true);
      expect(wrapper._renderModeButtons.renderedBtn.classList.contains('active')).toBe(true);
      expect(wrapper._renderModeButtons.renderedBtn.getAttribute('aria-pressed')).toBe('true');
      expect(wrapper._renderModeButtons.diffBtn.getAttribute('aria-pressed')).toBe('false');
      expect(renderedContainer.querySelectorAll('.rendered-markdown-block')).toHaveLength(2);
      expect(mgr._activeRenderedFile).toBe('docs/guide.md');
      expect(mgr._renderedDocuments.has('docs/guide.md')).toBe(true);
    });

    it('toggling back to diff hides the rendered container without discarding the built view (no re-fetch)', async () => {
      const { wrapper } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      let fetchCount = 0;
      sandbox.fetch = vi.fn(async () => { fetchCount++; return { ok: true, json: async () => ({ newContents: '# Title\n' }) }; });

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');
      await mgr.setFileRenderMode('docs/guide.md', 'diff');
      expect(wrapper.classList.contains('rendered-mode-active')).toBe(false);
      expect(mgr._activeRenderedFile).toBeNull();

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');
      expect(wrapper.classList.contains('rendered-mode-active')).toBe(true);
      expect(fetchCount).toBe(1);
    });

    it('shows an error message and does not build a view when the fetch fails', async () => {
      const { renderedContainer } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      sandbox.fetch = vi.fn(async () => ({ ok: false }));

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');
      expect(renderedContainer.querySelector('.rendered-markdown-error')).toBeTruthy();
      expect(mgr._renderedDocuments.has('docs/guide.md')).toBe(false);
    });

    it('discards a fetch that resolves after the render generation has moved on (stale guard)', async () => {
      addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });

      let resolveFetch;
      sandbox.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));

      const pending = mgr._ensureRenderedDocument('docs/guide.md');
      // Simulate renderDiff() running mid-flight: bumps the generation and
      // resets the maps, exactly as the real renderDiff() does.
      mgr._renderGen += 1;
      mgr._renderedDocuments = new Map();

      resolveFetch({ ok: true, json: async () => ({ newContents: '# Title\n' }) });
      const result = await pending;

      expect(result).toBeNull();
      expect(mgr._renderedDocuments.has('docs/guide.md')).toBe(false);
    });

    it('de-dupes concurrent _ensureRenderedDocument calls for the same file into a single fetch + build', async () => {
      const { renderedContainer } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });

      let fetchCount = 0;
      let resolveFetch;
      sandbox.fetch = vi.fn(() => {
        fetchCount++;
        return new Promise((resolve) => { resolveFetch = resolve; });
      });

      // Three concurrent callers before the fetch resolves — mirrors a fast
      // double-click or a toggle racing an internal-link navigation to the
      // same file.
      const p1 = mgr._ensureRenderedDocument('docs/guide.md');
      const p2 = mgr._ensureRenderedDocument('docs/guide.md');
      const p3 = mgr._ensureRenderedDocument('docs/guide.md');

      expect(fetchCount).toBe(1);
      expect(p1).toBe(p2);
      expect(p2).toBe(p3);

      resolveFetch({ ok: true, json: async () => ({ newContents: '# Title\n' }) });
      const [v1, v2, v3] = await Promise.all([p1, p2, p3]);

      expect(fetchCount).toBe(1);
      expect(v1).toBe(v2);
      expect(v2).toBe(v3);
      expect(renderedContainer.querySelectorAll('.rendered-markdown-block')).toHaveLength(1);
      // The in-flight cache entry is cleared once settled, so a LATER call
      // (not concurrent with the first) fetches again rather than hanging
      // forever on an already-resolved promise.
      expect(mgr._renderedDocumentPromises.has('docs/guide.md')).toBe(false);
    });

    it('falls back to a "too large" message and never builds a view when the file exceeds the size ceiling', async () => {
      const { renderedContainer } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      const tooLarge = 'x'.repeat(PRManager.RENDERED_MARKDOWN_MAX_SOURCE_CHARS + 1);
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: tooLarge }) }));

      const result = await mgr.setFileRenderMode('docs/guide.md', 'rendered');

      expect(result).toBeUndefined(); // setFileRenderMode itself returns nothing
      expect(mgr._renderedDocuments.has('docs/guide.md')).toBe(false);
      expect(renderedContainer.querySelector('.rendered-markdown-error')).toBeTruthy();
      expect(renderedContainer.textContent).toMatch(/too large/i);
    });

    it('renders a file exactly at the char-count ceiling (boundary is inclusive)', async () => {
      const { renderedContainer } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      // A single huge paragraph at exactly the char ceiling, safely under
      // the line ceiling.
      const atCeiling = 'x'.repeat(PRManager.RENDERED_MARKDOWN_MAX_SOURCE_CHARS);
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: atCeiling }) }));

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');

      expect(mgr._renderedDocuments.has('docs/guide.md')).toBe(true);
      expect(renderedContainer.querySelector('.rendered-markdown-error')).toBeNull();
    });

    it('falls back to a "too large" message when the file exceeds the line-count ceiling (even under the char ceiling)', async () => {
      const { renderedContainer } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      const tooManyLines = new Array(PRManager.RENDERED_MARKDOWN_MAX_SOURCE_LINES + 2).fill('x').join('\n');
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: tooManyLines }) }));

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');

      expect(mgr._renderedDocuments.has('docs/guide.md')).toBe(false);
      expect(renderedContainer.querySelector('.rendered-markdown-error')).toBeTruthy();
    });
  });

  describe('LEFT-side (old-file) comments are never shown in Rendered mode', () => {
    it('excludes a LEFT-side comment on initial load, even when its line_start coincides with an unrelated RIGHT-file block', async () => {
      const { renderedContainer } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      // New file: line 5 is "Paragraph C" — completely unrelated to whatever
      // used to be on old-file line 5 before a deletion shifted things up.
      sandbox.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ newContents: '# Title\n\nParagraph A\n\nParagraph C\n' })
      }));
      // A comment left (in Diff mode) on a since-deleted OLD-file line 5.
      // Its line_start of 5 numerically coincides with the NEW file's
      // "Paragraph C" block — this must NOT be shown attached to it.
      mgr.userComments = [
        { id: 1, file: 'docs/guide.md', side: 'LEFT', line_start: 5, line_end: 5, is_file_level: 0, status: 'active', body: 'about deleted Paragraph B' }
      ];

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');

      expect(renderedContainer.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(0);
      expect(renderedContainer.textContent).not.toContain('about deleted Paragraph B');
    });

    it('still shows a RIGHT-side comment (and a legacy comment with no side at all) on initial load', async () => {
      const { renderedContainer } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      sandbox.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ newContents: '# Title\n\nParagraph A\n\nParagraph C\n' })
      }));
      mgr.userComments = [
        { id: 1, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'right side comment' },
        { id: 2, file: 'docs/guide.md', line_start: 5, line_end: 5, is_file_level: 0, status: 'active', body: 'legacy no-side comment' }
      ];

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');

      const cardText = renderedContainer.textContent;
      expect(cardText).toContain('right side comment');
      expect(cardText).toContain('legacy no-side comment');
    });

    it('excludes a LEFT-side comment on refresh (_refreshRenderedDocumentsComments), not just on initial load', () => {
      const fakeView = { setComments: vi.fn() };
      mgr._renderedDocuments.set('docs/guide.md', fakeView);
      mgr.userComments = [
        { id: 1, file: 'docs/guide.md', side: 'LEFT', line_start: 5, line_end: 5, is_file_level: 0, status: 'active' },
        { id: 2, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active' }
      ];

      mgr._refreshRenderedDocumentsComments();

      expect(fakeView.setComments).toHaveBeenCalledWith([expect.objectContaining({ id: 2 })]);
    });
  });

  describe('_findAnyRenderedFilePath / preserving the active Rendered file across another file\'s toggle', () => {
    it('keeps a DIFFERENT still-rendered file as _activeRenderedFile when the file being toggled off was not it', async () => {
      addFileWrapper('docs/guide.md');
      addFileWrapper('docs/setup.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      mgr.changedFilesByPath.set('docs/setup.md', { file: 'docs/setup.md', patch: null, insertions: 1, deletions: 1 });
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: '# Title\n' }) }));

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');
      await mgr.setFileRenderMode('docs/setup.md', 'rendered');
      expect(mgr._activeRenderedFile).toBe('docs/setup.md');

      // Toggle setup.md (the currently-active one) back to Diff. guide.md
      // is STILL in Rendered mode — the Outline must not go blank.
      await mgr.setFileRenderMode('docs/setup.md', 'diff');

      expect(mgr._activeRenderedFile).toBe('docs/guide.md');
      const outlineList = document.getElementById('outline-list');
      expect(outlineList.querySelector('.outline-empty-state')).toBeNull();
    });

    it('falls back to null when the only rendered file is toggled off', async () => {
      addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: '# Title\n' }) }));

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');
      await mgr.setFileRenderMode('docs/guide.md', 'diff');

      expect(mgr._activeRenderedFile).toBeNull();
    });
  });

  describe('_onInternalMarkdownLink', () => {
    it('switches the target file into Rendered mode and scrolls to the fragment heading', async () => {
      addFileWrapper('docs/guide.md');
      addFileWrapper('docs/setup.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      mgr.changedFilesByPath.set('docs/setup.md', { file: 'docs/setup.md', patch: null, insertions: 1, deletions: 1 });
      sandbox.fetch = vi.fn(async (url) => {
        if (String(url).includes('docs%2Fsetup.md')) {
          return { ok: true, json: async () => ({ newContents: '# Setup\n\n## Install\n\nSteps here.\n' }) };
        }
        return { ok: true, json: async () => ({ newContents: '# Guide\n' }) };
      });
      mgr.scrollToFile = vi.fn(async () => {});

      const scrollSpy = vi.spyOn(RenderedDocumentView.prototype, 'scrollToHeading');

      await mgr._onInternalMarkdownLink('docs/setup.md', 'install');

      expect(mgr._fileViewMode.get('docs/setup.md')).toBe('rendered');
      expect(mgr.scrollToFile).toHaveBeenCalledWith('docs/setup.md');
      expect(scrollSpy).toHaveBeenCalledWith('install');
      scrollSpy.mockRestore();
    });
  });

  describe('Outline sidebar', () => {
    it('shows the empty-state prompt when no document is in Rendered mode', () => {
      mgr._renderOutlineSidebar();
      const outlineList = document.getElementById('outline-list');
      expect(outlineList.querySelector('.outline-empty-state').textContent).toMatch(/Rendered mode/);
    });

    it('lists headings for the active rendered document and supports click-to-scroll with aria-current', async () => {
      const { } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: '# Guide\n\ntext\n\n## Usage\n\nmore\n' }) }));

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');

      const outlineList = document.getElementById('outline-list');
      const items = outlineList.querySelectorAll('.outline-item');
      expect(items).toHaveLength(2);
      expect(items[0].textContent).toBe('Guide');
      expect(items[1].textContent).toBe('Usage');

      items[1].click();
      expect(items[1].classList.contains('current')).toBe(true);
      expect(items[1].getAttribute('aria-current')).toBe('true');
      expect(items[0].hasAttribute('aria-current')).toBe(false);
    });

    it('clears the outline (back to the empty state) when the active file is switched back to Diff', async () => {
      addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: '# Guide\n' }) }));

      await mgr.setFileRenderMode('docs/guide.md', 'rendered');
      await mgr.setFileRenderMode('docs/guide.md', 'diff');

      const outlineList = document.getElementById('outline-list');
      expect(outlineList.querySelector('.outline-empty-state')).toBeTruthy();
    });
  });

  describe('setSidebarMode', () => {
    it('toggles tab active state and the visible list', () => {
      mgr.setSidebarMode('outline');
      expect(document.getElementById('sidebar-tab-outline').classList.contains('active')).toBe(true);
      expect(document.getElementById('sidebar-tab-files').classList.contains('active')).toBe(false);
      expect(document.getElementById('file-list').hidden).toBe(true);
      expect(document.getElementById('outline-list').hidden).toBe(false);

      mgr.setSidebarMode('files');
      expect(document.getElementById('file-list').hidden).toBe(false);
      expect(document.getElementById('outline-list').hidden).toBe(true);
    });

    it('applies roving tabindex: only the selected tab is Tab-reachable', () => {
      mgr.setSidebarMode('files');
      expect(document.getElementById('sidebar-tab-files').tabIndex).toBe(0);
      expect(document.getElementById('sidebar-tab-outline').tabIndex).toBe(-1);

      mgr.setSidebarMode('outline');
      expect(document.getElementById('sidebar-tab-files').tabIndex).toBe(-1);
      expect(document.getElementById('sidebar-tab-outline').tabIndex).toBe(0);
    });
  });

  describe('sidebar tabs keyboard navigation (ARIA APG tab pattern)', () => {
    it('ArrowRight/ArrowLeft move focus AND activate the adjacent tab', () => {
      mgr._initSidebarModeTabs();
      mgr.setSidebarMode('files');
      const filesTab = document.getElementById('sidebar-tab-files');
      const outlineTab = document.getElementById('sidebar-tab-outline');
      filesTab.focus();

      filesTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(document.activeElement).toBe(outlineTab);
      expect(outlineTab.getAttribute('aria-selected')).toBe('true');
      expect(document.getElementById('outline-list').hidden).toBe(false);

      outlineTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      expect(document.activeElement).toBe(filesTab);
      expect(filesTab.getAttribute('aria-selected')).toBe('true');
    });

    it('Home/End jump to the first/last tab', () => {
      mgr._initSidebarModeTabs();
      mgr.setSidebarMode('files');
      const filesTab = document.getElementById('sidebar-tab-files');
      const outlineTab = document.getElementById('sidebar-tab-outline');
      outlineTab.focus();

      outlineTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      expect(document.activeElement).toBe(outlineTab);
      expect(mgr._sidebarMode).toBe('outline');

      outlineTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      expect(document.activeElement).toBe(filesTab);
      expect(mgr._sidebarMode).toBe('files');
    });

    it('leaves ordinary click activation unaffected', () => {
      mgr._initSidebarModeTabs();
      document.getElementById('sidebar-tab-outline').click();
      expect(mgr._sidebarMode).toBe('outline');
    });

    it('is idempotent — calling it twice does not double-register listeners', () => {
      mgr._initSidebarModeTabs();
      mgr._initSidebarModeTabs();
      let clicks = 0;
      const outlineTab = document.getElementById('sidebar-tab-outline');
      const originalSetSidebarMode = mgr.setSidebarMode.bind(mgr);
      mgr.setSidebarMode = (mode) => { clicks++; originalSetSidebarMode(mode); };
      outlineTab.click();
      expect(clicks).toBe(1);
    });
  });

  describe('comment lifecycle', () => {
    it('_createRenderedBlockComment POSTs to the shared comments endpoint and records the comment', async () => {
      const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 555 }) }));
      sandbox.fetch = fetchSpy;

      const comment = await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: 4, body: 'Nice!'
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/reviews/1/comments',
        expect.objectContaining({ method: 'POST' })
      );
      const [, options] = fetchSpy.mock.calls[0];
      const sentBody = JSON.parse(options.body);
      expect(sentBody).toMatchObject({
        file: 'docs/guide.md', line_start: 3, line_end: 3, side: 'RIGHT', diff_position: 4,
        body: 'Nice!', commit_sha: 'headsha123'
      });
      expect(comment.id).toBe(555);
      expect(mgr.userComments).toContainEqual(expect.objectContaining({ id: 555, file: 'docs/guide.md' }));
    });

    it('_createRenderedBlockComment omits rendered_anchor entirely for a block-level target', async () => {
      const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 556 }) }));
      sandbox.fetch = fetchSpy;

      await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: 4, rendered_anchor: null, body: 'Nice!'
      });

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect('rendered_anchor' in sentBody).toBe(false);
    });

    it('_createRenderedBlockComment forwards a nested target descriptor and keeps it on the in-memory comment', async () => {
      const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 557 }) }));
      sandbox.fetch = fetchSpy;
      const anchor = { v: 1, kind: 'table-cell', startLine: 9, endLine: 9, ordinal: 1 };

      const comment = await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 9, line_end: 9, diff_position: null, rendered_anchor: anchor, body: 'Cell note'
      });

      const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      // Sent ALONGSIDE the line coordinates, which are unchanged — the
      // descriptor never replaces the GitHub-facing anchor.
      expect(sentBody).toMatchObject({
        file: 'docs/guide.md', line_start: 9, line_end: 9, side: 'RIGHT', rendered_anchor: anchor
      });
      // Retained locally so a later cross-surface refresh re-renders the
      // comment on the same cell instead of demoting it to its block.
      expect(comment.rendered_anchor).toEqual(anchor);
      expect(mgr.userComments.find((c) => c.id === 557).rendered_anchor).toEqual(anchor);
    });

    it('_refreshRenderedDocumentsComments only pushes active, non-file-level comments for the matching file to each view', () => {
      const fakeViewA = { setComments: vi.fn() };
      const fakeViewB = { setComments: vi.fn() };
      mgr._renderedDocuments.set('docs/a.md', fakeViewA);
      mgr._renderedDocuments.set('docs/b.md', fakeViewB);
      mgr.userComments = [
        { id: 1, file: 'docs/a.md', is_file_level: 0, status: 'active' },
        { id: 2, file: 'docs/a.md', is_file_level: 1, status: 'active' }, // file-level: excluded
        { id: 3, file: 'docs/a.md', is_file_level: 0, status: 'inactive' }, // dismissed: excluded
        { id: 4, file: 'docs/b.md', is_file_level: 0, status: 'active' },
        { id: 5, file: 'docs/other.md', is_file_level: 0, status: 'active' } // different file: excluded
      ];

      mgr._refreshRenderedDocumentsComments();

      expect(fakeViewA.setComments).toHaveBeenCalledWith([expect.objectContaining({ id: 1 })]);
      expect(fakeViewB.setComments).toHaveBeenCalledWith([expect.objectContaining({ id: 4 })]);
    });
  });

  // Regression coverage for the P1 cross-surface sync gap: the legacy
  // Diff-view comment UI (saveEditedUserComment/deleteUserComment) and the
  // Rendered-block comment UI (_createRenderedBlockComment/
  // _editRenderedBlockComment/_deleteRenderedBlockComment) are two
  // independent DOM surfaces over the SAME `this.userComments`. Every test
  // below drives the actual production method on one surface and asserts
  // the OTHER surface (and `this.userComments`) reflect the change —
  // no reimplementation of the sync logic under test.
  describe('cross-surface comment CRUD sync: legacy Diff UI -> Rendered view', () => {
    async function setupWithBothSurfaces() {
      const { wrapper, renderedContainer } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      mgr.userComments = [
        { id: 10, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'Original text' }
      ];
      sandbox.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ newContents: '# Title\n\nParagraph A\n\nParagraph C\n' })
      }));

      // Build the real RenderedDocumentView (picks up comment id 10 from
      // mgr.userComments at construction time, same as production).
      await mgr.setFileRenderMode('docs/guide.md', 'rendered');

      // Build the matching legacy Diff-view row via the REAL displayUserComment
      // (what loadUserComments() would already have done for this comment).
      const legacyRow = addLegacyDiffRow(wrapper, 3);
      mgr.displayUserComment(mgr.userComments[0], legacyRow);

      return { wrapper, renderedContainer };
    }

    it('saveEditedUserComment patches this.userComments and the Rendered card, not just the legacy row', async () => {
      const { renderedContainer } = await setupWithBothSurfaces();
      expect(renderedContainer.textContent).toContain('Original text');
      expect(document.querySelector('[data-comment-id="10"] .user-comment-body').textContent).toContain('Original text');

      // Open the real in-place edit form and change the text.
      mgr.editUserComment(10);
      const textarea = document.getElementById('edit-comment-10');
      expect(textarea).toBeTruthy();
      textarea.value = 'Updated text';

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      await mgr.saveEditedUserComment(10);

      // Legacy row itself was patched (pre-existing behavior).
      const legacyBody = document.querySelector('[data-comment-id="10"] .user-comment-body');
      expect(legacyBody.textContent).toContain('Updated text');
      expect(legacyBody.textContent).not.toContain('Original text');

      // The fix under test: this.userComments AND the Rendered card reflect
      // the edit too — this is the exact defect the gate reported (an edit
      // that "will never surface... anywhere else, with no error or warning").
      expect(mgr.userComments.find((c) => c.id === 10).body).toBe('Updated text');
      expect(renderedContainer.textContent).toContain('Updated text');
      expect(renderedContainer.textContent).not.toContain('Original text');
      // Exactly one card for this comment — no duplicate left behind by the
      // setComments() full-rebuild the fix triggers.
      expect(renderedContainer.querySelectorAll('.rendered-markdown-comment-card[data-comment-id="10"]')).toHaveLength(1);
    });

    it('deleteUserComment removes the comment from this.userComments and the Rendered card, not just the legacy row', async () => {
      const { renderedContainer } = await setupWithBothSurfaces();
      expect(renderedContainer.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(1);

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      await mgr.deleteUserComment(10);

      // Legacy row removed (pre-existing behavior).
      expect(document.querySelector('[data-comment-id="10"]')).toBeNull();

      // The fix under test: this.userComments no longer carries the
      // dismissed comment, and the Rendered card is gone too — before the
      // fix this stayed visible with live Edit/Delete controls.
      expect(mgr.userComments.find((c) => c.id === 10)).toBeUndefined();
      expect(renderedContainer.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(0);
    });
  });

  /**
   * Build a minimal stand-in for PierreBridge that mirrors the REAL
   * `files`/`addAnnotation`/`removeAnnotation`/`getAnnotations` contract
   * (see public/js/modules/pierre-bridge.js) closely enough to exercise
   * PRManager's own engine-dispatch/reconciliation logic under test —
   * PierreBridge itself has its own dedicated test suite
   * (tests/unit/pierre-bridge-*.test.js); this fake exists only so the
   * `_syncDiffComment*` dispatch-and-guard logic in pr.js runs against a
   * collaborator with real add/remove/lookup semantics, not a bare
   * `vi.fn()` that can't reveal a duplicate-annotation bug.
   * @param {string[]} fileNames - files considered "already Pierre-rendered"
   */
  function createFakePierreBridge(fileNames) {
    const files = new Map(fileNames.map((f) => [f, {}]));
    const annotationsByFile = new Map(fileNames.map((f) => [f, []]));
    return {
      files,
      getAnnotations(fileName, type) {
        const list = annotationsByFile.get(fileName) || [];
        return type ? list.filter((a) => a.metadata.type === type) : [...list];
      },
      addAnnotation(fileName, annotation) {
        if (!files.has(fileName)) return;
        const list = annotationsByFile.get(fileName) || [];
        list.push({
          lineNumber: annotation.lineNumber,
          side: annotation.side,
          metadata: { type: annotation.type, data: annotation.data, id: annotation.id }
        });
        annotationsByFile.set(fileName, list);
      },
      removeAnnotation(fileName, annotationId) {
        const list = annotationsByFile.get(fileName) || [];
        annotationsByFile.set(fileName, list.filter((a) => a.metadata.id !== annotationId));
      }
    };
  }

  describe('cross-surface comment CRUD sync: Rendered block UI -> Diff view (Pierre annotation)', () => {
    it('_createRenderedBlockComment adds exactly one comment-<id> Pierre annotation, with correct line/side/data, when that file is Pierre-rendered', async () => {
      addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      mgr.pierreBridge = createFakePierreBridge(['docs/guide.md']);

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 501 }) }));
      const comment = await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: 4, body: 'Pierre comment body'
      });

      const annotations = mgr.pierreBridge.getAnnotations('docs/guide.md', 'comment');
      expect(annotations).toHaveLength(1);
      expect(annotations[0].metadata.id).toBe('comment-501');
      expect(annotations[0].lineNumber).toBe(3);
      expect(annotations[0].side).toBe('RIGHT');
      expect(annotations[0].metadata.data).toBe(comment);
      expect(annotations[0].metadata.data.body).toBe('Pierre comment body');

      // Must NOT also insert a legacy row for a Pierre-rendered file.
      expect(document.querySelector('.user-comment-row[data-comment-id="501"]')).toBeNull();
    });

    it('does not duplicate the annotation on a redundant create sync for the same comment id', () => {
      mgr.pierreBridge = createFakePierreBridge(['docs/guide.md']);
      const comment = {
        id: 502, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3,
        is_file_level: 0, status: 'active', body: 'first'
      };

      mgr._syncDiffCommentCreate(comment);
      mgr._syncDiffCommentCreate(comment);
      mgr._syncDiffCommentCreate(comment);

      expect(mgr.pierreBridge.getAnnotations('docs/guide.md', 'comment')).toHaveLength(1);
    });

    it('does not add a Pierre annotation (or crash) when that file has not rendered a Diff body yet', async () => {
      mgr.pierreBridge = createFakePierreBridge([]); // no file rendered by Pierre yet
      mgr.changedFilesByPath.set('docs/other.md', { file: 'docs/other.md', patch: null, insertions: 1, deletions: 1 });

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 503 }) }));
      const comment = await mgr._createRenderedBlockComment('docs/other.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: 4, body: 'orphan pierre'
      });

      expect(comment.id).toBe(503);
      expect(mgr.userComments).toContainEqual(expect.objectContaining({ id: 503, file: 'docs/other.md' }));
      expect(mgr.pierreBridge.getAnnotations('docs/other.md', 'comment')).toHaveLength(0);
    });

    it('_editRenderedBlockComment updates the Pierre annotation\'s data/body in place, preserving the anchor and id, without duplicating it', async () => {
      mgr.pierreBridge = createFakePierreBridge(['docs/guide.md']);
      mgr.userComments = [
        { id: 510, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'before' }
      ];
      mgr._syncDiffCommentCreate(mgr.userComments[0]);
      expect(mgr.pierreBridge.getAnnotations('docs/guide.md', 'comment')).toHaveLength(1);

      sandbox.fetch = vi.fn(async () => ({ ok: true }));
      await mgr._editRenderedBlockComment(510, 'after');

      const annotations = mgr.pierreBridge.getAnnotations('docs/guide.md', 'comment');
      expect(annotations).toHaveLength(1);
      expect(annotations[0].metadata.id).toBe('comment-510');
      expect(annotations[0].lineNumber).toBe(3);
      expect(annotations[0].side).toBe('RIGHT');
      expect(annotations[0].metadata.data.body).toBe('after');
      expect(mgr.userComments.find((c) => c.id === 510).body).toBe('after');
    });

    it('_editRenderedBlockComment does not crash (and does not add an annotation) when no Pierre annotation exists yet for that comment', async () => {
      mgr.pierreBridge = createFakePierreBridge(['docs/guide.md']);
      mgr.userComments = [
        { id: 511, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'before' }
      ];
      sandbox.fetch = vi.fn(async () => ({ ok: true }));

      await expect(mgr._editRenderedBlockComment(511, 'after')).resolves.toBeUndefined();
      expect(mgr.userComments.find((c) => c.id === 511).body).toBe('after');
      expect(mgr.pierreBridge.getAnnotations('docs/guide.md', 'comment')).toHaveLength(0);
    });

    it('_deleteRenderedBlockComment removes the comment-<id> annotation from Pierre immediately (no ghost reappearance)', async () => {
      mgr.pierreBridge = createFakePierreBridge(['docs/guide.md']);
      mgr.userComments = [
        { id: 520, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'to be removed' }
      ];
      mgr._syncDiffCommentCreate(mgr.userComments[0]);
      expect(mgr.pierreBridge.getAnnotations('docs/guide.md', 'comment')).toHaveLength(1);

      sandbox.fetch = vi.fn(async () => ({ ok: true }));
      await mgr._deleteRenderedBlockComment(520);

      expect(mgr.pierreBridge.getAnnotations('docs/guide.md', 'comment')).toHaveLength(0);
      expect(mgr.userComments.find((c) => c.id === 520)).toBeUndefined();

      // Simulate an UNRELATED later rerender of the same file (e.g. another
      // comment created on it) — the deleted annotation must not resurrect,
      // proving removal went through the bridge's own list, not just a DOM
      // node the bridge doesn't know was removed.
      mgr._syncDiffCommentCreate({ id: 521, file: 'docs/guide.md', side: 'RIGHT', line_start: 4, line_end: 4, is_file_level: 0, status: 'active', body: 'unrelated' });
      const ids = mgr.pierreBridge.getAnnotations('docs/guide.md', 'comment').map((a) => a.metadata.id);
      expect(ids).toEqual(['comment-521']);
    });

    it('_deleteRenderedBlockComment does not crash when no Pierre annotation exists yet for that comment', async () => {
      mgr.pierreBridge = createFakePierreBridge(['docs/guide.md']);
      mgr.userComments = [
        { id: 522, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'orphan' }
      ];
      sandbox.fetch = vi.fn(async () => ({ ok: true }));

      await expect(mgr._deleteRenderedBlockComment(522)).resolves.toBeUndefined();
      expect(mgr.userComments.find((c) => c.id === 522)).toBeUndefined();
    });
  });

  describe('cross-surface comment CRUD sync: Rendered block UI -> legacy Diff view', () => {
    it('_createRenderedBlockComment inserts a matching legacy Diff row when that file’s diff body is already rendered', async () => {
      const { wrapper } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      addLegacyDiffRow(wrapper, 3);

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 77 }) }));
      const comment = await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: 4, body: 'New comment body'
      });

      expect(comment.id).toBe(77);
      const row = document.querySelector('[data-comment-id="77"]');
      expect(row).toBeTruthy();
      expect(row.classList.contains('user-comment-row')).toBe(true);
      expect(row.querySelector('.user-comment-body').textContent).toContain('New comment body');
    });

    it('_createRenderedBlockComment does not insert a duplicate legacy row for a comment id that already has one', async () => {
      const { wrapper } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      const row = addLegacyDiffRow(wrapper, 3);
      // Simulate the row already existing — e.g. inserted moments earlier by
      // loadUserComments() from another client's create that raced this one.
      mgr.displayUserComment(
        { id: 77, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, body: 'already there' },
        row
      );
      expect(document.querySelectorAll('[data-comment-id="77"]')).toHaveLength(1);

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 77 }) }));
      await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: 4, body: 'duplicate attempt'
      });

      expect(document.querySelectorAll('[data-comment-id="77"]')).toHaveLength(1);
    });

    it('_createRenderedBlockComment does not crash and records the comment even when that file has no rendered Diff body', async () => {
      // No addFileWrapper() at all — file was never expanded in Diff mode
      // this session, matching a Markdown-only Rendered-mode workflow.
      mgr.changedFilesByPath.set('docs/other.md', { file: 'docs/other.md', patch: null, insertions: 1, deletions: 1 });

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 78 }) }));
      const comment = await mgr._createRenderedBlockComment('docs/other.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: 4, body: 'orphan'
      });

      expect(comment.id).toBe(78);
      expect(document.querySelector('[data-comment-id="78"]')).toBeNull();
      expect(mgr.userComments).toContainEqual(expect.objectContaining({ id: 78, file: 'docs/other.md' }));
    });

    it('_editRenderedBlockComment patches the matching legacy Diff row body', async () => {
      const { wrapper } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      const row = addLegacyDiffRow(wrapper, 3);
      mgr.userComments = [
        { id: 80, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'before' }
      ];
      mgr.displayUserComment(mgr.userComments[0], row);

      sandbox.fetch = vi.fn(async () => ({ ok: true }));
      await mgr._editRenderedBlockComment(80, 'after');

      const bodyDiv = document.querySelector('[data-comment-id="80"] .user-comment-body');
      expect(bodyDiv.textContent).toContain('after');
      expect(bodyDiv.dataset.originalMarkdown).toBe('after');
      expect(mgr.userComments.find((c) => c.id === 80).body).toBe('after');
    });

    it('_editRenderedBlockComment does not crash when no legacy row exists for that comment', async () => {
      mgr.userComments = [
        { id: 81, file: 'docs/other.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'before' }
      ];
      sandbox.fetch = vi.fn(async () => ({ ok: true }));

      await expect(mgr._editRenderedBlockComment(81, 'after')).resolves.toBeUndefined();
      expect(mgr.userComments.find((c) => c.id === 81).body).toBe('after');
    });

    it('_deleteRenderedBlockComment removes the matching legacy Diff row', async () => {
      const { wrapper } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      const row = addLegacyDiffRow(wrapper, 3);
      mgr.userComments = [
        { id: 90, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'to be removed' }
      ];
      mgr.displayUserComment(mgr.userComments[0], row);
      expect(document.querySelector('[data-comment-id="90"]')).toBeTruthy();

      sandbox.fetch = vi.fn(async () => ({ ok: true }));
      await mgr._deleteRenderedBlockComment(90);

      expect(document.querySelector('[data-comment-id="90"]')).toBeNull();
      expect(mgr.userComments.find((c) => c.id === 90)).toBeUndefined();
    });

    it('_deleteRenderedBlockComment does not crash when no legacy row exists for that comment', async () => {
      mgr.userComments = [
        { id: 91, file: 'docs/other.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'orphan' }
      ];
      sandbox.fetch = vi.fn(async () => ({ ok: true }));

      await expect(mgr._deleteRenderedBlockComment(91)).resolves.toBeUndefined();
      expect(mgr.userComments.find((c) => c.id === 91)).toBeUndefined();
    });
  });

  /**
   * The headline flow of the Rendered Markdown feature is commenting on
   * prose that is NOT part of the diff (an unchanged paragraph beside a
   * changed one). Such a comment's line sits OUTSIDE every default hunk,
   * so neither `_syncDiffCommentCreate` branch can anchor it until the
   * enclosing gap has been revealed — the Pierre branch anchors an
   * annotation at a line the vendor must actually be showing, and the
   * legacy branch scans the `<tr>`s that already exist.
   *
   * Before the fix the comment was stored but rendered on NO Diff surface,
   * and — because every counter in the app is DOM-based on
   * `.user-comment-row` — it also vanished from the toolbar count, from
   * "N comments will be submitted", from Clear All, and from the
   * "Request changes needs comments or a summary" check. These tests
   * therefore assert BOTH the comment surface AND the count/submission
   * state, on both rendering engines, driving the real production methods.
   */
  describe('out-of-hunk comments created in Rendered mode (legacy engine)', () => {
    // A 20-line Markdown file: odd lines are one-line paragraphs, even
    // lines are blank. Blank separators matter — they make each odd line
    // its OWN top-level markdown block, so `findBlockForLine(11)` resolves
    // to exactly line 11 (with one giant 20-line paragraph it would resolve
    // to lines 1-20 and the "out of hunk" premise would be lost).
    const FILE_LINES = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? `line ${i + 1}` : ''));
    // The only hunk touches new lines 5-7. Everything outside that is
    // collapsed into a gap, exactly as in production.
    const PATCH = [
      '@@ -5,3 +5,3 @@',
      '-line 5 old',
      '+line 5',
      ' ',
      ' line 7'
    ].join('\n');

    /**
     * Build a REAL legacy diff body for PATCH via production
     * `_renderLegacyFileDiffBody` (which runs `renderPatch`, so the gap
     * rows/hunk headers/line rows are all genuine), then run production
     * `validatePendingEofGaps` on it exactly as `_renderFileBodyNow` does —
     * without that the trailing gap still carries EOF_SENTINEL coordinates
     * and no gap can match a real line number.
     */
    async function setupLegacyDiffSurface() {
      const file = { file: 'docs/guide.md', patch: PATCH, insertions: 1, deletions: 1 };
      mgr.changedFilesByPath.set('docs/guide.md', file);

      const { wrapper, renderedContainer } = addFileWrapper('docs/guide.md');
      const fileBody = mgr._renderLegacyFileDiffBody(file);
      wrapper.appendChild(fileBody);

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ lines: FILE_LINES }) }));
      await mgr.validatePendingEofGaps(fileBody);

      return { wrapper, renderedContainer, fileBody };
    }

    /** Line numbers (NEW/RIGHT side) currently rendered in the diff body. */
    function visibleRightLines(fileBody) {
      return Array.from(fileBody.querySelectorAll('tr'))
        .map((row) => mgr.getLineNumber(row, 'RIGHT'))
        .filter((n) => n != null);
    }

    it('sanity: line 11 is outside the rendered hunk before the comment is created', async () => {
      const { fileBody } = await setupLegacyDiffSurface();
      expect(visibleRightLines(fileBody)).toEqual([5, 6, 7]);
      expect(visibleRightLines(fileBody)).not.toContain(11);
    });

    it('reveals the enclosing gap and renders the comment on the legacy Diff surface, and it counts', async () => {
      const { fileBody } = await setupLegacyDiffSurface();
      expect(mgr.countDraftComments()).toBe(0);

      // Serve BOTH the file-content fetch (gap expansion) and the comment
      // POST from one handler, dispatching on the URL — the production flow
      // makes both calls.
      sandbox.fetch = vi.fn(async (url) => {
        if (String(url).includes('/file-content/')) {
          return { ok: true, json: async () => ({ lines: FILE_LINES }) };
        }
        return { ok: true, json: async () => ({ commentId: 601 }) };
      });

      const comment = await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 11, line_end: 11, diff_position: null, body: 'Out-of-hunk prose comment'
      });

      expect(comment.id).toBe(601);
      // The honest fallback is preserved: no diff_position was fabricated.
      expect(comment.diff_position).toBeNull();

      // Line 11 is now actually rendered in the diff body...
      expect(visibleRightLines(fileBody)).toContain(11);

      // ...and the comment has a real row on the Diff surface, exactly one.
      const rows = fileBody.querySelectorAll('.user-comment-row[data-comment-id="601"]');
      expect(rows).toHaveLength(1);
      expect(rows[0].querySelector('.user-comment-body').textContent).toContain('Out-of-hunk prose comment');

      // Count/submission-visible state, via the very functions
      // submitReview()/ReviewModal use — not just the API storage.
      expect(mgr.countDraftComments()).toBe(1);
      mgr.updateCommentCount();
      expect(document.querySelector('#review-button .review-button-text').textContent).toBe('1 comment');
      expect(document.getElementById('review-button').classList.contains('has-comments')).toBe(true);
      expect(document.getElementById('clear-comments-btn').disabled).toBe(false);
    });

    it('syncs the Diff surface exactly once — no duplicate row from the reveal step', async () => {
      const { fileBody } = await setupLegacyDiffSurface();
      sandbox.fetch = vi.fn(async (url) => {
        if (String(url).includes('/file-content/')) {
          return { ok: true, json: async () => ({ lines: FILE_LINES }) };
        }
        return { ok: true, json: async () => ({ commentId: 602 }) };
      });

      await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 11, line_end: 11, diff_position: null, body: 'once only'
      });

      expect(fileBody.querySelectorAll('[data-comment-id="602"]')).toHaveLength(1);
      expect(mgr.countDraftComments()).toBe(1);
    });

    it('counts a comment once even when it is showing on BOTH the Diff and Rendered surfaces', async () => {
      const { fileBody, renderedContainer } = await setupLegacyDiffSurface();

      // Build the real Rendered view for the file, then create the comment
      // through the real Rendered-block flow so BOTH surfaces hold a card
      // with the same data-comment-id (Rendered mode only CSS-hides the
      // diff body; it never removes it).
      sandbox.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ newContents: FILE_LINES.join('\n') + '\n' })
      }));
      await mgr.setFileRenderMode('docs/guide.md', 'rendered');

      sandbox.fetch = vi.fn(async (url) => {
        if (String(url).includes('/file-content/')) {
          return { ok: true, json: async () => ({ lines: FILE_LINES }) };
        }
        return { ok: true, json: async () => ({ commentId: 603 }) };
      });
      const view = mgr._renderedDocuments.get('docs/guide.md');
      const block = view.findBlockForLine(11);
      expect(block).toBeTruthy();
      const target = RenderedMarkdown.resolveCommentTarget({
        patch: PATCH, startLine: block.startLine, endLine: block.endLine
      });
      expect(target.inDiff).toBe(false); // genuinely out of hunk
      const comment = await mgr._createRenderedBlockComment('docs/guide.md', {
        side: target.side,
        line_start: target.line_start,
        line_end: target.line_end,
        diff_position: target.diff_position,
        body: 'visible on both surfaces'
      });
      view.addComment(comment);

      expect(fileBody.querySelectorAll('.user-comment-row[data-comment-id="603"]')).toHaveLength(1);
      expect(renderedContainer.querySelectorAll('.rendered-markdown-comment-card[data-comment-id="603"]')).toHaveLength(1);
      // One comment, counted once — not two.
      expect(mgr.countDraftComments()).toBe(1);
      mgr.updateCommentCount();
      expect(document.querySelector('#review-button .review-button-text').textContent).toBe('1 comment');
    });

    it('still counts (and does not block submission) when the Diff target cannot be revealed at all', async () => {
      // No diff body was ever built for this file, and no gap exists — the
      // reveal step legitimately fails. The comment must NOT disappear from
      // the counters, because it is stored and WILL be submitted.
      mgr.changedFilesByPath.set('docs/only-rendered.md', { file: 'docs/only-rendered.md', patch: null, insertions: 1, deletions: 0 });
      const { renderedContainer } = (() => {
        const w = addFileWrapper('docs/only-rendered.md');
        return w;
      })();

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: '# Title\n\nBody.\n' }) }));
      await mgr.setFileRenderMode('docs/only-rendered.md', 'rendered');

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 604 }) }));
      const comment = await mgr._createRenderedBlockComment('docs/only-rendered.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: null, body: 'rendered-only'
      });
      mgr._renderedDocuments.get('docs/only-rendered.md').addComment(comment);

      expect(document.querySelector('.user-comment-row[data-comment-id="604"]')).toBeNull();
      expect(renderedContainer.querySelector('.rendered-markdown-comment-card[data-comment-id="604"]')).toBeTruthy();
      // The regression this guards: a DOM-based counter that only looks at
      // `.user-comment-row` reports 0 here, hides "N comments will be
      // submitted", disables Clear All and blocks Request changes.
      expect(mgr.countDraftComments()).toBe(1);
      mgr.updateCommentCount();
      expect(document.getElementById('clear-comments-btn').disabled).toBe(false);
    });

    it('recounts after the Rendered card lands, so a Rendered-only create/delete leaves the toolbar honest', async () => {
      // Regression for the count ORDER: `_createRenderedBlockComment`
      // resolves (and counts) BEFORE RenderedDocumentView adds its card, so
      // without the onCommentsChanged hook the toolbar would read 0 right
      // after a create whose only surface is the Rendered view — and 1
      // right after deleting it.
      mgr.changedFilesByPath.set('docs/only-rendered.md', { file: 'docs/only-rendered.md', patch: null, insertions: 1, deletions: 0 });
      addFileWrapper('docs/only-rendered.md');
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: '# Title\n\nBody.\n' }) }));
      await mgr.setFileRenderMode('docs/only-rendered.md', 'rendered');
      const view = mgr._renderedDocuments.get('docs/only-rendered.md');

      // Drive the real in-view comment form, so the whole
      // form -> onCreateComment -> addComment -> onCommentsChanged chain runs.
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 606 }) }));
      dom.window.fetch = sandbox.fetch;
      view.container.querySelectorAll('.rendered-markdown-add-comment-btn')[1].click();
      const textarea = view.container.querySelector('.rendered-markdown-comment-textarea');
      textarea.value = 'rendered-only comment';
      textarea.dispatchEvent(new dom.window.Event('input'));
      view.container.querySelector('.rendered-markdown-comment-btn.submit').click();
      await new Promise(setImmediate);

      expect(view.container.querySelectorAll('.rendered-markdown-comment-card[data-comment-id="606"]')).toHaveLength(1);
      expect(document.querySelector('.user-comment-row[data-comment-id="606"]')).toBeNull();
      // Toolbar is honest immediately, with no further user interaction.
      expect(document.querySelector('#review-button .review-button-text').textContent).toBe('1 comment');
      expect(document.getElementById('clear-comments-btn').disabled).toBe(false);

      // ...and back to zero right after deleting it through the card UI.
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="606"] .rendered-markdown-comment-delete').click();
      await new Promise(setImmediate);

      expect(view.container.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(0);
      expect(document.querySelector('#review-button .review-button-text').textContent).toBe('0 comments');
      expect(document.getElementById('clear-comments-btn').disabled).toBe(true);
    });

    it('deleteUserComment recounts for a Rendered-only comment, which has no Diff row or file card', async () => {
      // Regression: the toolbar recount used to live INSIDE the
      // `if (commentRow)` / `if (fileCommentCard)` DOM sweeps, so dismissing
      // a comment whose only surface is a Rendered card (this file has no
      // Diff body at all) removed the card via
      // `_refreshRenderedDocumentsComments()` but left "1 comment" in the
      // review button and Clear All enabled until the next comment action.
      // This is the AI/Review-panel delete path — NOT the in-card delete
      // button covered above (`_deleteRenderedBlockComment`).
      mgr.changedFilesByPath.set('docs/only-rendered.md', { file: 'docs/only-rendered.md', patch: null, insertions: 1, deletions: 0 });
      addFileWrapper('docs/only-rendered.md');
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: '# Title\n\nBody.\n' }) }));
      await mgr.setFileRenderMode('docs/only-rendered.md', 'rendered');
      const view = mgr._renderedDocuments.get('docs/only-rendered.md');

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 607 }) }));
      const comment = await mgr._createRenderedBlockComment('docs/only-rendered.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: null, body: 'rendered-only, dismissed from the panel'
      });
      view.addComment(comment);

      // Preconditions: exactly one surface, and the toolbar sees it.
      expect(view.container.querySelectorAll('.rendered-markdown-comment-card[data-comment-id="607"]')).toHaveLength(1);
      expect(document.querySelector('.user-comment-row[data-comment-id="607"]')).toBeNull();
      expect(document.querySelector('.file-comment-card[data-comment-id="607"]')).toBeNull();
      mgr.updateCommentCount();
      expect(document.querySelector('#review-button .review-button-text').textContent).toBe('1 comment');
      expect(document.getElementById('clear-comments-btn').disabled).toBe(false);

      const deleteFetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      sandbox.fetch = deleteFetch;
      await mgr.deleteUserComment(607);

      expect(deleteFetch).toHaveBeenCalledWith(
        '/api/reviews/1/comments/607',
        expect.objectContaining({ method: 'DELETE' })
      );
      // The Rendered card is gone...
      expect(view.container.querySelectorAll('.rendered-markdown-comment-card[data-comment-id="607"]')).toHaveLength(0);
      expect(mgr.userComments.some((c) => c.id === 607)).toBe(false);
      // ...and so is the stale +1 on both toolbar affordances.
      expect(mgr.countDraftComments()).toBe(0);
      expect(document.querySelector('#review-button .review-button-text').textContent).toBe('0 comments');
      expect(document.getElementById('clear-comments-btn').disabled).toBe(true);
    });

    it('deleteUserComment recounts exactly once when the comment has a Diff row too', async () => {
      // The recount was hoisted out of the two DOM sweeps; it must still
      // run for the ordinary Diff-row case, and only once (it used to fire
      // twice for a comment that had both a row and a file card).
      const { fileBody } = await setupLegacyDiffSurface();
      sandbox.fetch = vi.fn(async (url) => {
        if (String(url).includes('/file-content/')) {
          return { ok: true, json: async () => ({ lines: FILE_LINES }) };
        }
        return { ok: true, json: async () => ({ commentId: 608 }) };
      });
      await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 11, line_end: 11, diff_position: null, body: 'has a diff row'
      });
      expect(fileBody.querySelectorAll('.user-comment-row[data-comment-id="608"]')).toHaveLength(1);

      const recount = vi.spyOn(mgr, 'updateCommentCount');
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      await mgr.deleteUserComment(608);

      expect(recount).toHaveBeenCalledTimes(1);
      expect(fileBody.querySelectorAll('.user-comment-row[data-comment-id="608"]')).toHaveLength(0);
      expect(document.querySelector('#review-button .review-button-text').textContent).toBe('0 comments');
      recount.mockRestore();
    });

    it('a failing reveal does not lose the comment or abort the create', async () => {
      await setupLegacyDiffSurface();
      const original = PRManager.prototype.ensureLinesVisible;
      PRManager.prototype.ensureLinesVisible = async () => { throw new Error('reveal exploded'); };
      try {
        sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 605 }) }));
        const comment = await mgr._createRenderedBlockComment('docs/guide.md', {
          side: 'RIGHT', line_start: 11, line_end: 11, diff_position: null, body: 'survives'
        });
        expect(comment.id).toBe(605);
        expect(mgr.userComments).toContainEqual(expect.objectContaining({ id: 605 }));
      } finally {
        PRManager.prototype.ensureLinesVisible = original;
      }
    });
  });

  describe('out-of-hunk comments created in Rendered mode (Pierre engine)', () => {
    /**
     * A PierreBridge stand-in that models the parts of the REAL bridge
     * contract this flow depends on — `files`, per-line visibility,
     * `addContextRanges` revealing lines, and the annotation list — and
     * renders each comment annotation with the REAL
     * `PierreBridge.prototype._renderCommentAnnotation`, appending the
     * resulting light-DOM node into the file wrapper the way the vendor
     * slots it. That makes the `.user-comment-row` this test asserts on
     * (and that every comment counter keys off) genuine production DOM.
     * PierreBridge's own behavior is covered by tests/unit/pierre-bridge-*.
     * @param {string} fileName
     * @param {number[]} initiallyVisible - NEW-side line numbers on screen
     */
    function createVisibilityAwarePierreBridge(fileName, initiallyVisible) {
      const visible = new Set(initiallyVisible);
      const annotations = [];
      const contextRangeCalls = [];
      const wrapper = document.querySelector(`[data-file-name="${fileName}"]`);
      const slotHost = document.createElement('div');
      slotHost.className = 'pierre-diff-body';
      wrapper.appendChild(slotHost);

      return {
        files: new Map([[fileName, {}]]),
        contextRangeCalls,
        isLineVisible: (file, line) => file === fileName && visible.has(line),
        addContextRanges: (file, ranges) => {
          contextRangeCalls.push({ file, ranges });
          ranges.forEach(({ startLine, endLine }) => {
            for (let l = startLine; l <= endLine; l++) visible.add(l);
          });
          return true;
        },
        convertOldToNew: (_file, s, e) => ({ startLine: s, endLine: e }),
        getAnnotations: (file, type) => annotations
          .filter((a) => a.file === file && (!type || a.metadata.type === type)),
        addAnnotation: (file, annotation) => {
          annotations.push({
            file,
            lineNumber: annotation.lineNumber,
            side: annotation.side,
            metadata: { type: annotation.type, id: annotation.id, data: annotation.data }
          });
          if (annotation.type !== 'comment') return;
          // Only lines the vendor is actually showing get a slot — this is
          // precisely why the reveal step has to happen first.
          if (!visible.has(annotation.lineNumber)) return;
          slotHost.appendChild(
            PierreBridge.prototype._renderCommentAnnotation.call({}, annotation.data, annotation.id)
          );
        },
        removeAnnotation: (file, annotationId) => {
          const i = annotations.findIndex((a) => a.file === file && a.metadata.id === annotationId);
          if (i !== -1) annotations.splice(i, 1);
          slotHost.querySelector(`[data-comment-id="${annotationId.replace('comment-', '')}"]`)?.remove();
        }
      };
    }

    async function setupPierreSurface() {
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      addFileWrapper('docs/guide.md');
      // Only new lines 5-8 are on screen — 11 sits in a collapsed region.
      mgr.pierreBridge = createVisibilityAwarePierreBridge('docs/guide.md', [5, 6, 7, 8]);
      // _ensurePierreContentUpgrade is a vendor-worker concern with its own
      // coverage; stub it to a resolved no-op so this test exercises the
      // reveal-then-sync ordering rather than the worker handshake.
      mgr._ensurePierreContentUpgrade = async () => {};
    }

    it('expands the collapsed region via addContextRanges, then renders the comment annotation exactly once', async () => {
      await setupPierreSurface();
      expect(mgr.pierreBridge.isLineVisible('docs/guide.md', 11, 'RIGHT')).toBe(false);
      expect(mgr.countDraftComments()).toBe(0);

      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 701 }) }));
      const comment = await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 11, line_end: 11, diff_position: null, body: 'Pierre out-of-hunk'
      });

      // The reveal used the shared ensureLinesVisible contract with this
      // file/range/side, before the sync.
      expect(mgr.pierreBridge.contextRangeCalls).toEqual([
        { file: 'docs/guide.md', ranges: [{ startLine: 11, endLine: 11 }] }
      ]);
      expect(mgr.pierreBridge.isLineVisible('docs/guide.md', 11, 'RIGHT')).toBe(true);

      const annotations = mgr.pierreBridge.getAnnotations('docs/guide.md', 'comment');
      expect(annotations).toHaveLength(1);
      expect(annotations[0].metadata.id).toBe('comment-701');
      expect(annotations[0].lineNumber).toBe(11);
      expect(annotations[0].side).toBe('RIGHT');
      expect(annotations[0].metadata.data).toBe(comment);

      // Genuine slotted `.user-comment-row` produced by the real
      // PierreBridge renderer — this is the node every counter keys off.
      const rows = document.querySelectorAll('.user-comment-row[data-comment-id="701"]');
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.lineStart).toBe('11');

      expect(mgr.countDraftComments()).toBe(1);
      mgr.updateCommentCount();
      expect(document.querySelector('#review-button .review-button-text').textContent).toBe('1 comment');
      expect(document.getElementById('clear-comments-btn').disabled).toBe(false);
    });

    it('does not re-expand a target that is already visible (no redundant context range)', async () => {
      await setupPierreSurface();
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 702 }) }));

      await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 6, line_end: 6, diff_position: 3, body: 'in-hunk'
      });

      expect(mgr.pierreBridge.contextRangeCalls).toEqual([]);
      expect(mgr.pierreBridge.getAnnotations('docs/guide.md', 'comment')).toHaveLength(1);
      expect(document.querySelectorAll('.user-comment-row[data-comment-id="702"]')).toHaveLength(1);
      expect(mgr.countDraftComments()).toBe(1);
    });

    it('syncs the annotation exactly once even though the reveal triggers a bridge rerender', async () => {
      await setupPierreSurface();
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 703 }) }));

      await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 11, line_end: 11, diff_position: null, body: 'once'
      });

      expect(mgr.pierreBridge.getAnnotations('docs/guide.md', 'comment')
        .filter((a) => a.metadata.id === 'comment-703')).toHaveLength(1);
      expect(document.querySelectorAll('[data-comment-id="703"]')).toHaveLength(1);
    });
  });

  describe('AI/Review panel notification from Rendered-mode comment CRUD', () => {
    let aiPanel;

    beforeEach(() => {
      aiPanel = {
        showDismissedComments: false,
        addComment: vi.fn(),
        updateComment: vi.fn(),
        removeComment: vi.fn(),
        updateFindingStatus: vi.fn()
      };
      // pr.js resolves `window.aiPanel` through its vm sandbox global.
      sandbox.aiPanel = aiPanel;
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
    });

    it('notifies the panel exactly once on create', async () => {
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 801 }) }));
      const comment = await mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: 4, body: 'hello panel'
      });

      expect(aiPanel.addComment).toHaveBeenCalledTimes(1);
      expect(aiPanel.addComment).toHaveBeenCalledWith(comment);
      expect(aiPanel.updateComment).not.toHaveBeenCalled();
      expect(aiPanel.removeComment).not.toHaveBeenCalled();
    });

    it('notifies the panel exactly once on create even when a legacy Diff row is also synced', async () => {
      const { wrapper } = addFileWrapper('docs/paired.md');
      mgr.changedFilesByPath.set('docs/paired.md', { file: 'docs/paired.md', patch: null, insertions: 1, deletions: 1 });
      addLegacyDiffRow(wrapper, 3);
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 802 }) }));

      await mgr._createRenderedBlockComment('docs/paired.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: 4, body: 'no dupes'
      });

      expect(document.querySelectorAll('.user-comment-row[data-comment-id="802"]')).toHaveLength(1);
      expect(aiPanel.addComment).toHaveBeenCalledTimes(1);
    });

    it('notifies the panel on edit with the new body', async () => {
      mgr.userComments = [
        { id: 803, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'before' }
      ];
      sandbox.fetch = vi.fn(async () => ({ ok: true }));

      await mgr._editRenderedBlockComment(803, 'after');

      expect(aiPanel.updateComment).toHaveBeenCalledTimes(1);
      expect(aiPanel.updateComment).toHaveBeenCalledWith(803, { body: 'after' });
    });

    it('removes the comment from the panel on delete when "show dismissed" is off', async () => {
      mgr.userComments = [
        { id: 804, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'bye' }
      ];
      sandbox.fetch = vi.fn(async () => ({ ok: true }));

      await mgr._deleteRenderedBlockComment(804);

      expect(aiPanel.removeComment).toHaveBeenCalledTimes(1);
      expect(aiPanel.removeComment).toHaveBeenCalledWith(804);
      expect(aiPanel.updateComment).not.toHaveBeenCalled();
    });

    it('marks the comment dismissed in the panel on delete when "show dismissed" is on — matching deleteUserComment', async () => {
      aiPanel.showDismissedComments = true;
      mgr.userComments = [
        { id: 805, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'bye' }
      ];
      sandbox.fetch = vi.fn(async () => ({ ok: true }));

      await mgr._deleteRenderedBlockComment(805);

      expect(aiPanel.updateComment).toHaveBeenCalledTimes(1);
      expect(aiPanel.updateComment).toHaveBeenCalledWith(805, { status: 'inactive' });
      expect(aiPanel.removeComment).not.toHaveBeenCalled();
    });

    it('does not throw when no AI panel is mounted', async () => {
      delete sandbox.aiPanel;
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 806 }) }));
      await expect(mgr._createRenderedBlockComment('docs/guide.md', {
        side: 'RIGHT', line_start: 3, line_end: 3, diff_position: 4, body: 'no panel'
      })).resolves.toMatchObject({ id: 806 });
    });

    /**
     * Deleting a comment ADOPTED from an AI suggestion orphans its parent
     * suggestion; the DELETE response reports it in `dismissedSuggestionId`.
     * `deleteUserComment` has always consumed that; the Rendered card's
     * Delete button is a SECOND entry point over the same endpoint and must
     * not disagree — otherwise the suggestion is left collapsed/hidden with
     * no restore path in the UI.
     */
    describe('parent suggestion state on delete (parity with deleteUserComment)', () => {
      function addSuggestionCard(suggestionId) {
        const div = document.createElement('div');
        div.className = 'ai-suggestion';
        div.dataset.suggestionId = String(suggestionId);
        div.dataset.hiddenForAdoption = 'true';
        document.body.appendChild(div);
        return div;
      }

      it('_deleteRenderedBlockComment applies the dismissed-suggestion state the server reports', async () => {
        const suggestionDiv = addSuggestionCard(9001);
        mgr.userComments = [
          { id: 810, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'adopted', parent_id: 9001 }
        ];
        sandbox.fetch = vi.fn(async () => ({
          ok: true,
          json: async () => ({ success: true, dismissedSuggestionId: 9001 })
        }));

        await mgr._deleteRenderedBlockComment(810);

        expect(aiPanel.updateFindingStatus).toHaveBeenCalledWith(9001, 'dismissed');
        // hiddenForAdoption is DELETED (not set to 'false'), so a later
        // restore takes the API path rather than the toggle-only shortcut —
        // exactly what deleteUserComment does.
        expect(suggestionDiv.dataset.hiddenForAdoption).toBeUndefined();
      });

      it('leaves suggestion state alone when the delete orphaned no suggestion', async () => {
        const suggestionDiv = addSuggestionCard(9002);
        mgr.userComments = [
          { id: 811, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'plain' }
        ];
        sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));

        await mgr._deleteRenderedBlockComment(811);

        expect(aiPanel.updateFindingStatus).not.toHaveBeenCalled();
        expect(suggestionDiv.dataset.hiddenForAdoption).toBe('true');
      });

      it('still completes the delete when the response carries no parsable body', async () => {
        mgr.userComments = [
          { id: 812, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'no body' }
        ];
        // No `json` method at all: a successful delete must not fail
        // because there was nothing to parse.
        sandbox.fetch = vi.fn(async () => ({ ok: true }));

        await expect(mgr._deleteRenderedBlockComment(812)).resolves.toBeUndefined();
        expect(mgr.userComments.find((c) => c.id === 812)).toBeUndefined();
        expect(aiPanel.updateFindingStatus).not.toHaveBeenCalled();
      });

      it('deleteUserComment and _deleteRenderedBlockComment leave the same suggestion state', async () => {
        const viaDiff = addSuggestionCard(9003);
        const viaRendered = addSuggestionCard(9004);
        mgr.userComments = [
          { id: 813, file: 'docs/guide.md', side: 'RIGHT', line_start: 3, line_end: 3, is_file_level: 0, status: 'active', body: 'a', parent_id: 9003 },
          { id: 814, file: 'docs/guide.md', side: 'RIGHT', line_start: 4, line_end: 4, is_file_level: 0, status: 'active', body: 'b', parent_id: 9004 }
        ];

        sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ dismissedSuggestionId: 9003 }) }));
        await mgr.deleteUserComment(813);
        sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ dismissedSuggestionId: 9004 }) }));
        await mgr._deleteRenderedBlockComment(814);

        expect(viaRendered.dataset.hiddenForAdoption).toBe(viaDiff.dataset.hiddenForAdoption);
        expect(aiPanel.updateFindingStatus.mock.calls).toEqual([
          [9003, 'dismissed'],
          [9004, 'dismissed']
        ]);
      });
    });
  });

  describe('adopted suggestions reach an open Rendered view', () => {
    beforeEach(() => {
      sandbox.aiPanel = { addComment: vi.fn(), updateFindingStatus: vi.fn() };
    });

    it('_notifyAdoption records the comment in userComments and refreshes live Rendered views', async () => {
      addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      sandbox.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ newContents: '# Title\n\nParagraph A\n' })
      }));
      await mgr.setFileRenderMode('docs/guide.md', 'rendered');
      const renderedContainer = mgr._renderedDocuments.get('docs/guide.md').container;
      expect(renderedContainer.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(0);

      const adopted = mgr._buildCommentObject({
        userCommentId: 901,
        formattedBody: 'Adopted suggestion body',
        fileName: 'docs/guide.md',
        lineNumber: 3,
        lineEnd: 3,
        suggestionType: 'bug',
        suggestionTitle: 'A bug',
        suggestionId: 55,
        diffPosition: 4,
        side: 'RIGHT'
      });

      mgr._notifyAdoption(55, adopted);

      expect(mgr.userComments).toContainEqual(expect.objectContaining({ id: 901, file: 'docs/guide.md' }));
      const cards = renderedContainer.querySelectorAll('.rendered-markdown-comment-card[data-comment-id="901"]');
      expect(cards).toHaveLength(1);
      expect(cards[0].textContent).toContain('Adopted suggestion body');
      // parent_id is set, so it renders with AI-origin styling.
      expect(cards[0].classList.contains('comment-ai-origin')).toBe(true);
      // Pre-existing behavior preserved.
      expect(sandbox.aiPanel.addComment).toHaveBeenCalledWith(adopted);
      expect(sandbox.aiPanel.updateFindingStatus).toHaveBeenCalledWith(55, 'adopted');
    });

    it('is id-keyed: a repeated notification never duplicates the comment or its card', async () => {
      addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      sandbox.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ newContents: '# Title\n\nParagraph A\n' }) }));
      await mgr.setFileRenderMode('docs/guide.md', 'rendered');
      const renderedContainer = mgr._renderedDocuments.get('docs/guide.md').container;

      const adopted = { id: 902, file: 'docs/guide.md', line_start: 3, line_end: 3, side: 'RIGHT', body: 'once', parent_id: 56 };
      mgr._notifyAdoption(56, adopted);
      mgr._notifyAdoption(56, adopted);

      expect(mgr.userComments.filter((c) => c.id === 902)).toHaveLength(1);
      expect(renderedContainer.querySelectorAll('.rendered-markdown-comment-card[data-comment-id="902"]')).toHaveLength(1);
    });

    it('does not disturb the Diff surface for a file with no Rendered view open', () => {
      const { wrapper } = addFileWrapper('docs/guide.md');
      const suggestionRow = addLegacyDiffRow(wrapper, 3);
      const adopted = { id: 903, file: 'docs/guide.md', line_start: 3, line_end: 3, side: 'RIGHT', body: 'diff only', parent_id: 57 };

      mgr._renderAdoptedUserComment(adopted, suggestionRow);
      mgr._notifyAdoption(57, adopted);

      expect(document.querySelectorAll('.user-comment-row[data-comment-id="903"]')).toHaveLength(1);
      expect(document.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(0);
      expect(mgr.userComments).toContainEqual(expect.objectContaining({ id: 903 }));
    });

    it('merges rather than overwrites when the comment is already known', () => {
      mgr.userComments = [
        { id: 904, file: 'docs/guide.md', line_start: 3, body: 'stored', status: 'active', is_file_level: 0 }
      ];
      mgr.registerCreatedUserComment({ id: 904, file: 'docs/guide.md', line_start: 3, body: 'refreshed' });

      expect(mgr.userComments).toHaveLength(1);
      expect(mgr.userComments[0]).toMatchObject({ id: 904, body: 'refreshed', status: 'active', is_file_level: 0 });
    });

    it('ignores a comment with no id rather than corrupting userComments', () => {
      mgr.userComments = [];
      mgr.registerCreatedUserComment(null);
      mgr.registerCreatedUserComment({ file: 'docs/guide.md' });
      expect(mgr.userComments).toEqual([]);
    });
  });

  /**
   * Producer/consumer contract for the legacy (non-@pierre/diffs) inline
   * comment form. CommentManager owns persistence; PRManager owns
   * `userComments` and the Rendered views. Before the fix, a comment
   * created in the legacy Diff form never reached `prManager.userComments`,
   * so it was missing from an open Rendered view until a full reload.
   */
  describe('legacy CommentManager create -> Rendered view', () => {
    it('CommentManager.saveUserComment records the comment via PRManager and it appears in the open Rendered view', async () => {
      const { wrapper } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      sandbox.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ newContents: '# Title\n\nParagraph A\n' })
      }));
      await mgr.setFileRenderMode('docs/guide.md', 'rendered');
      const renderedContainer = mgr._renderedDocuments.get('docs/guide.md').container;

      // Drive the REAL CommentManager save path: a textarea carrying the
      // dataset the production form writes, plus a form row whose previous
      // sibling is the target diff line.
      const targetRow = addLegacyDiffRow(wrapper, 3);
      const table = targetRow.closest('tbody');
      const formRow = document.createElement('tr');
      table.appendChild(formRow);

      const textarea = document.createElement('textarea');
      textarea.dataset.file = 'docs/guide.md';
      textarea.dataset.line = '3';
      textarea.dataset.lineEnd = '3';
      textarea.dataset.diffPosition = '4';
      textarea.dataset.side = 'RIGHT';
      textarea.value = 'From the legacy diff form';

      // CommentManager is required directly (not vm-sandboxed), so it uses
      // the real jsdom window's fetch.
      dom.window.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 1001 }) }));
      global.fetch = dom.window.fetch;
      try {
        await mgr.commentManager.saveUserComment(textarea, formRow);
      } finally {
        delete global.fetch;
      }

      // Authoritative state updated...
      expect(mgr.userComments).toContainEqual(expect.objectContaining({
        id: 1001, file: 'docs/guide.md', line_start: 3, body: 'From the legacy diff form'
      }));
      // ...the legacy Diff row still rendered (pre-existing behavior)...
      expect(document.querySelectorAll('.user-comment-row[data-comment-id="1001"]')).toHaveLength(1);
      // ...and the open Rendered view now shows it, exactly once.
      expect(renderedContainer.querySelectorAll('.rendered-markdown-comment-card[data-comment-id="1001"]')).toHaveLength(1);
      // Counted once despite being on two surfaces.
      expect(mgr.countDraftComments()).toBe(1);
    });

    it('does not fork persistence: exactly one POST is issued for the create', async () => {
      const { wrapper } = addFileWrapper('docs/guide.md');
      mgr.changedFilesByPath.set('docs/guide.md', { file: 'docs/guide.md', patch: null, insertions: 1, deletions: 1 });
      const targetRow = addLegacyDiffRow(wrapper, 3);
      const formRow = document.createElement('tr');
      targetRow.closest('tbody').appendChild(formRow);

      const textarea = document.createElement('textarea');
      textarea.dataset.file = 'docs/guide.md';
      textarea.dataset.line = '3';
      textarea.dataset.side = 'RIGHT';
      textarea.value = 'single post';

      const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 1002 }) }));
      dom.window.fetch = fetchSpy;
      global.fetch = fetchSpy;
      try {
        await mgr.commentManager.saveUserComment(textarea, formRow);
      } finally {
        delete global.fetch;
      }

      const posts = fetchSpy.mock.calls.filter(([, opts]) => opts?.method === 'POST');
      expect(posts).toHaveLength(1);
    });
  });

  describe('renderDiff() rendered-state reset: Outline scroll-spy lifecycle', () => {
    it('_wireOutlineScrollSpy disconnects the previous observer before creating a new one', () => {
      const disconnect = vi.fn();
      const observe = vi.fn();
      sandbox.IntersectionObserver = class {
        constructor() { this.disconnect = disconnect; this.observe = observe; }
      };
      const container = document.createElement('div');
      container.innerHTML = '<h2 id="md-heading-a--x">X</h2>';
      const view = { container, slugFromHeadingId: () => 'x' };

      mgr._wireOutlineScrollSpy(view);
      const first = mgr._outlineScrollObserver;
      expect(first).toBeTruthy();

      mgr._wireOutlineScrollSpy(view);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(mgr._outlineScrollObserver).not.toBe(first);
    });

    it('_teardownOutlineScrollSpy disconnects and clears, and is idempotent', () => {
      const disconnect = vi.fn();
      mgr._outlineScrollObserver = { disconnect };

      mgr._teardownOutlineScrollSpy();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(mgr._outlineScrollObserver).toBeNull();

      // Second call must not throw or re-disconnect.
      mgr._teardownOutlineScrollSpy();
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('renderDiff() disconnects the observer BEFORE clearing rendered state / replacing the DOM', async () => {
      const order = [];
      mgr._outlineScrollObserver = { disconnect: () => order.push('disconnect') };
      // The rendered-state maps are replaced right after the teardown; record
      // when that happens by watching the map identity change.
      const originalDocs = mgr._renderedDocuments;

      // Drive the real reset sequence. renderDiff does a lot more than this
      // block, so stop it right after the reset by making the very next step
      // (reading pr.changed_files) observable and then throwing.
      sandbox.document = dom.window.document;
      mgr._teardownFileBodyObserver = () => order.push('teardown-file-body');
      mgr._createFileBodyObserver = () => null;
      mgr._createPierreRenderBudget = () => null;
      mgr._renderOutlineSidebar = () => {
        order.push(mgr._renderedDocuments === originalDocs ? 'state-not-yet-reset' : 'state-reset');
        throw new Error('stop-after-reset');
      };
      mgr.setDiffLoading = () => {};

      // renderDiff is synchronous up to (and past) the reset block.
      expect(() => mgr.renderDiff({ changed_files: [] })).toThrow('stop-after-reset');
      expect(order).toEqual(['teardown-file-body', 'disconnect', 'state-reset']);
      expect(mgr._outlineScrollObserver).toBeNull();
    });
  });
});
