// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * RenderedDocumentView - DOM controller for one file's "Rendered" Markdown
 * view.
 *
 * Consumes the pure parsing/outline/target-resolution helpers from
 * `rendered-markdown.js` and builds the actual DOM: one wrapper `<div>` per
 * top-level markdown block, a per-block comment zone, heading ids for the
 * Outline sidebar, and click-interception for safe relative links to other
 * changed Markdown files.
 *
 * SECURITY NOTE: every block's inner HTML goes through the SAME
 * `renderMarkdown` pipeline already used for comments (markdown-it +
 * DOMPurify, see utils/markdown.js) — no new sanitizer allowlist is
 * introduced. The tracking attributes this module cares about
 * (`data-block-index`, `data-start-line`, `data-end-line`) are assigned in
 * JS via `element.dataset` AFTER sanitization, on wrapper elements THIS
 * module creates with `document.createElement` — they are never part of
 * the sanitized (repository-controlled) HTML string, so repository content
 * can never forge them to redirect a comment. Comment targets are always
 * resolved from this controller's own `this.blocks` array (by index),
 * never by re-reading attribute VALUES back out of the DOM.
 */

/* eslint-disable no-undef */
(function (root) {
  const isBrowser = typeof window !== 'undefined';

  function getRenderedMarkdown() {
    if (isBrowser && window.RenderedMarkdown) return window.RenderedMarkdown;
    // eslint-disable-next-line global-require
    return require('./rendered-markdown.js');
  }

  // Plain plus glyph. Deliberately NOT the filled-circle "plus in a disc"
  // icon this view first shipped with: a filled dark circle reads as a
  // status dot / avatar placeholder rather than an action, and gave no hint
  // that the control adds a comment. `aria-hidden` because every button
  // that embeds it carries its own descriptive `aria-label`.
  const ADD_COMMENT_ICON_SVG = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false" fill="currentColor">
    <path d="M7.25 1.75a.75.75 0 0 1 1.5 0V7.25h5.5a.75.75 0 0 1 0 1.5H8.75v5.5a.75.75 0 0 1-1.5 0V8.75h-5.5a.75.75 0 0 1 0-1.5h5.5V1.75Z"/>
  </svg>`;

  /**
   * Top-level block types whose rendered output can contain a nested
   * comment target. A blockquote qualifies because it can wrap a list or a
   * table; everything else (heading, paragraph, fence, hr, html_block)
   * cannot produce one, and `html_block` deliberately never gets targets at
   * all (its markup is opaque to the token stream — see `_wireNestedTargets`).
   */
  const NESTABLE_BLOCK_TYPES = new Set(['bullet_list', 'ordered_list', 'table', 'blockquote']);

  /**
   * Human-readable semantic kind for every top-level block type
   * `splitTopLevelBlocks` can emit (the markdown-it token type with its
   * `_open` suffix stripped). Used to build each block-level add-comment
   * button's accessible name, so a screen-reader user tabbing a document
   * hears WHAT they are about to comment on ("heading, line 3") rather than
   * a bare line number.
   *
   * The three NESTABLE types that also expose nested item/row/cell targets
   * say "the whole ..." explicitly, because for those the reviewer has to be
   * able to tell the container target apart from the more precise ones.
   * Anything not listed here (a plugin block type, a future markdown-it
   * addition) falls back to the generic "block" — see `_blockTargetLabel`.
   */
  const BLOCK_TARGET_LABELS = {
    heading: 'heading',
    paragraph: 'paragraph',
    fence: 'code block',
    code_block: 'code block',
    hr: 'divider',
    html_block: 'HTML block',
    bullet_list: 'the whole list',
    ordered_list: 'the whole list',
    table: 'the whole table',
    blockquote: 'the whole quote'
  };

  /** Generic fallback kind for an unrecognised top-level block type. */
  const BLOCK_TARGET_FALLBACK_LABEL = 'block';

  /**
   * Hard upper bound on how many NESTED targets (list item, nested list
   * item, table row, header cell, data cell) one document may attach in a
   * single render pass.
   *
   * WHY A CAP EXISTS. Every nested target adds a real `<button>`, a click
   * listener and a tab stop. The Rendered-mode size ceiling in pr.js
   * (`RENDERED_MARKDOWN_MAX_SOURCE_CHARS` = 200 KB /
   * `RENDERED_MARKDOWN_MAX_SOURCE_LINES` = 5000) bounds the SOURCE, not the
   * number of nested elements that source can expand to: a 5000-line,
   * ~130 KB table of 5000 rows × 8 columns passes both ceilings and yields
   * ~45,000 targets — i.e. ~45,000 buttons/listeners/tab stops, measured at
   * roughly 2.5× the render cost of the same document with nested targets
   * off. Those ceilings were tuned before nested targets existed.
   *
   * WHY 5000. It is the same order as the line ceiling (one target per
   * source line is already far more than any human document needs: the
   * pathological cases are all machine-generated tables), it keeps the
   * worst case well inside the pre-existing render budget, and no realistic
   * reviewed document comes close (a 5000-item list is exactly at it; a
   * 1000-row × 3-column table is ~4000).
   *
   * BEHAVIOUR AT THE CAP. Top-level BLOCK affordances are never affected —
   * every list/table/quote keeps its "comment on the whole ..." plus, so
   * commenting is always possible everywhere in the document. Only the
   * nested affordances stop. The check is made per BLOCK, before that
   * block attaches anything: a block whose full descriptor set does not fit
   * in the remaining budget attaches NONE of it, and no later block
   * attaches any either. Attaching part of a block is deliberately not an
   * option — a table with gutter cells on only some rows is ragged DOM, and
   * a partially-wired block would mean the in-memory descriptor set no
   * longer matches what the DOM offers. Fail closed, all-or-nothing, in
   * document order. Reset on every `render()`.
   */
  const MAX_NESTED_TARGETS_PER_DOCUMENT = 5000;

  /**
   * Coerce a stored comment line number to a usable 1-indexed source line,
   * or null. `Number(null)` is `0` and `Number('')` is `0`, both of which
   * are finite — so a bare `Number.isFinite` check would happily report
   * "line 0" for a comment with no anchor at all. Source lines are
   * 1-indexed positive integers; anything else is genuinely unknown and
   * must be reported as such rather than displayed as a real line.
   * @param {*} value
   * @returns {number|null}
   */
  function _toSourceLine(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 ? n : null;
  }

  /**
   * Intrinsically-safe fallback for the `escapeHtmlAttribute` constructor
   * option (used only when a caller omits it — see the constructor).
   * Escapes the five characters that matter for a double-quoted HTML
   * attribute value: `&`, `<`, `>`, `"`, `'`.
   * @param {*} value
   * @returns {string}
   */
  function _defaultEscapeHtmlAttribute(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  class RenderedDocumentView {
    /**
     * The documented per-document nested-target cap, exposed for tests and
     * for any host that wants to report it. A getter (not a writable static
     * field) because the enforcement path reads the module constant
     * directly: a settable property here would look like a knob while
     * changing nothing.
     * @returns {number}
     */
    static get MAX_NESTED_TARGETS_PER_DOCUMENT() {
      return MAX_NESTED_TARGETS_PER_DOCUMENT;
    }

    /**
     * @param {object} opts
     * @param {HTMLElement} opts.container - element to render the document into
     * @param {string} opts.filePath - repository path of the document (trusted)
     * @param {string} opts.source - full markdown source (the NEW/current file content)
     * @param {string|null} [opts.patch] - unified diff patch for this file (for diff-position resolution)
     * @param {object} opts.md - a markdown-it instance (used only for token/line boundaries)
     * @param {function(string):string} opts.renderMarkdown - the established sanitized renderer (window.renderMarkdown)
     * @param {function(string):string} [opts.escapeHtmlAttribute]
     * @param {Set<string>} [opts.changedMarkdownPaths] - other markdown files changed in this review
     * @param {object} [opts.callbacks]
     * @param {function(string,(string|null)):void} [opts.callbacks.onNavigateInternalLink]
     * @param {function(object):Promise<object>} [opts.callbacks.onCreateComment] - resolves to the saved comment ({id,...})
     * @param {function(number,string):Promise<void>} [opts.callbacks.onEditComment]
     * @param {function(number):Promise<void>} [opts.callbacks.onDeleteComment]
     * @param {function():void} [opts.callbacks.onCommentsChanged] - called AFTER
     *   this view adds/removes a comment card in response to a UI action, so
     *   a host whose comment count is DOM-derived can recount once the DOM
     *   has settled (see _notifyCommentsChanged)
     */
    constructor(opts) {
      this.container = opts.container;
      this.filePath = opts.filePath;
      this.source = opts.source || '';
      this.patch = opts.patch || null;
      this.md = opts.md;
      this.renderMarkdown = opts.renderMarkdown;
      // SECURITY: default to a real attribute-escaper, not an identity
      // passthrough. This is the only thing standing between arbitrary
      // comment-body text and a live HTML attribute value (see
      // `_buildCommentCard`'s `data-original-markdown` attribute) — an
      // identity default would let comment text like `" onmouseover="...`
      // inject a live event-handler attribute for any caller that omits
      // this option (the current app supplies a real one via
      // window.escapeHtmlAttribute, but this class must not depend on that
      // as an unstated invariant).
      this.escapeHtmlAttribute = opts.escapeHtmlAttribute || _defaultEscapeHtmlAttribute;
      this.changedMarkdownPaths = opts.changedMarkdownPaths || new Set();
      this.callbacks = opts.callbacks || {};

      this.blocks = [];
      this.outline = [];
      // Line ranges of the source that belong to NO top-level block —
      // blank separator lines between blocks, plus any leading/trailing
      // blank lines, plus source markdown-it consumes without emitting a
      // token (link-reference definitions). Comments anchored there are
      // real repository comments and must not be silently dropped, nor
      // coerced onto a neighbouring heading/paragraph they were never
      // about; each gap gets its own container so such a comment displays
      // at its true position in the document with its true line numbers.
      // See _computeSourceGaps.
      this.sourceGaps = [];
      this._totalSourceLines = 0;
      this._blockElements = new Map(); // blockIndex -> wrapper element
      this._commentListElements = new Map(); // blockIndex -> .rendered-markdown-comments-list
      this._gapElements = new Map(); // gapIndex -> gap wrapper element
      this._gapListElements = new Map(); // gapIndex -> .rendered-markdown-comments-list
      // Last-resort container for comments whose line is outside this
      // document's source entirely (e.g. a comment stored against a line
      // the file no longer has). Hidden unless it holds something.
      this._orphanZone = null;
      this._orphanList = null;
      // ---- Nested (hierarchical) comment targets -----------------------
      // Trusted, in-memory descriptors for every list item / nested list
      // item / table row / header cell / data cell this document currently
      // exposes as a comment target, keyed by the descriptor's stable
      // identity string (see RenderedMarkdown.renderedAnchorKey). Target
      // coordinates are ALWAYS read from these records — never from a
      // `data-*` attribute on rendered content, which is repository
      // controlled. (The sanitizer already strips `data-*` and non-code
      // `class` attributes, but the resolution path must not depend on
      // that as an unstated invariant.)
      this._targetsByKey = new Map();
      // Nested-target budget for the CURRENT render pass (see
      // MAX_NESTED_TARGETS_PER_DOCUMENT). Both are reset by render().
      this._nestedTargetsAttached = 0;
      this._nestedTargetBudgetExhausted = false;
      // DOM element -> the same record, for the innermost-target hover
      // lookup. A Map keyed on the element object means an injected element
      // cannot impersonate a target however it is marked up.
      this._targetsByElement = new Map();
      // The single target whose affordance is currently revealed. Exactly
      // one at a time: hovering a nested item inside a list item (or a cell
      // inside a row) reveals the INNERMOST target's plus only, so the
      // reviewer is never offered several overlapping ancestors at once.
      this._activeTargetEl = null;
      // Namespaces every heading id this document assigns (see render()) so
      // two Markdown files with a same-named heading, both open in Rendered
      // mode at once, never collide on the same DOM id.
      this._headingIdPrefix = `md-heading-${getRenderedMarkdown().fileIdSlug(this.filePath)}--`;
    }

    /**
     * Parse the source and (re)build the DOM. Safe to call more than once
     * (e.g. if the underlying content is refreshed); fully replaces the
     * container's contents.
     */
    render() {
      const RM = getRenderedMarkdown();
      this.blocks = RM.splitTopLevelBlocks(this.md, this.source);
      this.outline = RM.buildOutline(this.blocks);
      const outlineByBlock = new Map(this.outline.map((o) => [o.blockIndex, o]));

      this._blockElements = new Map();
      this._commentListElements = new Map();
      this._gapElements = new Map();
      this._gapListElements = new Map();
      this._targetsByKey = new Map();
      this._targetsByElement = new Map();
      // A fresh document gets a fresh nested-target budget: this render
      // replaces the container's contents outright, so every button and
      // listener the previous pass created is gone with it.
      this._nestedTargetsAttached = 0;
      this._nestedTargetBudgetExhausted = false;
      this._activeTargetEl = null;
      this._orphanZone = null;
      this._orphanList = null;
      this.container.innerHTML = '';

      this._totalSourceLines = this._countSourceLines();
      this.sourceGaps = this._computeSourceGaps(this._totalSourceLines);

      const doc = document.createElement('div');
      doc.className = 'rendered-markdown-doc';

      if (this.blocks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'rendered-markdown-empty';
        empty.textContent = 'This file is empty.';
        doc.appendChild(empty);
      }

      // Blocks and source gaps are disjoint and together cover [1,
      // totalSourceLines], so sorting by start line yields the true source
      // order — a gap container therefore renders exactly where the
      // unrendered lines it represents sit in the document.
      const items = [
        ...this.blocks.map((block) => ({ startLine: block.startLine, block })),
        ...this.sourceGaps.map((gap) => ({ startLine: gap.startLine, gap }))
      ].sort((a, b) => a.startLine - b.startLine);

      items.forEach((item) => {
        doc.appendChild(item.block
          ? this._buildBlockElement(item.block, outlineByBlock)
          : this._buildGapElement(item.gap));
      });

      doc.appendChild(this._buildOrphanZone());
      this.container.appendChild(doc);
    }

    /**
     * Number of lines in the source, counting a trailing newline as the
     * TERMINATOR of the last line rather than the start of a new one — so
     * `"# Title\n"` is a 1-line file. This matches how git/GitHub (and
     * therefore every stored comment's `line_start`) number lines, which is
     * what makes the gap ranges below safe to compare against a comment's
     * line number.
     * @returns {number}
     * @private
     */
    _countSourceLines() {
      if (!this.source) return 0;
      const lines = this.source.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines.length;
    }

    /**
     * The complement of the top-level block ranges over
     * `[1, totalLines]` — i.e. every source line that renders as no block
     * at all. Covers all three shapes deterministically:
     *   - a LEADING gap (blank lines / front-matter-ish filler before the
     *     first block),
     *   - INTERNAL gaps (the blank separator line(s) between two blocks —
     *     by far the most common case, and the one a reviewer hits by
     *     leaving a Diff-view comment on a blank line),
     *   - a TRAILING gap (blank lines after the last block).
     * Blocks are emitted in source order by `splitTopLevelBlocks` and never
     * overlap, but `cursor` is advanced with `Math.max` so a hypothetical
     * out-of-order/overlapping block can only shrink the gap set, never
     * produce a negative-length range.
     * @param {number} totalLines
     * @returns {Array<{index:number, startLine:number, endLine:number}>}
     * @private
     */
    _computeSourceGaps(totalLines) {
      const gaps = [];
      let cursor = 1;
      for (const block of this.blocks) {
        if (block.startLine > cursor) {
          gaps.push({ index: gaps.length, startLine: cursor, endLine: block.startLine - 1 });
        }
        cursor = Math.max(cursor, block.endLine + 1);
      }
      if (totalLines >= cursor) {
        gaps.push({ index: gaps.length, startLine: cursor, endLine: totalLines });
      }
      return gaps;
    }

    /**
     * Build one top-level block's wrapper: rendered content, heading id (if
     * this block is an outline entry), internal-link interception, and its
     * own comment zone.
     * @param {object} block
     * @param {Map<number, object>} outlineByBlock
     * @returns {HTMLElement}
     * @private
     */
    _buildBlockElement(block, outlineByBlock) {
      const wrapper = document.createElement('div');
      wrapper.className = 'rendered-markdown-block';
      wrapper.dataset.blockIndex = String(block.index);
      wrapper.dataset.startLine = String(block.startLine);
      wrapper.dataset.endLine = String(block.endLine);

      const content = document.createElement('div');
      content.className = 'rendered-markdown-block-content';
      content.innerHTML = this.renderMarkdown(block.source);
      wrapper.appendChild(content);

      const outlineEntry = outlineByBlock.get(block.index);
      if (outlineEntry) {
        const headingEl = content.querySelector('h1,h2,h3,h4,h5,h6');
        if (headingEl) {
          headingEl.id = `${this._headingIdPrefix}${outlineEntry.slug}`;
          headingEl.tabIndex = -1;
          wrapper.classList.add('rendered-markdown-heading-block');
        }
      }

      this._interceptInternalLinks(content);

      const commentZone = this._buildCommentZone(block);
      wrapper.appendChild(commentZone.zone);
      this._commentListElements.set(block.index, commentZone.list);
      this._blockElements.set(block.index, wrapper);

      // Nested targets are wired AFTER the block's comment zone exists —
      // their click handlers resolve that zone's list by block index.
      this._wireNestedTargets(block, content);
      return wrapper;
    }

    /**
     * Give a block's rendered lists/tables their own per-element comment
     * targets (list item, nested list item, table row, header cell, data
     * cell) on top of the block-level target, which always remains
     * available for "the whole list/table".
     *
     * SAFETY MODEL. The descriptors come from markdown-it's token stream for
     * this block's own source; they are then PAIRED POSITIONALLY against the
     * sanitized DOM, structural element by structural element. Any
     * discrepancy — a `<ul>` the token stream doesn't know about because the
     * author wrote raw HTML, a node the sanitizer dropped, an unexpected
     * nesting — fails the whole block closed: no nested affordances at all,
     * block-level commenting unaffected. That is the only way to guarantee a
     * descriptor is never attached to an element it does not describe, which
     * would silently mis-report what a reviewer commented on.
     *
     * BUDGET. Bounded per document by MAX_NESTED_TARGETS_PER_DOCUMENT: a
     * block whose descriptors do not fit in what is left attaches none of
     * them, and no later block attaches any either (see the constant for
     * why all-or-nothing, and why block-level targets are untouched).
     * @param {object} block
     * @param {HTMLElement} content - the block's rendered content element
     * @private
     */
    _wireNestedTargets(block, content) {
      // Only these top-level block types can contain a list item, row or
      // cell. Skipping the rest avoids an extra markdown-it parse for every
      // heading, paragraph and code fence in the document — which is the
      // overwhelming majority of blocks, and the per-block work the
      // large-file ceiling in pr.js exists to bound.
      if (!NESTABLE_BLOCK_TYPES.has(block.type)) return;
      // Budget already spent by an earlier block in this same render: skip
      // the markdown-it re-parse too, not just the attachment.
      if (this._nestedTargetBudgetExhausted) return;

      const RM = getRenderedMarkdown();
      if (typeof RM.buildNestedTargets !== 'function') return;
      const tree = RM.buildNestedTargets(this.md, block.source, block.startLine);
      if (!tree) return;

      const pairs = [];
      if (!this._pairStructuralNodes(tree.root, content, pairs, RM.STRUCTURAL_TAGS)) return;

      // All-or-nothing: count this block's descriptors BEFORE attaching any
      // of them, so the cap can never split a single list/table into a
      // partly-wired shape whose DOM and descriptor set disagree.
      let wanted = 0;
      for (const pair of pairs) if (pair.node.descriptor) wanted++;
      if (wanted === 0) return;
      if (this._nestedTargetsAttached + wanted > MAX_NESTED_TARGETS_PER_DOCUMENT) {
        this._nestedTargetBudgetExhausted = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[RenderedDocumentView] ${this.filePath}: nested comment target cap `
          + `(${MAX_NESTED_TARGETS_PER_DOCUMENT}) reached; the rest of this document `
          + 'keeps block-level commenting only.'
        );
        return;
      }

      let attached = 0;
      for (const pair of pairs) {
        if (!pair.node.descriptor) continue;
        if (this._attachTargetAffordance(block, pair.node.descriptor, pair.element)) attached++;
      }
      // Count what was ACTUALLY attached (a duplicate-key descriptor is
      // refused and costs nothing), so the budget matches the real number
      // of buttons/listeners/tab stops in the document.
      this._nestedTargetsAttached += attached;
      if (attached > 0) this._wireTargetHoverTracking(content);
    }

    /**
     * Positionally pair a token-derived structural subtree against the
     * corresponding DOM subtree, collecting `{node, element}` pairs.
     * Returns false (and leaves `out` to be discarded by the caller) on the
     * first structural disagreement.
     *
     * Only DIRECT structural children are paired, which is exactly how
     * markdown-it emits them (`ul > li`, `li > ul`, `table > thead > tr >
     * th`). A structural element buried deeper (only reachable through raw
     * HTML inside a paragraph) is therefore never paired and never becomes
     * a target — again, fail closed.
     * @param {object} tokenNode
     * @param {HTMLElement} domEl
     * @param {Array<{node:object, element:HTMLElement}>} out
     * @param {Set<string>} structuralTags
     * @returns {boolean}
     * @private
     */
    _pairStructuralNodes(tokenNode, domEl, out, structuralTags) {
      const tokenChildren = tokenNode.children || [];
      const domChildren = Array.from(domEl.children || []).filter(
        (el) => structuralTags.has(el.tagName.toLowerCase())
      );
      if (domChildren.length !== tokenChildren.length) return false;
      for (let i = 0; i < tokenChildren.length; i++) {
        const node = tokenChildren[i];
        const element = domChildren[i];
        if (element.tagName.toLowerCase() !== node.tag) return false;
        out.push({ node, element });
        if (!this._pairStructuralNodes(node, element, out, structuralTags)) return false;
      }
      return true;
    }

    /**
     * Attach one nested target's affordance (plus button + comment-count
     * badge) to its DOM element and register the trusted descriptor record.
     *
     * DOM VALIDITY. A `<tr>` may only contain `<td>`/`<th>`, so a row's
     * affordance goes into a dedicated trailing gutter cell rather than
     * being injected straight under the row — nothing is ever added
     * directly under `table`, `tr`, `ul` or `ol`. List items and cells
     * accept flow content, so their affordance is appended in place.
     * @param {object} block
     * @param {object} anchor - descriptor from buildNestedTargets
     * @param {HTMLElement} element
     * @returns {boolean} whether an affordance was attached
     * @private
     */
    _attachTargetAffordance(block, anchor, element) {
      const RM = getRenderedMarkdown();
      const key = RM.renderedAnchorKey(anchor);
      // Descriptors are unique by construction (ordinal is assigned per
      // kind+line); a collision would mean two elements answering to one
      // stored anchor, so refuse the second rather than make the mapping
      // ambiguous.
      if (this._targetsByKey.has(key)) return false;

      const description = RM.describeRenderedTarget(anchor);
      const tag = element.tagName.toLowerCase();

      const affordance = document.createElement('span');
      affordance.className = 'rendered-markdown-target-affordance';

      const badge = document.createElement('span');
      badge.className = 'rendered-markdown-target-badge';
      badge.hidden = true;
      // Decorative: a bare number on a generic element is announced
      // inconsistently. The count is carried in the adjacent button's
      // accessible name instead (see `_syncTargetBadges`).
      badge.setAttribute('aria-hidden', 'true');
      affordance.appendChild(badge);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rendered-markdown-add-comment-btn rendered-markdown-target-btn';
      button.title = `Add comment on ${description}`;
      button.setAttribute('aria-label', `Add comment on ${description}`);
      button.innerHTML = ADD_COMMENT_ICON_SVG;
      const record = { anchor, key, description, blockIndex: block.index, element, badge, button };
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const list = this._commentListElements.get(block.index);
        if (!list) return;
        this._showCommentForm(block, list, button, record);
      });
      affordance.appendChild(button);

      element.classList.add('rendered-markdown-target');
      if (tag === 'tr') {
        const gutter = document.createElement('td');
        gutter.className = 'rendered-markdown-row-gutter';
        // ACCESSIBILITY: this cell is pure UI chrome, not table data. Left
        // as a real `td` it would make every row report one more column
        // than the header describes, so AT announces a header-less trailing
        // column on every single row. `role="presentation"` removes the
        // CELL from the table's structure while leaving its contents in the
        // accessibility tree — presentation is NOT inherited by focusable
        // descendants, so the add-comment button keeps its own button role,
        // its `aria-label` and its tab stop. (`aria-hidden` would be wrong
        // here: it would hide the button itself, making the row target
        // unreachable for screen-reader users.)
        gutter.setAttribute('role', 'presentation');
        gutter.appendChild(affordance);
        element.appendChild(gutter);
      } else {
        element.appendChild(affordance);
      }

      this._targetsByKey.set(key, record);
      this._targetsByElement.set(element, record);
      return true;
    }

    /**
     * Track the INNERMOST target under the pointer / keyboard focus within a
     * block, revealing that one target's affordance and no other.
     *
     * This is what keeps overlapping hierarchies unambiguous: hovering a
     * nested list item reveals the nested item's plus (not its parent
     * item's, not the list's); hovering a table cell reveals the cell's (not
     * the row's — the row's own plus lives in the row gutter, which is not
     * inside any cell). The block-level plus sits outside the rendered
     * content entirely, in the block's comment zone, and stays the way to
     * comment on the whole list/table.
     * A `pointerdown` path is wired alongside the mouse/focus ones so the
     * nested affordances are REACHABLE on a pointer with no hover state at
     * all (touch, stylus): there, tapping the item/row/cell activates it and
     * reveals exactly that one plus, which the reviewer then taps. Without
     * it a touch user could only ever comment at block level. Still exactly
     * one target at a time — `pointerdown` resolves the innermost target
     * through the same `_findTargetElement` lookup as hover and focus, so
     * the "no stack of ancestor affordances" guarantee is unchanged. (For a
     * mouse this is a harmless no-op: `mouseover` has already set the same
     * target.)
     * @param {HTMLElement} content
     * @private
     */
    _wireTargetHoverTracking(content) {
      content.addEventListener('mouseover', (event) => {
        this._setActiveTarget(this._findTargetElement(event.target, content));
      });
      content.addEventListener('pointerdown', (event) => {
        this._setActiveTarget(this._findTargetElement(event.target, content));
      });
      content.addEventListener('mouseleave', () => this._setActiveTarget(null));
      content.addEventListener('focusin', (event) => {
        this._setActiveTarget(this._findTargetElement(event.target, content));
      });
      content.addEventListener('focusout', (event) => {
        if (!event.relatedTarget || !content.contains(event.relatedTarget)) {
          this._setActiveTarget(null);
        }
      });
    }

    /**
     * The nearest registered target element at or above `node`, stopping at
     * the block content root. Membership is tested against the in-memory
     * element Map, so rendered repository content cannot present itself as
     * a target.
     * @param {Node} node
     * @param {HTMLElement} root
     * @returns {HTMLElement|null}
     * @private
     */
    _findTargetElement(node, root) {
      let current = node && node.nodeType === 3 ? node.parentElement : node;
      while (current && current !== root) {
        if (this._targetsByElement.has(current)) return current;
        current = current.parentElement;
      }
      return null;
    }

    /**
     * Reveal exactly one nested affordance (or none).
     * @param {HTMLElement|null} element
     * @private
     */
    _setActiveTarget(element) {
      if (this._activeTargetEl === element) return;
      if (this._activeTargetEl) this._activeTargetEl.classList.remove('is-target-active');
      this._activeTargetEl = element || null;
      if (this._activeTargetEl) this._activeTargetEl.classList.add('is-target-active');
    }

    /**
     * Build the container for one source gap. Deliberately has NO "Add
     * comment" button: there is no rendered content here to comment on, so
     * Rendered mode never CREATES a gap-anchored comment — this container
     * exists only to DISPLAY comments that already exist (left from the
     * Diff view, or by another client) at their honest position, and it
     * stays `hidden` until one lands in it so an ordinary document is
     * visually unchanged.
     * @param {{index:number, startLine:number, endLine:number}} gap
     * @returns {HTMLElement}
     * @private
     */
    _buildGapElement(gap) {
      const wrapper = document.createElement('div');
      wrapper.className = 'rendered-markdown-gap';
      wrapper.dataset.gapIndex = String(gap.index);
      wrapper.dataset.startLine = String(gap.startLine);
      wrapper.dataset.endLine = String(gap.endLine);
      wrapper.hidden = true;

      const note = document.createElement('div');
      note.className = 'rendered-markdown-gap-note';
      note.textContent = gap.startLine === gap.endLine
        ? `Line ${gap.startLine} — no rendered content on this line`
        : `Lines ${gap.startLine}–${gap.endLine} — no rendered content on these lines`;
      wrapper.appendChild(note);

      const list = document.createElement('div');
      list.className = 'rendered-markdown-comments-list';
      wrapper.appendChild(list);

      this._gapElements.set(gap.index, wrapper);
      this._gapListElements.set(gap.index, list);
      return wrapper;
    }

    /**
     * Build the document-level fallback zone for comments whose line isn't
     * in this document's source at all (0/negative/NaN, or past the last
     * line — e.g. a comment stored against a line a later commit removed).
     * Hidden until used.
     * @returns {HTMLElement}
     * @private
     */
    _buildOrphanZone() {
      const zone = document.createElement('div');
      zone.className = 'rendered-markdown-orphan-comments';
      zone.hidden = true;

      const note = document.createElement('div');
      note.className = 'rendered-markdown-gap-note';
      note.textContent = 'Comments anchored outside this file’s current content';
      zone.appendChild(note);

      const list = document.createElement('div');
      list.className = 'rendered-markdown-comments-list';
      zone.appendChild(list);

      this._orphanZone = zone;
      this._orphanList = list;
      return zone;
    }

    /**
     * Rewrite same-document and cross-file relative links to safe internal
     * navigation, leaving external/unrelated links untouched.
     * @param {HTMLElement} content
     * @private
     */
    _interceptInternalLinks(content) {
      const RM = getRenderedMarkdown();
      const anchors = content.querySelectorAll('a[href]');
      anchors.forEach((anchor) => {
        const href = anchor.getAttribute('href');
        const resolved = RM.resolveInternalLink(href, this.filePath, this.changedMarkdownPaths);
        if (!resolved) return;

        anchor.classList.add('rendered-markdown-internal-link');
        anchor.removeAttribute('target');
        anchor.setAttribute('rel', 'noopener noreferrer');
        anchor.addEventListener('click', (e) => {
          e.preventDefault();
          if (this.callbacks.onNavigateInternalLink) {
            this.callbacks.onNavigateInternalLink(resolved.targetPath, resolved.fragment);
          }
        });
      });
    }

    /**
     * Scroll a heading into view and briefly focus it (for a11y: screen
     * readers announce the new focus target). No-op if the slug is unknown.
     * @param {string} slug
     */
    scrollToHeading(slug) {
      const headingEl = this.container.querySelector(`#${cssEscape(`${this._headingIdPrefix}${slug}`)}`);
      if (!headingEl) return false;
      headingEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      headingEl.focus({ preventScroll: true });
      return true;
    }

    /**
     * Recover the bare (un-namespaced) heading slug from a DOM id this
     * document assigned via `render()`, or null if `id` doesn't belong to
     * this document (e.g. it belongs to a different Rendered document's
     * heading). Used by the Outline scroll-spy in pr.js so it doesn't need
     * to know this document's id-namespacing scheme.
     * @param {string} id
     * @returns {string|null}
     */
    slugFromHeadingId(id) {
      if (typeof id !== 'string' || !id.startsWith(this._headingIdPrefix)) return null;
      return id.slice(this._headingIdPrefix.length);
    }

    /**
     * Build the (initially empty) comment zone for a block: a list
     * container plus a hover-revealed "Add comment" button.
     * @param {object} block
     * @returns {{zone:HTMLElement, list:HTMLElement}}
     * @private
     */
    _buildCommentZone(block) {
      const zone = document.createElement('div');
      zone.className = 'rendered-markdown-comments';

      const list = document.createElement('div');
      list.className = 'rendered-markdown-comments-list';
      zone.appendChild(list);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'rendered-markdown-add-comment-btn rendered-markdown-block-btn';
      const blockLabel = this._blockTargetLabel(block);
      addBtn.title = blockLabel;
      addBtn.setAttribute('aria-label', blockLabel);
      addBtn.innerHTML = ADD_COMMENT_ICON_SVG;
      addBtn.addEventListener('click', () => this._showCommentForm(block, list, addBtn, null));
      zone.appendChild(addBtn);

      return { zone, list };
    }

    /**
     * Accessible name for a block's own (container-level) add-comment
     * button: the block's semantic KIND plus its real source line range.
     *
     * Every top-level target gets a kind, not just the ones that also expose
     * nested targets — without it a screen-reader user tabbing the document
     * hears only "Add comment on line 3", "Add comment on line 5", with no
     * indication of whether the target is a heading, a paragraph, a code
     * fence or a blockquote. For a list, a table or a blockquote the label
     * says "the whole ..." because those are exactly the blocks that ALSO
     * expose nested item/row/cell targets, and the reviewer must be able to
     * tell which scope they are about to comment on.
     * @param {object} block
     * @returns {string}
     * @private
     */
    _blockTargetLabel(block) {
      const lines = block.endLine > block.startLine
        ? `lines ${block.startLine}-${block.endLine}`
        : `line ${block.startLine}`;
      const kind = BLOCK_TARGET_LABELS[block.type] || BLOCK_TARGET_FALLBACK_LABEL;
      return `Add comment on ${kind}, ${lines}`;
    }

    /**
     * Show the inline "new comment" form for a block or for one of its
     * nested targets.
     *
     * Nested-target forms and cards live in the BLOCK's comment list, not
     * inside the list item / row / cell itself: a comment card is flow
     * content that cannot legally sit under `tr`, and dropping one into a
     * table cell would also wreck the table's layout. The form and the
     * resulting card instead name their exact target, and the target
     * element itself carries a comment-count badge — see
     * `_syncTargetBadges`.
     * @param {object} block
     * @param {HTMLElement} list
     * @param {HTMLElement} [triggerEl] - the "Add comment" button that
     *   opened this form; keyboard focus is restored to it when the form is
     *   dismissed via Cancel or Escape without saving, so a keyboard-only
     *   reviewer doesn't lose their place in the document.
     * @param {object|null} [targetRecord] - nested target record, or null
     *   for the block-level (whole heading/paragraph/list/table) target
     * @private
     */
    _showCommentForm(block, list, triggerEl, targetRecord) {
      const targetKey = targetRecord ? targetRecord.key : 'block';
      const existing = list.querySelector('.rendered-markdown-comment-form');
      if (existing) {
        // Same target: this is a repeat click — just return to the form.
        // DIFFERENT target: the reviewer has changed their mind about what
        // they are commenting on, so the open form is replaced rather than
        // silently retargeted (which would attach their text to whichever
        // element they clicked first).
        if (existing.dataset.targetKey === targetKey) {
          existing.querySelector('textarea')?.focus();
          return;
        }
        existing.remove();
      }

      const RM = getRenderedMarkdown();
      const startLine = targetRecord ? targetRecord.anchor.startLine : block.startLine;
      const endLine = targetRecord ? targetRecord.anchor.endLine : block.endLine;
      const target = RM.resolveCommentTarget({ patch: this.patch, startLine, endLine });

      const form = document.createElement('div');
      form.className = 'rendered-markdown-comment-form';
      form.dataset.targetKey = targetKey;
      const targetNoteHtml = targetRecord
        ? `<div class="rendered-markdown-comment-target">Commenting on ${this.escapeHtmlAttribute(targetRecord.description)}</div>`
        : '';
      form.innerHTML = `
        ${targetNoteHtml}
        ${target.inDiff ? '' : '<div class="rendered-markdown-context-note">Outside changed lines — will be submitted as a file comment referencing this range.</div>'}
        <textarea class="rendered-markdown-comment-textarea" placeholder="Write a comment... (Ctrl+Enter to save)"></textarea>
        <div class="rendered-markdown-comment-form-footer">
          <button type="button" class="rendered-markdown-comment-btn submit" disabled>Save</button>
          <button type="button" class="rendered-markdown-comment-btn cancel">Cancel</button>
        </div>
      `;
      list.appendChild(form);

      const textarea = form.querySelector('textarea');
      const submitBtn = form.querySelector('.submit');
      const cancelBtn = form.querySelector('.cancel');

      textarea.focus();
      if (isBrowser && window.emojiPicker) {
        window.emojiPicker.attach(textarea);
      }

      textarea.addEventListener('input', () => {
        submitBtn.disabled = !textarea.value.trim();
      });
      const dismiss = () => {
        form.remove();
        triggerEl?.focus();
      };
      // Both entry paths funnel through the SAME call, and `_submitComment`
      // owns the single duplicate-submit guard — Ctrl/Cmd+Enter bypasses the
      // button's `disabled` attribute entirely, so a guard living only on
      // the button would not stop a second keyboard submit landing while the
      // first POST is still in flight.
      const trySubmit = () => {
        const value = textarea.value.trim();
        if (!value) return;
        this._submitComment(block, target, value, form, targetRecord);
      };
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          dismiss();
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          trySubmit();
        }
      });
      cancelBtn.addEventListener('click', dismiss);
      submitBtn.addEventListener('click', trySubmit);
    }

    /**
     * Persist a new comment through the host, then render its card.
     *
     * `rendered_anchor` is LOCAL display metadata only: it records which
     * nested element the reviewer picked so the comment can return to it
     * after a reload. The GitHub-facing contract is unchanged and remains
     * exactly `file` + `side` + `line_start`/`line_end` + `diff_position`,
     * all resolved from the target's real source line range — a table cell
     * submits at its row's line, never at a fabricated column coordinate.
     * @param {object} block
     * @param {object} target - resolved line/diff coordinates
     * @param {string} body
     * @param {HTMLElement} form
     * @param {object|null} [targetRecord] - nested target, if any
     * @private
     */
    async _submitComment(block, target, body, form, targetRecord) {
      // Duplicate-submit guard. The reviewer can reach this twice for ONE
      // intended comment: a fast double-click on Save, or Ctrl/Cmd+Enter
      // pressed twice (which does not respect the button's `disabled`
      // attribute), both before the create POST resolves. Two POSTs mean two
      // stored comments and two cards for one action. The flag lives on the
      // form element so it is torn down with the form on success, and is
      // cleared again on failure so a retry is possible.
      if (form.dataset.submitting === 'true') return;
      form.dataset.submitting = 'true';
      const submitBtn = form.querySelector('.submit');
      if (submitBtn) submitBtn.disabled = true;
      try {
        if (!this.callbacks.onCreateComment) throw new Error('No comment handler configured');
        const comment = await this.callbacks.onCreateComment({
          file: this.filePath,
          side: target.side,
          line_start: target.line_start,
          line_end: target.line_end,
          diff_position: target.diff_position,
          rendered_anchor: targetRecord ? { ...targetRecord.anchor } : null,
          body
        });
        form.remove();
        this.addComment(comment);
        this._notifyCommentsChanged();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Error saving rendered-markdown comment:', error);
        if (isBrowser && window.toast) {
          window.toast.showError('Failed to save comment');
        }
        // Re-enable BOTH halves of the retry state: the button and the
        // duplicate-submit flag. Leaving the flag set would make the form
        // permanently inert after one transient failure.
        delete form.dataset.submitting;
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    /**
     * Find which block (if any) contains a given 1-indexed line.
     * @param {number} line
     * @returns {object|null}
     */
    findBlockForLine(line) {
      return this.blocks.find((b) => line >= b.startLine && line <= b.endLine) || null;
    }

    /**
     * Find the source gap (if any) containing a given 1-indexed line.
     * @param {number} line
     * @returns {object|null}
     */
    findGapForLine(line) {
      return this.sourceGaps.find((g) => line >= g.startLine && line <= g.endLine) || null;
    }

    /**
     * Decide WHERE a comment's card belongs, and be honest about it. Four
     * outcomes, in strict precedence order:
     *   0. `target` — the comment carries a VALID rendered anchor that still
     *      resolves to a nested target present in the current document (a
     *      list item, a table row, an exact cell). The card goes in that
     *      target's block zone, labelled with the target, and the target
     *      element itself gets a comment badge. This is the only case that
     *      can tell two comments on two cells of one source line apart.
     *   1. `block` — the line is inside a rendered top-level block. The
     *      card goes in that block's comment zone (the normal case, and the
     *      unchanged behavior for every comment predating nested anchors).
     *   2. `gap`   — the line is a real line of this file that renders as
     *      no block (a blank separator line, leading/trailing blank lines,
     *      a link-reference definition). The card goes in that gap's own
     *      container, in source order, labelled with its real line range.
     *      It is NOT attached to the neighbouring heading/paragraph, which
     *      would silently claim the reviewer commented on content they
     *      never saw.
     *   3. `orphan` — the line isn't in this file's source at all. The card
     *      goes in the document-level fallback zone, still labelled with
     *      its real stored line number.
     * Every case resolves to a container, so no comment is ever silently
     * dropped from the Rendered view.
     *
     * A comment whose anchor is malformed, of an unknown version, or no
     * longer matches any target (the content moved or changed) falls
     * through to 1/2/3 — its honest line area — and is labelled as such. It
     * is NEVER re-pointed at a neighbouring item/row/cell: "close enough"
     * would misattribute a reviewer's words to content they didn't read.
     * @param {object} comment
     * @returns {{kind:string, list:HTMLElement|null, wrapper:HTMLElement|null,
     *   targetKey?:string, targetLabel?:string, staleAnchor?:object}}
     * @private
     */
    _resolveCommentContainer(comment) {
      const RM = getRenderedMarkdown();
      const rawAnchor = comment ? comment.rendered_anchor : null;
      const anchor = rawAnchor == null || typeof RM.normalizeRenderedAnchor !== 'function'
        ? null
        : RM.normalizeRenderedAnchor(rawAnchor);
      if (anchor) {
        const key = RM.renderedAnchorKey(anchor);
        const record = this._targetsByKey.get(key);
        if (record) {
          const list = this._commentListElements.get(record.blockIndex);
          if (list) {
            return {
              kind: 'target',
              list,
              wrapper: this._blockElements.get(record.blockIndex) || null,
              targetKey: key,
              targetLabel: record.description
            };
          }
        }
      }
      // Reaching here with a readable anchor means it did not resolve to a
      // live target. That does NOT mean the element is gone: the anchor's
      // line numbers are absolute source lines, so inserting or removing a
      // single line ABOVE an otherwise-untouched list or table shifts every
      // descendant target's range and misses the anchor. Saying "no longer
      // in this file" in that (common) case is alarming and factually
      // wrong. State only what is actually known — the target the reviewer
      // picked can't be identified in the current content — and name the
      // honest line the comment came from.
      const fallback = this._resolveLineContainer(comment ? comment.line_start : null);
      if (anchor) {
        fallback.staleAnchor = anchor;
        fallback.targetLabel =
          `${RM.describeRenderedTarget(anchor)} — this target changed or is unavailable; `
          + `shown at its original ${this._formatLineRange(comment).toLowerCase()}`;
      }
      return fallback;
    }

    /**
     * The line-based half of `_resolveCommentContainer` (block -> gap ->
     * orphan). Split out so the nested-anchor path above can reuse it
     * verbatim as its fallback, guaranteeing a stale anchor lands exactly
     * where the same comment would have landed with no anchor at all.
     * @param {*} rawLine - comment.line_start as stored
     * @returns {{kind:string, list:HTMLElement|null, wrapper:HTMLElement|null}}
     * @private
     */
    _resolveLineContainer(rawLine) {
      const line = _toSourceLine(rawLine);
      if (line != null) {
        const block = this.findBlockForLine(line);
        if (block) {
          const list = this._commentListElements.get(block.index);
          if (list) return { kind: 'block', list, wrapper: this._blockElements.get(block.index) || null };
        }
        const gap = this.findGapForLine(line);
        if (gap) {
          const list = this._gapListElements.get(gap.index);
          if (list) return { kind: 'gap', list, wrapper: this._gapElements.get(gap.index) || null };
        }
      }
      return { kind: 'orphan', list: this._orphanList, wrapper: this._orphanZone };
    }

    /**
     * Every comment list in this document — block zones, gap containers,
     * and the orphan fallback zone.
     * @returns {HTMLElement[]}
     * @private
     */
    _allCommentLists() {
      const lists = [
        ...this._commentListElements.values(),
        ...this._gapListElements.values()
      ];
      if (this._orphanList) lists.push(this._orphanList);
      return lists;
    }

    /**
     * Hide every gap/orphan container that currently holds no comment card,
     * and show every one that does. Blocks are unaffected (they are always
     * visible — they are the document). Called after any bulk or single
     * add/remove so the document only grows these extra containers while
     * they actually carry feedback.
     * @private
     */
    _syncFallbackVisibility() {
      const sync = (wrapper, list) => {
        if (!wrapper || !list) return;
        wrapper.hidden = list.querySelector('.rendered-markdown-comment-card') === null;
      };
      for (const [index, wrapper] of this._gapElements) {
        sync(wrapper, this._gapListElements.get(index));
      }
      sync(this._orphanZone, this._orphanList);
    }

    /**
     * Replace the full set of displayed comments for this document. Only
     * active, non-file-level comments for this file should be passed in
     * (file-level comments are shown by the existing file-comments-zone,
     * above the rendered document; the caller filters — see
     * PRManager._isRenderableComment).
     * @param {Array<object>} comments
     */
    setComments(comments) {
      for (const list of this._allCommentLists()) {
        list.querySelectorAll('.rendered-markdown-comment-card').forEach((el) => el.remove());
      }
      (comments || []).forEach((comment) => this.addComment(comment, { skipMissing: true, deferSync: true }));
      this._syncFallbackVisibility();
      this._syncTargetBadges();
    }

    /**
     * Render a single comment card into whichever container owns its line
     * (see `_resolveCommentContainer`).
     * @param {object} comment
     * @param {object} [opts]
     * @param {boolean} [opts.skipMissing] - suppress the console warning for a
     *   comment that lands in the orphan fallback zone (bulk load). The
     *   comment is DISPLAYED either way — this only controls the log.
     * @param {boolean} [opts.deferSync] - skip the per-card badge resync
     *   (bulk load does one resync at the end).
     */
    addComment(comment, opts = {}) {
      if (!comment) return;
      // Idempotent by comment id. `_submitComment` awaits the host's create
      // (which itself awaits `ensureLinesVisible`) before adding its card,
      // so a host-driven refresh — `loadUserComments()`, another client's
      // websocket event, `registerCreatedUserComment` — can land in that
      // window and render this comment first. Adding it again would leave
      // TWO cards for one comment (and a badge counting it twice) until the
      // next full reload. Comments with DIFFERENT ids on the same target are
      // untouched by this: the check is by id, not by target.
      if (comment.id != null && this._findCommentCards(comment.id).length > 0) return;
      const target = this._resolveCommentContainer(comment);
      if (!target.list) return;

      if (target.kind === 'orphan' && !opts.skipMissing) {
        // eslint-disable-next-line no-console
        console.warn('[RenderedDocumentView] comment line is outside this document\'s source:', comment);
      }

      // Off-block cards carry their real line range in the card itself:
      // without the surrounding prose to give them context, the line
      // number is the only honest anchor the reviewer has. A card whose
      // nested anchor no longer resolves shows it too, alongside the
      // "target changed or is unavailable" note — its line is exactly what
      // it fell back to.
      const card = this._buildCommentCard(comment, {
        // An unresolved-anchor card ALWAYS shows its line range, even
        // inside a block: the target the reviewer picked can't be
        // identified, so the line is the only anchor left that is true.
        showLineMeta: (target.kind !== 'block' && target.kind !== 'target') || !!target.staleAnchor,
        targetLabel: target.targetLabel || null,
        staleTarget: !!target.staleAnchor
      });
      if (target.targetKey) card.dataset.renderedTargetKey = target.targetKey;
      const form = target.list.querySelector('.rendered-markdown-comment-form');
      if (form) target.list.insertBefore(card, form);
      else target.list.appendChild(card);

      if (target.wrapper && target.kind !== 'block' && target.kind !== 'target') {
        target.wrapper.hidden = false;
      }
      if (!opts.deferSync) this._syncTargetBadges();
    }

    /**
     * Every comment card in this document currently rendered for `commentId`.
     * Compares the `data-comment-id` dataset VALUE rather than interpolating
     * the id into an attribute selector, so an id that is not a bare number
     * (or that contains a quote) can neither throw a selector `SyntaxError`
     * nor match an unintended node.
     * @param {number|string} commentId
     * @returns {HTMLElement[]}
     * @private
     */
    _findCommentCards(commentId) {
      const wanted = String(commentId);
      return Array.from(this.container.querySelectorAll('.rendered-markdown-comment-card'))
        .filter((el) => el.dataset.commentId === wanted);
    }

    /**
     * Remove a comment card by id.
     * @param {number} commentId
     */
    removeComment(commentId) {
      this._findCommentCards(commentId).forEach((el) => el.remove());
      this._syncFallbackVisibility();
      this._syncTargetBadges();
    }

    /**
     * Refresh every nested target's comment-count badge from the cards
     * currently in the DOM.
     *
     * The badge is what makes a nested comment visibly belong to its exact
     * element: the card itself lives in the block's comment zone (a card
     * cannot legally sit under a `tr`, and would destroy a table's layout
     * inside a cell), so without the badge the cell/row/item would give no
     * sign that it carries feedback. Counting from the DOM — rather than a
     * parallel tally — means the badges cannot drift out of step with the
     * cards after any add/remove/refresh path.
     * @private
     */
    _syncTargetBadges() {
      if (!this._targetsByKey || this._targetsByKey.size === 0) return;
      const counts = new Map();
      this.container
        .querySelectorAll('.rendered-markdown-comment-card[data-rendered-target-key]')
        .forEach((card) => {
          const key = card.dataset.renderedTargetKey;
          counts.set(key, (counts.get(key) || 0) + 1);
        });

      for (const [key, record] of this._targetsByKey) {
        const count = counts.get(key) || 0;
        record.badge.hidden = count === 0;
        record.badge.textContent = count > 0 ? String(count) : '';
        record.element.classList.toggle('has-comments', count > 0);
        // The count reaches assistive tech through the button's name, since
        // the badge itself is aria-hidden.
        const label = count > 0
          ? `Add comment on ${record.description} (${count} comment${count === 1 ? '' : 's'})`
          : `Add comment on ${record.description}`;
        record.button.setAttribute('aria-label', label);
        record.button.title = label;
      }
    }

    /**
     * @param {object} comment
     * @param {object} [opts]
     * @param {boolean} [opts.showLineMeta] - render the comment's real
     *   repository line range in the card header. Used for cards that sit
     *   outside any rendered block (gap / orphan containers), where the
     *   line number is the reviewer's only anchor.
     * @param {string|null} [opts.targetLabel] - the nested target this
     *   comment belongs to (or why its target could not be found).
     * @param {boolean} [opts.staleTarget] - the label above describes a
     *   target that no longer exists; style it as a warning.
     * @private
     */
    _buildCommentCard(comment, opts = {}) {
      const card = document.createElement('div');
      const isAIOrigin = !!comment.parent_id;
      card.className = `rendered-markdown-comment-card ${isAIOrigin ? 'comment-ai-origin' : 'comment-user-origin'}`;
      card.dataset.commentId = String(comment.id);

      const icon = isAIOrigin
        ? (isBrowser && window.CommentManager ? window.CommentManager.AI_ICON_SVG : '')
        : (isBrowser && window.CommentManager ? window.CommentManager.PERSON_ICON_SVG : '');

      const renderedBody = this.renderMarkdown(comment.body);
      // Escaped, never interpolated raw: comment.line_start/line_end come
      // from the API, but this string lands in innerHTML like every other
      // value here, so it goes through the same attribute escaper.
      const lineMetaHtml = opts.showLineMeta
        ? `<span class="rendered-markdown-comment-lines">${this.escapeHtmlAttribute(this._formatLineRange(comment))}</span>`
        : '';
      // Target labels are built by this module from validated descriptors,
      // never from stored free text — but they go through the same escaper
      // as everything else that lands in innerHTML here.
      const targetHtml = opts.targetLabel
        ? `<span class="rendered-markdown-comment-target${opts.staleTarget ? ' is-stale' : ''}">${this.escapeHtmlAttribute(opts.targetLabel)}</span>`
        : '';

      card.innerHTML = `
        <div class="rendered-markdown-comment-header">
          <span class="comment-origin-icon">${icon}</span>
          ${targetHtml}
          ${lineMetaHtml}
          <div class="rendered-markdown-comment-actions">
            <button type="button" class="rendered-markdown-comment-edit" title="Edit comment">Edit</button>
            <button type="button" class="rendered-markdown-comment-delete" title="Delete comment">Delete</button>
          </div>
        </div>
        <div class="rendered-markdown-comment-body" data-original-markdown="${this.escapeHtmlAttribute(comment.body)}">${renderedBody}</div>
      `;

      card.querySelector('.rendered-markdown-comment-edit').addEventListener('click', () => this._editComment(card, comment));
      card.querySelector('.rendered-markdown-comment-delete').addEventListener('click', () => this._deleteComment(card, comment));

      return card;
    }

    /**
     * @private
     */
    _editComment(card, comment) {
      const editTriggerBtn = card.querySelector('.rendered-markdown-comment-edit');
      const bodyEl = card.querySelector('.rendered-markdown-comment-body');
      const original = bodyEl.dataset.originalMarkdown || comment.body;
      bodyEl.innerHTML = `
        <textarea class="rendered-markdown-comment-textarea">${this._escapeForTextarea(original)}</textarea>
        <div class="rendered-markdown-comment-form-footer">
          <button type="button" class="rendered-markdown-comment-btn submit">Save</button>
          <button type="button" class="rendered-markdown-comment-btn cancel">Cancel</button>
        </div>
      `;
      const textarea = bodyEl.querySelector('textarea');
      textarea.focus();
      // Restore both the rendered body AND keyboard focus to the "Edit"
      // button that opened this form — otherwise a keyboard-only reviewer
      // who cancels/Escapes loses their place (the textarea it was on no
      // longer exists once bodyEl.innerHTML is replaced back to rendered
      // markdown).
      const restore = () => {
        bodyEl.innerHTML = this.renderMarkdown(original);
        bodyEl.dataset.originalMarkdown = original;
        editTriggerBtn?.focus();
      };
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') restore();
      });
      bodyEl.querySelector('.cancel').addEventListener('click', restore);
      bodyEl.querySelector('.submit').addEventListener('click', async () => {
        const newBody = textarea.value.trim();
        if (!newBody) return;
        try {
          await this.callbacks.onEditComment?.(comment.id, newBody);
          comment.body = newBody;
          bodyEl.innerHTML = this.renderMarkdown(newBody);
          bodyEl.dataset.originalMarkdown = newBody;
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('Error editing rendered-markdown comment:', error);
          if (isBrowser && window.toast) window.toast.showError('Failed to update comment');
        }
      });
    }

    /**
     * @private
     */
    async _deleteComment(card, comment) {
      // Double-activation guard: a fast double-click (or Enter+click) on
      // Delete would fire a second DELETE for a comment the first request
      // already removed, which 404s and shows a false "Failed to delete
      // comment" error for an operation that actually succeeded.
      if (card.dataset.deleting === 'true') return;
      card.dataset.deleting = 'true';
      const deleteBtn = card.querySelector('.rendered-markdown-comment-delete');
      if (deleteBtn) deleteBtn.disabled = true;
      try {
        await this.callbacks.onDeleteComment?.(comment.id);
        card.remove();
        // The card may have been the only occupant of a gap/orphan
        // container — collapse it again rather than leaving an empty
        // "Lines X–Y — no rendered content" note behind. Same for a nested
        // target's badge, which must not keep claiming a comment count the
        // reviewer just removed.
        this._syncFallbackVisibility();
        this._syncTargetBadges();
        this._notifyCommentsChanged();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Error deleting rendered-markdown comment:', error);
        if (isBrowser && window.toast) window.toast.showError('Failed to delete comment');
        // The card is still on screen, so restore its retry state.
        delete card.dataset.deleting;
        if (deleteBtn) deleteBtn.disabled = false;
      }
    }

    /**
     * Tell the host that THIS view's comment DOM just changed.
     *
     * Why this exists: the `onCreateComment` / `onDeleteComment` callbacks
     * resolve BEFORE this view adds or removes its card (the host owns
     * persistence; this view owns its own DOM, and mutates it once the
     * host's promise settles). The host's comment COUNT, however, is read
     * from the DOM across both surfaces — so a count taken inside those
     * callbacks is one card stale: it misses a brand-new card whose only
     * surface is this view, and still includes a card that is about to be
     * removed. This hook lets the host recount after the DOM has settled.
     * Deliberately fired only from the two UI-driven mutations
     * (`_submitComment`, `_deleteComment`); bulk `setComments` refreshes are
     * driven BY the host, which recounts on its own schedule.
     * @private
     */
    _notifyCommentsChanged() {
      try {
        this.callbacks.onCommentsChanged?.();
      } catch (error) {
        // A host-side counter must never be able to fail the comment
        // operation the reviewer just completed.
        // eslint-disable-next-line no-console
        console.error('[RenderedDocumentView] onCommentsChanged handler failed:', error);
      }
    }

    /**
     * Human-readable repository line range for a comment, e.g. `Line 11` or
     * `Lines 11–13`. Falls back to a clearly-unknown label rather than
     * inventing a number when the stored range is unusable.
     * @param {object} comment
     * @returns {string}
     * @private
     */
    _formatLineRange(comment) {
      const start = _toSourceLine(comment?.line_start);
      if (start == null) return 'Line unknown';
      const end = _toSourceLine(comment?.line_end);
      return end != null && end > start ? `Lines ${start}–${end}` : `Line ${start}`;
    }

    /** @private */
    _escapeForTextarea(text) {
      return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  }

  /**
   * Minimal CSS.escape fallback (heading slugs are already restricted to
   * `[\w-]` plus a leading digit guard, but keep this defensive).
   */
  function cssEscape(value) {
    if (isBrowser && window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  if (isBrowser) {
    window.RenderedDocumentView = RenderedDocumentView;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RenderedDocumentView, MAX_NESTED_TARGETS_PER_DOCUMENT };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
