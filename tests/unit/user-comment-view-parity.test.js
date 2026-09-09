// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Cross-surface parity for the SAVED user-comment presentation.
 *
 * One stored comment is rendered by three independent producers:
 *   - CommentManager.displayUserComment       (legacy diff2html rows)
 *   - PierreBridge._renderCommentAnnotation   (@pierre/diffs rows)
 *   - RenderedDocumentView._buildCommentCard  (Rendered Markdown)
 * They must be the same visual object, or the same comment looks like two
 * different things depending on which view the reviewer is in. These tests
 * drive the REAL production renderers (no markup is restated here) and
 * assert their canonical structure, class list, header metadata order,
 * action order/titles/icons and body contract are identical — so a future
 * change to one producer cannot silently drift from the others.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const markdownit = require('markdown-it');
const createDOMPurify = require('dompurify');
const {
  configureMarkdownIt,
  createRenderMarkdown,
  escapeHtmlAttribute
} = require('../../public/js/utils/markdown.js');

const USER_COMMENT_VIEW_PATH = '../../public/js/modules/user-comment-view.js';
const COMMENT_MANAGER_PATH = '../../public/js/modules/comment-manager.js';
const PIERRE_BRIDGE_PATH = '../../public/js/modules/pierre-bridge.js';
const RENDERED_DOC_PATH = '../../public/js/modules/rendered-document-view.js';
const RENDERED_MD_PATH = '../../public/js/modules/rendered-markdown.js';
const HUNK_PARSER_PATH = '../../public/js/modules/hunk-parser.js';

// docs/guide.md, hunk `@@ -1,3 +1,3 @@`: new-side line 1 is `context one`,
// line 2 is the added `new three`, line 3 is the `context four` CONTEXT line.
// So line 3 is inside the hunk (a context line inside a hunk is addressable
// from both sides and therefore still "in the diff") — which is the harder
// parity case, because the three surfaces reach that verdict by two different
// walks. Line 40 is nowhere near the hunk.
const PATCH = '@@ -1,3 +1,3 @@\n context one\n-old three\n+new three\n context four\n';
const FILE = 'docs/guide.md';

