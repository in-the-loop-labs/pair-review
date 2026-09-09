// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const markdownit = require('markdown-it');
const createDOMPurify = require('dompurify');
const { configureMarkdownIt, createRenderMarkdown, escapeHtmlAttribute } = require('../../public/js/utils/markdown.js');

const RENDERED_DOC_PATH = '../../public/js/modules/rendered-document-view.js';
const RENDERED_MD_PATH = '../../public/js/modules/rendered-markdown.js';
const HUNK_PARSER_PATH = '../../public/js/modules/hunk-parser.js';

describe('RenderedDocumentView', () => {
  let dom;
  let RenderedDocumentView;

  beforeEach(() => {
    delete require.cache[require.resolve(RENDERED_DOC_PATH)];
    delete require.cache[require.resolve(RENDERED_MD_PATH)];
    delete require.cache[require.resolve(HUNK_PARSER_PATH)];

    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;

    require(HUNK_PARSER_PATH); // window.HunkParser
    RenderedDocumentView = require(RENDERED_DOC_PATH).RenderedDocumentView;
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
  });

  function buildRenderMarkdown() {
    const purify = createDOMPurify(dom.window);
    const md = configureMarkdownIt(markdownit, { html: true });
    return createRenderMarkdown({ md, purify });
  }

  function makeView(opts) {
    const container = document.createElement('div');
    const md = markdownit({ html: false, breaks: true, linkify: true, typographer: true });
    return new RenderedDocumentView({
      container,
      filePath: opts.filePath || 'docs/guide.md',
      source: opts.source,
      patch: opts.patch || null,
      md,
      renderMarkdown: opts.renderMarkdown || buildRenderMarkdown(),
      escapeHtmlAttribute,
      changedMarkdownPaths: opts.changedMarkdownPaths || new Set(),
      callbacks: opts.callbacks || {}
    });
  }

  it('renders one wrapper block per top-level markdown block with line-range data attributes', () => {
    const view = makeView({ source: '# Title\n\nSome text.\n' });
    view.render();

    const blocks = view.container.querySelectorAll('.rendered-markdown-block');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].dataset.startLine).toBe('1');
    expect(blocks[0].dataset.endLine).toBe('1');
    expect(blocks[1].dataset.startLine).toBe('3');
    expect(blocks[1].dataset.endLine).toBe('3');
  });

  it('assigns a namespaced id to headings and marks their wrapper, for Outline navigation', () => {
    const view = makeView({ source: '## Usage\n\ntext\n', filePath: 'docs/guide.md' });
    view.render();
    const heading = view.container.querySelector('h2');
    expect(heading.id).toBe('md-heading-docs-guide-md--usage');
    expect(heading.closest('.rendered-markdown-block').classList.contains('rendered-markdown-heading-block')).toBe(true);
  });

  it('scopes heading ids by file so two documents with the same heading text do not collide', () => {
    const viewA = makeView({ source: '## Overview\n\ntext A\n', filePath: 'docs/a.md' });
    const viewB = makeView({ source: '## Overview\n\ntext B\n', filePath: 'docs/b.md' });
    viewA.render();
    viewB.render();
    // jsdom doesn't implement scrollIntoView.
    viewA.container.querySelector('h2').scrollIntoView = () => {};
    viewB.container.querySelector('h2').scrollIntoView = () => {};

    const idA = viewA.container.querySelector('h2').id;
    const idB = viewB.container.querySelector('h2').id;
    expect(idA).not.toBe(idB);

    // Attach both documents to the same real document so a global id
    // lookup is meaningful (mirrors two files both being in Rendered mode
    // simultaneously in the real app).
    document.body.appendChild(viewA.container);
    document.body.appendChild(viewB.container);
    expect(document.querySelectorAll(`#${idA}`)).toHaveLength(1);
    expect(document.querySelectorAll(`#${idB}`)).toHaveLength(1);

    expect(viewA.scrollToHeading('overview')).toBe(true);
    expect(viewB.scrollToHeading('overview')).toBe(true);
    expect(viewA.container.querySelector('h2')).toBe(document.querySelector(`#${idA}`));
  });

  it('slugFromHeadingId recovers the bare slug for its own ids and returns null for a foreign id', () => {
    const view = makeView({ source: '## Usage\n', filePath: 'docs/guide.md' });
    view.render();
    const heading = view.container.querySelector('h2');
    expect(view.slugFromHeadingId(heading.id)).toBe('usage');
    expect(view.slugFromHeadingId('md-heading-some-other-file--usage')).toBeNull();
    expect(view.slugFromHeadingId(null)).toBeNull();
  });

  it('scrollToHeading finds the heading by slug and returns true; false for unknown slugs', () => {
    const view = makeView({ source: '# Title\n' });
    view.render();
    const heading = view.container.querySelector('h1');
    let scrolled = false;
    heading.scrollIntoView = () => { scrolled = true; };
    heading.focus = () => {};
    expect(view.scrollToHeading('title')).toBe(true);
    expect(scrolled).toBe(true);
    expect(view.scrollToHeading('does-not-exist')).toBe(false);
  });

  it('sanitizes malicious markdown content exactly like the established comment renderer (no script execution, no event handler attrs)', () => {
    const view = makeView({ source: 'Hello <img src=x onerror="window.pwned=1"> <script>window.pwned=2</script> world\n' });
    view.render();
    const html = view.container.querySelector('.rendered-markdown-block-content').innerHTML;
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<script');
    expect(html).toContain('Hello');
    expect(html).toContain('world');
  });

  describe('internal link interception', () => {
    it('intercepts a relative link to another changed markdown file and calls onNavigateInternalLink, not the browser', () => {
      let navigated = null;
      const view = makeView({
        source: 'See [Setup](./setup.md) for details.\n',
        changedMarkdownPaths: new Set(['docs/setup.md']),
        callbacks: { onNavigateInternalLink: (target, fragment) => { navigated = { target, fragment }; } }
      });
      view.render();
      const anchor = view.container.querySelector('a');
      expect(anchor.classList.contains('rendered-markdown-internal-link')).toBe(true);

      const evt = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
      anchor.dispatchEvent(evt);

      expect(evt.defaultPrevented).toBe(true);
      expect(navigated).toEqual({ target: 'docs/setup.md', fragment: null });
    });

    it('leaves an external link untouched (no interception class, default safe attrs preserved)', () => {
      let navigated = null;
      const view = makeView({
        source: 'See [GitHub](https://github.com) for source.\n',
        callbacks: { onNavigateInternalLink: () => { navigated = 'called'; } }
      });
      view.render();
      const anchor = view.container.querySelector('a');
      expect(anchor.classList.contains('rendered-markdown-internal-link')).toBe(false);
      expect(anchor.getAttribute('href')).toBe('https://github.com');

      anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(navigated).toBeNull();
    });

    it('does not intercept a relative link to a markdown file that is NOT in the changed set', () => {
      const view = makeView({
        source: 'See [Other](./other.md).\n',
        changedMarkdownPaths: new Set(['docs/setup.md'])
      });
      view.render();
      const anchor = view.container.querySelector('a');
      expect(anchor.classList.contains('rendered-markdown-internal-link')).toBe(false);
    });
  });

  describe('block comments', () => {
    it('renders an "Add comment" button per block and opens a form on click', () => {
      const view = makeView({ source: 'Some paragraph.\n' });
      view.render();
      const addBtn = view.container.querySelector('.rendered-markdown-add-comment-btn');
      addBtn.click();
      expect(view.container.querySelector('.rendered-markdown-comment-form')).toBeTruthy();
    });

    it('submits a comment via onCreateComment with the resolved target, and renders the returned comment', async () => {
      const calls = [];
      const view = makeView({
        source: 'Some paragraph.\n',
        patch: '@@ -1,1 +1,1 @@\n-old\n+Some paragraph.\n',
        callbacks: {
          onCreateComment: async (payload) => {
            calls.push(payload);
            return { id: 42, file: 'docs/guide.md', line_start: payload.line_start, line_end: payload.line_end, body: payload.body, source: 'user' };
          }
        }
      });
      view.render();

      const addBtn = view.container.querySelector('.rendered-markdown-add-comment-btn');
      addBtn.click();
      const textarea = view.container.querySelector('.rendered-markdown-comment-textarea');
      textarea.value = 'Nice paragraph!';
      textarea.dispatchEvent(new dom.window.Event('input'));
      const saveBtn = view.container.querySelector('.rendered-markdown-comment-form .submit');
      saveBtn.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        file: 'docs/guide.md',
        side: 'RIGHT',
        line_start: 1,
        line_end: 1,
        diff_position: 3,
        body: 'Nice paragraph!'
      });
      // The comment card should now be visible with the saved body rendered.
      const card = view.container.querySelector('.rendered-markdown-comment-card');
      expect(card).toBeTruthy();
      expect(card.dataset.commentId).toBe('42');
      expect(card.textContent).toContain('Nice paragraph!');
    });

    it('shows the "outside changed lines" note when the block is not covered by the diff', () => {
      const view = makeView({
        source: 'Unchanged paragraph.\n',
        patch: '@@ -50,1 +50,1 @@\n-old\n+new\n'
      });
      view.render();
      view.container.querySelector('.rendered-markdown-add-comment-btn').click();
      expect(view.container.querySelector('.rendered-markdown-context-note')).toBeTruthy();
    });

    describe('diff-position memoization', () => {
      const HUNK = '@@ -1,4 +1,4 @@\n context one\n context two\n-old three\n+new three\n context four\n';

      /**
       * Count how many times the patch is actually PARSED while a document
       * full of comments is built. Spying on HunkParser (the expensive step)
       * rather than on the memo itself keeps the assertion about the real
       * cost, not about an implementation detail of the cache.
       */
      function spyOnPatchParsing() {
        const HunkParser = window.HunkParser;
        const original = HunkParser.parseDiffIntoBlocks.bind(HunkParser);
        const spy = vi.fn(original);
        HunkParser.parseDiffIntoBlocks = spy;
        return { spy, restore: () => { HunkParser.parseDiffIntoBlocks = original; } };
      }

      it('parses the patch once for a whole batch of comment cards, not once per card', () => {
        const view = makeView({ source: 'one\ntwo\nnew three\nfour\n', patch: HUNK });
        view.render();
        const { spy, restore } = spyOnPatchParsing();
        try {
          view.setComments([1, 2, 3, 4, 5, 6].map((n) => ({
            id: 100 + n, line_start: 3, line_end: 3, body: `comment ${n}`
          })));
          expect(view.container.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(6);
          expect(spy).toHaveBeenCalledTimes(1);
        } finally {
          restore();
        }
      });

      it('gives the same in/out-of-hunk answer cached as uncached, including for CONTEXT lines', () => {
        // The discriminating input class: line 4 is an unchanged CONTEXT
        // line INSIDE the hunk. It is addressable in the diff, so it must
        // NOT get the "posted as a file-level comment" indicator — the same
        // answer the Diff surface's hunk-membership check gives.
        const view = makeView({ source: 'one\ntwo\nnew three\nfour\n', patch: HUNK });
        view.render();
        view.setComments([
          { id: 201, line_start: 3, line_end: 3, body: 'changed line' },
          { id: 202, line_start: 4, line_end: 4, body: 'context line inside the hunk' },
          { id: 203, line_start: 40, line_end: 40, body: 'far outside every hunk' }
        ]);
        const indicator = (id) => !!view.container.querySelector(
          `.rendered-markdown-comment-card[data-comment-id="${id}"] .expanded-context-indicator`
        );
        expect(indicator(201)).toBe(false);
        expect(indicator(202)).toBe(false);
        expect(indicator(203)).toBe(true);

        // Byte-for-byte the same verdicts from a view that never reuses a
        // cached map (one comment per fresh view).
        for (const c of [
          { id: 201, line_start: 3 }, { id: 202, line_start: 4 }, { id: 203, line_start: 40 }
        ]) {
          const fresh = makeView({ source: 'one\ntwo\nnew three\nfour\n', patch: HUNK });
          fresh.render();
          fresh.setComments([{ ...c, line_end: c.line_start, body: 'x' }]);
          expect(!!fresh.container.querySelector('.expanded-context-indicator')).toBe(indicator(c.id));
        }
      });

      it('memoizes a NULL patch instead of handing back the empty cache slot', () => {
        // This is the whole job of the `_NO_PATCH_CACHED` key sentinel, and
        // the only input class that discriminates it: `null` is a legitimate
        // `this.patch` (a file with no diff at all), so a nullish "nothing
        // cached yet" key would compare EQUAL to it on the very first call
        // and return the still-empty cache slot. Callers pass the result
        // straight into `RenderedMarkdown.resolveCommentTarget({ positions })`,
        // so that would be a `undefined`/`null` map reaching a `.get`.
        const view = makeView({ source: 'one\ntwo\n', patch: null });
        view.render();

        const first = view._diffPositions();
        expect(first).toBeInstanceOf(Map);
        expect(first.size).toBe(0);
        // Second call is the memoized hit, not a second empty map.
        expect(view._diffPositions()).toBe(first);

        // And the verdict a card actually renders from is unaffected: with no
        // patch, every line is outside every hunk.
        view.setComments([{ id: 220, line_start: 1, line_end: 1, body: 'x' }]);
        expect(view.container.querySelector('.expanded-context-indicator')).toBeTruthy();
      });

      it('recomputes when the host swaps the patch, so a stale map can never answer', () => {
        const view = makeView({ source: 'one\ntwo\nnew three\nfour\n', patch: HUNK });
        view.render();
        view.setComments([{ id: 210, line_start: 3, line_end: 3, body: 'x' }]);
        expect(view.container.querySelector('.expanded-context-indicator')).toBeNull();

        // A patch that no longer covers line 3 at all.
        view.patch = '@@ -80,1 +80,1 @@\n-old\n+new\n';
        view.setComments([]);
        view.setComments([{ id: 210, line_start: 3, line_end: 3, body: 'x' }]);
        expect(view.container.querySelector('.expanded-context-indicator')).toBeTruthy();
      });
    });

    it('restores focus to the "Add comment" button when the form is cancelled', () => {
      const view = makeView({ source: 'Some paragraph.\n' });
      view.render();
      document.body.appendChild(view.container);

      const addBtn = view.container.querySelector('.rendered-markdown-add-comment-btn');
      addBtn.click();
      expect(view.container.querySelector('.rendered-markdown-comment-form')).toBeTruthy();

      view.container.querySelector('.rendered-markdown-comment-form .cancel').click();

      expect(view.container.querySelector('.rendered-markdown-comment-form')).toBeNull();
      expect(document.activeElement).toBe(addBtn);
    });

    it('restores focus to the "Add comment" button when the form is dismissed via Escape', () => {
      const view = makeView({ source: 'Some paragraph.\n' });
      view.render();
      document.body.appendChild(view.container);

      const addBtn = view.container.querySelector('.rendered-markdown-add-comment-btn');
      addBtn.click();
      const textarea = view.container.querySelector('.rendered-markdown-comment-textarea');
      textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(view.container.querySelector('.rendered-markdown-comment-form')).toBeNull();
      expect(document.activeElement).toBe(addBtn);
    });

    it('restores focus to the "Edit" button when an in-place comment edit is cancelled', () => {
      const view = makeView({ source: 'text\n' });
      view.render();
      document.body.appendChild(view.container);
      view.addComment({ id: 7, line_start: 1, body: 'original text' });

      const editBtn = view.container.querySelector('.rendered-markdown-comment-edit');
      editBtn.click();
      expect(view.container.querySelector('.rendered-markdown-comment-body textarea')).toBeTruthy();

      view.container.querySelector('.rendered-markdown-comment-body .cancel').click();

      expect(view.container.querySelector('.rendered-markdown-comment-body textarea')).toBeNull();
      expect(document.activeElement).toBe(editBtn);
    });

    it('restores focus to the "Edit" button when an in-place comment edit is dismissed via Escape', () => {
      const view = makeView({ source: 'text\n' });
      view.render();
      document.body.appendChild(view.container);
      view.addComment({ id: 7, line_start: 1, body: 'original text' });

      const editBtn = view.container.querySelector('.rendered-markdown-comment-edit');
      editBtn.click();
      const textarea = view.container.querySelector('.rendered-markdown-comment-body textarea');
      textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(view.container.querySelector('.rendered-markdown-comment-body textarea')).toBeNull();
      expect(document.activeElement).toBe(editBtn);
    });

    it('hides the icon actions while an in-place edit is open, and restores them on cancel', () => {
      const view = makeView({ source: 'text\n' });
      view.render();
      document.body.appendChild(view.container);
      view.addComment({ id: 7, line_start: 1, body: 'original text' });

      const shell = view.container.querySelector('.user-comment');
      expect(shell.classList.contains('editing-mode')).toBe(false);

      view.container.querySelector('.rendered-markdown-comment-edit').click();
      // Same `editing-mode` state the Diff surface uses to hide the actions.
      expect(shell.classList.contains('editing-mode')).toBe(true);

      view.container.querySelector('.rendered-markdown-comment-body .cancel').click();
      expect(shell.classList.contains('editing-mode')).toBe(false);
      // Focus restoration still works, which it could not if the button
      // were still hidden when focus() ran.
      expect(document.activeElement).toBe(
        view.container.querySelector('.rendered-markdown-comment-edit')
      );
    });

    it('leaves editing mode after a successful save, and stays in it after a failed one so the retry is reachable', async () => {
      let fail = true;
      const view = makeView({
        source: 'text\n',
        callbacks: {
          onEditComment: async () => {
            if (fail) throw new Error('boom');
          }
        }
      });
      view.render();
      document.body.appendChild(view.container);
      view.addComment({ id: 8, line_start: 1, body: 'original' });
      const shell = view.container.querySelector('.user-comment');

      view.container.querySelector('.rendered-markdown-comment-edit').click();
      const textarea = view.container.querySelector('.rendered-markdown-comment-body textarea');
      textarea.value = 'edited';
      view.container.querySelector('.rendered-markdown-comment-body .submit').click();
      await vi.waitFor(() => {
        expect(view.container.querySelector('.rendered-markdown-comment-body textarea')).toBeTruthy();
      });
      // Failed save: the textarea is still on screen, so the card stays in
      // editing mode rather than showing actions over a live edit form.
      expect(shell.classList.contains('editing-mode')).toBe(true);

      fail = false;
      view.container.querySelector('.rendered-markdown-comment-body .submit').click();
      await vi.waitFor(() => {
        expect(view.container.querySelector('.rendered-markdown-comment-body').textContent)
          .toContain('edited');
      });
      expect(shell.classList.contains('editing-mode')).toBe(false);
    });

    it('a failed save keeps the reviewer\'s typed text and re-enables Save so the retry is real', async () => {
      const attempts = [];
      let fail = true;
      const view = makeView({
        source: 'text\n',
        callbacks: {
          onEditComment: async (id, body) => {
            attempts.push(body);
            if (fail) throw new Error('network down');
          }
        }
      });
      view.render();
      document.body.appendChild(view.container);
      view.addComment({ id: 80, line_start: 1, body: 'original' });

      view.container.querySelector('.rendered-markdown-comment-edit').click();
      const textarea = view.container.querySelector('.rendered-markdown-comment-body textarea');
      textarea.value = 'a carefully typed retry';
      const submit = view.container.querySelector('.rendered-markdown-comment-body .submit');
      submit.click();
      await vi.waitFor(() => expect(submit.disabled).toBe(false));

      // The whole point of "retryable": the text the reviewer typed is still
      // in the box (not reset to the stored markdown), the control is live
      // again, and the failed body was sent exactly once.
      expect(view.container.querySelector('.rendered-markdown-comment-body textarea').value)
        .toBe('a carefully typed retry');
      expect(attempts).toEqual(['a carefully typed retry']);

      fail = false;
      submit.click();
      await vi.waitFor(() => {
        expect(view.container.querySelector('.rendered-markdown-comment-body').textContent)
          .toContain('a carefully typed retry');
      });
      expect(attempts).toEqual(['a carefully typed retry', 'a carefully typed retry']);
    });

    it('a double-clicked Save only issues one edit request', async () => {
      let resolveEdit;
      const calls = [];
      const view = makeView({
        source: 'text\n',
        callbacks: {
          onEditComment: (id, body) => {
            calls.push(body);
            return new Promise((resolve) => { resolveEdit = resolve; });
          }
        }
      });
      view.render();
      document.body.appendChild(view.container);
      view.addComment({ id: 81, line_start: 1, body: 'original' });

      view.container.querySelector('.rendered-markdown-comment-edit').click();
      view.container.querySelector('.rendered-markdown-comment-body textarea').value = 'edited once';
      const submit = view.container.querySelector('.rendered-markdown-comment-body .submit');
      submit.click();
      submit.click();
      expect(calls).toEqual(['edited once']);

      resolveEdit();
      await vi.waitFor(() => {
        expect(view.container.querySelector('.rendered-markdown-comment-body').textContent)
          .toContain('edited once');
      });
      expect(calls).toEqual(['edited once']);
    });

    it('a second Edit click while the form is open returns to it instead of discarding typed text', () => {
      const view = makeView({ source: 'text\n' });
      view.render();
      document.body.appendChild(view.container);
      view.addComment({ id: 82, line_start: 1, body: 'original' });

      const editBtn = view.container.querySelector('.rendered-markdown-comment-edit');
      editBtn.click();
      const textarea = view.container.querySelector('.rendered-markdown-comment-body textarea');
      textarea.value = 'half-written thought';

      // Re-entry (double-click, Enter+click, or a click landing while the
      // actions are still hittable) must not rebuild the form from the
      // stored markdown.
      editBtn.click();
      const after = view.container.querySelector('.rendered-markdown-comment-body textarea');
      expect(after).toBe(textarea);
      expect(after.value).toBe('half-written thought');
      expect(view.container.querySelectorAll('.rendered-markdown-comment-body textarea')).toHaveLength(1);
      expect(document.activeElement).toBe(after);
    });

    it('fails closed with a named error if the canonical action hooks are ever missing', () => {
      const view = makeView({ source: 'text\n' });
      view.render();
      // Simulate the shared view regressing (renamed hook, defaulted
      // actionMode, stale cached bundle). Previously this was a bare
      // `Cannot read properties of null` from inside the setComments loop.
      const UCV = window.UserCommentView || require('../../public/js/modules/user-comment-view.js');
      const original = UCV.buildCommentHtml;
      UCV.buildCommentHtml = (comment, options) => original(comment, { ...options, actionMode: 'diff' });
      try {
        expect(() => view.addComment({ id: 83, line_start: 1, body: 'x' }))
          .toThrow(/canonical comment actions missing/);
      } finally {
        UCV.buildCommentHtml = original;
      }
    });

    it('setComments puts in-block comments in their block and never drops an out-of-file comment', () => {
      const view = makeView({ source: '# Title\n\nParagraph one.\n\nParagraph two.\n' });
      view.render();
      view.setComments([
        { id: 1, line_start: 3, body: 'on paragraph one' },
        { id: 2, line_start: 999, body: 'orphaned - no matching block' }
      ]);
      // The in-block comment is inside its block's zone.
      const blocks = view.container.querySelectorAll('.rendered-markdown-block');
      const inBlockCard = blocks[1].querySelector('.rendered-markdown-comment-card');
      expect(inBlockCard.dataset.commentId).toBe('1');
      expect(inBlockCard.textContent).toContain('on paragraph one');

      // The out-of-file comment is NOT silently dropped: it lands in the
      // explicit document-level fallback zone, with its honest stored line
      // number, and is NOT attached to any block.
      const orphanZone = view.container.querySelector('.rendered-markdown-orphan-comments');
      expect(orphanZone.hidden).toBe(false);
      const orphanCard = orphanZone.querySelector('.rendered-markdown-comment-card');
      expect(orphanCard.dataset.commentId).toBe('2');
      expect(orphanCard.querySelector('.user-comment-line-info').textContent).toBe('Line 999');
      expect(orphanCard.closest('.rendered-markdown-block')).toBeNull();

      // Both comments are represented exactly once each.
      expect(view.container.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(2);
    });

    it('defaults escapeHtmlAttribute to a real escaper when the caller omits it — no attribute injection from comment text', () => {
      // Deliberately construct WITHOUT `escapeHtmlAttribute` in opts (unlike
      // every other test in this file, which goes through makeView() and
      // always supplies the real one) — this is the exact "caller omits the
      // option" scenario the default must protect against on its own.
      const md = markdownit({ html: false, breaks: true, linkify: true, typographer: true });
      const view = new RenderedDocumentView({
        container: document.createElement('div'),
        filePath: 'docs/guide.md',
        source: 'text\n',
        md,
        renderMarkdown: buildRenderMarkdown()
      });
      view.render();
      view.addComment({
        id: 1,
        line_start: 1,
        body: 'hello" onmouseover="window.pwned=1" data-x="'
      });
      const bodyEl = view.container.querySelector('.rendered-markdown-comment-body');
      expect(bodyEl.hasAttribute('onmouseover')).toBe(false);
      expect(bodyEl.getAttribute('data-x')).toBeNull();
      // The browser decodes the escaped entities back to the original text
      // on attribute read — the point is that it stayed ONE attribute
      // value rather than breaking out into new attributes.
      expect(bodyEl.getAttribute('data-original-markdown')).toBe(
        'hello" onmouseover="window.pwned=1" data-x="'
      );
    });

    /**
     * The host's comment count is DOM-derived across the Diff and Rendered
     * surfaces, but `onCreateComment`/`onDeleteComment` resolve BEFORE this
     * view mutates its own DOM. Without a post-mutation hook the host's
     * count is one card stale: a comment whose only surface is this view is
     * missed on create, and a card about to be removed is still counted on
     * delete.
     */
    describe('onCommentsChanged (post-DOM-mutation hook)', () => {
      it('fires AFTER the new card is in the DOM on create', async () => {
        const observed = [];
        const view = makeView({
          source: 'text\n',
          callbacks: {
            onCreateComment: async () => ({ id: 31, line_start: 1, body: 'new' }),
            onCommentsChanged: () => {
              observed.push(view.container.querySelectorAll('.rendered-markdown-comment-card').length);
            }
          }
        });
        view.render();
        document.body.appendChild(view.container);

        view.container.querySelector('.rendered-markdown-add-comment-btn').click();
        const textarea = view.container.querySelector('.rendered-markdown-comment-textarea');
        textarea.value = 'new';
        textarea.dispatchEvent(new dom.window.Event('input'));
        view.container.querySelector('.rendered-markdown-comment-btn.submit').click();
        await new Promise(setImmediate);

        expect(observed).toEqual([1]);
      });

      it('fires AFTER the card is removed from the DOM on delete', async () => {
        const observed = [];
        const view = makeView({
          source: 'text\n',
          callbacks: {
            onDeleteComment: async () => {},
            onCommentsChanged: () => {
              observed.push(view.container.querySelectorAll('.rendered-markdown-comment-card').length);
            }
          }
        });
        view.render();
        view.addComment({ id: 32, line_start: 1, body: 'bye' });

        view.container.querySelector('.rendered-markdown-comment-delete').click();
        await new Promise(setImmediate);

        expect(observed).toEqual([0]);
      });

      it('does not fire when the create fails', async () => {
        const onCommentsChanged = vi.fn();
        const view = makeView({
          source: 'text\n',
          callbacks: {
            onCreateComment: async () => { throw new Error('nope'); },
            onCommentsChanged
          }
        });
        view.render();
        document.body.appendChild(view.container);

        view.container.querySelector('.rendered-markdown-add-comment-btn').click();
        const textarea = view.container.querySelector('.rendered-markdown-comment-textarea');
        textarea.value = 'x';
        textarea.dispatchEvent(new dom.window.Event('input'));
        view.container.querySelector('.rendered-markdown-comment-btn.submit').click();
        await new Promise(setImmediate);

        expect(onCommentsChanged).not.toHaveBeenCalled();
      });

      it('a throwing handler does not fail the comment operation', async () => {
        const view = makeView({
          source: 'text\n',
          callbacks: {
            onDeleteComment: async () => {},
            onCommentsChanged: () => { throw new Error('counter exploded'); }
          }
        });
        view.render();
        view.addComment({ id: 33, line_start: 1, body: 'bye' });

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          view.container.querySelector('.rendered-markdown-comment-delete').click();
          await new Promise(setImmediate);
          // The card is still gone — the reviewer's delete succeeded.
          expect(view.container.querySelector('.rendered-markdown-comment-card')).toBeNull();
          expect(errorSpy).toHaveBeenCalled();
        } finally {
          errorSpy.mockRestore();
        }
      });

      it('is optional — no handler configured is not an error', async () => {
        const view = makeView({ source: 'text\n', callbacks: { onDeleteComment: async () => {} } });
        view.render();
        view.addComment({ id: 34, line_start: 1, body: 'bye' });
        view.container.querySelector('.rendered-markdown-comment-delete').click();
        await new Promise(setImmediate);
        expect(view.container.querySelector('.rendered-markdown-comment-card')).toBeNull();
      });
    });

    /**
     * One reviewer action must produce exactly one stored comment / one
     * removal, even when the UI can be triggered twice before the request
     * it started resolves.
     */
    describe('duplicate-action guards', () => {
      function makePendingCreateView(source = 'text\n') {
        const calls = [];
        let settle;
        const view = makeView({
          source,
          callbacks: {
            onCreateComment: (payload) => {
              calls.push(payload);
              return new Promise((resolve, reject) => {
                settle = { resolve: (c) => resolve(c), reject };
              });
            }
          }
        });
        view.render();
        document.body.appendChild(view.container);
        view.container.querySelector('.rendered-markdown-add-comment-btn').click();
        const textarea = view.container.querySelector('.rendered-markdown-comment-textarea');
        textarea.value = 'once';
        textarea.dispatchEvent(new dom.window.Event('input'));
        return { view, calls, textarea, settle: () => settle };
      }

      it('a second Ctrl+Enter while the create is in flight does not POST twice', async () => {
        const { view, calls, textarea, settle } = makePendingCreateView();
        const ctrlEnter = () => textarea.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
        );

        // Ctrl+Enter bypasses the Save button's `disabled` attribute
        // entirely, so this is the path a button-only guard would miss.
        ctrlEnter();
        ctrlEnter();
        ctrlEnter();
        expect(calls).toHaveLength(1);

        settle().resolve({ id: 51, line_start: 1, body: 'once' });
        await new Promise(setImmediate);
        expect(calls).toHaveLength(1);
        expect(view.container.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(1);
      });

      it('a second Save click while the create is in flight does not POST twice', async () => {
        const { view, calls, settle } = makePendingCreateView();
        const submitBtn = view.container.querySelector('.rendered-markdown-comment-form .submit');

        submitBtn.click();
        // Re-enabling the button models any path that leaves it clickable
        // (a browser dispatching a queued second click, an assistive-tech
        // activation): the guard must not depend on `disabled` alone.
        submitBtn.disabled = false;
        submitBtn.click();
        expect(calls).toHaveLength(1);

        settle().resolve({ id: 52, line_start: 1, body: 'once' });
        await new Promise(setImmediate);
        expect(view.container.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(1);
      });

      it('a failed create restores the retry state so the reviewer can save again', async () => {
        const { view, calls, textarea, settle } = makePendingCreateView();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          view.container.querySelector('.rendered-markdown-comment-form .submit').click();
          settle().reject(new Error('network down'));
          await new Promise(setImmediate);

          const form = view.container.querySelector('.rendered-markdown-comment-form');
          expect(form).toBeTruthy();
          expect(form.dataset.submitting).toBeUndefined();
          expect(form.querySelector('.submit').disabled).toBe(false);

          // And a retry actually goes through.
          textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
          expect(calls).toHaveLength(2);
          settle().resolve({ id: 53, line_start: 1, body: 'once' });
          await new Promise(setImmediate);
          expect(view.container.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(1);
        } finally {
          errorSpy.mockRestore();
        }
      });

      it('a double-activated Delete only issues one delete request', async () => {
        let settle;
        const calls = [];
        const view = makeView({
          source: 'text\n',
          callbacks: {
            onDeleteComment: (id) => {
              calls.push(id);
              return new Promise((resolve, reject) => { settle = { resolve, reject }; });
            }
          }
        });
        view.render();
        view.addComment({ id: 54, line_start: 1, body: 'bye' });
        const deleteBtn = view.container.querySelector('.rendered-markdown-comment-delete');

        deleteBtn.click();
        deleteBtn.disabled = false;
        deleteBtn.click();
        expect(calls).toEqual([54]);

        settle.resolve();
        await new Promise(setImmediate);
        expect(view.container.querySelector('.rendered-markdown-comment-card')).toBeNull();
      });

      it('a failed delete leaves the card retryable rather than permanently inert', async () => {
        let settle;
        const calls = [];
        const view = makeView({
          source: 'text\n',
          callbacks: {
            onDeleteComment: (id) => {
              calls.push(id);
              return new Promise((resolve, reject) => { settle = { resolve, reject }; });
            }
          }
        });
        view.render();
        view.addComment({ id: 55, line_start: 1, body: 'bye' });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          view.container.querySelector('.rendered-markdown-comment-delete').click();
          settle.reject(new Error('500'));
          await new Promise(setImmediate);

          const card = view.container.querySelector('.rendered-markdown-comment-card');
          expect(card).toBeTruthy();
          expect(card.dataset.deleting).toBeUndefined();
          const retryBtn = card.querySelector('.rendered-markdown-comment-delete');
          expect(retryBtn.disabled).toBe(false);

          retryBtn.click();
          expect(calls).toEqual([55, 55]);
          settle.resolve();
          await new Promise(setImmediate);
          expect(view.container.querySelector('.rendered-markdown-comment-card')).toBeNull();
        } finally {
          errorSpy.mockRestore();
        }
      });
    });

    /**
     * `addComment` is reachable twice for one comment: `_submitComment`
     * awaits the host's create before adding its card, and a host-driven
     * refresh (websocket reload, `loadUserComments`) can render the same
     * comment inside that window.
     */
    describe('addComment idempotency by comment id', () => {
      it('ignores a repeat add of the same comment id', () => {
        const view = makeView({ source: 'text\n' });
        view.render();
        view.addComment({ id: 60, line_start: 1, body: 'once' });
        view.addComment({ id: 60, line_start: 1, body: 'once' });
        expect(view.container.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(1);
      });

      it('does not double-render when a host refresh races the create it started', async () => {
        let view;
        const created = { id: 61, line_start: 1, body: 'raced' };
        view = makeView({
          source: 'text\n',
          callbacks: {
            // Models the host refresh landing while `_submitComment` is
            // still awaiting: the comment is already on screen by the time
            // the create resolves.
            onCreateComment: async () => {
              view.setComments([created]);
              return created;
            }
          }
        });
        view.render();
        document.body.appendChild(view.container);

        view.container.querySelector('.rendered-markdown-add-comment-btn').click();
        const textarea = view.container.querySelector('.rendered-markdown-comment-textarea');
        textarea.value = 'raced';
        textarea.dispatchEvent(new dom.window.Event('input'));
        view.container.querySelector('.rendered-markdown-comment-form .submit').click();
        await new Promise(setImmediate);

        expect(view.container.querySelectorAll('.rendered-markdown-comment-card[data-comment-id="61"]'))
          .toHaveLength(1);
      });

      it('keeps two DISTINCT comments on the same nested target separate', () => {
        // Lines 1-3 are a two-column table; both body cells are on line 3.
        const view = makeView({ source: '| A | B |\n| - | - |\n| a1 | b1 |\n' });
        view.render();
        const cellAnchor = { v: 1, kind: 'table-cell', startLine: 3, endLine: 3, ordinal: 0 };
        view.setComments([
          { id: 62, line_start: 3, line_end: 3, body: 'first', rendered_anchor: { ...cellAnchor } },
          { id: 63, line_start: 3, line_end: 3, body: 'second', rendered_anchor: { ...cellAnchor } }
        ]);
        // The id guard must not collapse two real comments that happen to
        // share a target.
        expect(view.container.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(2);
        const cell = view.container.querySelectorAll('tbody td.rendered-markdown-target')[0];
        expect(cell.querySelector('.rendered-markdown-target-badge').textContent).toBe('2');
      });
    });

    it('removeComment removes the card by id', () => {
      const view = makeView({ source: 'text\n' });
      view.render();
      view.addComment({ id: 7, line_start: 1, body: 'hi' });
      expect(view.container.querySelector('.rendered-markdown-comment-card')).toBeTruthy();
      view.removeComment(7);
      expect(view.container.querySelector('.rendered-markdown-comment-card')).toBeNull();
    });
  });

  /**
   * Regression coverage for comments anchored on source lines that render
   * as NO top-level block — overwhelmingly the blank separator line between
   * two blocks, which is trivially easy to land on in the Diff view (click
   * the "+" on a blank line). Before the fix these were silently dropped
   * from the Rendered view by `addComment`'s `skipMissing` path: real,
   * stored, submittable feedback that the Rendered surface simply did not
   * show. The fix must ALSO not "helpfully" reattach them to a neighbouring
   * heading/paragraph — that would claim the reviewer commented on content
   * they never commented on.
   */
  describe('comments on source lines outside every rendered block', () => {
    // 1: '# Title'
    // 2: ''            <- internal gap
    // 3: 'Paragraph one.'
    // 4: ''            <- internal gap
    // 5: 'Paragraph two.'
    const SOURCE = '# Title\n\nParagraph one.\n\nParagraph two.\n';

    it('computes leading, internal and trailing source gaps as the exact complement of the block ranges', () => {
      const view = makeView({ source: '\n\n# Title\n\nBody.\n\n\n' });
      view.render();
      // 1-2 blank (leading), 3 heading, 4 blank (internal), 5 body,
      // 6-7 blank (trailing; the final newline terminates line 7's
      // predecessor rather than creating a line 8).
      expect(view.blocks.map((b) => [b.startLine, b.endLine])).toEqual([[3, 3], [5, 5]]);
      expect(view.sourceGaps.map((g) => [g.startLine, g.endLine])).toEqual([[1, 2], [4, 4], [6, 7]]);
    });

    it('counts a trailing newline as terminating the last line, not starting a new one', () => {
      const view = makeView({ source: '# Title\n' });
      view.render();
      expect(view._totalSourceLines).toBe(1);
      // No phantom line-2 gap.
      expect(view.sourceGaps).toEqual([]);
    });

    it('displays a comment on an INTERNAL blank separator line in its own gap container, not on a neighbouring block', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([{ id: 42, line_start: 4, line_end: 4, body: 'about the gap' }]);

      const card = view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="42"]');
      expect(card).toBeTruthy();
      // Not coerced onto the heading or either paragraph.
      expect(card.closest('.rendered-markdown-block')).toBeNull();

      const gap = card.closest('.rendered-markdown-gap');
      expect(gap).toBeTruthy();
      expect(gap.hidden).toBe(false);
      expect(gap.dataset.startLine).toBe('4');
      expect(gap.dataset.endLine).toBe('4');
      // Honest repository line metadata on the card itself.
      expect(card.querySelector('.user-comment-line-info').textContent).toBe('Line 4');
      // And honest, non-misleading framing on the container.
      expect(gap.querySelector('.rendered-markdown-gap-note').textContent).toContain('4');
    });

    it('places the gap container at its true position in source order (between the blocks it separates)', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([{ id: 43, line_start: 4, body: 'between one and two' }]);

      const doc = view.container.querySelector('.rendered-markdown-doc');
      const positioned = Array.from(doc.children).map((el) => `${el.className.split(' ')[0]}:${el.dataset.startLine || ''}`);
      expect(positioned).toEqual([
        'rendered-markdown-block:1',
        'rendered-markdown-gap:2',
        'rendered-markdown-block:3',
        'rendered-markdown-gap:4',
        'rendered-markdown-block:5',
        'rendered-markdown-orphan-comments:'
      ]);
    });

    it('displays a comment on a LEADING blank line in the leading gap container', () => {
      const view = makeView({ source: '\n# Title\n\nBody.\n' });
      view.render();
      view.setComments([{ id: 44, line_start: 1, body: 'on the leading blank line' }]);

      const card = view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="44"]');
      const gap = card.closest('.rendered-markdown-gap');
      expect(gap.dataset.startLine).toBe('1');
      expect(gap.dataset.endLine).toBe('1');
      // The leading gap renders BEFORE the first block.
      const doc = view.container.querySelector('.rendered-markdown-doc');
      expect(doc.children[0]).toBe(gap);
    });

    it('displays a comment on a TRAILING blank line in the trailing gap container', () => {
      const view = makeView({ source: '# Title\n\nBody.\n\n\n' });
      view.render();
      // Lines: 1 heading, 2 blank, 3 body, 4-5 blank.
      view.setComments([{ id: 45, line_start: 5, line_end: 5, body: 'on a trailing blank line' }]);

      const card = view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="45"]');
      const gap = card.closest('.rendered-markdown-gap');
      expect(gap.dataset.startLine).toBe('4');
      expect(gap.dataset.endLine).toBe('5');
      expect(card.querySelector('.user-comment-line-info').textContent).toBe('Line 5');
    });

    it('renders a multi-line range label for a multi-line off-block comment', () => {
      const view = makeView({ source: '# Title\n\n\n\nBody.\n' });
      view.render();
      view.setComments([{ id: 46, line_start: 2, line_end: 4, body: 'spans the gap' }]);
      const card = view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="46"]');
      expect(card.querySelector('.user-comment-line-info').textContent).toBe('Lines 2-4');
    });

    it('keeps gap containers hidden when they hold no comments, so an ordinary document is visually unchanged', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([{ id: 47, line_start: 3, body: 'on a real block' }]);
      const gaps = view.container.querySelectorAll('.rendered-markdown-gap');
      expect(gaps.length).toBeGreaterThan(0);
      Array.from(gaps).forEach((gap) => expect(gap.hidden).toBe(true));
      expect(view.container.querySelector('.rendered-markdown-orphan-comments').hidden).toBe(true);
      // The canonical line badge is now on EVERY card (Diff parity), so the
      // "is this card off-block?" signal is the gap/orphan container itself,
      // asserted above — never a missing line label. Scoped to THIS
      // comment's own card: a document-wide "first match" would keep passing
      // if the card moved to a gap container, or if block ordering changed
      // so the first badge in the document belonged to something else.
      const card = view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="47"]');
      expect(card).not.toBeNull();
      expect(card.closest('.rendered-markdown-gap')).toBeNull();
      expect(card.closest('.rendered-markdown-orphan-comments')).toBeNull();
      expect(card.querySelector('.user-comment-line-info').textContent).toBe('Line 3');
    });

    it('re-hides a gap container once its last comment is removed', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([{ id: 48, line_start: 4, body: 'temporary' }]);
      const gap = view.container.querySelector('.rendered-markdown-gap[data-start-line="4"]');
      expect(gap.hidden).toBe(false);

      view.removeComment(48);
      expect(gap.hidden).toBe(true);
      expect(view.container.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(0);
    });

    it('re-hides a gap container when its last comment is deleted through the card UI', async () => {
      const deleted = [];
      const view = makeView({
        source: SOURCE,
        callbacks: { onDeleteComment: async (id) => { deleted.push(id); } }
      });
      view.render();
      view.setComments([{ id: 49, line_start: 4, body: 'delete me' }]);
      const gap = view.container.querySelector('.rendered-markdown-gap[data-start-line="4"]');
      expect(gap.hidden).toBe(false);

      view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="49"] .rendered-markdown-comment-delete').click();
      // The delete handler awaits the callback before removing the card.
      await new Promise(setImmediate);

      expect(deleted).toEqual([49]);
      expect(gap.hidden).toBe(true);
    });

    it('setComments is idempotent for a gap comment (no duplicate cards on refresh)', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      const comments = [{ id: 50, line_start: 4, body: 'once' }];
      view.setComments(comments);
      view.setComments(comments);
      expect(view.container.querySelectorAll('.rendered-markdown-comment-card[data-comment-id="50"]')).toHaveLength(1);
    });

    it('displays an off-block comment even in an empty document (nothing to attach to at all)', () => {
      const view = makeView({ source: '' });
      view.render();
      view.setComments([{ id: 51, line_start: 1, body: 'on an empty file' }]);
      expect(view.container.querySelector('.rendered-markdown-empty')).toBeTruthy();
      const card = view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="51"]');
      expect(card).toBeTruthy();
      expect(card.querySelector('.user-comment-line-info').textContent).toBe('Line 1');
    });

    it('labels a comment with an unusable stored line without inventing a number', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([{ id: 52, line_start: null, body: 'no anchor' }]);
      const card = view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="52"]');
      expect(card.closest('.rendered-markdown-orphan-comments')).toBeTruthy();
      expect(card.querySelector('.user-comment-line-info').textContent).toBe('Line unknown');
    });

    describe('line badge text comes from the canonical formatter', () => {
      const UCV = () => require('../../public/js/modules/user-comment-view.js');

      /**
       * Every stored range that is not "a plain single line" — including the
       * shapes only a corrupted/legacy row can produce. The badge on a
       * Rendered card and on a Diff row are the same string for a reason:
       * the same comment must not read as two different anchors depending on
       * which view the reviewer is in.
       */
      it.each([
        ['a plain single line', { line_start: 3, line_end: 3 }],
        ['a real multi-line range', { line_start: 2, line_end: 4 }],
        ['a missing end line', { line_start: 3, line_end: null }],
        ['an INVERTED range (end before start)', { line_start: 9, line_end: 3 }]
      ])('matches UserCommentView.formatLineInfo for %s', (_label, range) => {
        const view = makeView({ source: SOURCE });
        view.render();
        view.setComments([{ id: 60, body: 'x', ...range }]);
        const card = view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="60"]');
        expect(card.querySelector('.user-comment-line-info').textContent)
          .toBe(UCV().formatLineInfo(range));
      });

      it('keeps "Line unknown" — never a canonical "Line null" — for an unusable start', () => {
        const view = makeView({ source: SOURCE });
        view.render();
        view.setComments([{ id: 61, line_start: 0, line_end: 4, body: 'x' }]);
        const card = view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="61"]');
        expect(card.querySelector('.user-comment-line-info').textContent).toBe('Line unknown');
      });

      it('normalizes an unusable END line instead of printing "Lines 3-null"', () => {
        const view = makeView({ source: SOURCE });
        view.render();
        view.setComments([{ id: 62, line_start: 3, line_end: 'nonsense', body: 'x' }]);
        const card = view.container.querySelector('.rendered-markdown-comment-card[data-comment-id="62"]');
        expect(card.querySelector('.user-comment-line-info').textContent).toBe('Line 3');
      });
    });

    it('gap containers offer no "Add comment" button — Rendered mode never creates a gap-anchored comment', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.container.querySelectorAll('.rendered-markdown-gap').forEach((gap) => {
        expect(gap.querySelector('.rendered-markdown-add-comment-btn')).toBeNull();
      });
      // Blocks still have theirs.
      expect(view.container.querySelectorAll('.rendered-markdown-block .rendered-markdown-add-comment-btn').length)
        .toBe(view.blocks.length);
    });
  });

  /**
   * Hierarchical (nested) comment targets: list items, nested list items,
   * table rows, header cells and data cells, alongside — never instead of —
   * the whole-list/whole-table block target.
   *
   * The three things that must hold no matter what:
   *   1. no invalid DOM is produced (nothing injected straight under
   *      `table`/`tr`/`ul`/`ol`);
   *   2. exactly ONE nested affordance is revealed at a time, so overlapping
   *      ancestors can never leave the reviewer guessing what they'd hit;
   *   3. a stored anchor either resolves to the SAME element it was created
   *      on, or falls back to the comment's honest line area — never to a
   *      sibling item/row/cell.
   */
  describe('nested comment targets', () => {
    // 1: # Title
    // 2:
    // 3: - Alpha
    // 4:   - Nested alpha
    // 5: - Beta
    // 6:
    // 7: | A | B |
    // 8: | --- | --- |
    // 9: | a1 | b1 |
    const SOURCE = [
      '# Title', '',
      '- Alpha', '  - Nested alpha', '- Beta', '',
      '| A | B |', '| --- | --- |', '| a1 | b1 |', ''
    ].join('\n');

    const CELL_1 = { v: 1, kind: 'table-cell', startLine: 9, endLine: 9, ordinal: 0 };
    const CELL_2 = { v: 1, kind: 'table-cell', startLine: 9, endLine: 9, ordinal: 1 };

    const labelsOf = (view, selector) =>
      Array.from(view.container.querySelectorAll(selector)).map((el) => el.getAttribute('aria-label'));

    it('renders a plain plus glyph — no filled-circle icon anywhere', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      const buttons = view.container.querySelectorAll('.rendered-markdown-add-comment-btn');
      expect(buttons.length).toBeGreaterThan(1);
      buttons.forEach((btn) => {
        const svg = btn.querySelector('svg');
        expect(svg).toBeTruthy();
        // The retired icon was a filled disc: a single path starting with
        // the circle "M8 0a8 8 0 100 16A8 8 0 008 0z" arc. The plus is a
        // simple cross outline with no arc commands at all.
        const d = svg.querySelector('path').getAttribute('d');
        expect(d).not.toMatch(/[aA]\s*8\s+8/);
        expect(svg.getAttribute('aria-hidden')).toBe('true');
      });
    });

    it('keeps the whole-list and whole-table block targets and names them explicitly', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      const blockLabels = labelsOf(view, '.rendered-markdown-block-btn');
      expect(blockLabels).toEqual([
        'Add comment on heading, line 1',
        'Add comment on the whole list, lines 3-6',
        'Add comment on the whole table, lines 7-9'
      ]);
    });

    it('names EVERY top-level target with its semantic kind and real line range', () => {
      // One document with every top-level block kind the splitter emits, so
      // no kind can silently regress to a bare line number (which tells a
      // screen-reader user nothing about what they are commenting on).
      const view = makeView({
        source: [
          '# Heading one',           // 1  heading
          '',                        // 2
          'A paragraph of prose.',   // 3  paragraph
          '',                        // 4
          '```js',                   // 5  fence
          'const a = 1;',            // 6
          '```',                     // 7
          '',                        // 8
          '> A quoted note.',        // 9  blockquote
          '',                        // 10
          '---',                     // 11 hr
          '',                        // 12
          '1. Only item',            // 13 ordered_list
          '',                        // 14
          '| A |',                   // 15 table
          '| - |',                   // 16
          '| 1 |',                   // 17
          ''
        ].join('\n')
      });
      view.render();
      expect(labelsOf(view, '.rendered-markdown-block-btn')).toEqual([
        'Add comment on heading, line 1',
        'Add comment on paragraph, line 3',
        'Add comment on code block, lines 5-7',
        'Add comment on the whole quote, line 9',
        'Add comment on divider, line 11',
        'Add comment on the whole list, lines 13-14',
        'Add comment on the whole table, lines 15-17'
      ]);
      // Every block button has a title matching its accessible name, so a
      // sighted mouse user gets the same information on hover.
      view.container.querySelectorAll('.rendered-markdown-block-btn').forEach((btn) => {
        expect(btn.title).toBe(btn.getAttribute('aria-label'));
      });
    });

    it('falls back to a generic kind for an unrecognised top-level block type', () => {
      const view = makeView({ source: '# Heading\n' });
      view.render();
      // Simulate a block type this view has no name for (a markdown-it
      // plugin type, or a future addition) — the label must still carry a
      // kind and the real line range, never just a line number.
      expect(view._blockTargetLabel({ type: 'math_block', startLine: 4, endLine: 6 }))
        .toBe('Add comment on block, lines 4-6');
      expect(view._blockTargetLabel({ type: 'html_block', startLine: 2, endLine: 2 }))
        .toBe('Add comment on HTML block, line 2');
    });

    it('adds an accessible, line-accurate affordance for each list item and nested item', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      const list = view.container.querySelector('ul');
      expect(labelsOf(view, 'li > .rendered-markdown-target-affordance > .rendered-markdown-target-btn')).toEqual([
        'Add comment on Nested list item, line 4',
        'Add comment on List item, lines 3–4',
        'Add comment on List item, line 5'
      ]);
      // Only <li> may be a child of <ul>/<ol>: the affordance goes INSIDE
      // the item, never between items.
      Array.from(list.children).forEach((child) => expect(child.tagName).toBe('LI'));
    });

    it('adds row/header-cell/data-cell affordances without ever putting invalid children in the table', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      const table = view.container.querySelector('table');

      expect(labelsOf(view, '.rendered-markdown-row-gutter .rendered-markdown-target-btn')).toEqual([
        'Add comment on Table row, line 7',
        'Add comment on Table row, line 9'
      ]);
      expect(labelsOf(view, 'th > .rendered-markdown-target-affordance > .rendered-markdown-target-btn')).toEqual([
        'Add comment on Table header cell, line 7, column 1',
        'Add comment on Table header cell, line 7, column 2'
      ]);
      expect(labelsOf(view, 'td.rendered-markdown-target > .rendered-markdown-target-affordance > .rendered-markdown-target-btn')).toEqual([
        'Add comment on Table cell, line 9, column 1',
        'Add comment on Table cell, line 9, column 2'
      ]);

      // Structural validity: table -> thead/tbody, tr -> th/td only.
      Array.from(table.children).forEach((child) => expect(['THEAD', 'TBODY']).toContain(child.tagName));
      table.querySelectorAll('tr').forEach((row) => {
        Array.from(row.children).forEach((cell) => expect(['TH', 'TD']).toContain(cell.tagName));
      });
      // The row affordance lives in a real trailing cell, one per row.
      expect(table.querySelectorAll('tr > td.rendered-markdown-row-gutter')).toHaveLength(2);
    });

    it('marks the row gutter cell presentational while keeping its button reachable', () => {
      // The gutter is UI chrome, not data: without `role="presentation"`
      // every row reports one more column than the header describes, so AT
      // announces a header-less trailing column on every row. The button
      // inside must stay a real, named, focusable button — presentation is
      // not inherited by focusable descendants, and `aria-hidden` here
      // would have made the row target unreachable for screen-reader users.
      const view = makeView({ source: SOURCE });
      view.render();
      document.body.appendChild(view.container); // so focus() can take effect

      const gutters = view.container.querySelectorAll('td.rendered-markdown-row-gutter');
      expect(gutters).toHaveLength(2);
      gutters.forEach((gutter) => {
        expect(gutter.getAttribute('role')).toBe('presentation');
        // Nothing hides the subtree: that would take the button with it.
        expect(gutter.hasAttribute('aria-hidden')).toBe(false);
        expect(gutter.closest('[aria-hidden="true"]')).toBeNull();

        const button = gutter.querySelector('.rendered-markdown-target-btn');
        expect(button.tagName).toBe('BUTTON');
        expect(button.getAttribute('role')).toBeNull(); // implicit button role
        expect(button.getAttribute('aria-label')).toMatch(/^Add comment on Table row, line \d+$/);
        expect(button.disabled).toBe(false);
        // Keyboard reachable: a <button> with no negative tabindex is in
        // the tab order.
        expect(button.getAttribute('tabindex')).toBeNull();
        button.focus();
        expect(document.activeElement).toBe(button);
      });
    });

    it('reveals only the INNERMOST target on hover — never a stack of ancestors', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      const outerItem = view.container.querySelector('ul > li');
      const nestedItem = view.container.querySelector('ul ul > li');

      nestedItem.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      expect(view.container.querySelectorAll('.is-target-active')).toHaveLength(1);
      expect(view.container.querySelector('.is-target-active')).toBe(nestedItem);

      // Moving out to the parent item's own text switches the single active
      // target to the parent.
      outerItem.firstChild.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      expect(view.container.querySelectorAll('.is-target-active')).toHaveLength(1);
      expect(view.container.querySelector('.is-target-active')).toBe(outerItem);
    });

    it('a cell hover activates the cell, and the row gutter activates the row', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      const cell = view.container.querySelectorAll('tbody td.rendered-markdown-target')[1];
      cell.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      expect(view.container.querySelector('.is-target-active')).toBe(cell);

      const gutterBtn = view.container.querySelectorAll('tbody .rendered-markdown-row-gutter .rendered-markdown-target-btn')[0];
      gutterBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      expect(view.container.querySelector('.is-target-active')).toBe(view.container.querySelector('tbody tr'));
      expect(view.container.querySelectorAll('.is-target-active')).toHaveLength(1);
    });

    it('a tap (pointerdown) activates the innermost target, so touch pointers can reach it', () => {
      // A touch/stylus pointer has no hover state at all, so without a
      // pointer-driven activation path the nested affordances would be
      // permanently invisible and unreachable on those devices. Still
      // exactly ONE target: the innermost one under the tap.
      const view = makeView({ source: SOURCE });
      view.render();
      const nestedItem = view.container.querySelector('ul ul > li');
      const outerItem = view.container.querySelector('ul > li');

      nestedItem.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
      expect(view.container.querySelectorAll('.is-target-active')).toHaveLength(1);
      expect(view.container.querySelector('.is-target-active')).toBe(nestedItem);

      // Tapping the parent item's own text moves the single active target.
      outerItem.firstChild.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
      expect(view.container.querySelectorAll('.is-target-active')).toHaveLength(1);
      expect(view.container.querySelector('.is-target-active')).toBe(outerItem);

      // ...and a tap on a cell activates the cell, not its row.
      const cell = view.container.querySelectorAll('tbody td.rendered-markdown-target')[1];
      cell.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
      expect(view.container.querySelectorAll('.is-target-active')).toHaveLength(1);
      expect(view.container.querySelector('.is-target-active')).toBe(cell);
    });

    it('keyboard focus activates a target, and leaving the block clears it', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      document.body.appendChild(view.container);
      const nestedBtn = view.container.querySelector('ul ul > li .rendered-markdown-target-btn');
      nestedBtn.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
      expect(view.container.querySelector('.is-target-active')).toBe(view.container.querySelector('ul ul > li'));

      nestedBtn.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
      expect(view.container.querySelector('.is-target-active')).toBeNull();
    });

    it('submits a cell comment with the row\'s line coordinates and the cell descriptor', async () => {
      const payloads = [];
      const view = makeView({
        source: SOURCE,
        callbacks: {
          onCreateComment: async (payload) => {
            payloads.push(payload);
            return { id: 90, line_start: payload.line_start, body: payload.body, rendered_anchor: payload.rendered_anchor };
          }
        }
      });
      view.render();

      const cellBtn = view.container.querySelectorAll('tbody td.rendered-markdown-target .rendered-markdown-target-btn')[1];
      cellBtn.click();
      const form = view.container.querySelector('.rendered-markdown-comment-form');
      expect(form.querySelector('.rendered-markdown-comment-target').textContent)
        .toContain('Table cell, line 9, column 2');
      const textarea = form.querySelector('textarea');
      textarea.value = 'about the second cell';
      textarea.dispatchEvent(new dom.window.Event('input'));
      form.querySelector('.submit').click();
      await new Promise(setImmediate);

      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        file: 'docs/guide.md',
        side: 'RIGHT',
        // GitHub coordinates stay the ROW's real source line — a column is
        // never invented as a line coordinate.
        line_start: 9,
        line_end: 9,
        rendered_anchor: CELL_2
      });
    });

    it('submits a list-item comment with the item\'s own line range', async () => {
      const payloads = [];
      const view = makeView({
        source: SOURCE,
        callbacks: { onCreateComment: async (p) => { payloads.push(p); return { id: 91, line_start: p.line_start, body: p.body }; } }
      });
      view.render();
      view.container.querySelector('ul ul > li .rendered-markdown-target-btn').click();
      const textarea = view.container.querySelector('.rendered-markdown-comment-textarea');
      textarea.value = 'about the nested item';
      textarea.dispatchEvent(new dom.window.Event('input'));
      view.container.querySelector('.rendered-markdown-comment-form .submit').click();
      await new Promise(setImmediate);

      expect(payloads[0]).toMatchObject({
        line_start: 4,
        line_end: 4,
        rendered_anchor: { v: 1, kind: 'nested-list-item', startLine: 4, endLine: 4, ordinal: 0 }
      });
    });

    it('a block-level comment carries no descriptor at all', async () => {
      const payloads = [];
      const view = makeView({
        source: SOURCE,
        callbacks: { onCreateComment: async (p) => { payloads.push(p); return { id: 92, line_start: p.line_start, body: p.body }; } }
      });
      view.render();
      // The table block's own button.
      view.container.querySelectorAll('.rendered-markdown-block-btn')[2].click();
      const textarea = view.container.querySelector('.rendered-markdown-comment-textarea');
      textarea.value = 'about the whole table';
      textarea.dispatchEvent(new dom.window.Event('input'));
      view.container.querySelector('.rendered-markdown-comment-form .submit').click();
      await new Promise(setImmediate);

      expect(payloads[0].rendered_anchor).toBeNull();
      expect(payloads[0]).toMatchObject({ line_start: 7, line_end: 9 });
    });

    it('switching target while a form is open retargets the form instead of silently reusing the old target', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      const cellBtns = view.container.querySelectorAll('tbody td.rendered-markdown-target .rendered-markdown-target-btn');
      cellBtns[0].click();
      expect(view.container.querySelector('.rendered-markdown-comment-form').dataset.targetKey)
        .toBe('table-cell|9|9|0');

      cellBtns[1].click();
      const forms = view.container.querySelectorAll('.rendered-markdown-comment-form');
      expect(forms).toHaveLength(1);
      expect(forms[0].dataset.targetKey).toBe('table-cell|9|9|1');
      expect(forms[0].querySelector('.rendered-markdown-comment-target').textContent).toContain('column 2');
    });

    it('re-clicking the SAME target returns to the open form rather than discarding typed text', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      document.body.appendChild(view.container);
      const btn = view.container.querySelector('tbody td.rendered-markdown-target .rendered-markdown-target-btn');
      btn.click();
      view.container.querySelector('.rendered-markdown-comment-textarea').value = 'draft text';
      btn.click();
      expect(view.container.querySelectorAll('.rendered-markdown-comment-form')).toHaveLength(1);
      expect(view.container.querySelector('.rendered-markdown-comment-textarea').value).toBe('draft text');
    });

    it('restores two comments on two cells of ONE source line to their own cells after a reload', () => {
      // Exactly the state the API returns after a reload: line numbers are
      // identical, only the (JSON-string) descriptors differ.
      const stored = [
        { id: 1, line_start: 9, line_end: 9, body: 'first cell', rendered_anchor: JSON.stringify(CELL_1) },
        { id: 2, line_start: 9, line_end: 9, body: 'second cell', rendered_anchor: JSON.stringify(CELL_2) }
      ];
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments(stored);

      const cells = view.container.querySelectorAll('tbody td.rendered-markdown-target');
      expect(cells[0].querySelector('.rendered-markdown-target-badge').hidden).toBe(false);
      expect(cells[0].querySelector('.rendered-markdown-target-badge').textContent).toBe('1');
      expect(cells[1].querySelector('.rendered-markdown-target-badge').textContent).toBe('1');
      expect(cells[0].classList.contains('has-comments')).toBe(true);

      const cards = view.container.querySelectorAll('.rendered-markdown-comment-card');
      expect(cards).toHaveLength(2);
      expect(cards[0].dataset.renderedTargetKey).toBe('table-cell|9|9|0');
      expect(cards[1].dataset.renderedTargetKey).toBe('table-cell|9|9|1');
      expect(cards[0].querySelector('.rendered-markdown-comment-target').textContent)
        .toBe('Table cell, line 9, column 1');
      expect(cards[1].querySelector('.rendered-markdown-comment-target').textContent)
        .toBe('Table cell, line 9, column 2');
      // Neither is marked stale, and no other target claims them.
      expect(view.container.querySelectorAll('.rendered-markdown-comment-target.is-stale')).toHaveLength(0);
      expect(view.container.querySelectorAll('.rendered-markdown-target-badge:not([hidden])')).toHaveLength(2);
    });

    it('counts multiple comments on one target in that target\'s badge', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([
        { id: 1, line_start: 9, body: 'a', rendered_anchor: CELL_1 },
        { id: 2, line_start: 9, body: 'b', rendered_anchor: CELL_1 }
      ]);
      const cell = view.container.querySelectorAll('tbody td.rendered-markdown-target')[0];
      const badge = cell.querySelector('.rendered-markdown-target-badge');
      expect(badge.textContent).toBe('2');
      // The badge is decorative; the count reaches assistive tech through
      // the adjacent button's accessible name.
      expect(badge.getAttribute('aria-hidden')).toBe('true');
      expect(cell.querySelector('.rendered-markdown-target-btn').getAttribute('aria-label'))
        .toBe('Add comment on Table cell, line 9, column 1 (2 comments)');
    });

    it('clears a target badge when its last comment is deleted through the card UI', async () => {
      const view = makeView({
        source: SOURCE,
        callbacks: { onDeleteComment: async () => {} }
      });
      view.render();
      view.setComments([{ id: 5, line_start: 9, body: 'bye', rendered_anchor: CELL_2 }]);
      const cell = view.container.querySelectorAll('tbody td.rendered-markdown-target')[1];
      expect(cell.querySelector('.rendered-markdown-target-badge').hidden).toBe(false);

      view.container.querySelector('.rendered-markdown-comment-delete').click();
      await new Promise(setImmediate);

      expect(cell.querySelector('.rendered-markdown-target-badge').hidden).toBe(true);
      expect(cell.classList.contains('has-comments')).toBe(false);
      expect(view.container.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(0);
    });

    it('removeComment clears the badge too', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([{ id: 6, line_start: 9, body: 'x', rendered_anchor: CELL_1 }]);
      view.removeComment(6);
      expect(view.container.querySelectorAll('.rendered-markdown-target-badge:not([hidden])')).toHaveLength(0);
    });

    it('a legacy comment with NO descriptor keeps its established top-level block placement', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([{ id: 10, line_start: 9, line_end: 9, body: 'legacy comment' }]);

      const card = view.container.querySelector('.rendered-markdown-comment-card');
      expect(card.dataset.renderedTargetKey).toBeUndefined();
      expect(card.querySelector('.rendered-markdown-comment-target')).toBeNull();
      // It belongs to the table BLOCK, exactly as before this feature.
      const block = card.closest('.rendered-markdown-block');
      expect(block.dataset.startLine).toBe('7');
      // ...and no cell claims it.
      expect(view.container.querySelectorAll('.rendered-markdown-target-badge:not([hidden])')).toHaveLength(0);
    });

    it('a STALE descriptor falls back to the comment\'s own line area and says so — never to a sibling cell', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      // Column 5 of line 9 does not exist in this table (two columns).
      view.setComments([{
        id: 11,
        line_start: 9,
        line_end: 9,
        body: 'target vanished',
        rendered_anchor: { v: 1, kind: 'table-cell', startLine: 9, endLine: 9, ordinal: 4 }
      }]);

      const card = view.container.querySelector('.rendered-markdown-comment-card');
      expect(card.dataset.renderedTargetKey).toBeUndefined();
      expect(card.closest('.rendered-markdown-block').dataset.startLine).toBe('7');
      const label = card.querySelector('.rendered-markdown-comment-target');
      expect(label.classList.contains('is-stale')).toBe(true);
      // The copy must NOT claim the element is gone: an unresolved anchor is
      // just as likely to mean "a line was inserted above this table", which
      // shifts every descendant target's absolute line range. It says what
      // is actually known, and names the honest original line.
      expect(label.textContent).toContain('this target changed or is unavailable');
      expect(label.textContent).toContain('shown at its original line 9');
      expect(label.textContent).not.toMatch(/no longer in this file/);
      expect(card.querySelector('.user-comment-line-info').textContent).toBe('Line 9');
      // Critically: no existing cell was given the comment instead.
      expect(view.container.querySelectorAll('.rendered-markdown-target-badge:not([hidden])')).toHaveLength(0);
    });

    it('exposes the WHOLE stale explanation as a tooltip, because the chip ellipses', () => {
      // The chip is the one shrinkable item in the canonical header-left flex
      // track (pr.css `.user-comment-header-left
      // .rendered-markdown-comment-target`: `white-space: nowrap;
      // text-overflow: ellipsis`). The stale label is not a short descriptor
      // but a full sentence — the tail of it ("shown at its original line 9")
      // is the part that tells the reviewer where the comment actually is, and
      // it is the first part to be truncated. Without `title` that sentence is
      // only recoverable with dev tools.
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([{
        id: 15,
        line_start: 9,
        line_end: 9,
        body: 'target vanished',
        rendered_anchor: { v: 1, kind: 'table-cell', startLine: 9, endLine: 9, ordinal: 4 }
      }]);

      const label = view.container.querySelector('.rendered-markdown-comment-target');
      // Not "some tooltip" — the SAME string, so the two can never drift and
      // the tooltip can never be a truncated copy of its own text.
      expect(label.getAttribute('title')).toBe(label.textContent);
      expect(label.getAttribute('title')).toContain('this target changed or is unavailable');
      expect(label.getAttribute('title')).toContain('shown at its original line 9');
      // Long enough that the CSS above will in fact truncate it.
      expect(label.getAttribute('title').length).toBeGreaterThan(60);
    });

    it('gives a resolved (non-stale) target chip the same full-text tooltip', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([{ id: 16, line_start: 9, line_end: 9, body: 'x', rendered_anchor: CELL_2 }]);

      const label = view.container.querySelector('.rendered-markdown-comment-target');
      expect(label.classList.contains('is-stale')).toBe(false);
      expect(label.getAttribute('title')).toBe(label.textContent);
      expect(label.getAttribute('title')).toContain('column 2');
    });

    it('an unreadable descriptor (unknown version/kind/garbage) behaves exactly like no descriptor', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([
        { id: 12, line_start: 9, body: 'bad version', rendered_anchor: { v: 99, kind: 'table-cell', startLine: 9, endLine: 9, ordinal: 0 } },
        { id: 13, line_start: 9, body: 'garbage', rendered_anchor: 'not json at all' }
      ]);
      const cards = view.container.querySelectorAll('.rendered-markdown-comment-card');
      expect(cards).toHaveLength(2);
      cards.forEach((card) => {
        expect(card.dataset.renderedTargetKey).toBeUndefined();
        expect(card.querySelector('.rendered-markdown-comment-target')).toBeNull();
        expect(card.closest('.rendered-markdown-block').dataset.startLine).toBe('7');
      });
      expect(view.container.querySelectorAll('.rendered-markdown-target-badge:not([hidden])')).toHaveLength(0);
    });

    it('a descriptor pointing at a line that renders as nothing still falls back to the gap container', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      // Line 2 is the blank separator between the heading and the list —
      // part of no rendered block at all.
      view.setComments([{
        id: 14,
        line_start: 2,
        line_end: 2,
        body: 'on the blank separator line',
        rendered_anchor: { v: 1, kind: 'table-cell', startLine: 2, endLine: 2, ordinal: 0 }
      }]);
      const card = view.container.querySelector('.rendered-markdown-comment-card');
      expect(card.closest('.rendered-markdown-block')).toBeNull();
      expect(card.querySelector('.rendered-markdown-comment-target').classList.contains('is-stale')).toBe(true);
    });

    it('offers NO nested targets when repository-authored raw HTML makes the DOM disagree with the tokens', () => {
      // markdown-it emits this as an opaque html_block, so the DOM has a
      // <ul><li> the token stream knows nothing about. Mapping "the first
      // li in the DOM" onto a descriptor here would attach a comment to
      // attacker-authored markup; the structural pairing refuses instead.
      const view = makeView({ source: '<ul><li>injected item</li></ul>\n' });
      view.render();
      expect(view.container.querySelector('li')).toBeTruthy();
      expect(view.container.querySelectorAll('.rendered-markdown-target-btn')).toHaveLength(0);
      expect(view.container.querySelectorAll('.rendered-markdown-target')).toHaveLength(0);
      // Block-level commenting is unaffected.
      expect(view.container.querySelectorAll('.rendered-markdown-block-btn')).toHaveLength(1);
    });

    it('fails the whole block closed when raw HTML adds an extra item to a real list', () => {
      const view = makeView({ source: '- real item\n\n<ul><li>injected</li></ul>\n' });
      view.render();
      // The real list is its own block and still gets targets; the injected
      // one is a separate block with none.
      const blocks = view.container.querySelectorAll('.rendered-markdown-block');
      expect(blocks[0].querySelectorAll('.rendered-markdown-target-btn')).toHaveLength(1);
      expect(blocks[1].querySelectorAll('.rendered-markdown-target-btn')).toHaveLength(0);
    });

    it('reaches list items inside a blockquote (the blockquote itself is not a target)', () => {
      const view = makeView({ source: '> - quoted item\n> - second quoted item\n' });
      view.render();
      const labels = Array.from(view.container.querySelectorAll('.rendered-markdown-target-btn'))
        .map((el) => el.getAttribute('aria-label'));
      expect(labels).toEqual([
        'Add comment on List item, line 1',
        'Add comment on List item, line 2'
      ]);
      expect(view.container.querySelector('blockquote').classList.contains('rendered-markdown-target')).toBe(false);
    });

    it('does not spend a parse on blocks that cannot contain a nested target', () => {
      const view = makeView({ source: '# Heading\n\nA paragraph.\n\n```js\nconst x = 1;\n```\n' });
      const parseSpy = vi.spyOn(view.md, 'parse');
      view.render();
      // Exactly one parse: the document-level split. No per-block parse for
      // headings/paragraphs/fences.
      expect(parseSpy).toHaveBeenCalledTimes(1);
      parseSpy.mockRestore();
    });

    it('re-rendering rebuilds the target registry from scratch (no stale elements)', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      const before = view._targetsByKey.size;
      expect(before).toBeGreaterThan(0);
      view.source = '- only item\n';
      view.render();
      expect(view._targetsByKey.size).toBe(1);
      expect(view._targetsByElement.size).toBe(1);
      expect(view._activeTargetEl).toBeNull();
      expect(view.container.querySelectorAll('.rendered-markdown-target-btn')).toHaveLength(1);
    });

    describe('per-document nested-target cap', () => {
      // The Rendered-mode SOURCE ceiling (200 KB / 5000 lines, in pr.js)
      // does not bound how many nested elements that source expands to: a
      // machine-generated table can pass it and still produce tens of
      // thousands of buttons, listeners and tab stops. These tests pin the
      // documented cap, its exact boundary, and the fail-closed shape at
      // the boundary — block-level commenting always survives.
      // Read from the module export rather than the (per-test, re-required)
      // class binding, which does not exist yet at collection time.
      const CAP = require(RENDERED_DOC_PATH).MAX_NESTED_TARGETS_PER_DOCUMENT;
      const listOf = (n) => Array.from({ length: n }, (_, i) => `- item ${i + 1}`).join('\n') + '\n';
      const tableOf = (rows, cols) => {
        const row = (cell) => `| ${Array.from({ length: cols }, (_, c) => `${cell}${c}`).join(' | ')} |`;
        return [
          row('h'),
          `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`,
          ...Array.from({ length: rows }, (_, r) => row(`r${r}c`))
        ].join('\n') + '\n';
      };
      /**
       * Every registered descriptor points at an element that is still in
       * this document, and every marked target element is registered —
       * i.e. the cap never left a block half-wired.
       */
      const assertRegistryMatchesDom = (view) => {
        const marked = view.container.querySelectorAll('.rendered-markdown-target');
        expect(view._targetsByElement.size).toBe(marked.length);
        expect(view._targetsByKey.size).toBe(marked.length);
        marked.forEach((el) => expect(view._targetsByElement.has(el)).toBe(true));
        for (const el of view._targetsByElement.keys()) {
          expect(view.container.contains(el)).toBe(true);
        }
        // One button per registered target (block buttons live in the
        // comment zone, not on a target element).
        expect(view.container.querySelectorAll('.rendered-markdown-target-btn')).toHaveLength(marked.length);
      };

      let warnSpy;
      beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
      afterEach(() => { warnSpy.mockRestore(); });

      it('is documented as 5000 and is not silently reconfigurable', () => {
        expect(CAP).toBe(5000);
        expect(RenderedDocumentView.MAX_NESTED_TARGETS_PER_DOCUMENT).toBe(CAP);
        // A getter with no setter, so a caller cannot come to believe they
        // changed a limit that the enforcement path does not read.
        expect(() => { RenderedDocumentView.MAX_NESTED_TARGETS_PER_DOCUMENT = 7; }).toThrow(TypeError);
        expect(RenderedDocumentView.MAX_NESTED_TARGETS_PER_DOCUMENT).toBe(5000);
      });

      it('attaches every nested target for a document sitting EXACTLY on the cap', () => {
        const view = makeView({ source: listOf(CAP) });
        view.render();

        expect(view._targetsByKey.size).toBe(CAP);
        expect(view._nestedTargetsAttached).toBe(CAP);
        expect(view._nestedTargetBudgetExhausted).toBe(false);
        expect(warnSpy).not.toHaveBeenCalled();
        assertRegistryMatchesDom(view);
      });

      it('attaches NOTHING nested for a single block one target OVER the cap, keeping the block target', () => {
        const view = makeView({ source: listOf(CAP + 1) });
        view.render();

        expect(view.container.querySelectorAll('li')).toHaveLength(CAP + 1); // content intact
        expect(view._targetsByKey.size).toBe(0);
        expect(view._nestedTargetsAttached).toBe(0);
        expect(view._nestedTargetBudgetExhausted).toBe(true);
        assertRegistryMatchesDom(view);
        // The reviewer can still comment on the whole list.
        expect(view.container.querySelectorAll('.rendered-markdown-block-btn')).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toContain('nested comment target cap');
      });

      it('skips a whole later block that does not fit, after an earlier block fills the budget', () => {
        // A paragraph between the two lists, otherwise markdown-it parses
        // them as ONE list separated by a blank line.
        const view = makeView({ source: `${listOf(CAP)}\nSeparator paragraph.\n\n- tail one\n- tail two\n` });
        view.render();

        const blocks = view.container.querySelectorAll('.rendered-markdown-block');
        expect(blocks).toHaveLength(3);
        expect(blocks[0].querySelectorAll('.rendered-markdown-target-btn')).toHaveLength(CAP);
        // All-or-nothing: the two-item tail list gets neither of its items.
        expect(blocks[2].querySelectorAll('.rendered-markdown-target-btn')).toHaveLength(0);
        expect(blocks[2].querySelectorAll('li')).toHaveLength(2);
        expect(blocks[2].querySelectorAll('.rendered-markdown-block-btn')).toHaveLength(1);
        expect(view._targetsByKey.size).toBe(CAP);
        assertRegistryMatchesDom(view);
      });

      it('never leaves a table partly wired: an over-cap table gets no gutter cells and stays rectangular', () => {
        // 1300 rows x 3 columns => 1 header row + 3 header cells + 1300
        // body rows + 3900 body cells = 5204 descriptors, just over the cap.
        const view = makeView({ source: tableOf(1300, 3) });
        view.render();

        const table = view.container.querySelector('table');
        expect(table.querySelectorAll('tbody tr')).toHaveLength(1300);
        expect(table.querySelectorAll('td.rendered-markdown-row-gutter')).toHaveLength(0);
        expect(view._targetsByKey.size).toBe(0);
        // Rectangular: every row still has exactly the header's cell count,
        // which is what a ragged partial attach would break.
        const widths = new Set(
          Array.from(table.querySelectorAll('tr')).map((tr) => tr.children.length)
        );
        expect(Array.from(widths)).toEqual([3]);
        expect(view.container.querySelectorAll('.rendered-markdown-block-btn')).toHaveLength(1);
      });

      it('resets the budget on every render, so a smaller document is fully wired again', () => {
        const view = makeView({ source: listOf(CAP + 1) });
        view.render();
        expect(view._targetsByKey.size).toBe(0);
        expect(view._nestedTargetBudgetExhausted).toBe(true);

        view.source = '- alpha\n- beta\n';
        view.render();
        expect(view._nestedTargetsAttached).toBe(2);
        expect(view._nestedTargetBudgetExhausted).toBe(false);
        expect(view._targetsByKey.size).toBe(2);
        assertRegistryMatchesDom(view);
      });

      it('leaves ordinary documents completely untouched by the cap', () => {
        const view = makeView({ source: SOURCE });
        view.render();
        expect(view._nestedTargetBudgetExhausted).toBe(false);
        expect(view._nestedTargetsAttached).toBe(view._targetsByKey.size);
        expect(view._nestedTargetsAttached).toBeGreaterThan(0);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    it('does not leak nested affordances into the comment-count surface (cards are the counted unit)', () => {
      const view = makeView({ source: SOURCE });
      view.render();
      view.setComments([
        { id: 20, line_start: 9, body: 'a', rendered_anchor: CELL_1 },
        { id: 21, line_start: 3, body: 'b' }
      ]);
      expect(view.container.querySelectorAll('.rendered-markdown-comment-card')).toHaveLength(2);
    });
  });

  it('re-rendering (calling render() again) fully replaces prior content', () => {
    const view = makeView({ source: '# One\n' });
    view.render();
    view.source = '# Two\n\n# Three\n';
    view.render();
    expect(view.container.querySelectorAll('.rendered-markdown-block')).toHaveLength(2);
    expect(view.outline.map((o) => o.text)).toEqual(['Two', 'Three']);
  });

  it('shows an empty-state message for an empty document', () => {
    const view = makeView({ source: '' });
    view.render();
    expect(view.container.querySelector('.rendered-markdown-empty')).toBeTruthy();
  });
});