describe('saved user-comment presentation parity across surfaces', () => {
  let dom;
  let UserCommentView;
  let CommentManager;
  let PierreBridge;
  let RenderedDocumentView;
  let renderMarkdown;

  beforeEach(() => {
    for (const p of [
      USER_COMMENT_VIEW_PATH, COMMENT_MANAGER_PATH, PIERRE_BRIDGE_PATH,
      RENDERED_DOC_PATH, RENDERED_MD_PATH, HUNK_PARSER_PATH
    ]) {
      delete require.cache[require.resolve(p)];
    }

    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    global.window = dom.window;
    global.document = dom.window.document;

    const purify = createDOMPurify(dom.window);
    const md = configureMarkdownIt(markdownit, { html: true });
    renderMarkdown = createRenderMarkdown({ md, purify });
    window.renderMarkdown = renderMarkdown;
    window.escapeHtmlAttribute = escapeHtmlAttribute;

    require(HUNK_PARSER_PATH); // installs window.HunkParser
    require(RENDERED_MD_PATH); // installs window.RenderedMarkdown
    UserCommentView = require(USER_COMMENT_VIEW_PATH);
    window.UserCommentView = UserCommentView;
    CommentManager = require(COMMENT_MANAGER_PATH).CommentManager;
    PierreBridge = require(PIERRE_BRIDGE_PATH);
    RenderedDocumentView = require(RENDERED_DOC_PATH).RenderedDocumentView;
  });

  afterEach(() => {
    delete global.window;
    delete global.document;
    // Every test gets a fresh JSDOM; without this the previous one's window,
    // document and timers stay reachable for the whole fork.
    dom.window.close();
    dom = null;
  });

  /**
   * A CommentManager wired to just enough of PRManager for
   * displayUserComment: the escaper and the parsed patch its
   * expanded-context check reads.
   */
  function makeCommentManager() {
    const cm = Object.create(CommentManager.prototype);
    cm.prManager = {
      filePatches: new Map([[FILE, PATCH]]),
      escapeHtml: (text) => {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
    };
    return cm;
  }

  /** Render `comment` through CommentManager into a detached table. */
  function renderLegacy(comment) {
    const cm = makeCommentManager();
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    const targetRow = document.createElement('tr');
    tbody.appendChild(targetRow);
    table.appendChild(tbody);
    cm.displayUserComment(comment, targetRow);
    return tbody.querySelector('.user-comment-row');
  }

  /** Render `comment` through PierreBridge's annotation renderer. */
  function renderPierre(comment) {
    // window.prManager is the bridge's own seam for the escaper and for the
    // CommentManager that owns the parsed-patch hunk check.
    window.prManager = {
      escapeHtml: makeCommentManager().prManager.escapeHtml,
      commentManager: makeCommentManager()
    };
    const bridge = Object.create(PierreBridge.prototype);
    return bridge._renderCommentAnnotation(comment, `comment-${comment.id}`);
  }

  /** Render `comment` through RenderedDocumentView's card builder. */
  function renderRendered(comment, opts) {
    const view = new RenderedDocumentView({
      container: document.createElement('div'),
      filePath: FILE,
      source: 'one\ntwo\nnew three\nfour\n',
      patch: PATCH,
      md: markdownit({ html: false, breaks: true, linkify: true, typographer: true }),
      renderMarkdown,
      escapeHtmlAttribute,
      callbacks: {}
    });
    view.render();
    return view._buildCommentCard(comment, opts || {});
  }

  /**
   * Normalized description of the canonical fragment inside whatever
   * placement element a surface produced. Everything here is read from the
   * REAL rendered DOM; nothing is restated from the production templates.
   */
  function fingerprint(root) {
    const shell = root.querySelector('.user-comment');
    const header = shell.querySelector(':scope > .user-comment-header');
    const headerLeft = header.querySelector(':scope > .user-comment-header-left');
    const actions = header.querySelector(':scope > .user-comment-actions');
    const body = shell.querySelector(':scope > .user-comment-body');
    return {
      shellClasses: Array.from(shell.classList).sort(),
      // Header metadata, in document order, by its identifying class.
      headerLeftOrder: Array.from(headerLeft.children).map((el) => el.className),
      originIconSvg: headerLeft.querySelector('.comment-origin-icon svg').outerHTML,
      lineInfo: headerLeft.querySelector('.user-comment-line-info').textContent,
      praiseBadge: headerLeft.querySelector('.adopted-praise-badge')?.textContent ?? null,
      adoptedTitle: headerLeft.querySelector('.adopted-title')?.textContent ?? null,
      expandedContextTitle:
        headerLeft.querySelector('.expanded-context-indicator')?.getAttribute('title') ?? null,
      // Canonical action classes only, so a surface-owned behaviour hook
      // class does not count as a difference.
      actionOrder: Array.from(actions.children).map(
        (b) => b.className.split(/\s+/).filter((c) => UserCommentView.ACTION_ORDER.includes(c)).join(' ')
      ),
      actionTags: Array.from(actions.children).map((b) => `${b.tagName.toLowerCase()}:${b.getAttribute('type')}`),
      actionTitles: Array.from(actions.children).map((b) => b.getAttribute('title')),
      actionAriaLabels: Array.from(actions.children).map((b) => b.getAttribute('aria-label')),
      actionIcons: Array.from(actions.children).map((b) => b.querySelector('svg').outerHTML),
      chatDataset: { ...actions.querySelector('.btn-chat-comment').dataset },
      bodyHtml: body.innerHTML,
      bodyOriginalMarkdown: body.dataset.originalMarkdown
    };
  }

  const USER_COMMENT = {
    id: 101,
    file: FILE,
    line_start: 3,
    line_end: 3,
    side: 'RIGHT',
    body: 'A **user** comment.'
  };

  const ADOPTED_PRAISE_COMMENT = {
    id: 102,
    file: FILE,
    line_start: 3,
    line_end: 3,
    side: 'RIGHT',
    parent_id: 55,
    type: 'praise',
    title: 'Great naming',
    body: 'Adopted praise body.'
  };

  const OUT_OF_HUNK_COMMENT = {
    id: 103,
    file: FILE,
    line_start: 3,
    line_end: 3,
    side: 'RIGHT',
    body: 'Out of hunk.'
  };

  describe.each([
    ['a user-authored comment', USER_COMMENT],
    ['an adopted praise comment with a title', ADOPTED_PRAISE_COMMENT]
  ])('%s', (_label, comment) => {
    it('produces an identical canonical fragment on all three surfaces', () => {
      const legacy = fingerprint(renderLegacy(comment));
      const pierre = fingerprint(renderPierre(comment));
      const rendered = fingerprint(renderRendered(comment));

      expect(pierre).toEqual(legacy);
      expect(rendered).toEqual(legacy);
    });

    it('emits the canonical action order, tags and titles', () => {
      const legacy = fingerprint(renderLegacy(comment));
      expect(legacy.actionOrder).toEqual([...UserCommentView.ACTION_ORDER]);
      expect(legacy.actionTags).toEqual(['button:button', 'button:button', 'button:button']);
      expect(legacy.actionTitles).toEqual([
        UserCommentView.ACTION_TITLES.chat,
        UserCommentView.ACTION_TITLES.edit,
        UserCommentView.ACTION_TITLES.dismiss
      ]);
    });
  });

  describe('accessible names for the icon-only action controls', () => {
    /**
     * These three controls have no visible text — their only content is an
     * `<svg>`. Without an explicit `aria-label` the accessible name falls
     * back to `title`, which assistive technology exposes inconsistently and
     * which a touch user never sees at all. Asserted on the REAL production
     * renderers so the guarantee cannot be true of the module and false of a
     * surface.
     */
    it.each([
      ['legacy diff row', () => renderLegacy(USER_COMMENT)],
      ['pierre annotation', () => renderPierre(USER_COMMENT)],
      ['rendered card', () => renderRendered(USER_COMMENT)]
    ])('%s names every action button explicitly', (_label, build) => {
      const fp = fingerprint(build());
      expect(fp.actionAriaLabels).toEqual([
        UserCommentView.ACTION_TITLES.chat,
        UserCommentView.ACTION_TITLES.edit,
        UserCommentView.ACTION_TITLES.dismiss
      ]);
      // One string per action: `aria-label` overrides `title` when both are
      // present, so a drift between them would show sighted and
      // screen-reader users two different names for the same control.
      expect(fp.actionAriaLabels).toEqual(fp.actionTitles);
      expect(fp.actionAriaLabels.every((label) => typeof label === 'string' && label.length > 0))
        .toBe(true);
    });

    it('names them identically in BOTH action modes, so the mode is not an a11y fork', () => {
      const holder = document.createElement('div');
      const names = ['diff', 'callback'].map((actionMode) => {
        holder.innerHTML = `<div class="user-comment-actions">${UserCommentView.buildActionsHtml(
          USER_COMMENT, { mode: actionMode, escapeAttr: UserCommentView.defaultEscapeHtmlAttribute }
        )}</div>`;
        return Array.from(holder.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
      });
      expect(names[0]).toEqual(names[1]);
      expect(names[0]).toEqual(['Chat about comment', 'Edit comment', 'Dismiss comment']);
    });
  });

  describe('secondaryMetaHtml is raw HTML and therefore fails closed', () => {
    /**
     * `secondaryMetaHtml` is the ONE option `buildCommentHtml` interpolates
     * without escaping. It exists for a single caller (the Rendered card's
     * nested-target chip, which this module's own code builds and escapes),
     * but it is reachable from all three surfaces. So it is wrong-by-default:
     * without the explicit trust token the markup is dropped, and the
     * mistake is logged rather than shipped.
     *
     * NOT a sanitizer and NOT a boundary against code that can read the
     * module — a guard against passing raw HTML BY ACCIDENT.
     */
    const HOSTILE_META = '<img src=x onerror="window.pwned = 1">';

    it('drops untrusted secondaryMetaHtml and says why', () => {
      const errors = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));
      try {
        const holder = document.createElement('div');
        holder.innerHTML = UserCommentView.buildCommentHtml(USER_COMMENT, {
          secondaryMetaHtml: HOSTILE_META,
          renderMarkdown
        });
        expect(holder.querySelectorAll('img')).toHaveLength(0);
        expect(window.pwned).toBeUndefined();
        // The canonical header is otherwise untouched — failing closed drops
        // the untrusted extra, never the comment.
        expect(holder.querySelector('.user-comment-line-info').textContent).toBe('Line 3');
        expect(errors.join('\n')).toContain('secondaryMetaHtml');
        expect(errors.join('\n')).toContain('TRUSTED_SECONDARY_META');
      } finally {
        spy.mockRestore();
      }
    });

    it('renders it when the caller presents the trust token', () => {
      const holder = document.createElement('div');
      holder.innerHTML = UserCommentView.buildCommentHtml(USER_COMMENT, {
        secondaryMetaHtml: '<span class="rendered-markdown-comment-target">Table cell, row 2, column 1</span>',
        secondaryMetaTrust: UserCommentView.TRUSTED_SECONDARY_META,
        renderMarkdown
      });
      expect(holder.querySelector('.rendered-markdown-comment-target').textContent)
        .toBe('Table cell, row 2, column 1');
    });

    it('rejects a look-alike token — identity, not shape', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const holder = document.createElement('div');
        holder.innerHTML = UserCommentView.buildCommentHtml(USER_COMMENT, {
          secondaryMetaHtml: HOSTILE_META,
          secondaryMetaTrust: { token: 'UserCommentView.TRUSTED_SECONDARY_META' },
          renderMarkdown
        });
        expect(holder.querySelectorAll('img')).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('the Rendered card — the one legitimate caller — still gets its chip', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const card = renderRendered(USER_COMMENT, { targetLabel: 'Table cell, row 2, column 1' });
        expect(card.querySelector('.rendered-markdown-comment-target').textContent)
          .toBe('Table cell, row 2, column 1');
        // And it did not have to be warned about to get there.
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('header layout contract under the real pr.css', () => {
    /**
     * The nested-target chip is the one piece of header metadata whose
     * length is unbounded ("Table cell, row 12, column 7"), and it shares a
     * flex track with the canonical line badge. If the badge is shrinkable,
     * a long chip squeezes "Lines 11-13" until it wraps or clips and the
     * SAME comment reads differently in Rendered and Diff mode; if the chip
     * is not shrinkable, it pushes the chat/edit/dismiss actions off the
     * card instead.
     *
     * jsdom does not do flex LAYOUT, but it does resolve the real cascade
     * from the real stylesheet — which is where this contract actually
     * lives. So this asserts the declarations that decide the outcome
     * (`flex-shrink`, `min-width`, `overflow`, `white-space`) on markup the
     * PRODUCTION renderer emitted, rather than restating either.
     *
     * Run over BOTH header populations that can carry the chip. The adopted
     * one is not a duplicate: `.adopted-praise-badge` / `.adopted-title` only
     * appear on adopted comments. The compact praise badge stays fixed while
     * the existing long title and nested-target chip may both ellipse before
     * they can displace the canonical line badge or actions.
     */
    const LONG_TARGET_LABEL = 'Table cell, row 12, column 7, in a very long table heading';

    // Lines 11-13 sit outside the fixture patch, so each card carries the
    // out-of-hunk indicator too — every canonical item in one track at once.
    describe.each([
      [
        'a user-authored comment',
        USER_COMMENT,
        [
          'comment-origin-icon',
          'user-comment-line-info',
          'expanded-context-indicator',
          'rendered-markdown-comment-target'
        ],
        ['rendered-markdown-comment-target']
      ],
      [
        'an adopted praise comment with a title',
        ADOPTED_PRAISE_COMMENT,
        [
          'comment-origin-icon',
          'user-comment-line-info',
          'expanded-context-indicator',
          'adopted-praise-badge',
          'adopted-title',
          'rendered-markdown-comment-target'
        ],
        ['adopted-title', 'rendered-markdown-comment-target']
      ]
    ])('%s with a long target chip', (_label, comment, expectedTrack, expectedShrinkable) => {
      let cssDom;
      let cs;

      beforeEach(() => {
        const card = renderRendered(
          { ...comment, line_start: 11, line_end: 13 },
          { targetLabel: LONG_TARGET_LABEL }
        );
        const css = fs.readFileSync(path.join(__dirname, '../../public/css/pr.css'), 'utf8');
        cssDom = new JSDOM(
          `<!doctype html><html><head><style>${css}</style></head><body>${card.outerHTML}</body></html>`
        );
        cs = (selector) => {
          const el = cssDom.window.document.querySelector(selector);
          expect(el, `missing ${selector}`).not.toBeNull();
          return cssDom.window.getComputedStyle(el);
        };
      });

      afterEach(() => {
        cssDom.window.close();
      });

      it('renders the long chip beside every canonical header item in one flex track', () => {
        const headerLeft = cssDom.window.document.querySelector('.user-comment-header-left');
        expect(Array.from(headerLeft.children).map((el) => el.className)).toEqual(expectedTrack);
        expect(cs('.user-comment-line-info').display).not.toBe('none');
        expect(headerLeft.querySelector('.user-comment-line-info').textContent).toBe('Lines 11-13');
        expect(headerLeft.querySelector('.rendered-markdown-comment-target').textContent)
          .toBe(LONG_TARGET_LABEL);
      });

      it('pins the canonical line badge: it can neither shrink nor wrap', () => {
        expect(cs('.user-comment-line-info').flexShrink).toBe('0');
        expect(cs('.user-comment-line-info').whiteSpace).toBe('nowrap');
      });

      it('keeps the icon actions out of the chip\'s way entirely', () => {
        expect(cs('.user-comment-actions').flexShrink).toBe('0');
        // The track itself is what clips, so the chip has somewhere to ellipse
        // INTO rather than overflowing the card.
        expect(cs('.user-comment-header-left').minWidth).toBe('0px');
        expect(cs('.user-comment-header-left').overflow).toBe('hidden');
      });

      it('keeps only long-form metadata shrinkable in the header-left track', () => {
        const headerLeft = cssDom.window.document.querySelector('.user-comment-header-left');
        const shrinkable = Array.from(headerLeft.children)
          .filter((el) => cssDom.window.getComputedStyle(el).flexShrink !== '0')
          .map((el) => el.className);
        expect(shrinkable).toEqual(expectedShrinkable);
        // Including the out-of-hunk indicator, which is in this fixture's
        // track and is a fixed-size glyph like the origin icon.
        expect(cs('.expanded-context-indicator').flexShrink).toBe('0');
      });

      it('gives the chip everything it needs to ellipse instead of overflowing', () => {
        const chip = cs('.rendered-markdown-comment-target');
        expect(chip.minWidth).toBe('0px');
        expect(chip.overflow).toBe('hidden');
        expect(chip.textOverflow).toBe('ellipsis');
        expect(chip.whiteSpace).toBe('nowrap');
      });
    });

    it('keeps the praise badge whole while allowing a long adopted title to ellipse', () => {
      // "Nice Work" is a compact bordered pill, so it must not wrap. The
      // longer adopted title keeps its canonical shrink-and-ellipsis behavior
      // so it can share the metadata track with a nested-target chip without
      // pushing the line badge or action buttons away.
      const card = renderRendered(
        { ...ADOPTED_PRAISE_COMMENT, line_start: 11, line_end: 13 },
        { targetLabel: LONG_TARGET_LABEL }
      );
      const css = fs.readFileSync(path.join(__dirname, '../../public/css/pr.css'), 'utf8');
      const layoutDom = new JSDOM(
        `<!doctype html><html><head><style>${css}</style></head><body>${card.outerHTML}</body></html>`
      );
      try {
        const style = (selector) =>
          layoutDom.window.getComputedStyle(layoutDom.window.document.querySelector(selector));

        expect(style('.adopted-praise-badge').flexShrink).toBe('0');
        expect(style('.adopted-praise-badge').whiteSpace).toBe('nowrap');
        expect(style('.adopted-title').flexShrink).toBe('1');
        expect(style('.adopted-title').whiteSpace).toBe('nowrap');
        expect(style('.adopted-title').overflow).toBe('hidden');
        expect(style('.adopted-title').textOverflow).toBe('ellipsis');
      } finally {
        layoutDom.window.close();
      }
    });
  });

  describe('classic-script loading (how the browser actually loads these files)', () => {
    /**
     * The Node tests above load every producer through CommonJS, where each
     * file gets its own module scope. THE BROWSER DOES NOT: `pr.html` and
     * `local.html` load them as classic `<script>`s that all share one
     * global scope. Anything these files declare at top level is therefore a
     * global, and two files declaring the same name is a real collision the
     * CommonJS tests structurally cannot see. So this block loads them the
     * way the app does.
     */
    function loadAsScripts(sources) {
      const scriptDom = new JSDOM('<!doctype html><body></body>', {
        url: 'http://localhost/',
        runScripts: 'dangerously'
      });
      for (const src of sources) {
        const el = scriptDom.window.document.createElement('script');
        el.textContent = src;
        scriptDom.window.document.body.appendChild(el);
      }
      return scriptDom;
    }

    const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

    it('loads all three producers into one page without either Diff module shadowing the other\'s lookup', () => {
      const scriptDom = loadAsScripts([
        read(USER_COMMENT_VIEW_PATH), read(COMMENT_MANAGER_PATH), read(PIERRE_BRIDGE_PATH)
      ]);
      try {
        const w = scriptDom.window;
        expect(typeof w.UserCommentView).toBe('object');
        expect(typeof w.CommentManager).toBe('function');
        expect(typeof w.PierreBridge).toBe('function');
        // A top-level `function getUserCommentView()` in each Diff module
        // would define this same window property twice; the later-loaded
        // file would silently win for BOTH, so a future fix to one copy
        // could never be observed.
        expect(w.getUserCommentView).toBeUndefined();
        expect(Object.getOwnPropertyDescriptor(w, 'getUserCommentView')).toBeUndefined();
        // Both still resolve the one shared definition.
        expect(w.CommentManager.AI_ICON_SVG).toBe(w.UserCommentView.ICONS.ai);
        expect(w.CommentManager.PERSON_ICON_SVG).toBe(w.UserCommentView.ICONS.person);
      } finally {
        scriptDom.window.close();
      }
    });

    it('order does not matter: pierre-bridge first is the same page as comment-manager first', () => {
      for (const order of [
        [USER_COMMENT_VIEW_PATH, PIERRE_BRIDGE_PATH, COMMENT_MANAGER_PATH],
        [USER_COMMENT_VIEW_PATH, COMMENT_MANAGER_PATH, PIERRE_BRIDGE_PATH]
      ]) {
        const scriptDom = loadAsScripts(order.map(read));
        try {
          expect(scriptDom.window.getUserCommentView).toBeUndefined();
          expect(scriptDom.window.CommentManager.AI_ICON_SVG)
            .toBe(scriptDom.window.UserCommentView.ICONS.ai);
        } finally {
          scriptDom.window.close();
        }
      }
    });

    it.each([
      ['CommentManager', COMMENT_MANAGER_PATH, /CommentManager\].*user-comment-view\.js/s],
      ['PierreBridge', PIERRE_BRIDGE_PATH, /PierreBridge\].*user-comment-view\.js/s],
      ['RenderedDocumentView', RENDERED_DOC_PATH, /RenderedDocumentView\].*user-comment-view\.js/s]
    ])('%s fails with a message naming the missing script, not "require is not defined"', (_label, modulePath, expected) => {
      // The regression this guards: `require` does not exist in a browser,
      // so a missing/late `<script src=".../user-comment-view.js">` used to
      // surface as `ReferenceError: require is not defined` from deep inside
      // comment rendering, pointing at nothing.
      const scriptDom = loadAsScripts([read(modulePath)]);
      try {
        const w = scriptDom.window;
        expect(w.UserCommentView).toBeUndefined();
        let thrown = null;
        try {
          if (w.CommentManager) w.CommentManager.AI_ICON_SVG;
          else if (w.PierreBridge) {
            Object.create(w.PierreBridge.prototype)._renderCommentAnnotation({ id: 1, file: 'a.md' }, 'x');
          } else {
            const view = Object.create(w.RenderedDocumentView.prototype);
            view._formatLineRange({ line_start: 1 });
          }
        } catch (error) {
          thrown = error;
        }
        // The page's own realm: a JSDOM `Error` is not the Node `Error`.
        expect(thrown).toBeInstanceOf(w.Error);
        expect(thrown.message).not.toMatch(/require is not defined/);
        expect(thrown.message).toMatch(expected);
      } finally {
        scriptDom.window.close();
      }
    });
  });

  it('every surface resolves the SAME UserCommentView object', () => {
    // The point of the module: one definition, not three lookalikes.
    expect(require(USER_COMMENT_VIEW_PATH)).toBe(window.UserCommentView);
    expect(fingerprint(renderLegacy(USER_COMMENT)).actionIcons)
      .toEqual(fingerprint(renderPierre(USER_COMMENT)).actionIcons);
  });

  /**
   * Parse an icon template string through the DOM so it is compared in the
   * same serialized form as the rendered markup (`<path/>` vs `<path></path>`
   * is a serializer detail, not a difference).
   */
  function normalizeSvg(html) {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    return holder.querySelector('svg').outerHTML;
  }

  it('shows the same origin icon per origin: person for user, AI sparkle for adopted', () => {
    const user = fingerprint(renderRendered(USER_COMMENT));
    const adopted = fingerprint(renderRendered(ADOPTED_PRAISE_COMMENT));
    expect(user.originIconSvg).toBe(normalizeSvg(UserCommentView.ICONS.person));
    expect(adopted.originIconSvg).toBe(normalizeSvg(UserCommentView.ICONS.ai));
    expect(user.shellClasses).toEqual(['comment-user-origin', 'user-comment']);
    expect(adopted.shellClasses).toEqual([
      'adopted-comment', 'comment-ai-origin', 'user-comment'
    ]);
  });

  it('keeps the canonical header metadata order: icon, line badge, then adopted metadata', () => {
    const adopted = fingerprint(renderLegacy(ADOPTED_PRAISE_COMMENT));
    expect(adopted.headerLeftOrder).toEqual([
      'comment-origin-icon',
      'user-comment-line-info',
      'adopted-praise-badge',
      'adopted-title'
    ]);
    expect(adopted.praiseBadge).toBe('Nice Work');
    expect(adopted.adoptedTitle).toBe('Great naming');
  });

  it('omits only the missing optional metadata when an adopted comment has no title', () => {
    const noTitle = { ...ADOPTED_PRAISE_COMMENT, title: undefined };
    for (const fp of [fingerprint(renderLegacy(noTitle)), fingerprint(renderRendered(noTitle))]) {
      expect(fp.praiseBadge).toBe('Nice Work');
      expect(fp.adoptedTitle).toBeNull();
      expect(fp.headerLeftOrder).toEqual([
        'comment-origin-icon', 'user-comment-line-info', 'adopted-praise-badge'
      ]);
    }
  });

  it('renders the same line badge text for a multi-line comment on every surface', () => {
    const range = { ...USER_COMMENT, line_start: 2, line_end: 4 };
    expect(fingerprint(renderLegacy(range)).lineInfo).toBe('Lines 2-4');
    expect(fingerprint(renderPierre(range)).lineInfo).toBe('Lines 2-4');
    expect(fingerprint(renderRendered(range)).lineInfo).toBe('Lines 2-4');
  });

  describe('out-of-hunk (expanded context) comments', () => {
    it('shows no indicator on any surface when the line IS in the patch', () => {
      for (const fp of [
        fingerprint(renderLegacy(OUT_OF_HUNK_COMMENT)),
        fingerprint(renderPierre(OUT_OF_HUNK_COMMENT)),
        fingerprint(renderRendered(OUT_OF_HUNK_COMMENT))
      ]) {
        expect(fp.expandedContextTitle).toBeNull();
      }
    });

    it('shows the same indicator and tooltip on all three surfaces when the line is outside every hunk', () => {
      const outside = { ...OUT_OF_HUNK_COMMENT, line_start: 40, line_end: 40 };
      for (const fp of [
        fingerprint(renderLegacy(outside)),
        fingerprint(renderPierre(outside)),
        fingerprint(renderRendered(outside))
      ]) {
        expect(fp.expandedContextTitle).toBe(UserCommentView.EXPANDED_CONTEXT_TITLE);
        expect(fp.headerLeftOrder).toEqual([
          'comment-origin-icon', 'user-comment-line-info', 'expanded-context-indicator'
        ]);
      }
    });
  });

  describe('surface-specific placement and action wiring', () => {
    it('gives Diff rows the row identity and the Diff-only inline handlers', () => {
      for (const row of [renderLegacy(USER_COMMENT), renderPierre(USER_COMMENT)]) {
        expect(row.classList.contains('user-comment-row')).toBe(true);
        expect(row.dataset.commentId).toBe('101');
        expect(row.querySelector('.btn-edit-comment').getAttribute('onclick'))
          .toBe('prManager.editUserComment(101)');
        expect(row.querySelector('.btn-delete-comment').getAttribute('onclick'))
          .toBe('prManager.deleteUserComment(101)');
        expect(row.querySelector('[data-comment-action]')).toBeNull();
      }
    });

    it('keeps a non-numeric comment id inside the Diff inline handler attribute', () => {
      // Real ids are integer primary keys, but the inline-handler attribute
      // must not be forgeable if a host ever hands over a string id.
      const hostile = { ...USER_COMMENT, id: '1) + (window.pwned=1' };
      const row = renderLegacy(hostile);
      expect(row.querySelector('.btn-edit-comment').getAttribute('onclick'))
        .toBe('prManager.editUserComment("1) + (window.pwned=1")');
      expect(window.pwned).toBeUndefined();
    });

    it('gives the Rendered card a neutral placement adapter with NO Diff row identity or handlers', () => {
      const card = renderRendered(USER_COMMENT);
      expect(card.classList.contains('rendered-markdown-comment-card')).toBe(true);
      // The Diff row identity would make PRManager.editUserComment /
      // deleteUserComment / _syncDiffComment* treat this card as a Diff row,
      // and would double-count the comment in CommentCount.
      expect(card.classList.contains('user-comment-row')).toBe(false);
      expect(card.dataset.commentId).toBe('101');
      expect(card.querySelector('[onclick]')).toBeNull();
      expect(card.querySelector('.btn-edit-comment').dataset.commentAction).toBe('edit');
      expect(card.querySelector('.btn-delete-comment').dataset.commentAction).toBe('delete');
      // Behaviour hooks this view uses to find its own controls.
      expect(card.querySelector('.btn-edit-comment').classList.contains('rendered-markdown-comment-edit')).toBe(true);
      expect(card.querySelector('.btn-delete-comment').classList.contains('rendered-markdown-comment-delete')).toBe(true);
      expect(card.querySelector('.user-comment-body').classList.contains('rendered-markdown-comment-body')).toBe(true);
    });

    it('carries the same chat context data on every surface', () => {
      const expected = {
        chatCommentId: '101',
        chatFile: FILE,
        chatLineStart: '3',
        chatLineEnd: '3',
        chatParentId: ''
      };
      expect(fingerprint(renderLegacy(USER_COMMENT)).chatDataset).toEqual(expected);
      expect(fingerprint(renderPierre(USER_COMMENT)).chatDataset).toEqual(expected);
      expect(fingerprint(renderRendered(USER_COMMENT)).chatDataset).toEqual(expected);
    });

    it('keeps the nested-target chip as SECONDARY header metadata, after the line badge', () => {
      const card = renderRendered(USER_COMMENT, { targetLabel: 'Table cell, row 2, column 1' });
      const fp = fingerprint(card);
      expect(fp.headerLeftOrder).toEqual([
        'comment-origin-icon',
        'user-comment-line-info',
        'rendered-markdown-comment-target'
      ]);
      // The chip is additive: the canonical line badge is still there.
      expect(fp.lineInfo).toBe('Line 3');
      expect(card.querySelector('.rendered-markdown-comment-target').textContent)
        .toBe('Table cell, row 2, column 1');
    });

    it('marks an unresolved nested target chip as stale without dropping the line badge', () => {
      const card = renderRendered(USER_COMMENT, { targetLabel: 'gone', staleTarget: true });
      expect(card.querySelector('.rendered-markdown-comment-target').classList.contains('is-stale')).toBe(true);
      expect(card.querySelector('.user-comment-line-info').textContent).toBe('Line 3');
    });
  });

  describe('the nested-target chip stays discoverable when it is ellipsed', () => {
    /**
     * `.user-comment-header-left .rendered-markdown-comment-target` in the
     * real pr.css is `white-space: nowrap; overflow: hidden; text-overflow:
     * ellipsis` — deliberately, because it is the only item in the header-left
     * track allowed to give up space to the canonical line badge and the
     * action buttons. That makes the visible chip text a LOSSY view of the
     * label, so the full label has to survive somewhere a reviewer can reach
     * without dev tools.
     */
    const chipOf = (card) => card.querySelector('.rendered-markdown-comment-target');

    it('carries the full label as a title on a long chip, not the truncated text', () => {
      const long = 'Table cell, line 71, column 2 — this target changed or is unavailable; '
        + 'shown at its original line 9';
      const chip = chipOf(renderRendered(USER_COMMENT, { targetLabel: long, staleTarget: true }));
      expect(chip.getAttribute('title')).toBe(long);
      // One string, so the tooltip cannot drift from the text it explains.
      expect(chip.getAttribute('title')).toBe(chip.textContent);
      expect(chip.classList.contains('is-stale')).toBe(true);
    });

    it('carries it on a short, resolved chip too — no conditional tooltip', () => {
      const chip = chipOf(renderRendered(USER_COMMENT, { targetLabel: 'List item, line 4' }));
      expect(chip.getAttribute('title')).toBe('List item, line 4');
      expect(chip.getAttribute('title')).toBe(chip.textContent);
    });

    it('omits the chip entirely — and so any title — when there is no target', () => {
      expect(chipOf(renderRendered(USER_COMMENT))).toBeNull();
    });

    it('escapes hostile label text in the title attribute as well as in the text node', () => {
      // Target labels are application-generated from validated descriptors,
      // so this is defence in depth — but the label now lands in a QUOTED
      // ATTRIBUTE as well as in a text position, which is a strictly larger
      // sink than before. If that ever stops being escaped, the chip becomes
      // an injection point on the one surface that renders repository
      // structure.
      const HOSTILE_LABEL = 'Table cell "><img src=x onerror="window.pwned=1"> row \'1\' & <b>2</b>';
      const card = renderRendered(USER_COMMENT, {
        targetLabel: HOSTILE_LABEL,
        staleTarget: true
      });
      const chip = chipOf(card);

      // Round-trips exactly: escaped on the way in, decoded by the parser.
      expect(chip.getAttribute('title')).toBe(HOSTILE_LABEL);
      expect(chip.textContent).toBe(HOSTILE_LABEL);
      // No breakout: no injected element anywhere in the card, and the chip
      // grew no attributes beyond the two it is supposed to have.
      expect(card.querySelectorAll('img')).toHaveLength(0);
      expect(card.querySelectorAll('b')).toHaveLength(0);
      expect(chip.getAttributeNames().sort()).toEqual(['class', 'title']);
      expect(chip.getAttribute('onerror')).toBeNull();
      expect(window.pwned).toBeUndefined();
      // The canonical header is intact around it.
      expect(card.querySelector('.user-comment-line-info').textContent).toBe('Line 3');
      expect(card.querySelectorAll('.user-comment-actions button')).toHaveLength(3);
    });
  });

  describe('escaping of untrusted comment data', () => {
    const HOSTILE = {
      id: 999,
      file: 'docs/"><img src=x onerror=alert(1)>.md',
      line_start: 3,
      line_end: 3,
      parent_id: 7,
      type: 'praise',
      title: '<img src=x onerror="alert(1)">',
      body: 'hi" onmouseover="window.pwned=1" data-x="'
    };

    it.each([
      ['legacy diff row', () => renderLegacy(HOSTILE)],
      ['pierre annotation', () => renderPierre(HOSTILE)],
      ['rendered card', () => renderRendered(HOSTILE)]
    ])('%s neither breaks out of an attribute nor injects markup', (_label, build) => {
      const root = build();
      const body = root.querySelector('.user-comment-body');
      expect(body.hasAttribute('onmouseover')).toBe(false);
      expect(body.getAttribute('data-x')).toBeNull();
      expect(body.dataset.originalMarkdown).toBe(HOSTILE.body);

      const chatBtn = root.querySelector('.btn-chat-comment');
      expect(chatBtn.dataset.chatFile).toBe(HOSTILE.file);
      expect(chatBtn.querySelectorAll('img')).toHaveLength(0);

      // The adopted title is TEXT, never markup.
      expect(root.querySelector('.adopted-title').textContent).toBe(HOSTILE.title);
      expect(root.querySelectorAll('img')).toHaveLength(0);
    });
  });
  describe('chat action delegation', () => {
    /**
     * A real CommentManager (not a prototype stub) so its constructor
     * installs the delegated `.btn-chat-comment` handler on `document` —
     * that delegation IS what is under test.
     */
    function installCommentManager() {
      const open = vi.fn();
      window.chatPanel = { open };
      const prManager = {
        currentPR: { id: 4242 },
        filePatches: new Map([[FILE, PATCH]]),
        escapeHtml: makeCommentManager().prManager.escapeHtml
      };
      const manager = new CommentManager(prManager);
      return { manager, open };
    }

    it('opens chat exactly once from a Rendered card, with the same context a Diff row gives', () => {
      const { open } = installCommentManager();

      const card = renderRendered(USER_COMMENT);
      document.body.appendChild(card);
      card.querySelector('.btn-chat-comment').click();

      expect(open).toHaveBeenCalledTimes(1);
      const renderedArg = open.mock.calls[0][0];
      expect(renderedArg).toEqual({
        reviewId: 4242,
        commentContext: {
          commentId: '101',
          body: USER_COMMENT.body,
          file: FILE,
          line_start: 3,
          line_end: 3,
          parentId: null,
          source: 'user'
        }
      });

      // The Diff surface must produce byte-identical chat context for the
      // same stored comment.
      open.mockClear();
      const row = renderLegacy(USER_COMMENT);
      const table = document.createElement('table');
      const tbody = document.createElement('tbody');
      tbody.appendChild(row);
      table.appendChild(tbody);
      document.body.appendChild(table);
      row.querySelector('.btn-chat-comment').click();

      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0][0]).toEqual(renderedArg);
    });

    it('sends the parent id for an adopted comment', () => {
      const { open } = installCommentManager();
      const card = renderRendered(ADOPTED_PRAISE_COMMENT);
      document.body.appendChild(card);
      card.querySelector('.btn-chat-comment').click();
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0][0].commentContext).toMatchObject({
        commentId: '102',
        parentId: '55',
        body: ADOPTED_PRAISE_COMMENT.body
      });
    });

    it('ignores a file-level comment card, which FileCommentManager owns', () => {
      // Guards against widening the delegated selector to a bare
      // `.btn-chat-comment`, which would open the chat panel twice for one
      // click on a file-level comment.
      const { open } = installCommentManager();
      const zone = document.createElement('div');
      zone.className = 'file-comments-zone';
      zone.innerHTML = '<div class="file-comment-card user-comment" data-comment-id="7">'
        + '<button class="btn-chat-comment" data-chat-comment-id="7"></button>'
        + '<div class="user-comment-body" data-original-markdown="x">x</div></div>';
      document.body.appendChild(zone);
      zone.querySelector('.btn-chat-comment').click();
      expect(open).not.toHaveBeenCalled();
    });

    it('handles a click on the icon INSIDE the button (the real hit target)', () => {
      const { open } = installCommentManager();
      const card = renderRendered(USER_COMMENT);
      document.body.appendChild(card);
      card.querySelector('.btn-chat-comment svg').dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
      expect(open).toHaveBeenCalledTimes(1);
    });
  });
});
