// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PierreBridge - adapter between pair-review and ONE virtualized
 * @pierre/diffs CodeView that shows every file of the diff pane.
 *
 * It owns the CodeView, the worker pool, one record per file of the pane
 * (`files`, keyed by the file's path), the annotation lists and their
 * elements, every publish to the viewer, all knowledge of the viewer's
 * shadow DOM, the stamps on the viewer's hosts, scrolling, and the derivation
 * of what a file shows (patch, full contents, revealed ranges).
 *
 * "The per-file renderer" in comments of this file and of pierre-styles.js
 * is what this viewer replaced: one vendor diff instance per file, each in a
 * wrapper element of the page. The pane is held to its look and its rows
 * (tests/parity, plans/codeview-virtualized-diff.md), so several numbers and
 * rules here are stated in its terms.
 *
 * It never reads PRManager state. What it needs from the page comes in
 * through the constructor: `hooks` (renderHeader, hostState, onItemLifecycle,
 * resolvePath), `collaborators` for the card renderers, and the interaction
 * callbacks.
 *
 * Two kinds of record:
 *   - kind 'diff': a changed file, drawn from its patch and, once its
 *     contents are loaded (upgradeFileContents), expandable.
 *   - kind 'context': a file outside the diff, drawn as ranges of its lines
 *     with the rest behind expandable separators. The viewer sees a diff
 *     item without changes; nothing in the annotation, gutter, selection or
 *     scroll API takes a kind.
 *
 * WHAT A PUBLISH GUARANTEES. Every change goes to the viewer as one
 * `updateItem` followed by a synchronous flush. After an annotation-only
 * publish on an item that is mounted, expanded, with no new diff awaiting
 * display, and with the worker pool ready, the card is connected to the
 * document in the same task. In every other state it is not: an unmounted or
 * collapsed item draws nothing; while a new diff of the item awaits display
 * (the highlighter answers asynchronously) the viewer goes on drawing the old
 * diff with the annotations it had; and nothing is mounted until the pool is
 * ready. So "the card is not in the DOM" never means "there is no such
 * annotation" or "the line is not shown". Ask getAnnotationElement for the
 * card (it can build one that is not attached) and isLineVisible for the line
 * (it answers from data). And "the card is in the DOM" never means "the card
 * is on screen somewhere": a file of ROWS_PER_ITEM_WINDOW rows or more has
 * rows for a window of its lines, and the card of a line outside it is
 * connected without a place. Ask isElementDrawn.
 *
 * THE LIST IS REPLACED, NEVER SPLICED. The viewer cannot insert or remove an
 * item above a mounted one without corrupting its layout. `_writeList` is the
 * only caller of `setItems`: it sends the records of `files` as they are at
 * that moment (clear, set, flush), then restores the reader's view (first
 * visible line, line selection, focus and caret, hover). It is asked for by
 * renderAll (a new diff: every record is new) and by reconcile (the set of
 * context files changed: every other record is kept).
 *
 * NO FLUSH INSIDE A VIEWER CALLBACK. A synchronous flush from inside the
 * viewer's render callbacks corrupts its layout for good. A publish made
 * while one of them is running is flushed in a microtask instead.
 *
 * A LIST WRITE ASKED FOR INSIDE A VIEWER CALLBACK (a renderAll or reconcile
 * called from a hook or a card renderer) changes the records at once and the
 * viewer's list when the pass has ended, in a microtask. Until then `files`
 * (what the pane holds) is ahead of `_listed` (the records the viewer's items
 * were made from), and five rules keep the two from being confused:
 *   1. The write is made from `files` as they are when it runs, never from a
 *      list built when it was asked for: an annotation added, a range
 *      revealed or a file collapsed meanwhile is part of it.
 *   2. There is at most one waiting write. A list write made directly
 *      meanwhile (a renderAll or reconcile outside a callback) is that write;
 *      destroy() cancels it. The microtask then does nothing. A list write
 *      never runs inside another: one asked for by the page while a write is
 *      in progress (from a hook in its flush, from the selection callback of
 *      its view restore) waits for it to end.
 *   3. A viewer callback is about an item of the viewer's list, so it
 *      resolves its record in `_listed`. A record that was removed or
 *      replaced goes on drawing its item until the write (an item that lost
 *      its header or its cards mid-pass is a layout the viewer's validator
 *      rejects), and is discarded by the write. Nothing of such an item
 *      (host, instance, expansions) reaches the record that replaced it, and
 *      nothing of the page is run for it: no renderHeader, no hostState, no
 *      card renderer, no card sync, no selection callback, no 'mount' or
 *      'update' (its 'unmount' is told if the page heard its 'mount' and
 *      still has the file). It is drawn from what the bridge already holds:
 *      the header slot, the host classes and the cards it has. The viewer
 *      draws the items of a pass one after another, so such an item can also
 *      be drawn for the FIRST time between the request and the write; it
 *      then gets an empty header slot of the height the viewer was told, and
 *      no cards.
 *   4. A record that is not in the viewer's list yet is never published: the
 *      item the viewer has under its id, if any, is another record's.
 *   5. What addresses the viewer's list by id (scrollToItem, scrollToLine,
 *      selectLines, clearLineSelection) runs after the write, in call order;
 *      so does one sent by a hook while a list write is drawing, which the
 *      write's own view restore would otherwise undo. And whatever is sent
 *      to the viewer's list is decided from that list (`_listed` and the
 *      viewer's own item), never from `files`: the view restore of a write
 *      runs after the write's flush, in which a hook may already have asked
 *      for the next one.
 *
 * Depends on: window.PierreDiffs (vendor bundle), window.PierreContext,
 * window.PierreStyles, window.PierreAnnotations, window.PierreGutter.
 *
 * Wrapped in a function: this file is a classic script, and top-level
 * `const` and `class` names are shared by every script on the page.
 */
(function () {
  const COLLAPSED_CONTEXT_THRESHOLD = 5;
  const EXPANSION_LINE_COUNT = 20;
  const WORKER_INIT_TIMEOUT_MS = 15000;
  /**
   * The viewer's layout, in the per-file renderer's numbers: 17 px above the
   * first file (the pane's 16 px padding and its 1 px border, which pr.css
   * draws behind the list and not on the scroll container), 24 px between
   * files, and 41 px below the last (every file has a 24 px bottom margin
   * there, the last one too, then the padding and the border).
   */
  const DEFAULT_LAYOUT = { paddingTop: 17, paddingBottom: 41, gap: 24 };
  /**
   * How many rows of an item the viewer draws at a time: the size of one
   * block of its rows. The viewer draws two blocks at most, so an item that
   * shows no more rows than this is drawn whole whenever it is mounted, as a
   * file is by the per-file renderer, and a longer one is drawn a window of
   * its rows at a time.
   *
   * Why not smaller. The viewer's default for a list (1) keeps a window of
   * rows around the viewport and moves it a row at a time as the pane
   * scrolls, and a window that shrinks to end at a row loses what follows
   * that row, the separator after a file's last hunk or a line's card, which
   * is not drawn again when the window grows (vendor fact F26,
   * tests/contract/vendor/row-window.spec.js). A window that does not move is
   * never trimmed. What is left of the defect: in a file that shows more
   * than this many rows the window still moves, in steps of this many rows,
   * and the cards of the row a moved window ended at (row 5000, 10000, ...)
   * are gone when the window covers that row again. _restoreTrimmedCards
   * draws such a file again.
   *
   * Why not larger ("draw every file whole"). The viewer measures every row
   * it has drawn with getBoundingClientRect, whose numbers are 32-bit
   * floats: a row more than 262,144 px (2^18) from the viewport measures a
   * 64th of a pixel off when the line height is not a multiple of 1/32 px
   * (the application's is 17.4 px), and the item's computed height drifts
   * from its DOM, 39 px for a file of 20,100 rows (vendor fact F31). Two
   * blocks of this many rows stay within 174,000 px of the pane.
   *
   * The viewer chooses the blocks by the middle of the pane, which leaves
   * the rows after a block boundary undrawn while they are inside the pane;
   * coverPaneWithRowWindow corrects that (vendor fact F30). Which items are
   * mounted is still the viewer's.
   */
  const ROWS_PER_ITEM_WINDOW = 5000;
  /** What the function coverPaneWithRowWindow installs is marked with. */
  const COVERS_PANE = 'pairReviewRowWindowCoversPane';
  const FALLBACK_HEADER_HEIGHT = 53;

  // The end of the pane after a reader's scroll (_followEndAfterReaderScroll).
  // A scroll toward the end that the reader starts (a wheel step down, a
  // scroll key down, a touch drag up) counts as theirs for this long; a
  // smooth scroll to the end of a long pane takes several hundred
  // milliseconds.
  const READER_SCROLL_MS = 1500;
  // The pane is kept at its end until its height has not grown for this many
  // frames, and for this long at most.
  const END_FOLLOW_STILL_FRAMES = 20;
  const END_FOLLOW_MAX_MS = 2000;
  const SCROLL_DOWN_KEYS = new Set(['End', 'PageDown', 'ArrowDown', ' ', 'Spacebar']);
  // The end of the pane after a collapse (_holdEndAfterCollapse). The pane is
  // kept at its end while a file that is drawn still awaits its contents or
  // their display, and for this long at most. The longest such wait the page
  // makes on purpose is the ten seconds it holds a file's contents back while
  // the pointer rests on that file (PRManager.PIERRE_POINTER_UPGRADE_DELAY_MS);
  // the rest is for the request before it and the highlighter after it.
  const END_HOLD_MAX_MS = 15000;
  // A release of the pane's scrollbar (_followEndAfterScrollbarRelease): the
  // pointer went down the track by at least this much during the press, and
  // the strip at the pane's edge a scrollbar may be in where the browser
  // draws it over the content and it has no width of its own
  // (_pressOnScrollbar).
  const SCROLLBAR_PULL_PX = 8;
  const OVERLAY_SCROLLBAR_PX = 16;
  // When the pane counts as at rest after a scroll while a file that shows
  // this many rows or more is mounted (_watchScrollRest): it has not moved
  // for this many frames and for this long. Two frames otherwise.
  const COSTLY_HOVER_ROWS = 2000;
  const SCROLL_REST_FRAMES = 8;
  const SCROLL_REST_MS = 120;
  /** Above these a context file's lines are not coloured (the limits a changed file's contents have). */
  const CONTEXT_PLAIN_TEXT_MAX_CHARS = 400 * 1024;
  const CONTEXT_PLAIN_TEXT_MAX_LINES = 12000;
  /** The annotation every item has, first in its list: the file's comment zone. */
  const ZONE_TYPE = 'file-comments';
  const ZONE_ID = 'file-comments';
  const NOTICE_TYPE = 'notice';
  const NOTICE_ID = 'notice';
  /** How long a line flashes: the length of the pierre-line-highlight-flash animation (pierre-styles.js). */
  const FLASH_DURATION_MS = 3500;
  // A flashed range is a handful of lines; a link to a whole file's worth is
  // flashed up to here.
  const MAX_FLASHED_LINES = 500;

  const schedule = (fn) => (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(fn)
    : setTimeout(fn, 16));

  function sameSequence(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function sameRanges(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].startLine !== b[i].startLine || a[i].endLine !== b[i].endLine) return false;
    }
    return true;
  }

  class PierreBridge {
    /**
     * @param {Object} options
     * @param {HTMLElement} [options.root] - the scroll container the viewer
     *   renders into; may also be given later with attach(root)
     * @param {string} [options.theme] - 'light' or 'dark'
     * @param {string} [options.diffStyle] - 'unified' or 'split'
     * @param {Object} [options.hooks]
     * @param {Function} [options.hooks.renderHeader] - (id, kind) => HTMLElement,
     *   the file's header; one element per file, the same each time
     * @param {Function} [options.hooks.hostState] - (id, kind) => string[] of
     *   classes the file's host carries besides the bridge's own
     * @param {Function} [options.hooks.onItemLifecycle] - (id, phase) => void,
     *   phase 'mount' | 'update' | 'unmount'
     * @param {Function} [options.hooks.resolvePath] - (path) => the id of the
     *   file a path in another form names, or null
     * @param {Function} [options.hooks.contentsAwaited] - () => boolean,
     *   whether a file that is drawn is still to be given its contents by the
     *   page (a request in flight, or contents held back for the pointer)
     * @param {Object|Function} [options.collaborators] - what the card
     *   renderers need (see pierre-annotations.js); an object, or a function
     *   returning one that is called whenever something is needed
     * @param {Function} [options.onCommentClick] - (file, line, side, target) => void
     * @param {Function} [options.onChatClick] - (file, line, side, target) => void
     * @param {Function} [options.onLineClick] - (file, { lineNumber, side, lineType, element }) => void
     * @param {Function} [options.onLineSelect] - (file, range) => void
     * @param {Function} [options.onLineSelectionEnd] - (file, range) => void
     * @param {Function} [options.onCommentFormSubmit] - (file, annotationId, data, text) => Promise
     * @param {Function} [options.onCommentFormCancel] - (file, annotationId, data) => void
     * @param {Function} [options.onSuggestionInsert] - (textarea, button) => void
     * @param {boolean} [options.useWorkerPool=true]
     * @param {string} [options.workerUrl='/js/vendor/pierre-diffs-worker.js']
     * @param {Object} [options.itemMetrics] - { diffHeaderHeight, lineHeight };
     *   measured from the page when not given
     * @param {Object} [options.layout] - { paddingTop, paddingBottom, gap }
     * @param {Object} [options.viewerOptions] - extra CodeView options
     *   (the development bundle's `__devOnlyValidateItemHeights`)
     */
    constructor(options = {}) {
      this.options = options;
      this.hooks = options.hooks || {};
      const vendorLoaded = !!(window.PierreDiffs && window.PierreDiffs.CodeView);
      const modulesLoaded = !!(window.PierreContext && window.PierreStyles && window.PierreAnnotations && window.PierreGutter);
      /** False when the vendor bundle (or one of the bridge's own modules) is missing: nothing can be rendered. */
      this.available = vendorLoaded && modulesLoaded;
      if (!vendorLoaded) {
        console.warn('[PierreBridge] window.PierreDiffs.CodeView not loaded: the @pierre/diffs bundle is missing.');
      } else if (!modulesLoaded) {
        console.warn('[PierreBridge] pierre-context.js, pierre-styles.js, pierre-annotations.js and pierre-gutter.js must be loaded first.');
      }
      if (vendorLoaded && !PierreBridge.coverPaneWithRowWindow(window.PierreDiffs.VirtualizedFileDiff)) {
        // The viewer works; a file that shows more than ROWS_PER_ITEM_WINDOW
        // rows has the vendor's own row window (vendor fact F30).
        console.warn('[PierreBridge] window.PierreDiffs.VirtualizedFileDiff has no computeRenderRangeFromWindow: the row window of a very long file is the vendor\'s own.');
      }
      this.theme = options.theme || PierreBridge.detectTheme();
      this.diffStyle = PierreBridge.isValidDiffStyle(options.diffStyle) ? options.diffStyle : 'unified';
      this.root = options.root || null;

      /** One record per file of the pane, in pane order, keyed by path. */
      this.files = new Map();
      /**
       * The records the viewer's list was last written from, by id. The same
       * records as `files`, except between a list write being asked for
       * inside a viewer callback and it running (file header).
       */
      this._listed = new Map();
      this.codeView = null;

      this._annotationCounter = 0;
      this._renderGen = 0;
      this._keyPrefix = 'review';
      this._metrics = null;
      this._viewerOptions = null;

      // Publish and flush state.
      this._batchDepth = 0;
      this._callbackDepth = 0;
      this._flushWanted = false;
      this._flushQueued = false;

      // A list write asked for inside a viewer callback, and the commands on
      // the viewer's list that wait for it (file header).
      this._listWriteQueued = false;
      this._listWriteRunning = false;
      this._afterListWrite = [];
      this._destroyed = false;
      // The ids the page was told are mounted and not yet told are
      // unmounted (id -> how many times): 'unmount' is told only for those.
      this._mountsTold = new Map();

      // List-write holds (reconcile with whenIdle).
      this._pointerDownOnRoot = false;
      this._listWriteHolds = 0;
      this._pendingReconcile = null;

      // Pointer tracking for hover restore and the gutter.
      this._lastPointer = null;
      this._gutterHiddenByScroll = false;
      this._scrollRestWatched = false;
      this._ownScrollUntil = 0;
      this._hoverRestoreQueued = new Set();

      this._elements = this.available
        ? new window.PierreAnnotations.AnnotationElements({ env: () => this._collaborators(), handlers: options })
        : null;

      this.workerManager = this.available && options.useWorkerPool !== false ? this._createWorkerManager() : null;

      this._onPointerMove = (event) => this._handlePointerMove(event);
      this._onPointerUp = (event) => this._handlePointerUp(event);
      this._onRootPointerDown = (event) => this._handleRootPointerDown(event);
      // Only the browser's own click answers "did the press get its click":
      // the click the bridge sends for an earlier press (_handlePointerUp)
      // arrives here too, and by then a later press may be the one in progress.
      this._onRootClick = (event) => { if (this._press && event?.isTrusted !== false) this._press.clicked = true; };
      // A press that opens the context menu (the secondary button; on macOS
      // also Control with the primary button) gets no click from the browser
      // and must get none from the bridge.
      this._onRootContextMenu = () => { this._press = null; };
      this._onRootPressKind = (event) => this._notePressKind(event);
      this._onRootScroll = () => this._handleRootScroll();
      // The reader's last scroll input toward the end of the pane, with the
      // end of the pane at that moment; the follow that is running
      // (_followEndAfterReaderScroll), or the hold after a collapse
      // (_holdEndAfterCollapse: `hold` is set); the press in progress when it began
      // on the pane's own scrollbar (where, whether the pane moved under it
      // and whether the thumb has been at the end of its track); and where
      // the finger of a touch was.
      this._readerScroll = null;
      this._endFollow = null;
      this._scrollbarPress = null;
      this._touchY = null;
      this._onReaderScrollInput = (event) => this._noteReaderScrollInput(event);
      // How often each file's element was drawn, and the press in progress (_handleRootPointerDown).
      this._hostDraws = new WeakMap();
      this._press = null;
      document.addEventListener('pointermove', this._onPointerMove, { passive: true });
      document.addEventListener('pointerup', this._onPointerUp, { passive: true });
      document.addEventListener('pointercancel', this._onPointerUp, { passive: true });
      if (this.root) this._bindRoot();
    }

    // ─── Statics ─────────────────────────────────────────────────────

    static detectTheme() {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    /** @returns {boolean} true when `style` is a supported diff layout. */
    static isValidDiffStyle(style) {
      return style === 'unified' || style === 'split';
    }

    /** The app's side ('LEFT'/'RIGHT') as the viewer's ('deletions'/'additions'). */
    static toPierreSide(side) {
      if (side === 'LEFT' || side === 'deletions') return 'deletions';
      return 'additions';
    }

    /** The viewer's side as the app's. */
    static toPairReviewSide(side) {
      if (side === 'deletions' || side === 'LEFT') return 'LEFT';
      return 'RIGHT';
    }

    /**
     * The key a derived metadata is published under: the record's base key
     * plus a counter that never repeats for the record. The viewer treats two
     * diffs with the same key as the same content and does not draw the
     * second, so every metadata the bridge derives (full contents, revealed
     * ranges, a fold of manual expansions) gets a new key.
     * @param {{baseKey: string, derivation: number}} record
     * @param {Object} metadata
     * @returns {Object} a copy of `metadata` with the new key
     */
    static rekey(record, metadata) {
      record.derivation += 1;
      return { ...metadata, cacheKey: `${record.baseKey}|d${record.derivation}` };
    }

    /**
     * How a changed file's metadata is derived once its full contents are
     * known, by the type of the diff.
     *   'rediff':  diff the two contents again (changes and renames with
     *              changes), which is what the per-file renderer did: the
     *              vendor's own context around every change (four lines),
     *              the lines of the patch kept on screen by
     *              upgradeFileContents. The reader
     *              sees the same rows after the contents have loaded as with
     *              that renderer.
     *   'none':    the patch already is everything there is to show: an added
     *              or deleted file (the patch is the whole file).
     *   'reparse': a file without a hunk (pure rename, mode change). Its
     *              patch holds no line. Its two contents are diffed; when
     *              they are the same text, as they are for these files, the
     *              result has no hunk either and holds the file's lines, so a
     *              line of it can still be revealed. The file stays
     *              header-only until then.
     * @param {Object} metadata - the metadata parsed from the patch
     * @returns {'rediff'|'none'|'reparse'}
     */
    static upgradeStrategy(metadata) {
      if (!metadata || !Array.isArray(metadata.hunks)) return 'none';
      if (metadata.hunks.length === 0) return 'reparse';
      return metadata.type === 'change' || metadata.type === 'rename-changed' ? 'rediff' : 'none';
    }

    /**
     * The lines of the new file that a patch shows, one range per hunk that
     * has any. The diff of the two contents can draw fewer lines of context
     * than the patch did; these ranges keep every line the reader, a comment
     * or a suggestion was already on.
     * @param {Object} metadata - the metadata parsed from the patch
     * @returns {Array<{startLine: number, endLine: number}>}
     */
    static patchParityRanges(metadata) {
      return (metadata?.hunks || [])
        .filter((hunk) => hunk.additionCount > 0)
        .map((hunk) => ({ startLine: hunk.additionStart, endLine: hunk.additionStart + hunk.additionCount - 1 }));
    }

    /**
     * How many rows of lines the viewer draws for a diff nobody has expanded
     * by hand: the lines of its hunks in the given layout, and, where the
     * diff carries the file's contents, every gap between hunks (and after
     * the last) that is small enough to be drawn instead of folded
     * (COLLAPSED_CONTEXT_THRESHOLD). What decides whether a file is drawn
     * whole or in windows of its rows (ROWS_PER_ITEM_WINDOW).
     * @param {Object} metadata - the vendor's metadata of a diff
     * @param {string} diffStyle - 'unified' or 'split'
     * @returns {number}
     */
    static drawnRowCount(metadata, diffStyle) {
      const hunks = metadata?.hunks;
      if (!Array.isArray(hunks) || hunks.length === 0) return 0;
      const key = diffStyle === 'split' ? 'splitLineCount' : 'unifiedLineCount';
      let rows = 0;
      let lastNewLine = 0;
      for (const hunk of hunks) {
        rows += hunk[key] || 0;
        const hidden = Math.max(hunk.collapsedBefore || 0, 0);
        if (!metadata.isPartial && hidden > 0 && hidden <= COLLAPSED_CONTEXT_THRESHOLD) rows += hidden;
        lastNewLine = Math.max(lastNewLine, hunk.additionStart + hunk.additionCount - 1);
      }
      if (!metadata.isPartial && Array.isArray(metadata.additionLines)) {
        const trailing = metadata.additionLines.length - lastNewLine;
        if (trailing > 0 && trailing <= COLLAPSED_CONTEXT_THRESHOLD) rows += trailing;
      }
      return rows;
    }

    /**
     * The window to ask the viewer about again when the rows it chose to
     * draw of an item end inside the pane (vendor fact F30).
     *
     * The viewer draws an item's rows in blocks of ROWS_PER_ITEM_WINDOW: the
     * block the middle of the pane's window is in, and the one before it.
     * While the middle is still in one block and the lower part of the pane
     * is already in the next, the rows of the next block are not drawn: the
     * item's drawn rows are held against the pane's bottom edge instead of
     * moving with the scroll, the files after it are laid out against rows
     * that are not there, and the last rows of an item that ends less than
     * half a pane after a boundary are never drawn at all when that item
     * ends the pane. Asked with a window of the same height whose middle is
     * on the first row it left out, the viewer answers with that row's
     * block and the one before, which holds everything the pane shows (a
     * block is far taller than the pane).
     *
     * @param {Object} range - the viewer's answer for the pane's window:
     *   { totalLines, bufferAfter } (the height of what it leaves out after
     *   the rows it draws)
     * @param {number} itemTop - the item's top in the pane's coordinates
     * @param {number} itemHeight - the item's height in the viewer's layout
     * @param {{top: number, bottom: number}} windowSpecs - the pane's window
     * @returns {{top: number, bottom: number}|null} null when the answer
     *   needs no correction: nothing is drawn (the item is outside the
     *   window), nothing is left out after the drawn rows, or what is left
     *   out begins below the window
     */
    static windowPastDrawnRows(range, itemTop, itemHeight, windowSpecs) {
      if (!range || !windowSpecs || !(range.totalLines > 0) || !(range.bufferAfter >= 1)) return null;
      // Where the rows the viewer left out begin, to within the item's
      // bottom padding (which puts the point inside the first of them).
      const firstLeftOut = itemTop + itemHeight - range.bufferAfter;
      if (!Number.isFinite(firstLeftOut) || !(firstLeftOut < windowSpecs.bottom)) return null;
      const half = (windowSpecs.bottom - windowSpecs.top) / 2;
      if (!(half > 0)) return null;
      return { top: firstLeftOut - half, bottom: firstLeftOut + half };
    }

    /**
     * Make the rows the viewer draws of an item always hold the rows the
     * pane shows (windowPastDrawnRows). The viewer's own computation is
     * kept and asked a second time where its first answer falls short; with
     * a viewer whose first answer never does, this changes nothing.
     *
     * This replaces a method of a vendor class that is not part of its
     * documented options: `VirtualizedFileDiff.prototype
     * .computeRenderRangeFromWindow(fileDiff, fileTop, windowSpecs)`, which
     * the viewer calls for the rows to draw and for the item's part of the
     * pane's layout alike. Pinned by tests/contract/vendor/row-window.spec.js
     * (the defect, on the viewer alone) and tests/contract/bridge/view.spec.js
     * (the pane with this in place).
     *
     * @param {Function} VirtualizedFileDiff - the vendor's class
     * @returns {boolean} false when the class or the method is not there
     *   (another version of the vendor): nothing was changed
     */
    static coverPaneWithRowWindow(VirtualizedFileDiff) {
      const prototype = VirtualizedFileDiff?.prototype;
      const compute = prototype?.computeRenderRangeFromWindow;
      if (typeof compute !== 'function') return false;
      if (compute[COVERS_PANE]) return true;
      const covering = function computeRenderRangeFromWindow(fileDiff, fileTop, windowSpecs) {
        const range = compute.call(this, fileDiff, fileTop, windowSpecs);
        const further = PierreBridge.windowPastDrawnRows(range, fileTop, this.height, windowSpecs);
        if (!further) return range;
        const covered = compute.call(this, fileDiff, fileTop, further);
        // Never from rows to none: the first answer stands.
        return covered?.totalLines > 0 ? covered : range;
      };
      covering[COVERS_PANE] = true;
      prototype.computeRenderRangeFromWindow = covering;
      return true;
    }

    /**
     * The language a context file is tokenized as: nothing (the vendor infers
     * it from the name) unless the file is too large to colour or is not
     * text, in which case 'text' (drawn uncoloured; everything else works).
     * @param {string} contents
     * @returns {string|undefined}
     */
    static contextLanguage(contents) {
      const text = contents || '';
      if (text.length > CONTEXT_PLAIN_TEXT_MAX_CHARS) return 'text';
      if (text.includes('\u0000')) return 'text';
      let lines = 1;
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
        if (++lines > CONTEXT_PLAIN_TEXT_MAX_LINES) return 'text';
      }
      return undefined;
    }

    // ─── Set-up ──────────────────────────────────────────────────────

    /**
     * Give the bridge its scroll container. Needed before the first
     * renderAll when the constructor did not get `root`.
     * @param {HTMLElement} root
     */
    attach(root) {
      if (this.root === root || this._destroyed) return;
      if (this.codeView) throw new Error('[PierreBridge] attach() after the viewer was created');
      this.root = root;
      if (root) this._bindRoot();
    }

    /** @private */
    _bindRoot() {
      this.root.addEventListener('pointerdown', this._onRootPointerDown, { passive: true });
      this.root.addEventListener('click', this._onRootClick, { capture: true, passive: true });
      this.root.addEventListener('contextmenu', this._onRootContextMenu, { capture: true, passive: true });
      this.root.addEventListener('mousedown', this._onRootPressKind, { capture: true, passive: true });
      this.root.addEventListener('touchstart', this._onRootPressKind, { capture: true, passive: true });
      this.root.addEventListener('scroll', this._onRootScroll, { passive: true });
      this.root.addEventListener('wheel', this._onReaderScrollInput, { capture: true, passive: true });
      this.root.addEventListener('touchmove', this._onReaderScrollInput, { capture: true, passive: true });
      this.root.addEventListener('pointerdown', this._onReaderScrollInput, { capture: true, passive: true });
      document.addEventListener('keydown', this._onReaderScrollInput, { capture: true, passive: true });
    }

    /** @private */
    _collaborators() {
      const given = this.options.collaborators;
      const resolved = (typeof given === 'function' ? given() : given) || {};
      // Page-level utilities that are not PRManager's are found on the page
      // when they were not handed in.
      return {
        renderMarkdown: window.renderMarkdown,
        escapeHtmlAttribute: window.escapeHtmlAttribute,
        getPostedCommentIcon: window.getPostedCommentIcon,
        chatPanel: window.chatPanel,
        emojiPicker: window.emojiPicker,
        ...resolved,
      };
    }

    getThemeConfig() {
      return { dark: 'github-dark', light: 'github-light' };
    }

    /** @private */
    _getWorkerRenderOptions() {
      return {
        theme: this.getThemeConfig(),
        useTokenTransformer: false,
        lineDiffType: 'word',
        maxLineDiffLength: 1000,
        tokenizeMaxLineLength: 1000,
      };
    }

    /**
     * The shared worker pool the viewer highlights with. Without it Shiki
     * runs on the main thread and freezes large reviews. A worker that fails
     * to start is the vendor's business: the same viewer falls back to the
     * main thread by itself.
     * @returns {Object|null}
     * @private
     */
    _createWorkerManager() {
      if (!window.PierreDiffs.WorkerPoolManager || typeof Worker === 'undefined') return null;
      try {
        const hardwareConcurrency = window.navigator?.hardwareConcurrency || 2;
        const poolSize = Math.max(1, Math.min(2, Math.floor(hardwareConcurrency / 2) || 1));
        const workerUrl = this.options.workerUrl || '/js/vendor/pierre-diffs-worker.js';
        return new window.PierreDiffs.WorkerPoolManager({
          workerFactory: () => new Worker(workerUrl),
          poolSize,
          totalASTLRUCacheSize: 50,
          workerInitializationTimeout: WORKER_INIT_TIMEOUT_MS,
        }, {
          langs: ['text'],
          ...this._getWorkerRenderOptions(),
          preferredHighlighter: 'shiki-js',
        });
      } catch (err) {
        console.warn('[PierreBridge] Failed to create the @pierre/diffs worker pool; highlighting runs on the main thread.', err);
        return null;
      }
    }

    /**
     * The two numbers the viewer estimates unmounted content with. They must
     * equal what the page's CSS renders, exactly: the header's fixed height
     * (the --pr-file-header-height token) and the height of one code row,
     * which the page sets through --diffs-font-size / --diffs-line-height on
     * the hosts. The row height is measured, not multiplied out: 12px x 1.45
     * is 17.4, the browser lays the row out at 17.390625.
     * @returns {{diffHeaderHeight: number, lineHeight?: number}}
     * @private
     */
    _measureMetrics() {
      const given = this.options.itemMetrics || {};
      const metrics = {};
      if (typeof given.diffHeaderHeight === 'number') {
        metrics.diffHeaderHeight = given.diffHeaderHeight;
      } else {
        const token = parseFloat(getComputedStyle(this.root).getPropertyValue('--pr-file-header-height'));
        metrics.diffHeaderHeight = Number.isFinite(token) && token > 0 ? token : FALLBACK_HEADER_HEIGHT;
      }
      if (typeof given.lineHeight === 'number') {
        metrics.lineHeight = given.lineHeight;
      } else {
        const host = document.createElement('diffs-container');
        this.root.appendChild(host);
        const style = getComputedStyle(host);
        const fontSize = style.getPropertyValue('--diffs-font-size').trim();
        const lineHeight = style.getPropertyValue('--diffs-line-height').trim();
        host.remove();
        // Without the page's overrides the vendor's own default is right.
        if (fontSize && lineHeight) {
          const row = document.createElement('div');
          row.style.cssText = `font-size: ${fontSize}; line-height: ${lineHeight}; font-family: monospace; position: absolute; visibility: hidden;`;
          row.textContent = 'x';
          this.root.appendChild(row);
          const measured = row.getBoundingClientRect().height;
          row.remove();
          if (measured > 0) metrics.lineHeight = measured;
        }
      }
      return metrics;
    }

    /**
     * The one options object the viewer has. Built once; a change of layout
     * or theme replaces it with a copy (setOptions takes a replacement, not a
     * patch), and the callbacks keep their identity, because a callback that
     * changes identity re-renders every mounted item.
     * @returns {Object}
     * @private
     */
    _buildViewerOptions() {
      return {
        theme: this.getThemeConfig(),
        themeType: this.theme,
        diffStyle: this.diffStyle,
        diffIndicators: 'bars',
        overflow: 'wrap',
        lineHoverHighlight: 'line',
        lineDiffType: 'word',
        enableGutterUtility: true,
        enableLineSelection: true,
        unsafeCSS: window.PierreStyles.unsafeCSS(),
        hunkSeparators: 'line-info',
        expansionLineCount: EXPANSION_LINE_COUNT,
        collapsedContextThreshold: COLLAPSED_CONTEXT_THRESHOLD,
        stickyHeaders: true,
        // With the default, item content takes no pointer input for about
        // 120 ms after any scroll, buttons inside cards included.
        pointerEventsOnScroll: true,
        itemMetrics: {
          ...this._metrics,
          hunkLineCount: ROWS_PER_ITEM_WINDOW,
          // Below a file's last row: the vendor's 8 px and the frame's
          // bottom border (pierre-styles.js FRAME_CSS).
          paddingBottom: window.PierreStyles.ITEM_PADDING_BOTTOM,
        },
        layout: { ...DEFAULT_LAYOUT, ...(this.options.layout || {}) },
        ...(this.options.viewerOptions || {}),

        renderCustomHeader: (fileOrDiff, context) => this._inCallback(() => this._renderHeader(context)),
        renderAnnotation: (annotation, fileOrDiff, context) => this._inCallback(() => this._renderAnnotation(annotation, context)),
        renderGutterUtility: (getHoveredLine, context) => this._inCallback(() => this._renderGutter(getHoveredLine, context)),
        onPostRender: (node, instance, phase, context) => this._inCallback(() => this._onPostRender(node, instance, phase, context)),
        onLineClick: (props, context) => {
          const id = context?.item?.id;
          const record = this._listedRecord(id);
          if (!this._isCurrent(record) || !this.options.onLineClick) return;
          this.options.onLineClick(id, {
            lineNumber: props.lineNumber,
            side: this._appSide(record, props.annotationSide),
            lineType: props.lineType,
            element: props.lineElement,
          });
        },
        // Every range the viewer reports is cut back at hidden lines before
        // anything uses it (_cutViewerSelection): the press (a shift-click
        // extends a selection there), each row the pointer reaches, the
        // release. The page is told the cut range only.
        onLineSelectionStart: (range, context) => {
          this._cutViewerSelection(this._listedRecord(context?.item?.id)?.id, range);
        },
        onLineSelectionChange: (range, context) => {
          this._cutViewerSelection(this._listedRecord(context?.item?.id)?.id, range);
        },
        onLineSelected: (range, context) => {
          const record = this._listedRecord(context?.item?.id);
          const cut = this._cutViewerSelection(record?.id, range);
          if (this._isCurrent(record) && this.options.onLineSelect) this.options.onLineSelect(record.id, cut);
        },
        onLineSelectionEnd: (range, context) => {
          const record = this._listedRecord(context?.item?.id);
          const cut = this._cutViewerSelection(record?.id, range);
          if (this._isCurrent(record) && this.options.onLineSelectionEnd) this.options.onLineSelectionEnd(record.id, cut);
        },
      };
    }

    /**
     * Run a viewer callback with the "inside a render pass" mark set, so a
     * publish it causes is flushed afterwards and not inside the pass.
     * @private
     */
    _inCallback(fn) {
      this._callbackDepth++;
      try {
        return fn();
      } catch (err) {
        console.error('[PierreBridge] a render callback failed:', err);
        return undefined;
      } finally {
        this._callbackDepth--;
      }
    }

    // ─── Theme and layout ────────────────────────────────────────────

    setTheme(theme) {
      this.theme = theme;
      if (this.workerManager?.setRenderOptions) {
        const update = this.workerManager.setRenderOptions(this._getWorkerRenderOptions());
        if (update?.catch) {
          update.catch((err) => {
            console.warn('[PierreBridge] Failed to update the worker pool theme.', err);
          });
        }
      }
      this._replaceViewerOptions({ themeType: theme });
    }

    /**
     * Switch every file between unified and split (side-by-side) layout. The
     * viewer keeps the first visible line where it is.
     * @param {'unified'|'split'} style
     * @returns {boolean} false for an invalid style
     */
    setDiffStyle(style) {
      if (!PierreBridge.isValidDiffStyle(style)) {
        console.warn(`[PierreBridge] Ignoring invalid diffStyle "${style}"; expected 'unified' or 'split'.`);
        return false;
      }
      if (style === this.diffStyle) return true;
      this.diffStyle = style;
      this._replaceViewerOptions({ diffStyle: style });
      return true;
    }

    /** @private */
    _replaceViewerOptions(patch) {
      if (!this._viewerOptions) return;
      this._viewerOptions = { ...this._viewerOptions, ...patch };
      if (!this.codeView) return;
      this.codeView.setOptions(this._viewerOptions);
      this._requestFlush();
    }

    // ─── Patch parsing and diff positions ────────────────────────────

    /**
     * Parse a unified diff patch for a single file.
     * @param {string} patch - with git headers, or bare hunks starting at @@
     * @param {string} [cacheKeyPrefix] - makes the metadata's cacheKey
     * @returns {Object|null} FileDiffMetadata
     */
    parsePatch(patch, cacheKeyPrefix) {
      if (!patch || !this.available) return null;
      let input = patch;
      if (!patch.startsWith('diff --git ')) {
        input = `diff --git a/file b/file\n--- a/file\n+++ b/file\n${patch}`;
      }
      const parsed = window.PierreDiffs.parsePatchFiles(input, cacheKeyPrefix ? { cacheKeyPrefix } : undefined);
      const metadata = parsed?.[0]?.files?.[0];
      if (!metadata) return null;
      // Pierre keeps git's C-quoted spelling of a header path. Respell the
      // names it reports with the decoded paths pair-review keys on; prevName
      // also picks the old side's highlighting language.
      const paths = window.GitPaths?.parsePatchPaths(input);
      if (paths) {
        metadata.name = paths.newPath;
        if (metadata.prevName != null) metadata.prevName = paths.oldPath;
      }
      return metadata;
    }

    /**
     * GitHub's diffPosition for every line of a patch: a 1-indexed counter
     * over the hunk headers and lines, derived from the parsed metadata's
     * ordered `hunkContent` (git emits a change region's deletions before its
     * additions, which is the order recorded there).
     * @param {Object} metadata - FileDiffMetadata parsed from the patch
     * @returns {Map<string, number>} "SIDE:line" -> diffPosition
     */
    computeDiffPositions(metadata) {
      const positions = new Map();
      if (!metadata || !Array.isArray(metadata.hunks)) return positions;
      let diffPosition = 0;
      for (const hunk of metadata.hunks) {
        if (!Array.isArray(hunk.hunkContent)) return new Map();
        diffPosition++; // the hunk header
        let oldLine = hunk.deletionStart;
        let newLine = hunk.additionStart;
        for (const segment of hunk.hunkContent) {
          if (segment.type === 'context') {
            for (let i = 0; i < segment.lines; i++) {
              diffPosition++;
              positions.set(`RIGHT:${newLine++}`, diffPosition);
              positions.set(`LEFT:${oldLine++}`, diffPosition);
            }
          } else if (segment.type === 'change') {
            for (let i = 0; i < (segment.deletions || 0); i++) positions.set(`LEFT:${oldLine++}`, ++diffPosition);
            for (let i = 0; i < (segment.additions || 0); i++) positions.set(`RIGHT:${newLine++}`, ++diffPosition);
          } else {
            // An unknown segment: no map is better than one that skips lines.
            return new Map();
          }
        }
      }
      return positions;
    }

    /**
     * The diffPosition of a line, or null. Always null for a context file: a
     * line outside the diff has no position in it.
     * @param {string} fileName
     * @param {number} lineNumber
     * @param {string} side - 'LEFT'/'RIGHT' (or 'deletions'/'additions')
     * @returns {number|null}
     */
    getDiffPosition(fileName, lineNumber, side) {
      const record = this._record(fileName);
      if (!record || record.kind !== 'diff') return null;
      return record.diffPositions.get(`${PierreBridge.toPairReviewSide(side)}:${lineNumber}`) || null;
    }

    // ─── Records ─────────────────────────────────────────────────────

    /**
     * The record a path names. A caller may hold a path in another form than
     * the pane's (a finding's `./src/a.js` for `src/a.js`); every function
     * that takes a file resolves it here, once, at its entry.
     * @param {string} path
     * @returns {Object|null}
     * @private
     */
    _record(path) {
      if (path == null) return null;
      const exact = this.files.get(path);
      if (exact) return exact;
      if (typeof path !== 'string') return null;
      let resolved = null;
      if (typeof this.hooks.resolvePath === 'function') {
        try {
          resolved = this.hooks.resolvePath(path);
        } catch (err) {
          console.error('[PierreBridge] resolvePath hook failed:', err);
        }
      }
      if (resolved == null) resolved = path.replace(/^\.\//, '').replace(/^\/+/, '');
      return (resolved !== path && this.files.get(resolved)) || null;
    }

    /** The id of the record a path names, or null. */
    resolveFileId(path) {
      return this._record(path)?.id ?? null;
    }

    /**
     * The record an item of the viewer's list was made from, by the item's
     * id. Every viewer callback resolves its record here, never in `files`:
     * while a list write is waiting, the record `files` holds under an id may
     * be a newer one than the item's (file header).
     * @param {string} id
     * @returns {Object|null}
     * @private
     */
    _listedRecord(id) {
      return (id != null && this._listed.get(id)) || null;
    }

    /**
     * Whether the viewer's list holds the item made from this record. False
     * from the record's creation to the list write that sends it.
     * @private
     */
    _isListed(record) {
      return !!record && this._listed.get(record.id) === record;
    }

    /**
     * Whether a record is the pane's record of its path. False for one that
     * was removed or replaced and whose item is still in the viewer's list
     * (a list write is waiting).
     * @private
     */
    _isCurrent(record) {
      return !!record && this.files.get(record.id) === record;
    }

    /**
     * Take a record out of the pane's data. One the viewer's list still
     * holds an item of goes on drawing that item and is discarded by the
     * next list write.
     * @private
     */
    _dropRecord(record) {
      if (!this._isListed(record)) this._discardRecord(record);
    }

    /** @private */
    _emptyMetadata(id, key) {
      const empty = { name: id, contents: '', cacheKey: `${key}:empty` };
      return window.PierreDiffs.parseDiffFromFile(empty, { ...empty });
    }

    /**
     * Build the record of one entry of the pane.
     * @param {Object} entry - kind 'diff': { id, patch, status, collapsed,
     *   forcePlainText, deferred, notice }; kind 'context': { id, kind,
     *   contents, contentsSeq, ranges, collapsed }
     * @param {number} index - position in the list, part of the cache key
     * @returns {Object|null}
     * @private
     */
    _createRecord(entry, index) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) return null;
      const kind = entry.kind === 'context' ? 'context' : 'diff';
      const record = {
        id: entry.id,
        fileName: entry.id,
        kind,
        status: entry.status || null,
        collapsed: !!entry.collapsed,
        forcePlainText: !!entry.forcePlainText,
        annotations: [],
        formElements: new Map(),
        diffPositions: new Map(),
        contextRanges: [],
        storedRanges: [],
        // A changed file whose contents are loaded: the lines its patch
        // showed (patchParityRanges). Never changed afterwards.
        parityRanges: [],
        baseKey: '',
        derivation: 0,
        version: 0,
        patch: null,
        deferred: false,
        upgraded: false,
        patchMetadata: null,
        baseMetadata: null,
        metadata: null,
        file: null,
        contentsSeq: null,
        // DOM references, valid only while the item is mounted.
        _element: null,
        // The viewer's instance for the item: stable for the item's life in
        // one list, replaced by a list write.
        _instance: null,
        _headerSlot: null,
        _flash: null,
        // Set while the viewer still draws the diff whose manual expansions
        // were folded into ranges: that diff (see _retireExpansions).
        _expansionsOf: null,
        // The row renderer callback taken over meanwhile (_watchForNextDiff).
        _expansionWatch: null,
        _gutter: null,
        _getHoveredLine: null,
        _splitLayoutQueued: false,
        _trimCheckQueued: false,
        _trimAttempt: null,
      };
      if (kind === 'context') {
        record.upgraded = true;
        this._setContextContents(record, entry.contents, entry.contentsSeq);
        record.storedRanges = this._normalizeRanges(entry.ranges);
        this._derive(record);
      } else {
        record.patch = entry.patch || null;
        record.deferred = !!entry.deferred;
        record.baseKey = `${this._keyPrefix}:${this._renderGen}:${index}`;
        this._parseRecordPatch(record);
      }
      record.annotations.push(this._zoneAnnotation(record));
      if (entry.notice != null) record.annotations.push(this._noticeAnnotation(record, entry.notice));
      return record;
    }

    /** @private */
    _parseRecordPatch(record) {
      let metadata = null;
      if (record.patch && !record.deferred) {
        try {
          metadata = this.parsePatch(record.patch, record.baseKey);
        } catch (err) {
          console.warn(`[PierreBridge] Could not parse the patch of ${record.id}; the file is shown without lines.`, err);
        }
      }
      if (!metadata) metadata = this._emptyMetadata(record.id, record.baseKey);
      metadata.name = record.id;
      if (record.forcePlainText) metadata.lang = 'text';
      record.patchMetadata = metadata;
      record.metadata = metadata;
      record.baseMetadata = null;
      record.parityRanges = [];
      record.upgraded = false;
      record.diffPositions = record.deferred ? new Map() : this.computeDiffPositions(metadata);
    }

    /** @private */
    _setContextContents(record, contents, contentsSeq) {
      const text = typeof contents === 'string' ? contents : '';
      record.contentsSeq = contentsSeq ?? null;
      record.baseKey = `${this._keyPrefix}:ctx:${record.id}:${contentsSeq ?? 0}`;
      const file = { name: record.id, contents: text, cacheKey: record.baseKey };
      const lang = PierreBridge.contextLanguage(text);
      if (lang) file.lang = lang;
      record.file = file;
      // The vendor's own constructor of a diff without changes, made
      // one-sided: with type 'new' the split layout draws ONE column, and
      // only additions-side annotations are laid out (hence _annotationSide).
      const base = window.PierreDiffs.parseDiffFromFile(file, { ...file });
      record.baseMetadata = { ...base, type: 'new' };
      if (lang) record.baseMetadata.lang = lang;
    }

    /** @private */
    _normalizeRanges(ranges) {
      const merge = window.PierreContext?.mergeOverlapping;
      const list = (ranges || []).map((r) => ({ startLine: r.startLine, endLine: r.endLine }));
      return merge ? merge(list) : list;
    }

    /**
     * Work out what a record shows from its base metadata and its ranges, and
     * make that the record's metadata. A changed file before its contents are
     * loaded keeps the patch's metadata.
     * @returns {boolean} whether the record's metadata changed
     * @private
     */
    _derive(record) {
      const base = record.baseMetadata;
      if (!base) return false;
      const ranges = [...record.storedRanges, ...(record.parityRanges || []), ...record.contextRanges];
      const merge = window.PierreContext?.mergeContextRanges;
      // A base that holds none of the file's lines (a patch without a hunk
      // whose contents could not be read) has nothing a range could show.
      const holdsLines = Array.isArray(base.additionLines) && base.additionLines.length > 0;
      const merged = ranges.length && merge && holdsLines ? merge(base, ranges) : base;
      if (merged === base) {
        // Nothing to add to the base. A file without a hunk whose base came
        // from its contents shows the same header-only item either way: what
        // is published stays, and nothing is drawn again for it.
        const published = record.metadata;
        if (published === base) return false;
        if (published && published.hunks.length === 0 && base.hunks.length === 0) return false;
        record.metadata = base;
        return true;
      }
      record.metadata = PierreBridge.rekey(record, merged);
      return true;
    }

    /** @private */
    _annotationSide(record, side) {
      // A context item is one-sided: the viewer lays out additions-side
      // annotations only. The stored side stays in the annotation's data.
      if (record.kind === 'context') return 'additions';
      return PierreBridge.toPierreSide(side);
    }

    /** @private */
    _appSide(record, pierreSide) {
      if (record.kind === 'context') return 'RIGHT';
      return PierreBridge.toPairReviewSide(pierreSide);
    }

    /**
     * The side a file-level (line 0) annotation must be on to be drawn: the
     * deletions side of a deleted file, additions otherwise. The file's
     * status decides first (a patch from the GitHub API starts at @@ and its
     * metadata does not say "deleted"), the parsed type second.
     * @private
     */
    _fileAnnotationSide(record) {
      if (record.kind === 'context') return 'additions';
      if (record.status === 'removed' || record.status === 'deleted') return 'deletions';
      return record.patchMetadata?.type === 'deleted' ? 'deletions' : 'additions';
    }

    /** @private */
    _zoneAnnotation(record) {
      return {
        side: this._fileAnnotationSide(record),
        lineNumber: 0,
        metadata: { type: ZONE_TYPE, data: { file: record.id }, id: ZONE_ID },
      };
    }

    /** @private */
    _noticeAnnotation(record, data) {
      return {
        side: this._fileAnnotationSide(record),
        lineNumber: 0,
        metadata: { type: NOTICE_TYPE, data, id: NOTICE_ID },
      };
    }

    /** @private */
    _itemFor(record) {
      return {
        id: record.id,
        type: 'diff',
        fileDiff: record.metadata,
        annotations: window.PierreAnnotations.sortAnnotations(record.annotations),
        collapsed: record.collapsed,
        version: record.version,
      };
    }

    /** @private */
    _discardRecord(record) {
      this._endFlash(record);
      record.formElements.clear();
      record._gutter?.remove();
      record._gutter = null;
      record._getHoveredLine = null;
      record._headerSlot = null;
      record._element = null;
      this._forgetInstance(record);
      record.annotations = [];
    }

    // ─── The list ────────────────────────────────────────────────────

    /**
     * Show a new diff: discard every record and build the pane from
     * `entries` (changed files and the context files already known, in pane
     * order). The reader's position is restored when the file they were in
     * is still there; manual expansions are not kept, as a re-render starts
     * from the patch again.
     *
     * Called from inside a viewer callback, the records are the new ones on
     * return and the viewer's list is written when the pass has ended (file
     * header).
     * @param {Array<Object>} entries
     * @param {Object} [options]
     * @param {string|number} [options.keyPrefix] - identifies the review in
     *   the viewer's highlight cache keys
     * @returns {boolean} false when nothing was rendered (no bundle, no
     *   list, no root)
     */
    renderAll(entries, { keyPrefix } = {}) {
      if (!this.available || this._destroyed || !Array.isArray(entries) || !this.root) return false;
      this._renderGen++;
      if (keyPrefix != null) this._keyPrefix = String(keyPrefix);
      this._pendingReconcile = null;
      for (const record of this.files.values()) this._dropRecord(record);
      this.files.clear();
      entries.forEach((entry, index) => {
        if (entry && this.files.has(entry.id)) {
          console.warn(`[PierreBridge] renderAll: duplicate id "${entry.id}" ignored.`);
          return;
        }
        const record = this._createRecord(entry, index);
        if (record) this.files.set(record.id, record);
      });
      this._requestListWrite();
      return true;
    }

    /**
     * Bring the pane in line with `entries` when the set of context files
     * changed at run time: one was added or removed, its ranges changed, its
     * contents were replaced.
     *
     * A record whose id and kind are in `entries` is KEPT as it is, with its
     * annotations, their elements, its metadata, revealed ranges, collapsed
     * state and contents; only a context record's stored ranges and contents
     * are taken from its entry. A record whose id is gone is destroyed with
     * its annotations. When the sequence of ids is unchanged no list is
     * written: the context records that changed are published. Otherwise the
     * list is replaced and the reader's view restored; the lines the reader
     * expanded by hand, which a list replace would lose, are first folded
     * into each record's revealed ranges.
     *
     * An entry list made for another diff is refused: the changed files of
     * `entries` must be the changed files the bridge holds, in order.
     *
     * @param {Array<Object>|Function} entries - the entries, or a function
     *   returning them (called when the reconcile runs)
     * @param {Object} [options]
     * @param {boolean} [options.whenIdle=false] - for a change the reader did
     *   not just ask for: wait while a pointer button is down on the pane (a
     *   selection in progress) and while a list-write hold is in place
     *   (holdListWrites); the latest such request wins
     * @returns {{applied: boolean, deferred?: boolean, reason?: string,
     *   created: string[], removed: string[], updated: string[], listWritten: boolean}}
     *   `listWritten`: the list was replaced, or, for a call from inside a
     *   viewer callback, is replaced when the pass has ended (file header);
     *   the records are the new ones on return either way
     */
    reconcile(entries, { whenIdle = false } = {}) {
      const nothing = (extra) => ({ applied: false, created: [], removed: [], updated: [], listWritten: false, ...extra });
      if (!this.available || !this.codeView) return nothing({ reason: 'not-rendered' });
      if (whenIdle && this._isListWriteHeld()) {
        this._pendingReconcile = entries;
        return nothing({ deferred: true });
      }
      this._pendingReconcile = null;
      const list = typeof entries === 'function' ? entries() : entries;
      if (!Array.isArray(list)) return nothing({ reason: 'no-list' });

      const kindOf = (entry) => (entry && entry.kind === 'context' ? 'context' : 'diff');
      const entryDiffIds = list.filter((e) => kindOf(e) === 'diff').map((e) => e.id);
      const recordDiffIds = [...this.files.values()].filter((r) => r.kind === 'diff').map((r) => r.id);
      if (!sameSequence(entryDiffIds, recordDiffIds)) return nothing({ reason: 'stale-entries' });

      const previousIds = [...this.files.keys()];
      const next = new Map();
      const created = [];
      const updated = [];
      list.forEach((entry, index) => {
        if (!entry || next.has(entry.id)) return;
        const existing = this.files.get(entry.id);
        if (existing && existing.kind === kindOf(entry)) {
          if (existing.kind === 'context' && this._applyContextEntry(existing, entry)) updated.push(existing.id);
          next.set(existing.id, existing);
          return;
        }
        const record = this._createRecord(entry, index);
        if (!record) return;
        next.set(record.id, record);
        created.push(record.id);
      });
      const removed = [];
      for (const [id, record] of this.files) {
        if (next.get(id) === record) continue;
        this._dropRecord(record);
        if (!next.has(id)) removed.push(id);
      }
      const nextIds = [...next.keys()];
      const listWritten = created.length > 0 || !sameSequence(previousIds, nextIds);

      if (!listWritten) {
        this.batch(() => { for (const id of updated) this._publish(id); });
        return { applied: true, created, removed, updated, listWritten };
      }

      this.files.clear();
      for (const [id, record] of next) this.files.set(id, record);
      this._requestListWrite();
      return { applied: true, created, removed, updated, listWritten };
    }

    /**
     * Take a kept context record's stored ranges and contents from its entry.
     * @returns {boolean} whether what the record shows changed
     * @private
     */
    _applyContextEntry(record, entry) {
      const contentsChanged = entry.contentsSeq !== undefined
        ? entry.contentsSeq !== record.contentsSeq
        : (typeof entry.contents === 'string' && entry.contents !== record.file.contents);
      const ranges = this._normalizeRanges(entry.ranges);
      const rangesChanged = !sameRanges(ranges, record.storedRanges);
      if (!contentsChanged && !rangesChanged) return false;
      if (contentsChanged) {
        // Other lines now: what was expanded by hand is not carried over.
        this._setContextContents(record, entry.contents, entry.contentsSeq);
      } else {
        this._foldManualExpansions(record);
      }
      record.storedRanges = ranges;
      // The base is new, or the hunks are: publish under a new key either way.
      record.metadata = null;
      this._derive(record);
      // The viewer's own record of the expansions is of the diff it draws,
      // and goes with that diff (not before: H120).
      this._retireExpansions(record);
      return true;
    }

    /**
     * Keep the pane's list as it is until the returned function is called:
     * a reconcile asked for with `whenIdle` waits. For a navigation in flight
     * (a smooth scroll that a list replace would cut off).
     * @returns {Function} release; calling it twice is harmless
     */
    holdListWrites() {
      this._listWriteHolds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this._listWriteHolds--;
        this._runPendingReconcile();
      };
    }

    /** @private */
    _isListWriteHeld() {
      return this._pointerDownOnRoot || this._listWriteHolds > 0;
    }

    /** @private */
    _runPendingReconcile() {
      if (this._pendingReconcile == null || this._isListWriteHeld()) return;
      const entries = this._pendingReconcile;
      this._pendingReconcile = null;
      this.reconcile(entries);
    }

    /**
     * Bring the viewer's list in line with `files`: now, or in a microtask
     * when it cannot be written now. That is when the viewer is inside one
     * of its render callbacks (a list write flushes, and a flush there
     * corrupts its layout), and when a list write is in progress: its view
     * restore tells the page of the selection it puts back and moves the
     * focus, and a handler of the page that asks for a list write there
     * gets it after the write in progress has ended, never inside it.
     * @private
     */
    _requestListWrite() {
      if (this._callbackDepth === 0 && !this._listWriteRunning) {
        this._writeList();
        return;
      }
      if (this._listWriteQueued) return;
      this._listWriteQueued = true;
      queueMicrotask(() => {
        // Nothing waits any more: a direct list write has sent the records
        // meanwhile, or the bridge was destroyed.
        if (this._listWriteQueued) this._writeList();
      });
    }

    /**
     * Run `command` on the viewer's list: now, or after the list write that
     * is waiting or in progress. Until a waiting write runs the viewer's
     * list is the old one: a scroll target or a selection sent to it would
     * be aimed at the wrong items. And one sent while a write is drawing (by
     * a hook, from the write's flush) would be undone by that write's view
     * restore.
     * @private
     */
    _onList(command) {
      if (this._listWriteQueued || this._listWriteRunning) this._afterListWrite.push(command);
      else command();
    }

    /**
     * Replace the viewer's list with the records of `files` as they are now.
     * The only caller of setItems. Never called from inside a viewer
     * callback (_requestListWrite).
     * @private
     */
    _writeList() {
      this._listWriteQueued = false;
      // Taken before anything can throw: a command never outlives the write
      // it waited for.
      const commands = this._afterListWrite;
      this._afterListWrite = [];
      // The records whose items this write takes away.
      for (const record of this._listed.values()) {
        if (!this._isCurrent(record)) this._discardRecord(record);
      }
      this._listed = new Map(this.files);
      for (const record of this.files.values()) {
        // The viewer creates new instances for every item of a new list, and
        // with them an empty expansion map: what the reader expanded by hand
        // becomes part of the record's revealed ranges first. (A new diff's
        // records have no instance: a re-render starts from the patch.)
        if (this._foldManualExpansions(record)) {
          this._derive(record);
          // The instance that holds the viewer's record of them goes with
          // the old list, in this task.
          this._expansionMap(record)?.clear();
        }
        this._forgetInstance(record);
      }
      const items = [...this.files.values()].map((record) => this._itemFor(record));
      // From here to the end of the view restore the page's hooks run (the
      // flushes mount items). A hook may ask for the next list write: `files`
      // is then ahead of `_listed` again, and the restore still addresses
      // the list this write sent. A hook may send a command: it waits for
      // the restore (_onList).
      this._listWriteRunning = true;
      try {
        if (!this.codeView) {
          this._metrics = this._measureMetrics();
          this._viewerOptions = this._buildViewerOptions();
          this.codeView = new window.PierreDiffs.CodeView(this._viewerOptions, this.workerManager || undefined);
          this.codeView.setup(this.root);
          this.codeView.setItems(items);
        } else {
          const view = this._captureView();
          // Clear, then set, in one task: the viewer cannot splice.
          this.codeView.setItems([]);
          this.codeView.setItems(items);
          this.codeView.render(true);
          this._restoreView(view);
        }
      } finally {
        this._listWriteRunning = false;
        // The commands sent while this write was drawing, after those that
        // waited for it. Taken here so that none outlives a write that threw.
        commands.push(...this._afterListWrite);
        this._afterListWrite = [];
      }
      this._runAfterListWrite(commands);
    }

    /**
     * Run the commands that waited for a list write, in call order.
     * @private
     */
    _runAfterListWrite(commands) {
      while (commands.length > 0) {
        if (!this.codeView) return;
        // A hook that ran during the write, or during one of these commands,
        // asked for the next list write: the rest wait for that one.
        if (this._listWriteQueued) {
          this._afterListWrite = commands.concat(this._afterListWrite);
          return;
        }
        const command = commands.shift();
        try {
          command();
        } catch (err) {
          console.error('[PierreBridge] a command that waited for the list write failed:', err);
        }
      }
    }

    /**
     * What a list replace would lose and can be put back: the first line
     * below the sticky header and where it is (or that the pane was at its
     * very top), the line selection, and the focused element with its caret.
     * @private
     */
    _captureView() {
      const root = this.root;
      const rootTop = root.getBoundingClientRect().top;
      const header = this._metrics.diffHeaderHeight;
      let anchor = null;
      for (const rendered of this.codeView.getRenderedItems()) {
        const box = rendered.element.getBoundingClientRect();
        if (box.bottom <= rootTop + 1) continue;
        const rows = rendered.element.shadowRoot?.querySelectorAll('[data-content] > [data-line]') || [];
        for (const row of rows) {
          const top = row.getBoundingClientRect().top - rootTop;
          if (top < header) continue;
          anchor = {
            id: rendered.id,
            itemTop: box.top - rootTop,
            line: { lineNumber: Number(row.getAttribute('data-line')), side: PierreBridge._rowSide(row), top },
          };
          break;
        }
        // No row below the header (a collapsed or row-less file, or only its
        // last card is in view): the item itself is the anchor.
        if (!anchor) anchor = { id: rendered.id, itemTop: box.top - rootTop, line: null };
        break;
      }
      const active = document.activeElement;
      let focus = null;
      if (active && active !== document.body && root.contains(active)) {
        focus = { element: active };
        try {
          if (typeof active.selectionStart === 'number') {
            focus.selection = [active.selectionStart, active.selectionEnd, active.selectionDirection];
          }
        } catch (_err) { /* an input type without a text selection */ }
      }
      return {
        anchor,
        scrollTop: root.scrollTop,
        // A reader at the very top of the pane is not "inside" the first
        // file: what a list write puts above it is shown there, as content
        // inserted at the top of a scroll container that is at offset 0 is.
        atTop: root.scrollTop <= 0,
        selection: this.codeView.getSelectedLines?.() || null,
        focus,
      };
    }

    /**
     * Put back what _captureView recorded, into the list that was just
     * written. Everything here is decided from that list (`_listed`, and the
     * item the viewer holds), never from `files`: a hook that ran in the
     * write's flush may have asked for the next list write, and `files` is
     * then the records of a list the viewer does not have yet.
     * @private
     */
    _restoreView(view) {
      const { anchor, selection, focus } = view;
      // The scroll events this restore causes are not the reader scrolling.
      this._ownScrollUntil = performance.now() + 250;
      this._endFollow = null;
      this._readerScroll = null;
      if (view.atTop) {
        // The pane stays at its top, whatever is the first file now.
        if (this.root.scrollTop !== 0) this.root.scrollTop = 0;
      } else if (anchor && this._listed.has(anchor.id)) {
        const line = anchor.line;
        // A line target is exact where an item target plus a pixel offset is
        // not (heights above the line are estimates again after the clear).
        // It needs the line to still be shown: after a new diff it may not be.
        if (line && this._listShowsLine(anchor.id, line.lineNumber, line.side)) {
          this.codeView.scrollTo({
            type: 'line',
            id: anchor.id,
            lineNumber: line.lineNumber,
            side: line.side,
            align: 'start',
            offset: line.top - this._metrics.diffHeaderHeight,
          });
        } else {
          this.codeView.scrollTo({ type: 'item', id: anchor.id, align: 'start', offset: anchor.itemTop });
        }
        this.codeView.render(true);
      } else if (view.scrollTop > 0) {
        this.root.scrollTop = view.scrollTop;
      }
      if (selection && selection.id != null && this._listed.has(selection.id)) {
        // The file may have another diff now: what it hides is cut off.
        const range = this._cutForList(selection.id, selection.range);
        if (range) this.codeView.setSelectedLines(range === selection.range ? selection : { id: selection.id, range });
      }
      if (focus && focus.element.isConnected && document.activeElement !== focus.element) {
        focus.element.focus({ preventScroll: true });
        if (focus.selection) {
          try {
            focus.element.setSelectionRange(...focus.selection);
          } catch (_err) { /* see _captureView */ }
        }
      }
    }

    /** @private */
    static _rowSide(row) {
      const column = row.closest('[data-deletions],[data-additions],[data-unified]');
      if (column?.hasAttribute('data-deletions')) return 'deletions';
      if (column?.hasAttribute('data-additions')) return 'additions';
      return (row.getAttribute('data-line-type') || '').includes('deletion') ? 'deletions' : 'additions';
    }

    // ─── Publish and flush ───────────────────────────────────────────

    /**
     * Send a record's current state to the viewer and flush.
     * @returns {boolean} false when the viewer has no item of this record:
     *   the list write that is waiting sends the record as it then is
     * @private
     */
    _publish(id) {
      const record = this.files.get(id);
      if (!this._isListed(record) || !this.codeView) return false;
      const item = this.codeView.getItem(id);
      if (!item) return false;
      // The viewer ignores an item whose version it has already seen.
      record.version++;
      this.codeView.updateItem({ ...item, ...this._itemFor(record) });
      // The viewer put its selection back on the new diff without a
      // callback (CodeView syncSelection); what the new diff hides is cut.
      const selection = this.codeView.getSelectedLines?.();
      if (selection?.id === id && selection.range) this._cutViewerSelection(id, selection.range);
      this._requestFlush();
      return true;
    }

    /**
     * Flush the viewer synchronously, unless a batch is open (one flush when
     * it closes) or the viewer is inside a render pass (one flush in a
     * microtask).
     * @private
     */
    _requestFlush() {
      if (!this.codeView) return;
      if (this._batchDepth > 0) {
        this._flushWanted = true;
        return;
      }
      if (this._callbackDepth > 0) {
        if (this._flushQueued) return;
        this._flushQueued = true;
        queueMicrotask(() => {
          this._flushQueued = false;
          this._requestFlush();
        });
        return;
      }
      this.codeView.render(true);
    }

    /**
     * Run `fn` with every publish it makes flushed once, when it returns.
     * Batches nest. Fifty single flushes cost about forty times one.
     * @param {Function} fn
     * @returns {*} what `fn` returned
     */
    batch(fn) {
      this._batchDepth++;
      try {
        return fn();
      } finally {
        this._batchDepth--;
        if (this._batchDepth === 0 && this._flushWanted) {
          this._flushWanted = false;
          this._requestFlush();
        }
      }
    }

    // ─── Viewer callbacks ────────────────────────────────────────────

    /** @private */
    _renderHeader(context) {
      const record = this._listedRecord(context?.item?.id);
      if (!record || typeof this.hooks.renderHeader !== 'function') return undefined;
      // An item whose record is no longer the pane's: the page is not asked
      // (it may not know the file any more). The item keeps the header it
      // has; one that is drawn for the first time now (the viewer draws the
      // items of a pass one after another, and a hook of an earlier item
      // took this one's file out) gets a slot without a header in it.
      // Either way the item is the height the viewer laid it out with until
      // the waiting list write.
      if (!this._isCurrent(record)) return record._headerSlot || this._emptyHeaderSlot(record);
      const header = this.hooks.renderHeader(record.id, record.kind);
      if (!header) return undefined;
      const slot = this._headerSlotOf(record);
      if (header.parentNode !== slot || slot.childElementCount !== 1) slot.replaceChildren(header);
      return slot;
    }

    /**
     * The root of a record's header slot, made on first use. With the page's
     * header in it, it is the height the viewer was told every header has
     * (itemMetrics.diffHeaderHeight): the header inside it never changes
     * the item's height.
     * @private
     */
    _headerSlotOf(record) {
      if (!record._headerSlot) {
        record._headerSlot = document.createElement('div');
        record._headerSlot.className = 'pr-file-header-slot';
      }
      return record._headerSlot;
    }

    /**
     * The header slot of an item that is drawn without the page's header
     * (_renderHeader). It carries the height the viewer was told itself:
     * measured on the real viewer, a slot that takes its height from the
     * header inside it is 0 px when empty, and the item is then 40 px
     * shorter than its layout.
     * @private
     */
    _emptyHeaderSlot(record) {
      const slot = this._headerSlotOf(record);
      slot.style.boxSizing = 'border-box';
      slot.style.height = `${this._metrics.diffHeaderHeight}px`;
      return slot;
    }

    /** @private */
    _renderAnnotation(annotation, context) {
      const record = this._listedRecord(context?.item?.id);
      if (!record || !annotation?.metadata) return undefined;
      // An item whose record is no longer the pane's: the card it has, as it
      // is. No renderer and no sync of the page runs for it; an annotation
      // of it that was never drawn stays without a card.
      if (!this._isCurrent(record)) {
        return this._elements.lookup(annotation, record.id, record.formElements) || undefined;
      }
      return this._elements.draw(annotation, record.id, record.formElements);
    }

    /** @private */
    _renderGutter(getHoveredLine, context) {
      const record = this._listedRecord(context?.item?.id);
      if (!record) return undefined;
      record._getHoveredLine = getHoveredLine;
      if (!record._gutter) {
        const id = record.id;
        record._gutter = window.PierreGutter.createGutterButtons({
          getHoveredRow: () => this.getHoveredRow(id),
          getLineSelection: () => this.getLineSelection(id),
          clearLineSelection: () => this.clearLineSelection(id),
          selectLines: (start, end, side) => this.selectLines(id, start, end, side),
          onChatClick: this.options.onChatClick
            ? (line, side, target) => this.options.onChatClick(id, line, side, target)
            : null,
          onCommentClick: (line, side, target) => {
            if (this.options.onCommentClick) this.options.onCommentClick(id, line, side, target);
          },
          // A line of a file outside the diff has no position in it: its
          // comment is posted to GitHub as a file-level comment, and the
          // button says so, as it always has on a context file.
          commentTitle: record.kind === 'context' ? 'Add comment (expanded context - may not submit to GitHub)' : undefined,
        });
        if (this._gutterHiddenByScroll) record._gutter.style.visibility = 'hidden';
      }
      return record._gutter;
    }

    /** @private */
    _onPostRender(node, instance, phase, context) {
      const id = context?.item?.id;
      // Whether the file shows a card and no line, read from what was just
      // drawn, for every item and before the viewer measures it (the
      // stylesheet keys on a class, not on :has(): PierreStyles.ROWLESS_FIX).
      // A host that goes back to the pool loses the class.
      window.PierreStyles.markRowless(context?.element || node, phase !== 'unmount');
      const record = this._listedRecord(id);
      if (!record) {
        // An item of no record (its file was taken out of the pane): the
        // pooled host must still lose what was stamped on it. The page hears
        // nothing more of a file it no longer has.
        if (phase === 'unmount') {
          this._cleanHost(context?.element || node);
          this._mountsTold.delete(id);
        }
        return;
      }
      const host = context?.element || node;
      if (phase === 'unmount') {
        // The host goes back to the pool and keeps its attributes: strip the
        // stamps, and drop the DOM reference if it still points at this host.
        this._cleanHost(host);
        if (record._element === host || !record._element?.isConnected) record._element = null;
        this._dropExpansionsOfUnmounted(record);
        this._notifyLifecycle(record, phase);
        return;
      }
      if (host) this._hostDraws.set(host, (this._hostDraws.get(host) || 0) + 1);
      record._element = host || null;
      record._instance = context?.instance || instance || record._instance;
      this._dropRetiredExpansions(record);
      this._stampHost(record, host);
      // The rows are new: a flash in progress goes on the new row.
      if (record._flash) this._applyFlash(record);
      this._queueSplitLayout(record);
      this._queueHoverRestore(id);
      this._queueTrimmedCardCheck(record);
      this._queueEndHoldLook();
      this._notifyLifecycle(record, phase);
    }

    /**
     * After every draw of a file: look for cards the viewer dropped, once
     * the pass is over (the next frame; never inside a viewer callback).
     * @private
     */
    _queueTrimmedCardCheck(record) {
      if (record._trimCheckQueued) return;
      record._trimCheckQueued = true;
      schedule(() => {
        record._trimCheckQueued = false;
        this._restoreTrimmedCards(record);
      });
    }

    /**
     * Draw a file again when the viewer has dropped the cards of one of its
     * rows (vendor fact F26, hazard H119).
     *
     * A file that shows ROWS_PER_ITEM_WINDOW rows or more is drawn in
     * windows. When the window moves, the viewer updates the rows in place:
     * it removes the rows the new window does not cover and adds the ones it
     * newly covers. Where it removes rows after the last one it keeps, it
     * also removes that row's annotation row; where it later adds rows after
     * that row again, it adds them from the next line on. The annotation row
     * is then missing in the middle of the drawn rows, with the line it
     * belongs to on screen, and stays missing until the file is drawn from
     * scratch. A publish draws it from scratch (the viewer never updates in
     * place when an item's version changed), so that is what this does.
     *
     * "Missing" is read from the rows: the line's row is drawn, another row
     * follows it, and that row is not an annotation row. A line at the very
     * end of the drawn rows is left alone: the window ends there, and the
     * viewer draws that row's cards when the window covers what follows.
     *
     * One attempt per state: when the cards are still missing after the
     * draw this asked for (same rows, same lines), it does not ask again
     * until the rows or the lines change.
     * @private
     */
    _restoreTrimmedCards(record) {
      if (!this._isListed(record) || record.collapsed) return;
      const shadowRoot = record._element?.isConnected ? record._element.shadowRoot : null;
      if (!shadowRoot) return;
      // Fewer rows than a window: drawn whole, never trimmed.
      const column = shadowRoot.querySelector('[data-content]');
      if (!column || column.children.length < ROWS_PER_ITEM_WINDOW) {
        record._trimAttempt = null;
        return;
      }
      // The old diff is still on screen: its rows are not this record's lines.
      if (!this.isDiffDisplayed(record.id)) return;
      const missing = [];
      const seen = new Set();
      for (const annotation of record.annotations) {
        if (!(annotation.lineNumber > 0)) continue;
        const key = `${annotation.side}:${annotation.lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row = this._findRow(record, annotation.lineNumber, annotation.side);
        let next = row?.nextElementSibling;
        // "No newline at end of file" is a row of its own next to the line's.
        if (next?.hasAttribute('data-no-newline')) next = next.nextElementSibling;
        if (next && !next.hasAttribute('data-line-annotation')) missing.push(key);
      }
      if (missing.length === 0) {
        record._trimAttempt = null;
        return;
      }
      const rows = shadowRoot.querySelectorAll('[data-content] > [data-line-index]');
      const state = `${rows[0]?.getAttribute('data-line-index')}|${rows[rows.length - 1]?.getAttribute('data-line-index')}|${missing.join(',')}`;
      if (record._trimAttempt === state) return;
      record._trimAttempt = state;
      this._publish(record.id);
    }

    /**
     * Tell the page that a file's item was mounted, updated or unmounted.
     * Not for a record that is no longer the pane's (removed or replaced,
     * its item still in the viewer's list until the waiting write): what the
     * page knows under that path is another file now, or none.
     *
     * 'unmount' goes by the id, not by the record: it is told exactly when
     * the page was told 'mount' under that id and the pane still has the
     * file. The old item of a replaced record, unmounted by the list write
     * or before it, is the page's 'unmount' for the 'mount' it heard; an old
     * item that was first drawn after its record had been replaced was
     * never announced, and its unmount is not either; and the page hears
     * nothing more of a file that was taken out.
     * @private
     */
    _notifyLifecycle(record, phase) {
      const id = record.id;
      if (phase === 'unmount') {
        const told = this._mountsTold.get(id) || 0;
        if (told === 0) return;
        if (told === 1) this._mountsTold.delete(id);
        else this._mountsTold.set(id, told - 1);
        if (!this.files.has(id)) return;
      } else {
        if (!this._isCurrent(record)) return;
        if (phase === 'mount') this._mountsTold.set(id, (this._mountsTold.get(id) || 0) + 1);
      }
      if (typeof this.hooks.onItemLifecycle !== 'function') return;
      try {
        this.hooks.onItemLifecycle(id, phase);
      } catch (err) {
        console.error('[PierreBridge] onItemLifecycle hook failed:', err);
      }
    }

    // ─── Host stamps ─────────────────────────────────────────────────

    /**
     * Put the file's identity and state on its host: data-file-name, the
     * base class the page's CSS and lookups key on, `context-file` for a
     * context record, `collapsed`, and whatever the page's hostState hook
     * says (generated-file, summaries-hidden-file). Hosts are pooled and keep
     * attributes, so what was stamped before is removed first.
     * @private
     */
    _stampHost(record, host) {
      if (!host || !host.classList) return;
      const classes = new Set(['d2h-file-wrapper']);
      if (record.kind === 'context') classes.add('context-file');
      if (record.collapsed) classes.add('collapsed');
      // What pr.css keys the space under the header on: the file shows lines.
      if (record.metadata?.hunks?.length > 0) classes.add('has-diff-lines');
      if (!this._isCurrent(record)) {
        // No longer the pane's record: the page is not asked about it, and
        // its host keeps what it carries until the waiting list write.
        for (const name of host._pierreBridgeStamps || []) classes.add(name);
      } else if (typeof this.hooks.hostState === 'function') {
        let extra = null;
        try {
          extra = this.hooks.hostState(record.id, record.kind);
        } catch (err) {
          console.error('[PierreBridge] hostState hook failed:', err);
        }
        for (const name of Array.isArray(extra) ? extra : []) if (name) classes.add(name);
      }
      const previous = host._pierreBridgeStamps || [];
      for (const name of previous) if (!classes.has(name)) host.classList.remove(name);
      for (const name of classes) host.classList.add(name);
      host._pierreBridgeStamps = [...classes];
      host.setAttribute('data-file-name', record.id);
    }

    /** @private */
    _cleanHost(host) {
      if (!host || !host.classList) return;
      for (const name of host._pierreBridgeStamps || []) host.classList.remove(name);
      host._pierreBridgeStamps = [];
      host.removeAttribute('data-file-name');
    }

    /**
     * Re-apply a mounted file's host stamps after the page's state for it
     * changed (the hostState hook answers differently now).
     * @param {string} fileName
     */
    refreshHostState(fileName) {
      const record = this._record(fileName);
      if (record?._element) this._stampHost(record, record._element);
    }

    /**
     * The mounted host of a file, or null. Null does NOT mean "no such
     * file": a file outside the viewer's window has no host. Ask
     * `files.has()` for that.
     * @param {string} fileName
     * @returns {HTMLElement|null}
     */
    findFileElement(fileName) {
      return this._record(fileName)?._element || null;
    }

    // ─── Split layout, hover, gutter ─────────────────────────────────

    /** @private */
    _queueSplitLayout(record) {
      if (record._splitLayoutQueued) return;
      record._splitLayoutQueued = true;
      schedule(() => {
        record._splitLayoutQueued = false;
        // Every update of an item replaces its rows, and with them the
        // classes and variables this pass puts on them.
        window.PierreAnnotations.applySplitAnnotationLayout(record._element?.shadowRoot || null, this.diffStyle);
      });
    }

    /** @private */
    _handlePointerMove(event) {
      if (event.isPrimary === false) return;
      // A move the bridge dispatched itself (hover restore) is not the reader's.
      if (!event.isTrusted) return;
      this._lastPointer = {
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        pointerId: event.pointerId || 1,
        pointerType: event.pointerType || 'mouse',
      };
      if (this._gutterHiddenByScroll) {
        this._gutterHiddenByScroll = false;
        for (const record of this._listed.values()) record._gutter?.style.removeProperty('visibility');
      }
      // The page is told of a pointer move: the press in progress, if it was
      // taken for one on the pane's scrollbar, holds no scrollbar. While a
      // scrollbar is held the browser moves it and tells the page nothing of
      // the pointer until the release (measured in Chromium: no move in a
      // thumb's drag of 8 and of 40 steps, every move of a press on the
      // pane's padding). And with no button down, a press whose release
      // never arrived (the window lost the pointer while it was held) is
      // over: a later release of something else is not its release
      // (_followEndAfterScrollbarRelease).
      if (this._scrollbarPress) this._scrollbarPress = null;
    }

    /**
     * A press began on the pane. Remembered when it is on something the
     * page put into a file (its header, its comment zone, a card, the
     * gutter buttons), with the elements it was inside of at that moment:
     * see _handlePointerUp.
     * @private
     */
    _handleRootPointerDown(event) {
      this._pointerDownOnRoot = true;
      this._press = null;
      if (!event || event.isPrimary === false || event.button !== 0) return;
      const target = typeof event.composedPath === 'function' ? event.composedPath()[0] : event.target;
      // Not the viewer's own rows, which are in its shadow tree. Lines and
      // line numbers work on pointer events. Its expand controls work on
      // `click` and lose one to a draw exactly as they do with one viewer
      // per file, where every draw re-creates the rows too: nothing is
      // added for them here.
      if (!target || target.nodeType !== 1 || target.getRootNode() !== target.ownerDocument) return;
      const host = target.closest('diffs-container');
      if (!host) return;
      // The pressed element and what it is inside of, up to the file's own
      // element, as it is now: a draw may take an inner one away for good.
      const path = [];
      for (let element = target; element && element !== host; element = element.parentElement) path.push(element);
      this._press = {
        target,
        path,
        host,
        draws: this._hostDraws.get(host) || 0,
        clicked: false,
        pointerType: event.pointerType || 'mouse',
        mouseDown: false,
        touchStart: false,
      };
    }

    /**
     * The event the browser sends right after a `pointerdown`, in the same
     * task, says which of its two ways of making a click the press is on:
     * `mousedown` for a mouse press, `touchstart` for a touch. See
     * _isMousePress.
     * @private
     */
    _notePressKind(event) {
      const press = this._press;
      if (!press || !event || event.isTrusted === false) return;
      if (event.type === 'mousedown') press.mouseDown = true;
      else if (event.type === 'touchstart') press.touchStart = true;
    }

    /**
     * Whether the browser makes this press's click the way it does for a
     * mouse. It has two ways, and only one of them can lose a click to a
     * draw (measured in Chromium with a mouse, a pen and a touch, each with
     * a draw of the file between the press and the release):
     *
     * - A mouse press, and a pen the platform reports as one. `mousedown`
     *   follows `pointerdown` at once, the browser remembers the element
     *   that was pressed, and at the release it sends `click` only if that
     *   element never left the document. A draw in between: no click.
     * - A touch, and a pen the platform reports as one. `touchstart`
     *   follows `pointerdown`; nothing is remembered. The tap is recognized
     *   after the release, and `mousedown`, `mouseup` and `click` are then
     *   sent to whatever is under the point at that moment, a few
     *   milliseconds after `pointerup`. A draw in between changes nothing:
     *   the click arrives, once.
     *
     * A click added to the second kind would be a second click, which
     * undoes the first on a toggle. So the kind is read from what the
     * browser did, not guessed from the device: `mousedown` during the
     * press is a mouse press, `touchstart` is a touch. When neither was
     * sent (a `pointerdown` listener that prevents the default takes
     * `mousedown` away, and the click with a draw is lost all the same),
     * the pointer's type decides: a touch is a touch, anything else is a
     * mouse press.
     * @private
     */
    _isMousePress(press) {
      if (press.mouseDown) return true;
      if (press.touchStart) return false;
      return press.pointerType !== 'touch';
    }

    /**
     * What a click belongs to when a press that began on `press.path[0]`
     * ends on `releaseTarget`: the innermost element the press was inside
     * of that is still in the document and has the release inside it. That
     * is the browser's own rule (a click goes to the nearest common
     * ancestor of the press and the release), read with the press's
     * ancestors as they were when it began, because the page re-stamps a
     * header's contents on every draw: the chevron's icon is a new element
     * each time (PRManager._syncFileHeader), so the icon that was pressed is
     * not the icon under the pointer at the release, and it is not coming
     * back. The button both are in is the same one.
     *
     * Null when there is no such element inside the file's own element: the
     * release was on a line of code, on another control, on another file,
     * or the control itself was replaced by another.
     * @private
     */
    _pressedControl(press, releaseTarget) {
      if (!releaseTarget || releaseTarget.nodeType !== 1) return null;
      for (const element of press.path) {
        if (element.isConnected && press.host.contains(element) && element.contains(releaseTarget)) return element;
      }
      return null;
    }

    /**
     * A press ended. Two things wait for that.
     *
     * A change of the list that was asked for while the button was down
     * runs now (reconcile).
     *
     * And a click the browser did not deliver is delivered. Every draw of a
     * file takes what the page put into it (header, comment zone, cards)
     * out of the document and puts it back. For a mouse press a browser
     * sends `click` only if the element that was pressed stayed in the
     * document from the press to the release; when a draw of the file
     * falls between the two (the file's contents arrive, a comment reload,
     * a suggestion that lands), it sends no click at all, to anything. With
     * one file per viewer the header and the comment zone are elements of
     * the page and never leave it. So: when the press was a mouse press
     * (_isMousePress: the click of a touch is not lost, and must not be
     * added to), the file was drawn between the press and the release,
     * both were on the same control (_pressedControl), and no click has
     * arrived by the end of the release's task, that control is clicked.
     * @private
     */
    _handlePointerUp(event) {
      const press = this._press;
      if (press && event && event.type === 'pointerup' && event.button === 0) {
        const target = typeof event.composedPath === 'function' ? event.composedPath()[0] : event.target;
        const drawn = (this._hostDraws.get(press.host) || 0) !== press.draws;
        const control = drawn && this._isMousePress(press) ? this._pressedControl(press, target) : null;
        if (control) {
          setTimeout(() => {
            if (this._press === press) this._press = null;
            if (press.clicked || this._destroyed || !control.isConnected) return;
            // An icon inside a button is not an element that can be clicked.
            let element = control;
            while (element && element !== press.host && typeof element.click !== 'function') element = element.parentElement;
            if (element && element !== press.host) element.click();
          }, 0);
        } else {
          this._press = null;
        }
      } else if (press && event && event.type === 'pointercancel') {
        this._press = null;
      }
      const scrollbarPress = this._scrollbarPress;
      if (scrollbarPress) {
        // The scrollbar was let go. See _followEndAfterScrollbarRelease.
        this._scrollbarPress = null;
        if (event && event.type === 'pointerup') this._followEndAfterScrollbarRelease(scrollbarPress, event);
      }
      if (!this._pointerDownOnRoot) return;
      this._pointerDownOnRoot = false;
      this._runPendingReconcile();
    }

    /**
     * The viewer's hover does not follow a scroll under a resting pointer:
     * the row it marks, and the gutter buttons on it, are where the pointer
     * was. The buttons are hidden while the pane moves. When it has come to
     * rest the viewer is told where the pointer is, so the buttons are back
     * on the row that is under it now (or gone, when no row is). A real
     * pointer move in between does the same at once.
     * @private
     */
    _handleRootScroll() {
      this._noteScrollbarScroll();
      this._followEndAfterReaderScroll();
      if (performance.now() < this._ownScrollUntil) return;
      if (!this._gutterHiddenByScroll) {
        this._gutterHiddenByScroll = true;
        for (const record of this._listed.values()) {
          if (record._gutter) record._gutter.style.visibility = 'hidden';
        }
      }
      this._watchScrollRest();
    }

    /**
     * Something the reader did that may scroll the pane, or that says they
     * are doing something else: a wheel step, a touch move, a key, a press.
     *
     * A scroll toward the end of the pane is noted, with the end of the
     * pane as it is now: a wheel step down, a touch dragged up, a key that
     * scrolls down pressed outside a text field. The scroll it causes is
     * followed when it reaches that end (_followEndAfterReaderScroll); a
     * follow that is already running goes on, it is where this scroll is
     * going too. (The hold after a collapse, _holdEndAfterCollapse, is not
     * such a follow: it ends here, at any input.)
     *
     * Everything else ends a follow that is running and forgets the last
     * scroll toward the end: a wheel step up, a touch dragged down, any
     * other key (one that scrolls up, one typed into a form), a press
     * anywhere on the pane. What the reader does next is not undone by a
     * scroll they made before it.
     *
     * A press on the pane's own scrollbar (_pressOnScrollbar) is such a
     * press, and is remembered until its release: while the reader holds
     * the scrollbar the position is the thumb's, and the browser puts it
     * back there at the next pointer move whatever was written in between.
     * @private
     */
    _noteReaderScrollInput(event) {
      const root = this.root;
      if (!root || this._destroyed) return;
      let towardEnd = false;
      if (event.type === 'keydown') {
        const target = event.target;
        const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''));
        const spaceUp = event.shiftKey && (event.key === ' ' || event.key === 'Spacebar');
        towardEnd = !typing && !spaceUp && SCROLL_DOWN_KEYS.has(event.key);
      } else if (event.type === 'wheel') {
        // A step sideways moves the pane neither way.
        if (!(event.deltaY > 0) && !(event.deltaY < 0)) return;
        towardEnd = event.deltaY > 0;
      } else if (event.type === 'touchmove') {
        const y = event.touches && event.touches[0] ? event.touches[0].clientY : null;
        const from = this._touchY;
        this._touchY = y;
        if (y === null || from === null || y === from) return;
        // The finger moves up: the pane moves toward its end.
        towardEnd = y < from;
      } else if (event.type === 'pointerdown') {
        this._scrollbarPress = this._pressOnScrollbar(event)
          ? { y: event.clientY, from: root.scrollTop, top: root.scrollTop, moved: false, atEnd: false }
          : null;
        this._touchY = event.pointerType === 'touch' ? event.clientY : null;
      }
      if (!towardEnd) {
        this._endFollow = null;
        this._readerScroll = null;
        return;
      }
      // The hold after a collapse ends at any input of the reader's, a
      // scroll toward the end included: from here on the pane is theirs,
      // and what that scroll does at the end is _followEndAfterReaderScroll's.
      if (this._endFollow?.hold) this._endFollow = null;
      this._readerScroll = { at: performance.now(), end: root.scrollHeight - root.clientHeight };
    }

    /**
     * Whether a press may be one on the pane's own scrollbar: it is a
     * press of the primary button, its target is the pane itself (the
     * browser sends a press on a scrollbar to the element that scrolls),
     * and it is where the scrollbar is, at the pane's right edge. A
     * scrollbar with a width of its own, beside the content, is that wide,
     * and a press there is on nothing else. One the browser draws over the
     * content has none, and neither has one that is not drawn: there the
     * strip is OVERLAY_SCROLLBAR_PX of the pane's own padding, and a press
     * in it may hold no scrollbar at all.
     *
     * So a press that passes is a candidate, no more. What tells a held
     * scrollbar from a press on the padding is what follows it: the page
     * is told of no pointer move while a scrollbar is held
     * (_handlePointerMove forgets the press at the first one), and the
     * pane's position changes under it (_noteScrollbarScroll,
     * _followEndAfterScrollbarRelease). Without the two, a drag that
     * began on the padding and was let go at the pane's bottom edge sent
     * the reader to the end of the review (44,843 px from 3,122 on a
     * review of 60 files), with a text selection or without.
     * @private
     */
    _pressOnScrollbar(event) {
      const root = this.root;
      if (event.target !== root || event.button !== 0) return false;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
      const rect = root.getBoundingClientRect();
      const own = rect.right - (rect.left + root.clientLeft + root.clientWidth);
      const strip = own >= 1 ? own : OVERLAY_SCROLLBAR_PX;
      return event.clientX >= rect.right - strip && event.clientX <= rect.right;
    }

    /**
     * Keep the pane at its end when the reader scrolled it there.
     *
     * The pane's height is an estimate for every file the viewer has not
     * drawn: a file with wrapping lines is taller than its estimate. When
     * the reader goes to the end (the End key, the wheel), the last files
     * are drawn and measured in the frames after the scroll, the pane
     * grows, and the place the scroll ended at is no longer the end: on a
     * review of eight 600-line files with a wrapping line in every ten it
     * was 2,095 px short, and a second scroll was needed. So a scroll
     * toward the end that the reader started (_noteReaderScrollInput) and
     * that reaches the end of the pane (as it is now, or as it was when
     * they started) is followed: for as long as the pane goes on growing,
     * and nothing else has moved it, it is put at its end again
     * (_startEndFollow).
     *
     * The input is used up by the follow it starts. A later scroll event,
     * of whatever cause, starts another one only after another input
     * toward the end: without this, the position beyond the remembered
     * (old, smaller) end counted as "reached the end" for every scroll in
     * the next second and a half, and a Page Up pressed right after End was
     * undone.
     *
     * Only the reader's own scroll is followed. A position the application
     * writes (a navigation, a view restore) is somebody's target, and the
     * end of the pane is not. And nothing is followed while the reader
     * holds the pane's scrollbar: see _followEndAfterScrollbarRelease.
     * @private
     */
    _followEndAfterReaderScroll() {
      const root = this.root;
      const input = this._readerScroll;
      if (!root || !input || this._endFollow) return;
      if (performance.now() - input.at > READER_SCROLL_MS) {
        this._readerScroll = null;
        return;
      }
      const end = root.scrollHeight - root.clientHeight;
      if (end <= 0 || root.scrollTop < Math.min(end, input.end) - 1) return;
      this._readerScroll = null;
      this._startEndFollow();
    }

    /**
     * A scroll while the reader holds the pane's scrollbar: that the
     * position changed under the press, and whether the thumb has been at
     * the end of its track in this press and has not been taken back up
     * since. Read at the release (_followEndAfterScrollbarRelease).
     *
     * A scroll that leaves the pane at its end says the thumb is at the end
     * of its track. The pane growing afterwards moves nothing and is no
     * scroll. The browser then moves the thumb down again by as much as the
     * pointer is ahead of it, which may not be all the way: such a scroll
     * goes down and leaves the answer as it is. A scroll that goes up is the
     * reader taking the thumb back.
     * @private
     */
    _noteScrollbarScroll() {
      const press = this._scrollbarPress;
      const root = this.root;
      if (!press || !root) return;
      const top = root.scrollTop;
      const end = root.scrollHeight - root.clientHeight;
      if (Math.abs(top - press.top) > 1) press.moved = true;
      if (end > 0 && top >= end - 1) press.atEnd = true;
      else if (top < press.top - 1) press.atEnd = false;
      press.top = top;
    }

    /**
     * The reader let go of the pane's scrollbar. When they had taken it to
     * the end, the pane is put at its end and kept there while the files
     * at the end are measured, as after a key or the wheel.
     *
     * Only a press that held the scrollbar: one that began where the
     * scrollbar is (_pressOnScrollbar), during which the page was told of
     * no pointer move (_handlePointerMove), and under which the pane's
     * position changed. A press that moved nothing is let go with nothing
     * done, wherever the pane is.
     *
     * "Taken to the end" is one of three things:
     *  - the pane is at its end at the release;
     *  - the thumb was at the end of its track during the press and was
     *    not taken back up (_noteScrollbarScroll), and the pane has grown
     *    since: the files down there are measured in the frames after the
     *    thumb arrives;
     *  - the pointer was pulled down the scrollbar to the pane's bottom
     *    edge or beyond it (_pulledToTrackEnd). The browser moves a thumb
     *    by as much as the pointer moves; a pane that grows while it is
     *    dragged slides the thumb back up under the pointer, and the
     *    pointer is at the bottom of the track before the thumb is
     *    (measured on a review of eight 600-line files with wrapping
     *    lines: 2,883 px short with the pointer at the pane's bottom
     *    edge; main, whose pane grows by a quarter as much, 0).
     *
     * Not before the release. A thumb that is held decides the position:
     * the browser computes it from the pointer at every pointer move, so a
     * position written to the end during a drag is put back at the next
     * move (measured: a jump of about 4,000 px to the end and back for
     * each time the pane grew), and a thumb the reader then drags up would
     * be fought. Until the release the reader sees where the thumb is.
     * Released anywhere else, nothing is followed.
     * @param {{y: number, from: number, top: number, moved: boolean, atEnd: boolean}} press - the press that began on the scrollbar
     * @param {PointerEvent} event - its `pointerup`
     * @private
     */
    _followEndAfterScrollbarRelease(press, event) {
      const root = this.root;
      if (!root || this._destroyed || this._endFollow) return;
      const end = root.scrollHeight - root.clientHeight;
      if (end <= 0) return;
      // The last scroll of the press may not have been reported yet.
      if (!press.moved && Math.abs(root.scrollTop - press.top) <= 1) return;
      if (root.scrollTop < end - 1 && !press.atEnd && !this._pulledToTrackEnd(press, event)) return;
      this._startEndFollow();
    }

    /**
     * Whether a press that held the pane's scrollbar was a pull down to
     * the end of its track: the pointer went down, the pane went down with
     * it, and it was let go at the pane's bottom edge or below it. With a
     * thumb that follows the pointer that is the end of the track whatever
     * the thumb's length and wherever it was taken hold of.
     * @private
     */
    _pulledToTrackEnd(press, event) {
      const root = this.root;
      if (!Number.isFinite(press.y) || !Number.isFinite(event.clientY)) return false;
      if (event.clientY - press.y < SCROLLBAR_PULL_PX) return false;
      if (root.scrollTop <= press.from + 1) return false;
      return event.clientY >= root.getBoundingClientRect().bottom - 1;
    }

    /**
     * Put the pane at its end in every frame in which it is not, until its
     * height has not grown for END_FOLLOW_STILL_FRAMES frames, for
     * END_FOLLOW_MAX_MS at most, and only while nothing else moves it: an
     * input of the reader's or a scroll of the application's ends the
     * follow (`_endFollow = null`), and so does a position above the one
     * the follow last saw.
     * @private
     */
    _startEndFollow() {
      const root = this.root;
      const follow = { until: performance.now() + END_FOLLOW_MAX_MS, still: 0, top: root.scrollTop };
      this._endFollow = follow;
      const tick = () => {
        if (this._endFollow !== follow) return;
        if (this._destroyed || this.root !== root || root.scrollTop < follow.top - 1) {
          // Gone, or something moved the pane up: that was not this follow.
          this._endFollow = null;
          return;
        }
        const now = root.scrollHeight - root.clientHeight;
        if (now - root.scrollTop > 0.5) {
          root.scrollTop = now;
          follow.still = 0;
        } else {
          follow.still++;
        }
        follow.top = root.scrollTop;
        if (follow.still >= END_FOLLOW_STILL_FRAMES || performance.now() > follow.until) {
          this._endFollow = null;
          return;
        }
        schedule(tick);
      };
      tick();
    }

    /**
     * Wait until the pane has come to rest, then re-derive the hover from
     * the resting pointer.
     *
     * At rest: not moved for two frames. With a long file mounted, not
     * moved for SCROLL_REST_FRAMES frames and SCROLL_REST_MS, because what
     * follows is not free there. The viewer marks the row under the pointer
     * by moving its gutter button into that row, and the browser lays the
     * file's rows out again for it: 7 ms in a file of 5,000 drawn rows and
     * 16 ms in one of 10,000, measured, and nothing a reader could tell in
     * a file of a few hundred. The steps of a wheel and the frames of a
     * smooth scroll are more than two frames apart often enough; in a long
     * file that was a layout of the whole file between the steps of one
     * scroll gesture (H169).
     * @private
     */
    _watchScrollRest() {
      if (this._scrollRestWatched) return;
      this._scrollRestWatched = true;
      let last = this.root ? this.root.scrollTop : 0;
      let still = 0;
      let movedAt = performance.now();
      const tick = () => {
        if (!this._gutterHiddenByScroll || !this.root || this._destroyed) {
          // A real pointer move showed the buttons already, or the viewer is gone.
          this._scrollRestWatched = false;
          return;
        }
        const now = this.root.scrollTop;
        if (now !== last) {
          last = now;
          still = 0;
          movedAt = performance.now();
        } else {
          still++;
        }
        const rested = still >= 2
          && (!this._hasLongFileMounted() || (still >= SCROLL_REST_FRAMES && performance.now() - movedAt >= SCROLL_REST_MS));
        if (!rested) {
          schedule(tick);
          return;
        }
        this._scrollRestWatched = false;
        this._rederiveHoverAtRest();
      };
      schedule(tick);
    }

    /**
     * Whether a file that shows COSTLY_HOVER_ROWS rows or more is mounted
     * (see _watchScrollRest). From the diffs the bridge published, not from
     * the document.
     * @private
     */
    _hasLongFileMounted() {
      for (const record of this._listed.values()) {
        if (!record._element || !record._element.isConnected || record.collapsed) continue;
        if (PierreBridge.drawnRowCount(record.metadata, this.diffStyle) >= COSTLY_HOVER_ROWS) return true;
      }
      return false;
    }

    /**
     * The pane is at rest after a scroll: tell the file under the pointer
     * where the pointer is, so that it marks the row that is under it now,
     * and show the buttons again. A file the pointer is no longer over has
     * been told so by the browser (it reports a pointer that an element
     * moved away from as having left it), and marks no row.
     * @private
     */
    _rederiveHoverAtRest() {
      const pos = this._lastPointer;
      if (pos) {
        for (const record of this._listed.values()) {
          const host = record._element;
          if (host && host.isConnected && this._tellPointer(host, pos)) break;
        }
      }
      this._gutterHiddenByScroll = false;
      for (const record of this._listed.values()) record._gutter?.style.removeProperty('visibility');
    }

    /**
     * Dispatch a pointer move at `pos` into a file's rows, when `pos` is over
     * them. The viewer handles it in the same task.
     * @returns {boolean} whether the move was dispatched into the file's rows
     * @private
     */
    _tellPointer(host, pos) {
      const box = host.getBoundingClientRect();
      if (pos.clientX < box.left || pos.clientX > box.right || pos.clientY < box.top || pos.clientY > box.bottom) return false;
      const target = host.shadowRoot?.elementFromPoint?.(pos.clientX, pos.clientY);
      if (!target || typeof window.PointerEvent !== 'function') return false;
      // The viewer listens on the code block; a point on the header is not in it.
      if (typeof target.closest !== 'function' || !target.closest('pre')) return false;
      target.dispatchEvent(new window.PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: pos.clientX,
        clientY: pos.clientY,
        screenX: pos.screenX || 0,
        screenY: pos.screenY || 0,
        pointerId: pos.pointerId,
        pointerType: pos.pointerType,
        isPrimary: true,
      }));
      return true;
    }

    /**
     * Whether the pointer is over a file's host.
     * @param {string} fileName
     * @returns {boolean}
     */
    isPointerOverFile(fileName) {
      const host = this._record(fileName)?._element;
      return !!host && host.isConnected && host.matches(':hover');
    }

    /**
     * Whether the focused element is inside a file's host (a comment form
     * being typed in). Replacing the file's diff drops that focus.
     * @param {string} fileName
     * @returns {boolean}
     */
    hasFocusInside(fileName) {
      const host = this._record(fileName)?._element;
      const active = document.activeElement;
      return !!host && !!active && active !== document.body && host.contains(active);
    }

    /**
     * Whether the reader is typing in a file: the keyboard focus is in a
     * text field of one of its cards or forms. Every update of a file's diff
     * re-creates its rows and takes the focus away from what is slotted into
     * it (the text is kept), so a background update asks this first.
     * @param {string} fileName
     * @returns {boolean}
     */
    isEditingInside(fileName) {
      if (!this.hasFocusInside(fileName)) return false;
      const active = document.activeElement;
      return typeof active.matches === 'function'
        && active.matches('textarea, input, select, [contenteditable=""], [contenteditable="true"]');
    }

    /**
     * After an item is drawn again its rows are new: the hovered-row mark and
     * the gutter buttons are gone until the pointer moves. When the pointer
     * rests on the item, tell the viewer where it is.
     * @private
     */
    _queueHoverRestore(id) {
      if (!this._lastPointer || this._hoverRestoreQueued.has(id)) return;
      this._hoverRestoreQueued.add(id);
      schedule(() => {
        this._hoverRestoreQueued.delete(id);
        const pos = this._lastPointer;
        const host = this.files.get(id)?._element;
        if (!pos || !host || !host.isConnected || this._gutterHiddenByScroll) return;
        this._tellPointer(host, pos);
      });
    }

    /**
     * The line the viewer reports as hovered in a file, in the viewer's own
     * terms.
     * @param {string} fileName
     * @returns {{lineNumber: number, side: string}|undefined}
     */
    getHoveredLine(fileName) {
      const record = this._record(fileName);
      if (!record || typeof record._getHoveredLine !== 'function') return undefined;
      try {
        return record._getHoveredLine() || undefined;
      } catch (_err) {
        // The getter belongs to an instance a list write replaced.
        return undefined;
      }
    }

    /**
     * The hovered line of a file with the app's side. On a context file the
     * side is always 'RIGHT'.
     * @param {string} fileName
     * @returns {{lineNumber: number, side: 'LEFT'|'RIGHT'}|null}
     */
    getHoveredRow(fileName) {
      const record = this._record(fileName);
      const hovered = record ? this.getHoveredLine(record.id) : undefined;
      if (!hovered) return null;
      return { lineNumber: hovered.lineNumber, side: this._appSide(record, hovered.side) };
    }

    // ─── Line selection ──────────────────────────────────────────────

    /**
     * The line selection, when it is in this file. The viewer has one
     * selection for the whole pane.
     * @param {string} fileName
     * @returns {{start: number, end: number, side: string}|null}
     */
    getLineSelection(fileName) {
      const record = this._record(fileName);
      // Before its list write a record has no item: a selection under its id
      // is in the file it replaced.
      const selection = this._isListed(record) ? this.codeView?.getSelectedLines?.() : null;
      if (!selection || selection.id !== record.id || !selection.range) return null;
      // The bridge keeps the viewer's selection cut (_cutViewerSelection);
      // asked again here so that no reader ever gets a hidden line.
      const range = this._cutForList(record.id, selection.range);
      if (!range) return null;
      const { start, end, side } = range;
      return { start: Math.min(start, end), end: Math.max(start, end), side: this._appSide(record, side) };
    }

    /**
     * A line range cut back to the run of shown lines (_shownRuns) that
     * holds its first line: nothing beyond the nearest hidden lines in the
     * direction of the drag. The viewer's ranges have the line a gesture
     * started on (its anchor) as `start` and the line under the pointer as
     * `end`, whichever is higher; `endSide` when the end is in the other
     * column of a split layout. Hidden lines are unchanged lines, the same
     * lines on both sides, so the n-th run of one side is the n-th run of
     * the other: an end in the other column is cut at that column's run.
     * A diff where a run has lines on one side only (hunks without context
     * lines; neither GitHub's patches nor the local diff make them) keeps
     * the one line the gesture started on. A cut end is the run's first or
     * last row, named as _addressCutEnd says.
     * @param {Object} record
     * @param {Object} metadata - the diff the range is a range of
     * @param {{start: number, end: number, side?: string, endSide?: string}|null} range
     *   - the viewer's
     * @param {Map|null} [map] - the expansion map drawn with `metadata`
     *   (default: the one that belongs to the record's metadata,
     *   _expansionMap)
     * @returns {Object|null} the range itself when it crosses no hidden
     *   line, a cut copy, or null when its first line is not shown
     * @private
     */
    _cutToShownRun(record, metadata, range, map) {
      if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)) return range;
      const side = range.side || 'additions';
      const runs = this._shownRuns(record, metadata, side, map);
      const index = runs.findIndex((run) => range.start >= run.startLine && range.start <= run.endLine);
      if (index < 0) return null;
      let run = runs[index];
      const endSide = range.endSide || side;
      if (record.kind !== 'context' && PierreBridge.toPierreSide(endSide) !== PierreBridge.toPierreSide(side)) {
        const other = this._shownRuns(record, metadata, endSide, map);
        if (other.length !== runs.length) {
          const single = { start: range.start, end: range.start };
          if (range.side) single.side = range.side;
          return single;
        }
        run = other[index];
      }
      const end = Math.min(Math.max(range.end, run.startLine), run.endLine);
      return end === range.end ? range : this._addressCutEnd(record, metadata, range, end);
    }

    /**
     * The range cut at `end`, a boundary row of the run, with that row named
     * on the side the viewer and the page can use. The row is normally an
     * unchanged line (a hunk's context or a line drawn outside the hunks),
     * which has a number on both sides, and is named:
     *
     * - on the side the range started on, so that the whole range is in one
     *   side's numbers: getLineSelection answers `start` and `end` under the
     *   start's side, and an end left in the other side's numbers names
     *   another line wherever old and new numbers differ (a comment on new
     *   64 up to the old 56 would post new 56-64, three hidden lines);
     * - except in unified layout for a range that started on a deleted row
     *   and is cut at its bottom: unified layout draws an unchanged line
     *   once, as an additions row, and the viewer places the gutter's
     *   buttons on the bottom row of a selection by that row's own side
     *   (InteractionManager.targetForSelectionPoint); named on the deletions
     *   side, the row is found by its index and highlighted, but no button
     *   is placed on it, nor, while the selection lasts, on any other row of
     *   the file. Named on the additions side, it is what the viewer reports
     *   for a release on that row.
     *
     * A boundary row that is not an unchanged line (a run that ends in a
     * change; no patch GitHub or the local diff makes has one next to
     * hidden lines) keeps the side it was cut on.
     * @param {Object} record
     * @param {Object} metadata - the diff the range is a range of
     * @param {{start: number, end: number, side?: string, endSide?: string}} range
     * @param {number} end - the boundary row, on the side the range ends on
     * @returns {Object} a copy of `range`
     * @private
     */
    _addressCutEnd(record, metadata, range, end) {
      const cut = { ...range, end };
      if (record.kind === 'context') return cut;
      const startSide = PierreBridge.toPierreSide(range.side || 'additions');
      const endSide = PierreBridge.toPierreSide(range.endSide || range.side || 'additions');
      const bottom = range.end > end;
      const named = this.diffStyle !== 'split' && startSide === 'deletions' && bottom ? 'additions' : startSide;
      if (named === endSide) return cut;
      const twin = PierreBridge._unchangedTwin(metadata, end, endSide);
      if (twin == null) return cut;
      cut.end = twin;
      if (named === startSide) delete cut.endSide;
      else cut.endSide = named;
      return cut;
    }

    /**
     * The number on the other side of a line of `metadata` that is
     * unchanged: in a context block of a hunk, or outside the hunks (hidden
     * or drawn by an expansion). Null for a deleted or added line.
     * @param {Object} metadata
     * @param {number} line
     * @param {string} side - the viewer's side `line` is on
     * @returns {number|null}
     * @private
     */
    static _unchangedTwin(metadata, line, side) {
      const hunks = Array.isArray(metadata?.hunks) ? metadata.hunks : [];
      const from = side === 'deletions' ? 'deletion' : 'addition';
      const to = side === 'deletions' ? 'addition' : 'deletion';
      // Other side minus this side, for the lines between the hunks so far.
      let offset = 0;
      for (const hunk of hunks) {
        const start = hunk[`${from}Start`];
        const count = hunk[`${from}Count`];
        // A hunk with no line on this side (a new or deleted file: no hidden
        // lines) only moves the numbers after it.
        if (count > 0) {
          if (line < start) return line + offset;
          if (line < start + count) {
            for (const block of hunk.hunkContent || []) {
              const at = start + block[`${from}LineIndex`] - hunk[`${from}LineIndex`];
              if (block.type === 'context') {
                if (line >= at && line < at + block.lines) {
                  return hunk[`${to}Start`] + block[`${to}LineIndex`] - hunk[`${to}LineIndex`] + (line - at);
                }
              } else if (line >= at && line < at + block[`${from}s`]) {
                return null;
              }
            }
            return null;
          }
        }
        offset += side === 'deletions'
          ? hunk.additionLines - hunk.deletionLines
          : hunk.deletionLines - hunk.additionLines;
      }
      return line + offset;
    }

    /**
     * _cutToShownRun against the item the viewer holds for `id`: what is
     * sent to the viewer is decided from its list (H103 rule 5). A range of
     * an item the viewer's list does not have is answered as it is: there
     * is nothing to cut it against.
     *
     * And against the diff the file draws, when that is another one: a
     * mounted file goes on drawing its present diff until the new one has
     * been highlighted (F28; a content upgrade, a reveal that loads the
     * contents first, the frame before the viewer's next pass). The item
     * then shows lines the screen does not, and a drag across a separator
     * that is still drawn would hold rows on both sides of it, and a cut
     * end on a row that is not drawn would leave the gutter's buttons with
     * no row to sit on. The diff that replaces the one on screen shows the
     * lines of both cuts, so the selection stays right when it is drawn.
     * @private
     */
    _cutForList(id, range) {
      const record = this._listedRecord(id);
      const item = record ? this.codeView?.getItem?.(id) : null;
      if (!item) return range;
      const cut = this._cutToShownRun(record, item.fileDiff, range);
      const drawn = record._element?.isConnected ? record._instance?.getRenderedDiff?.() : null;
      if (!cut || !drawn || drawn === item.fileDiff) return cut;
      return this._cutToShownRun(record, drawn, cut, this._drawnExpansionMap(record, drawn));
    }

    /**
     * The expansion map the viewer draws `drawn` with: the map itself while
     * it is not retired, or while it is retired for `drawn` (_retireExpansions
     * keeps it for the diff on screen); no map when it was retired for
     * another diff.
     * @private
     */
    _drawnExpansionMap(record, drawn) {
      const map = record._instance?.hunksRenderer?.expandedHunks || null;
      if (record._expansionsOf && record._expansionsOf !== drawn) return null;
      return map;
    }

    /**
     * Keep the viewer's selection within what its item shows. Called by each
     * of the viewer's selection callbacks (the press, every row the pointer
     * reaches, the release), after the viewer's own wrapper has made the
     * uncut range its selection, and after a publish (the viewer puts its
     * selection back on the new diff without a callback). A cut range
     * replaces the viewer's selection at once, without a callback: the
     * viewer draws a selection that changed with the pointer in the next
     * frame, and draws a range it is given at once, so the uncut range is
     * never drawn. Not deferred to the list write (_onList): it corrects
     * the item the viewer has now, and a waiting write keeps the corrected
     * selection (_captureView). The pointer's next row is reported from the
     * anchor again and cut again.
     * @param {string} id
     * @param {Object|null} range - the viewer's
     * @returns {Object|null} the range every consumer is to see
     * @private
     */
    _cutViewerSelection(id, range) {
      if (!range || id == null || !this.codeView) return range;
      const cut = this._cutForList(id, range);
      if (cut === range) return range;
      if (cut) {
        this.codeView.setSelectedLines({ id, range: cut }, { notify: false });
      } else if (this.codeView.getSelectedLines?.()?.id === id) {
        this.codeView.clearSelectedLines({ notify: false });
      }
      return cut;
    }

    /**
     * Clear the line selection if it is in this file.
     * @param {string} fileName
     */
    clearLineSelection(fileName) {
      const id = this._record(fileName)?.id;
      if (id == null || !this.codeView) return;
      this._onList(() => {
        if (this.codeView.getSelectedLines?.()?.id === id) this.codeView.clearSelectedLines();
      });
    }

    /**
     * Select lines of a file, cut back at hidden lines from `start`
     * (_cutToShownRun): `start` is the line a gesture started on, and may be
     * the higher one. Nothing is selected when `start` is not shown.
     * @param {string} fileName
     * @param {number} start
     * @param {number} end
     * @param {string} side - 'LEFT'/'RIGHT'
     */
    selectLines(fileName, start, end, side) {
      const record = this._record(fileName);
      if (!record || !this.codeView) return;
      const id = record.id;
      const range = { start, end, side: this._annotationSide(record, side) };
      this._onList(() => {
        if (!this._listed.has(id)) return;
        const cut = this._cutForList(id, range);
        if (cut) this.codeView.setSelectedLines({ id, range: cut });
      });
    }

    // ─── Collapse ────────────────────────────────────────────────────

    /**
     * Collapse or expand a file. Works for a file that is not mounted.
     *
     * The one place that moves the pane on a collapse. A file collapsed
     * while the reader is inside it keeps its header at the place in the
     * pane it had (_stuckHeaderOffset), with the files after it below; a
     * pane that is too short for that now is at its end. A file whose
     * header is not stuck and a file that is not mounted move nothing.
     * When the pane's end kept the collapsed header below the place it had,
     * the pane is held at its end while the files that came into view above
     * it are given their contents (_holdEndAfterCollapse).
     *
     * An expand is not anchored: when the file is in the pane or reaches
     * into it from above, the pane's scroll position stays the number it
     * was. A collapsed header that was partly above the pane's top edge
     * drops to that edge with the file's first rows under it, and the pane
     * is not moved to make up for it.
     * @param {string} fileName
     * @param {boolean} collapsed
     * @returns {boolean} false when there is no such file
     */
    setCollapsed(fileName, collapsed) {
      const record = this._record(fileName);
      if (!record) return false;
      if (record.collapsed === !!collapsed) return true;
      // A collapse or an expand decides where the pane is: a follow of the
      // pane's end, or the hold of an earlier collapse, ends here.
      this._endFollow = null;
      // Read before the publish: collapsed, the file is its header alone.
      // (Left to itself the viewer anchors on a row that no longer exists
      // and the pane ends up somewhere else.)
      const headerOffset = collapsed ? this._stuckHeaderOffset(record) : null;
      // Where the header is now, stuck or in view: the place a collapse
      // keeps it at when the pane is long enough for that.
      const headerPlace = !collapsed ? null : headerOffset !== null ? headerOffset : this._headerTop(record);
      // Left to itself the viewer moves the pane by a few pixels when the
      // file that expands is at the pane's top edge.
      const expandAt = !collapsed && this._reachesIntoPane(record) ? this.root.scrollTop : null;
      record.collapsed = !!collapsed;
      // One flush for the publish and the target: the viewer draws the
      // collapsed file where its header was, in this task, and never
      // anywhere else first.
      this.batch(() => {
        this._publish(record.id);
        if (headerOffset !== null) {
          this._scrollTo({ type: 'item', id: record.id, align: 'start', offset: headerOffset, behavior: 'instant' });
        }
      });
      if (expandAt !== null && this.root && this.root.scrollTop !== expandAt) this.root.scrollTop = expandAt;
      if (headerPlace !== null) this._holdEndAfterCollapse(record, headerPlace);
      return true;
    }

    /**
     * Where the header of the file the reader is inside is, in pixels from
     * the pane's top edge: 0 while it is stuck there, negative once the
     * file's last rows have pushed it partly above that edge. Null when the
     * reader is not inside the file: it is not mounted, it starts at or
     * below the pane's top (its header is not stuck), or it ends above it.
     * @private
     */
    _stuckHeaderOffset(record) {
      const element = record._element;
      if (!element?.isConnected || !this.root) return null;
      const paneTop = this.root.getBoundingClientRect().top;
      const box = element.getBoundingClientRect();
      if (!(box.top < paneTop - 0.5 && box.bottom > paneTop)) return null;
      const header = record._headerSlot;
      if (!header?.isConnected) return 0;
      return Math.min(0, header.getBoundingClientRect().top - paneTop);
    }

    /**
     * Whether a file is mounted and ends below the pane's top edge: it is
     * in the pane, below it, or reaches into it from above. (A file that
     * ends above the pane is the viewer's to keep the reader's place
     * under.)
     * @private
     */
    _reachesIntoPane(record) {
      const element = record._element;
      if (!element?.isConnected || !this.root) return false;
      return element.getBoundingClientRect().bottom > this.root.getBoundingClientRect().top;
    }

    /**
     * Where a mounted file's header is, in pixels from the pane's top edge
     * (negative above it). Null for a file that is not mounted.
     * @private
     */
    _headerTop(record) {
      const element = record._element;
      if (!element?.isConnected || !this.root) return null;
      const header = record._headerSlot?.isConnected ? record._headerSlot : element;
      return header.getBoundingClientRect().top - this.root.getBoundingClientRect().top;
    }

    /**
     * Keep the pane at its end after a collapse that its end cut short.
     *
     * A collapse keeps the file's header at the place it had (setCollapsed)
     * when the pane is long enough below that header. When it is not, the
     * pane is at its end and the header is further down: the last file of a
     * review collapsed from inside it ends with its header 503 px below the
     * pane's top in the measured review, and the files before it come into
     * view above it. Those files were not mounted before. They are drawn
     * from their patches, their contents are asked for now and arrive later
     * (0.03 to 0.1 s; ten seconds while the pointer rests on such a file,
     * which is where it is after a click on a header that was at the pane's
     * top), and each grows by the lines its contents add (144 px for the
     * file above, measured). The viewer keeps the line at the pane's top
     * where it is when a file grows, so the pane was then 92 px short of
     * its end and the collapsed header at 595 px in a pane of 597 px, out
     * of view. With one renderer per file those files had their contents
     * before the collapse and nothing moved.
     *
     * So after such a collapse the pane is held at its end: whenever its
     * end has moved away from it, it is put there again before the frame
     * is drawn, but never further than the collapsed header's own place
     * (once the pane is long enough for the header to be where it was, the
     * collapse is what it would have been, and the hold is over).
     *
     * Nothing is held when the header is where it was: the pane's end did
     * not come into it, and what the pane does next is not the collapse's.
     *
     * The hold ends
     *  - at any input of the reader's: a wheel step, a key, a touch move,
     *    a press on the pane, its scrollbar included (_noteReaderScrollInput);
     *  - at a scroll target or a view restore of the application's, and at
     *    the next collapse or expand;
     *  - when something else has moved the pane up (a scroll made by a
     *    script; a pane that got shorter and is still at its end is not that);
     *  - when the header is back at its place;
     *  - when the collapsed file is no longer the pane's;
     *  - when nothing is awaited (_awaitsContents) and the pane has not
     *    changed for END_FOLLOW_STILL_FRAMES frames;
     *  - after END_HOLD_MAX_MS, whatever is still awaited.
     * It writes a position only when the pane's end has moved away since
     * it last saw the pane at its end; a pane that is short of its end for
     * any other reason is left where it is.
     * @param {Object} record - the file that was collapsed
     * @param {number} headerPlace - where its header was before the
     *   collapse, in px from the pane's top edge
     * @private
     */
    _holdEndAfterCollapse(record, headerPlace) {
      const root = this.root;
      // Not when the collapse is not drawn yet (asked for inside a batch,
      // from a viewer callback, or with a list write waiting).
      if (!root || this._destroyed || this._batchDepth > 0 || this._callbackDepth > 0) return;
      if (this._listWriteQueued || this._listWriteRunning) return;
      const end = Math.max(0, root.scrollHeight - root.clientHeight);
      if (root.scrollTop < end - 1) return;
      const now = this._headerTop(record);
      if (now === null || now - headerPlace <= 1) return;
      const hold = {
        hold: true, record, headerPlace, until: performance.now() + END_HOLD_MAX_MS, still: 0, top: root.scrollTop, end, queued: false,
      };
      // Look at the pane: put it at its end when its end has moved away,
      // and say whether the hold goes on. `frame`: this look is the one of
      // a new frame (the frames at rest are counted; a look after a draw
      // is not one).
      hold.look = (frame) => {
        if (this._endFollow !== hold) return false;
        const over = () => {
          this._endFollow = null;
          return false;
        };
        if (this._destroyed || this.root !== root || this._listed.get(record.id) !== record) return over();
        const top = root.scrollTop;
        const endNow = Math.max(0, root.scrollHeight - root.clientHeight);
        const atEnd = top >= endNow - 0.5;
        // Something moved the pane up: that was not this hold.
        if (top < hold.top - 1 && !atEnd) return over();
        if (atEnd) {
          // At its end, as it was or because it got shorter.
          if (endNow !== hold.end || top !== hold.top || this._awaitsContents()) hold.still = 0;
          else if (frame) hold.still++;
          hold.top = top;
          hold.end = endNow;
        } else if (endNow > hold.end + 0.5) {
          // The pane grew under a reader who was at its end.
          const header = this._headerTop(record);
          const room = header === null ? 0 : header - hold.headerPlace;
          // The header is where it was (or the file is not drawn): done.
          if (room <= 0.5) return over();
          root.scrollTop = Math.min(endNow, top + room);
          hold.top = root.scrollTop;
          hold.end = endNow;
          hold.still = 0;
          // The pane is long enough for the header's place now.
          if (hold.top < endNow - 0.5) return over();
        }
        if (hold.still >= END_FOLLOW_STILL_FRAMES || performance.now() > hold.until) return over();
        return true;
      };
      this._endFollow = hold;
      const tick = () => {
        if (hold.look(true)) schedule(tick);
      };
      schedule(tick);
    }

    /**
     * A file was drawn while the pane is held at its end
     * (_holdEndAfterCollapse): look at the pane as soon as the viewer's
     * pass is over, which is before the frame is painted. The viewer draws
     * a file's new diff, and moves the pane for it, in a frame callback of
     * its own; the hold's look of that frame has run by then, and without
     * this one the pane was painted 92 px short of its end for one frame.
     * @private
     */
    _queueEndHoldLook() {
      const hold = this._endFollow;
      if (!hold || !hold.hold || hold.queued) return;
      hold.queued = true;
      queueMicrotask(() => {
        hold.queued = false;
        hold.look(false);
      });
    }

    /**
     * Whether a file that is drawn may still change its height by itself:
     * the page is still to give it its contents (hooks.contentsAwaited), or
     * the viewer draws an older diff of it while the one the bridge last
     * published is being highlighted (isDiffDisplayed).
     * @private
     */
    _awaitsContents() {
      if (typeof this.hooks.contentsAwaited === 'function') {
        try {
          if (this.hooks.contentsAwaited()) return true;
        } catch (err) {
          console.error('[PierreBridge] contentsAwaited hook failed:', err);
        }
      }
      for (const record of this._listed.values()) {
        if (record.collapsed || !record._element?.isConnected) continue;
        if (typeof record._instance?.getRenderedDiff !== 'function') continue;
        if (record._instance.getRenderedDiff() !== record.metadata) return true;
      }
      return false;
    }

    // ─── Contents, ranges, visibility ────────────────────────────────

    /**
     * Give a changed file its full contents, which is what makes its hidden
     * lines expandable. The two contents are diffed again and the lines the
     * patch showed are kept, as the per-file renderer did, so the file shows
     * the same rows as with that renderer. Files whose patch already is
     * everything (added, deleted) are only marked as upgraded.
     * @param {string} fileName
     * @param {{name: string, contents: string}|null} oldFile
     * @param {{name: string, contents: string}|null} newFile
     * @returns {boolean} true when the file is upgraded on return
     */
    upgradeFileContents(fileName, oldFile, newFile) {
      const record = this._record(fileName);
      if (!record || record.kind !== 'diff' || record.deferred) return false;
      if (record.upgraded) return true;
      const patchMetadata = record.patchMetadata;
      const strategy = PierreBridge.upgradeStrategy(patchMetadata);
      const plain = (file) => (file && record.forcePlainText ? { ...file, lang: 'text' } : file);
      if (strategy === 'rediff') {
        const rediffed = this._rediff(record, plain(oldFile), plain(newFile));
        if (!rediffed) return false;
        record.baseMetadata = rediffed;
        record.parityRanges = PierreBridge.patchParityRanges(patchMetadata);
      } else {
        record.baseMetadata = (strategy === 'reparse' && this._reparseUnchanged(record, plain(oldFile), plain(newFile)))
          || patchMetadata;
      }
      record.upgraded = true;
      // The lines of the patch, and ranges asked for before the contents
      // were there, are applied now.
      if (this._derive(record)) {
        this._retireExpansions(record);
        this._publish(record.id);
      }
      return true;
    }

    /**
     * The diff of a changed file's two contents, made by the vendor.
     * Null when a side is missing or the contents cannot be diffed (they
     * are the same text, which a patch with hunks contradicts): the file
     * keeps the diff of its patch and its hidden lines stay hidden.
     * @private
     */
    _rediff(record, oldFile, newFile) {
      const hasText = (file) => !!file && typeof file.contents === 'string';
      if (!hasText(oldFile) || !hasText(newFile)) return null;
      let rediffed;
      try {
        const key = `${record.baseKey}:contents`;
        rediffed = window.PierreDiffs.parseDiffFromFile(
          { ...oldFile, cacheKey: `${key}:old` },
          { ...newFile, cacheKey: `${key}:new` }
        );
      } catch (err) {
        console.warn(`[PierreBridge] Could not load the full contents of ${record.id}; its hidden lines stay hidden.`, err);
        return null;
      }
      if (!rediffed || !Array.isArray(rediffed.hunks) || rediffed.hunks.length === 0) return null;
      rediffed.name = record.id;
      if (record.forcePlainText) rediffed.lang = 'text';
      return rediffed;
    }

    /**
     * The base of a file whose patch has no hunk, from its two contents: the
     * vendor's diff of them when that has no hunk either (same text on both
     * sides). Null when the contents are missing, are not text, or differ.
     * @private
     */
    _reparseUnchanged(record, oldFile, newFile) {
      const isText = (file) => !!file && typeof file.contents === 'string' && !file.contents.includes('\u0000');
      if (!isText(oldFile) || !isText(newFile) || oldFile.contents !== newFile.contents) return null;
      if (newFile.contents === '') return null;
      let reparsed;
      try {
        const key = `${record.baseKey}:contents`;
        reparsed = window.PierreDiffs.parseDiffFromFile(
          { ...oldFile, cacheKey: `${key}:old` },
          { ...newFile, cacheKey: `${key}:new` }
        );
      } catch (err) {
        console.warn(`[PierreBridge] Could not read the contents of ${record.id}.`, err);
        return null;
      }
      if (!reparsed || !Array.isArray(reparsed.hunks) || reparsed.hunks.length !== 0) return null;
      reparsed.name = record.id;
      if (record.forcePlainText) reparsed.lang = 'text';
      return reparsed;
    }

    /**
     * Turn a deferred file ("Large diff ... Load diff") into its real diff:
     * the same item, now with the patch's lines and without its notice.
     * @param {string} fileName
     * @returns {boolean} true when the file shows its diff on return
     */
    materializeDeferred(fileName) {
      const record = this._record(fileName);
      if (!record || record.kind !== 'diff') return false;
      if (!record.deferred) return true;
      record.deferred = false;
      // A new parse of other content: a new key.
      record.baseKey = `${record.baseKey}:loaded`;
      this._parseRecordPatch(record);
      record.annotations = record.annotations.filter((a) => a.metadata.id !== NOTICE_ID);
      this._publish(record.id);
      return true;
    }

    /**
     * Show, replace or remove a file's notice: a message under its header
     * (the registered 'notice' renderer draws it).
     * @param {string} fileName
     * @param {*} data - null removes the notice
     */
    setNotice(fileName, data) {
      const record = this._record(fileName);
      if (!record) return;
      record.annotations = record.annotations.filter((a) => a.metadata.id !== NOTICE_ID);
      if (data != null) record.annotations.splice(1, 0, this._noticeAnnotation(record, data));
      this._publish(record.id);
    }

    /**
     * The viewer's own record of what the reader expanded by hand in a file,
     * by hunk index of the diff the record publishes. Null when there is
     * none, and while the viewer still draws an older diff whose expansions
     * have already been folded into the record's ranges (_retireExpansions):
     * the map then belongs to that older diff.
     * @private
     */
    _expansionMap(record) {
      if (record._expansionsOf) return null;
      return record._instance?.hunksRenderer?.expandedHunks || null;
    }

    /**
     * The record's metadata has been derived again and the viewer's
     * expansion map, which is keyed by hunk index, must not be applied to
     * the new hunks (its lines are ranges of the record by now). Called
     * after the derive and before the publish, by everything that derives a
     * mounted record again: addContextRanges, upgradeFileContents, and a
     * context record whose stored ranges or contents changed
     * (_applyContextEntry).
     *
     * A file that is not drawing anything loses the map at once, and so
     * does one whose next draw is the new diff (plain text, a diff the
     * viewer has a result for, a file whose present diff has not been
     * highlighted yet: _drawsNextDiffAtOnce). Otherwise the file goes on
     * drawing its present diff until the new one has been highlighted, and
     * it draws that diff with this map: emptied now, the lines the reader
     * expanded would leave the screen for that long and come back with the
     * new diff. So the map is kept for the diff it belongs to, and dropped
     * at the moment the viewer has the new diff ready to draw
     * (_watchForNextDiff).
     * @private
     */
    _retireExpansions(record) {
      const map = record._instance?.hunksRenderer?.expandedHunks;
      if (!map || !map.size) return;
      if (record._expansionsOf) return; // already retired, for a diff still on screen
      const drawn = record._element?.isConnected ? record._instance.getRenderedDiff?.() : null;
      if (drawn && drawn !== record.metadata && !this._drawsNextDiffAtOnce(record)) {
        record._expansionsOf = drawn;
        this._watchForNextDiff(record);
        return;
      }
      this._clearExpansionMap(record, map);
    }

    /**
     * Whether the viewer's next draw of a mounted file is the record's
     * metadata, rather than the diff it draws now. The row renderer answers
     * (`getDiffForNextRender`, which the viewer's own render asks for the
     * same purpose): the new diff when it can be drawn without waiting for
     * a highlight result, the present one otherwise. False when the
     * renderer cannot be asked: the map is then kept and dropped by
     * _watchForNextDiff or its fallback.
     * @private
     */
    _drawsNextDiffAtOnce(record) {
      const renderer = record._instance?.hunksRenderer;
      if (!record.metadata || typeof renderer?.getDiffForNextRender !== 'function') return false;
      return renderer.getDiffForNextRender(record.metadata) === record.metadata;
    }

    /**
     * Drop a retired expansion map when the viewer is about to draw another
     * diff of the file.
     *
     * The viewer's row renderer is told when a diff it was asked to draw
     * has been highlighted (`onRenderUpdate`, its one callback), and draws
     * that diff in its next pass. That callback is the last moment at which
     * the map still belongs to what is on screen and the first at which it
     * must be gone, so it is taken over for this one call. A vendor internal,
     * like the map itself; should the callback go away, _dropRetiredExpansions
     * does the same one draw later (the file is drawn once with the old map
     * and again without it, in one task).
     * @private
     */
    _watchForNextDiff(record) {
      const instance = record._instance;
      const renderer = instance?.hunksRenderer;
      this._unwatchNextDiff(record);
      if (!renderer || typeof renderer.onRenderUpdate !== 'function') return;
      const original = renderer.onRenderUpdate;
      const hook = (...args) => {
        const staged = renderer.pendingHighlightResult?.diff;
        // A result for the diff that is on screen (its theme changed, say)
        // leaves the map with it.
        if (record._instance === instance && record._expansionsOf && staged !== record._expansionsOf) {
          this._unwatchNextDiff(record);
          record._expansionsOf = null;
          const map = renderer.expandedHunks;
          if (map && map.size) this._clearExpansionMap(record, map);
        } else if (record._instance !== instance || !record._expansionsOf) {
          // Nothing left to watch for on this renderer.
          if (renderer.onRenderUpdate === hook) renderer.onRenderUpdate = original;
          if (record._expansionWatch?.hook === hook) record._expansionWatch = null;
        }
        return original.apply(renderer, args);
      };
      renderer.onRenderUpdate = hook;
      record._expansionWatch = { renderer, original, hook };
    }

    /**
     * Give the row renderer its own callback back (_watchForNextDiff).
     * @private
     */
    _unwatchNextDiff(record) {
      const watch = record._expansionWatch;
      if (!watch) return;
      record._expansionWatch = null;
      if (watch.renderer.onRenderUpdate === watch.hook) watch.renderer.onRenderUpdate = watch.original;
    }

    /**
     * The record's instance is the viewer's no longer (a new list, a
     * discarded record): nothing of it is kept or watched.
     * @private
     */
    _forgetInstance(record) {
      this._unwatchNextDiff(record);
      record._instance = null;
      record._expansionsOf = null;
    }

    /**
     * The fallback of _watchForNextDiff, from _onPostRender: the viewer has
     * drawn a diff other than the one a retired expansion map belonged to.
     * Drop the map and draw the file once more without it. Runs inside the
     * viewer's render pass: the second draw is in the same task, so nothing
     * is painted in between.
     * @private
     */
    _dropRetiredExpansions(record) {
      const of = record._expansionsOf;
      if (!of) return;
      const drawn = record._instance?.getRenderedDiff?.();
      if (drawn === of) return;
      this._unwatchNextDiff(record);
      record._expansionsOf = null;
      const map = record._instance?.hunksRenderer?.expandedHunks;
      if (!map || !map.size) return;
      this._clearExpansionMap(record, map);
      this._publish(record.id);
    }

    /**
     * A file leaves the mounted window while a retired expansion map waits
     * for the file's next diff (_retireExpansions): nothing of the file is
     * on screen any more, so the map goes now, by the rule _retireExpansions
     * has for a file that is not drawing anything. Left for the file's
     * return, the map would be applied to the first draw of the new diff
     * (the viewer draws the record's metadata when it mounts the item again,
     * and the result that _watchForNextDiff waits for is not staged for an
     * unmounted file), and _dropRetiredExpansions would then draw the file a
     * second time at another height inside the same pass, which the
     * viewer's development build reports as a layout that does not match.
     * @private
     */
    _dropExpansionsOfUnmounted(record) {
      if (!record._expansionsOf) return;
      this._unwatchNextDiff(record);
      record._expansionsOf = null;
      const map = record._instance?.hunksRenderer?.expandedHunks;
      if (map && map.size) this._clearExpansionMap(record, map);
    }

    /** @private */
    _clearExpansionMap(record, map) {
      map.clear();
      // The viewer has the item's height cached with the expanded lines.
      // Nothing but a row window that moves makes it compute that height
      // again, and an item's window does not move here
      // (ROWS_PER_ITEM_WINDOW), so it is told to.
      record._instance?.resetLayoutCache?.({ includeEstimatedHeights: true });
    }

    /**
     * Lines of a record that are on screen without being in a hunk of its
     * metadata: revealed with the viewer's expand controls, or in a gap small
     * enough for the viewer to paint in full. `map` is the viewer's
     * expansion map drawn with `metadata`; by default the one that belongs
     * to the record's metadata (_expansionMap: none while it is retired).
     * @private
     */
    _expandedRanges(record, side, metadata = record.metadata, map = this._expansionMap(record)) {
      const fromMap = window.PierreContext?.rangesFromExpansionMap;
      if (!fromMap || !metadata) return [];
      return fromMap(metadata, map, {
        side: record.kind === 'context' ? 'additions' : PierreBridge.toPierreSide(side),
        threshold: COLLAPSED_CONTEXT_THRESHOLD,
      });
    }

    /**
     * Make what the reader expanded by hand part of the record's revealed
     * ranges. Done before the metadata is derived again (its hunk indices
     * change) and before a list replace (the viewer's record is lost). The
     * viewer's own record of the expansions is left as it is: it belongs to
     * the diff on screen, and the caller says when it goes
     * (_retireExpansions after the derive; a list write replaces the
     * instance that holds it).
     * @returns {boolean} whether there was a manual expansion to fold
     * @private
     */
    _foldManualExpansions(record) {
      const map = this._expansionMap(record);
      if (!map || !map.size) return false;
      const merge = window.PierreContext?.mergeOverlapping;
      if (merge) {
        record.contextRanges = merge([...record.contextRanges, ...this._expandedRanges(record, 'RIGHT')]);
      }
      return true;
    }

    /**
     * Reveal lines of a file that are hidden between or around what it
     * shows. Ranges are in NEW file coordinates (1-indexed). For a changed
     * file whose contents are not loaded yet the ranges are kept and applied
     * by upgradeFileContents.
     * @param {string} fileName
     * @param {Array<{startLine: number, endLine: number}>} ranges
     * @returns {boolean} true when the ranges are part of what the file
     *   shows on return (isLineVisible answers for them)
     */
    addContextRanges(fileName, ranges) {
      const record = this._record(fileName);
      const merge = window.PierreContext?.mergeOverlapping;
      if (!record || !merge) return false;
      // Deriving again changes hunk indices: keep manually revealed lines as
      // ranges first; comments may already be anchored to them.
      const expanded = this._expandedRanges(record, 'RIGHT');
      record.contextRanges = merge([...record.contextRanges, ...expanded, ...(ranges || [])]);
      if (!record.baseMetadata) return false;
      if (this._derive(record)) {
        this._retireExpansions(record);
        this._publish(record.id);
      }
      return true;
    }

    /**
     * Convert OLD-file (deletion-side) line numbers to NEW-file coordinates.
     * @param {string} fileName
     * @param {number} oldStart
     * @param {number} oldEnd
     * @returns {{startLine: number, endLine: number}|null} null before the
     *   file's contents are loaded
     */
    convertOldToNew(fileName, oldStart, oldEnd) {
      const record = this._record(fileName);
      const convert = window.PierreContext?.convertOldToNew;
      if (!record?.baseMetadata || !convert) return null;
      // A context file has no changes: old and new numbers are the same.
      if (record.kind === 'context') return { startLine: oldStart, endLine: oldEnd };
      return convert(record.baseMetadata, oldStart, oldEnd);
    }

    /**
     * Whether a line is part of what a file shows: inside a hunk of the
     * metadata the bridge last published for it, or revealed by hand, and the
     * file not collapsed. Decided from data, never from the DOM, so it is
     * right for a file that is not mounted and right immediately after
     * addContextRanges, while the viewer may still be drawing the old diff.
     * @param {string} fileName
     * @param {number} lineNumber
     * @param {string} side - 'LEFT'/'RIGHT'; ignored for a context file
     * @returns {boolean}
     */
    isLineVisible(fileName, lineNumber, side) {
      const record = this._record(fileName);
      return !!record && !record.collapsed && this._showsLine(record, record.metadata, lineNumber, side);
    }

    /**
     * Whether a line is part of what a file's diff shows, collapsed or not:
     * isLineVisible without the collapse. The question for anything that
     * belongs on a line of the file (an external thread, a tour stop, a
     * reveal): a collapsed file keeps its annotations, hides them, and shows
     * them on their lines when it is expanded. Decided from data.
     * @param {string} fileName
     * @param {number} lineNumber
     * @param {string} side - 'LEFT'/'RIGHT'; ignored for a context file
     * @returns {boolean}
     */
    isLineInDiff(fileName, lineNumber, side) {
      const record = this._record(fileName);
      return !!record && this._showsLine(record, record.metadata, lineNumber, side);
    }

    /**
     * Whether a line is part of what the viewer's item of a file shows: the
     * same question as isLineVisible, asked of the list the viewer has (the
     * record the item was made from, the metadata and collapsed state the
     * item carries). What decides whether a line target can be sent.
     * @param {string} id
     * @param {number} lineNumber
     * @param {string} side
     * @returns {boolean}
     * @private
     */
    _listShowsLine(id, lineNumber, side) {
      const record = this._listedRecord(id);
      const item = record ? this.codeView.getItem(id) : null;
      return !!item && !item.collapsed && this._showsLine(record, item.fileDiff, lineNumber, side);
    }

    /**
     * Whether `metadata`, drawn for `record`, shows a line: in one of its
     * hunks, or revealed by hand on the record's instance.
     * @private
     */
    _showsLine(record, metadata, lineNumber, side) {
      return this._shownRuns(record, metadata, side)
        .some((run) => lineNumber >= run.startLine && lineNumber <= run.endLine);
    }

    /**
     * The lines `metadata`, drawn for `record`, shows on one side, as runs:
     * its hunks and the lines drawn outside them (_expandedRanges), merged
     * where they touch, so that two runs are always parted by at least one
     * hidden line (a separator on screen). In line order. The one
     * definition of what a file shows: _showsLine asks it about one line,
     * the line selection about the run its first line is in
     * (_cutToShownRun).
     * @param {Object} record
     * @param {Object} metadata
     * @param {string} side - 'LEFT'/'RIGHT' or the viewer's; ignored for a
     *   context file
     * @param {Map|null} [map] - the expansion map drawn with `metadata`
     *   (default: _expandedRanges's, the one of the record's metadata)
     * @returns {Array<{startLine: number, endLine: number}>}
     * @private
     */
    _shownRuns(record, metadata, side, map) {
      const hunks = metadata?.hunks;
      if (!Array.isArray(hunks) || hunks.length === 0) return [];
      const deletions = record.kind !== 'context' && PierreBridge.toPierreSide(side) === 'deletions';
      const sideKey = deletions ? 'deletion' : 'addition';
      const ranges = [];
      for (const hunk of hunks) {
        const count = hunk[`${sideKey}Count`];
        if (!count) continue;
        const start = hunk[`${sideKey}Start`];
        ranges.push({ startLine: start, endLine: start + count - 1 });
      }
      ranges.push(...this._expandedRanges(record, side, metadata, map));
      const merge = window.PierreContext?.mergeOverlapping;
      return merge ? merge(ranges) : ranges.sort((a, b) => a.startLine - b.startLine);
    }

    /**
     * Whether the viewer is drawing the metadata the bridge last published
     * for a file (true) or still an older diff while the new one is being
     * highlighted (false). False for a file that is not mounted.
     * @param {string} fileName
     * @returns {boolean}
     */
    isDiffDisplayed(fileName) {
      const record = this._record(fileName);
      if (!record || !record._element?.isConnected || !record._instance) return false;
      return record._instance.getRenderedDiff?.() === record.metadata;
    }

    /**
     * Wait until a line of a file is on screen: the file mounted and drawing
     * the metadata that shows the line. A reveal reaches the screen a worker
     * round trip after it was published (about a second for a very large
     * file), and a scroll to the line before that lands on the separator.
     * @param {string} fileName
     * @param {number} lineNumber
     * @param {string} side
     * @param {Object} [options]
     * @param {number} [options.timeoutMs=4000]
     * @param {Function} [options.isCancelled] - () => boolean, checked each frame
     * @returns {Promise<boolean>} false when the line is not part of what
     *   the file shows, the wait was cancelled, or the time ran out
     */
    whenLineDisplayed(fileName, lineNumber, side, { timeoutMs = 4000, isCancelled } = {}) {
      const check = () => {
        if (!this.isLineVisible(fileName, lineNumber, side)) return { done: true, value: false };
        return this.isDiffDisplayed(fileName) ? { done: true, value: true } : { done: false };
      };
      const first = check();
      if (first.done) return Promise.resolve(first.value);
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve) => {
        const tick = () => {
          if (typeof isCancelled === 'function' && isCancelled()) return resolve(false);
          const now = check();
          if (now.done) return resolve(now.value);
          if (Date.now() >= deadline) return resolve(false);
          schedule(tick);
        };
        schedule(tick);
      });
    }

    // ─── Scrolling ───────────────────────────────────────────────────

    /**
     * Scroll to a file's header.
     * @param {string} fileName
     * @param {Object} [options]
     * @param {string} [options.align='start']
     * @param {string} [options.behavior='instant']
     * @returns {boolean} false when there is no such file
     */
    scrollToItem(fileName, { align = 'start', behavior = 'instant', offset } = {}) {
      const record = this._record(fileName);
      if (!record || !this.codeView) return false;
      const target = { type: 'item', id: record.id, align, behavior };
      if (typeof offset === 'number') target.offset = offset;
      this._scrollTo(target);
      return true;
    }

    /**
     * Scroll to a line of a file and flash it. Works for a file and a line
     * that are not mounted.
     * @param {string} fileName
     * @param {number} lineNumber
     * @param {string} [side='RIGHT']
     * @param {Object|boolean} [options] - or, as before, a boolean `scroll`
     * @param {boolean} [options.scroll=true] - false only flashes
     * @param {boolean} [options.ifNeeded=false] - do not scroll when the
     *   line's row is drawn and wholly inside the pane already
     * @param {string} [options.align='center']
     * @param {string} [options.behavior='smooth']
     * @param {boolean} [options.flash=true]
     * @param {number} [options.endLine] - flash every line from `lineNumber`
     *   to this one (a range)
     * @returns {boolean} false when the file does not show that line (it is
     *   not in the diff's data, is hidden, or the file is collapsed), so the
     *   caller can fall back to the file
     */
    scrollToLine(fileName, lineNumber, side = 'RIGHT', options = {}) {
      const { scroll = true, ifNeeded = false, align = 'center', behavior = 'smooth', flash = true, endLine } =
        typeof options === 'boolean' ? { scroll: options } : (options || {});
      const record = this._record(fileName);
      if (!record || !this.codeView) return false;
      if (!this.isLineVisible(record.id, lineNumber, side)) return false;
      const pierreSide = this._annotationSide(record, side);
      if (scroll && !(ifNeeded && this._isRowInView(record, lineNumber, pierreSide))) {
        this._scrollTo({ type: 'line', id: record.id, lineNumber, side: pierreSide, align, behavior });
      }
      if (flash) {
        const lines = [lineNumber];
        const last = Number(endLine);
        // A range is flashed line by line; a line of it the file does not
        // show has no row to flash.
        for (let line = lineNumber + 1; Number.isFinite(last) && line <= last && lines.length < MAX_FLASHED_LINES; line++) {
          if (this.isLineVisible(record.id, line, side)) lines.push(line);
        }
        this._flashLines(record, lines, side);
      }
      return true;
    }

    /**
     * Take the pane to the line an annotation is on (to the file's header
     * for a file-level one), so that the viewer mounts the annotation's card:
     * a file far from the viewport has no elements, and a very long file has
     * elements for a window of its rows only. Nothing is sent when the card
     * is drawn already (isElementDrawn), nor when the file is on screen with
     * a new diff awaiting display and that display draws the card
     * (_displayWillDraw).
     * @param {string} fileName
     * @param {string} annotationId
     * @param {Object} [options]
     * @param {string} [options.align='start']
     * @param {string} [options.behavior='instant']
     * @returns {boolean} whether the card is, or is going to be, drawn:
     *   false when the file does not show the annotation's line
     */
    scrollToAnnotation(fileName, annotationId, { align = 'start', behavior = 'instant' } = {}) {
      const record = this._record(fileName);
      const annotation = this._findAnnotation(record, annotationId);
      if (!annotation || !this.codeView || !this._isAnnotationLineShown(record, annotation)) return false;
      const element = this._elements.lookup(annotation, record.id, record.formElements, { create: false });
      if (this.isElementDrawn(element)) return true;
      if (this._displayWillDraw(record, element)) return true;
      if (annotation.lineNumber === 0) {
        this._scrollTo({ type: 'item', id: record.id, align, behavior });
      } else {
        this._scrollTo({
          type: 'line', id: record.id, lineNumber: annotation.lineNumber, side: annotation.side, align, behavior,
        });
      }
      return true;
    }

    /**
     * Whether the viewer draws an element it was handed: a card, or
     * something inside one (a card of a file's comment zone).
     *
     * "In the document" does not say so. The viewer keeps the card of every
     * annotation of a mounted file among the file element's children, and
     * each is shown through a slot in the row under its line. A file of
     * ROWS_PER_ITEM_WINDOW rows or more has rows for a window of its lines
     * only: the card of a line outside that window is in the document, has
     * no slot and no box, and scrolling to it does nothing. The same holds
     * for a card whose row the viewer dropped (_restoreTrimmedCards) and for
     * one of a line the diff on screen does not have yet. So the question
     * is asked of the slot, which is also right for a card that minimize
     * mode hides (it has a slot and no box).
     *
     * An element that is not a child of a file's element (or inside one) is
     * drawn when it is in the document.
     * @param {Element|null} element
     * @returns {boolean}
     */
    isElementDrawn(element) {
      if (!element?.isConnected) return false;
      // The child of the file's element that holds it: what a slot takes.
      let node = element;
      while (node.parentElement && !node.parentElement.shadowRoot) node = node.parentElement;
      if (!node.parentElement) return true;
      return !!node.assignedSlot;
    }

    /**
     * Whether a card that is in the document without being drawn is about
     * to be drawn where the pane is: its file is on screen with a new diff
     * that awaits display (the highlighter has not answered), and the file
     * is one the viewer draws whole, with the diff that is on screen and
     * with the one that awaits display (drawnRowCount: a reveal can take a
     * file from fewer rows than a window to more). The card of a line that
     * was just revealed is in this state for a worker round trip; the
     * page's scroll helper waits for its box. A file drawn in windows of
     * its rows is not counted: its display draws the rows of the window the
     * pane is in, which need not hold the card's line. There the pane is
     * taken to the line (scrollToAnnotation, and once more by
     * whenAnnotationRendered when the diff is displayed).
     * @private
     */
    _displayWillDraw(record, element) {
      if (!element?.isConnected || !this._awaitsDisplay(record.id)) return false;
      const column = record._element.shadowRoot?.querySelector('[data-content]');
      if (!column || column.children.length >= ROWS_PER_ITEM_WINDOW) return false;
      // The diff on screen is drawn whole. The one that awaits display may
      // not be (a reveal that takes the file to a window's worth of rows):
      // that is asked of its own rows.
      return PierreBridge.drawnRowCount(record.metadata, this.diffStyle) < ROWS_PER_ITEM_WINDOW;
    }

    /**
     * Wait until the viewer draws an element (isElementDrawn).
     * @param {Element|null} element
     * @param {Object} [options]
     * @param {number} [options.timeoutMs=4000]
     * @param {Function} [options.isCancelled] - () => boolean, checked each frame
     * @returns {Promise<boolean>} false when there is no element, the wait
     *   was cancelled, or the time ran out
     */
    whenElementDrawn(element, { timeoutMs = 4000, isCancelled } = {}) {
      if (!element) return Promise.resolve(false);
      if (this.isElementDrawn(element)) return Promise.resolve(true);
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve) => {
        const tick = () => {
          if (this._destroyed) return resolve(false);
          if (typeof isCancelled === 'function' && isCancelled()) return resolve(false);
          if (this.isElementDrawn(element)) return resolve(true);
          if (Date.now() >= deadline) return resolve(false);
          schedule(tick);
        };
        schedule(tick);
      });
    }

    /**
     * Send a scroll target to the viewer, after the list write that is
     * waiting or in progress if there is one. A target the viewer's list
     * has no item for by then is dropped, and so is a line target whose
     * line that item does not show (the viewer logs an error for a line it
     * cannot resolve).
     * @private
     */
    _scrollTo(target) {
      this._onList(() => {
        if (!this._listed.has(target.id)) return;
        if (target.type === 'line' && !this._listShowsLine(target.id, target.lineNumber, target.side)) return;
        // A target of the application's ends a follow of the pane's end.
        this._endFollow = null;
        this._readerScroll = null;
        this.codeView.scrollTo(target);
      });
    }

    /**
     * Whether a line's row is drawn and wholly inside the pane, below the
     * file header that is pinned at its top.
     * @private
     */
    _isRowInView(record, lineNumber, pierreSide) {
      const row = this._findRow(record, lineNumber, pierreSide);
      const root = this.root;
      if (!row || !root) return false;
      const box = row.getBoundingClientRect();
      const pane = root.getBoundingClientRect();
      if (box.height === 0) return false;
      const header = this._metrics?.diffHeaderHeight ?? FALLBACK_HEADER_HEIGHT;
      return box.top >= pane.top + header && box.bottom <= pane.bottom;
    }

    /**
     * Flash lines of a file. The flash starts when the first of their rows
     * is in the DOM (the row of a line being scrolled to or revealed exists
     * some frames later), and it survives the rows: every update of an item
     * replaces all its rows, a revealed line is drawn plain first and again
     * when it has been highlighted, so the flash is put back on the new
     * rows, continuing from where it was (_onPostRender).
     * @private
     */
    _flashLines(record, lines, side, { maxFrames = 120 } = {}) {
      this._endFlash(record);
      const flash = { lines: [...lines], side: this._annotationSide(record, side), startedAt: null, timer: null };
      record._flash = flash;
      let frames = 0;
      const tryStart = () => {
        // Re-read every frame: the item can be mounted, or its record
        // replaced by a new diff, meanwhile.
        if (this.files.get(record.id) !== record || record._flash !== flash || flash.startedAt != null) return;
        if (this._applyFlash(record)) return;
        if (++frames < maxFrames) schedule(tryStart);
        else if (record._flash === flash) record._flash = null;
      };
      tryStart();
    }

    /**
     * Put the record's flash on the rows of its lines that are mounted.
     * @returns {boolean} whether the row of the first line was there
     * @private
     */
    _applyFlash(record) {
      const flash = record._flash;
      if (!flash) return false;
      const rows = flash.lines.map((line) => this._findRow(record, line, flash.side));
      if (!rows[0]) return false;
      const now = performance.now();
      if (flash.startedAt == null) {
        flash.startedAt = now;
        flash.timer = setTimeout(() => {
          if (record._flash === flash) this._endFlash(record);
        }, FLASH_DURATION_MS);
      }
      for (const row of rows) {
        if (!row) continue;
        row.classList.remove('pierre-line-highlight');
        void row.offsetWidth; // restart the animation on this row
        row.style.animationDelay = `-${Math.round(now - flash.startedAt)}ms`;
        row.classList.add('pierre-line-highlight');
      }
      return true;
    }

    /** @private */
    _endFlash(record) {
      const flash = record._flash;
      if (!flash) return;
      record._flash = null;
      if (flash.timer) clearTimeout(flash.timer);
      for (const line of flash.lines) {
        const row = this._findRow(record, line, flash.side);
        if (!row) continue;
        row.classList.remove('pierre-line-highlight');
        row.style.removeProperty('animation-delay');
      }
    }

    /**
     * The mounted row of a line, or null.
     * @private
     */
    _findRow(record, lineNumber, pierreSide) {
      const shadowRoot = record._element?.isConnected ? record._element.shadowRoot : null;
      if (!shadowRoot) return null;
      const rows = shadowRoot.querySelectorAll(`[data-content] > [data-line="${lineNumber}"]`);
      for (const row of rows) {
        const column = row.closest('[data-deletions],[data-additions],[data-unified]');
        if (column?.hasAttribute('data-unified')) {
          // One column: a deletion carries the old number, every other row the new one.
          const isDeletion = (row.getAttribute('data-line-type') || '').includes('deletion');
          if (isDeletion === (pierreSide === 'deletions')) return row;
        } else if (PierreBridge._rowSide(row) === pierreSide) {
          return row;
        }
      }
      return null;
    }

    // ─── Annotations ─────────────────────────────────────────────────

    /**
     * Add an annotation: a comment, a suggestion, a form, or a registered
     * type.
     * @param {string} fileName
     * @param {Object} annotation - { lineNumber, side, type, data, id? };
     *   side 'LEFT'/'RIGHT' (or 'deletions'/'additions')
     */
    addAnnotation(fileName, annotation) {
      const record = this._record(fileName);
      if (!record) return;
      this._pushAnnotation(record, annotation);
      this._publish(record.id);
    }

    /**
     * Add many annotations to one file with a single publish.
     * @param {string} fileName
     * @param {Array<Object>} annotations
     */
    addAnnotations(fileName, annotations) {
      const record = this._record(fileName);
      if (!record || !Array.isArray(annotations) || annotations.length === 0) return;
      for (const annotation of annotations) this._pushAnnotation(record, annotation);
      this._publish(record.id);
    }

    /** @private */
    _pushAnnotation(record, annotation) {
      const side = this._annotationSide(record, annotation.side);
      record.annotations.push({
        side,
        lineNumber: annotation.lineNumber,
        metadata: {
          type: annotation.type,
          data: annotation.data,
          id: annotation.id || `${annotation.type}-${annotation.lineNumber}-${side}-${++this._annotationCounter}`,
        },
      });
    }

    /**
     * Remove an annotation by id.
     * @param {string} fileName
     * @param {string} annotationId
     */
    removeAnnotation(fileName, annotationId) {
      const record = this._record(fileName);
      if (!record || annotationId === ZONE_ID) return;
      const before = record.annotations.length;
      record.annotations = record.annotations.filter((a) => a.metadata.id !== annotationId);
      record.formElements.delete(annotationId);
      if (record.annotations.length !== before) this._publish(record.id);
    }

    /**
     * Remove every annotation of a type from a file.
     * @param {string} fileName
     * @param {string} type
     */
    removeAnnotationsByType(fileName, type) {
      const record = this._record(fileName);
      if (!record || type === ZONE_TYPE) return;
      const removed = record.annotations.filter((a) => a.metadata.type === type);
      if (removed.length === 0) return;
      record.annotations = record.annotations.filter((a) => a.metadata.type !== type);
      for (const annotation of removed) record.formElements.delete(annotation.metadata.id);
      this._publish(record.id);
    }

    /**
     * A file's annotations, optionally of one type. The file's comment zone
     * is not listed: it is part of the file, not something that was added.
     * @param {string} fileName
     * @param {string} [type]
     * @returns {Array}
     */
    getAnnotations(fileName, type) {
      const record = this._record(fileName);
      if (!record) return [];
      return record.annotations.filter((a) => (type ? a.metadata.type === type : a.metadata.type !== ZONE_TYPE));
    }

    /** Whether a file has an annotation with this id. Decided from data. */
    hasAnnotation(fileName, annotationId) {
      return !!this._findAnnotation(this._record(fileName), annotationId);
    }

    /**
     * The file and annotation of a given type whose data matches a
     * predicate, across every file.
     * @param {string} type
     * @param {Function} predicate - (data, annotation) => boolean
     * @returns {{fileName: string, annotation: Object}|null}
     */
    findAnnotationByData(type, predicate) {
      if (typeof predicate !== 'function') return null;
      for (const [fileName, record] of this.files) {
        for (const annotation of record.annotations) {
          if (annotation.metadata.type !== type) continue;
          if (predicate(annotation.metadata.data, annotation)) return { fileName, annotation };
        }
      }
      return null;
    }

    /**
     * The file that holds the annotation with this id, or null.
     * @param {string} annotationId
     * @param {string} [preferredFile] - tried first
     * @returns {string|null}
     */
    findAnnotationFile(annotationId, preferredFile) {
      if (annotationId == null || annotationId === ZONE_ID || annotationId === NOTICE_ID) return null;
      const preferred = this._record(preferredFile);
      if (preferred && this._findAnnotation(preferred, annotationId)) return preferred.id;
      for (const [fileName, record] of this.files) {
        if (record.annotations.some((a) => a.metadata.id === annotationId)) return fileName;
      }
      return null;
    }

    /** @private */
    _findAnnotation(record, annotationId) {
      if (!record || annotationId == null) return null;
      return record.annotations.find((a) => a.metadata.id === annotationId) || null;
    }

    /**
     * The element of an annotation, whether or not the viewer has it on
     * screen. The one way to get a card (see the file header: "what a
     * publish guarantees").
     *
     * With `create`, a card that has not been built yet is built the way the
     * viewer's render callback builds it, and the viewer later receives this
     * same element. A card that exists is handed back exactly as it is: a
     * lookup never syncs it with its data, only a draw by the viewer does.
     *
     * @param {string} fileName
     * @param {string} annotationId
     * @param {Object} [options]
     * @param {boolean} [options.create=false]
     * @returns {HTMLElement|null}
     */
    getAnnotationElement(fileName, annotationId, { create = false } = {}) {
      const record = this._record(fileName);
      const annotation = this._findAnnotation(record, annotationId);
      if (!annotation) return null;
      return this._elements.lookup(annotation, record.id, record.formElements, { create });
    }

    /**
     * Wait until an annotation's card has, or is about to get, its place on
     * screen: the viewer draws it (isElementDrawn: its file mounted, and the
     * row under its line among the rows the file has), or it is in the
     * document of a file whose new diff awaits display and that display
     * draws it (_displayWillDraw; the caller's scroll waits for its box, as
     * it does on the per-file renderer). A card that is in the document
     * with neither is waited for: the row of its line is outside the rows a
     * long file draws, and it has no place until the pane is taken there
     * (scrollToAnnotation). A card that minimize mode hides has no box and
     * is still the right element. There is nothing to wait for when the
     * file does not show the annotation's line; the answer is null at once.
     *
     * One thing is done during the wait. A line target that was sent while
     * the file's new diff awaited display went as far as the old diff's
     * height allowed, which is short of a line the new diff adds thousands
     * of rows further down. When the new diff is displayed and the card is
     * still not drawn, the pane is taken to the line once more
     * (scrollToAnnotation), now within the new diff's height.
     * @param {string} fileName
     * @param {string} annotationId
     * @param {Object} [options]
     * @param {number} [options.timeoutMs=4000]
     * @param {Function} [options.isCancelled]
     * @returns {Promise<HTMLElement|null>}
     */
    whenAnnotationRendered(fileName, annotationId, { timeoutMs = 4000, isCancelled } = {}) {
      const resolveNow = () => {
        const record = this._record(fileName);
        const annotation = this._findAnnotation(record, annotationId);
        // Asked first, and from data: a line the file does not show is
        // never drawn, and its card would be waited for until the time
        // ran out.
        if (!annotation || !this._isAnnotationLineShown(record, annotation)) return { element: null, done: true };
        const element = this.getAnnotationElement(record.id, annotationId, { create: true });
        return { element, done: !element || this.isElementDrawn(element) || this._displayWillDraw(record, element) };
      };
      const first = resolveNow();
      if (first.done) return Promise.resolve(first.element);
      const deadline = Date.now() + timeoutMs;
      let awaitedDisplay = this._awaitsDisplay(fileName);
      return new Promise((resolve) => {
        const tick = () => {
          if (typeof isCancelled === 'function' && isCancelled()) return resolve(null);
          const { element, done } = resolveNow();
          if (done) return resolve(element);
          if (Date.now() >= deadline) return resolve(null);
          if (this._awaitsDisplay(fileName)) {
            awaitedDisplay = true;
          } else if (awaitedDisplay && this.isDiffDisplayed(fileName)) {
            awaitedDisplay = false;
            this.scrollToAnnotation(fileName, annotationId);
          }
          schedule(tick);
        };
        schedule(tick);
      });
    }

    /**
     * Whether a file is on screen with an older diff than the one last
     * published for it (the new one is with the highlighter).
     * @private
     */
    _awaitsDisplay(fileName) {
      const record = this._record(fileName);
      return !!(record?._element?.isConnected && record._instance) && !this.isDiffDisplayed(fileName);
    }

    /** @private */
    _isAnnotationLineShown(record, annotation) {
      if (record.collapsed) return false;
      // A file-level annotation is drawn under the header of any expanded file.
      if (annotation.lineNumber === 0) return true;
      return this.isLineVisible(record.id, annotation.lineNumber, annotation.side);
    }

    /**
     * Register the renderer of an annotation type other than comment,
     * suggestion and comment-form: 'file-comments' (the file's comment
     * zone), 'notice', 'tour-stop', 'hunk-summary', 'external-comment'.
     * @param {string} type
     * @param {Function} renderFn - (data, id, fileName) => Element|null; the
     *   element is built once per annotation and reused
     * @param {Object} [options]
     * @param {Function} [options.sync] - (element, data, id, fileName) => void,
     *   run every time the viewer draws the annotation; must be idempotent
     */
    registerAnnotationRenderer(type, renderFn, { sync } = {}) {
      this._elements.register(type, renderFn, { sync });
    }

    // ─── Code extraction ─────────────────────────────────────────────

    /**
     * The text of a range of lines a file shows, for a suggestion block:
     * every line from `startLine` to `endLine` on one side, without line
     * breaks at their ends, joined by one line break. Applied on GitHub, a
     * suggestion replaces every line of its range with the block, so the
     * answer is all of the range or nothing: null when a line of it has no
     * text (it is not shown, or not loaded), and the caller refuses
     * (CommentManager.insertSuggestionBlock). Never a part of the range.
     *
     * The lines shown are those isLineVisible counts, collapse aside: the
     * lines of the hunks, and the lines the viewer draws outside them (a gap
     * small enough to paint in full, lines the reader expanded), which a
     * comment form opens on too. A line of a hunk is read where the hunk
     * says; a line outside the hunks is read from the file's contents, which
     * a metadata that is not partial holds whole (line n at index n - 1). A
     * context file holds its whole contents and has one side.
     *
     * The vendor's parsed lines keep their line ending ('a\n', 'a\r\n'); it
     * is removed here.
     * @param {string} fileName
     * @param {number} startLine
     * @param {number} endLine
     * @param {string} side - 'LEFT' or 'RIGHT' (ignored for a context file)
     * @returns {string|null}
     */
    getCodeFromLines(fileName, startLine, endLine, side) {
      const record = this._record(fileName);
      const metadata = record?.metadata;
      if (!metadata || !Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
      if (startLine < 1 || endLine < startLine) return null;
      const deletions = record.kind !== 'context' && (side || 'RIGHT') !== 'RIGHT';
      const lines = deletions ? metadata.deletionLines : metadata.additionLines;
      const hunks = metadata.hunks;
      if (!Array.isArray(lines) || !Array.isArray(hunks) || hunks.length === 0) return null;
      const sideKey = deletions ? 'deletion' : 'addition';
      // Outside the hunks a line is drawn when it is in one of these ranges,
      // and its text is in the contents only when the metadata is whole.
      const drawn = metadata.isPartial ? [] : this._expandedRanges(record, deletions ? 'LEFT' : 'RIGHT', metadata);
      const codeLines = [];
      for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
        let index = -1;
        for (const hunk of hunks) {
          const start = hunk[`${sideKey}Start`];
          const count = hunk[`${sideKey}Count`];
          if (count && lineNumber >= start && lineNumber < start + count) {
            index = hunk[`${sideKey}LineIndex`] + (lineNumber - start);
            break;
          }
        }
        if (index < 0 && drawn.some((range) => lineNumber >= range.startLine && lineNumber <= range.endLine)) {
          index = lineNumber - 1;
        }
        if (index < 0 || index >= lines.length || typeof lines[index] !== 'string') return null;
        codeLines.push(lines[index].replace(/\r?\n$/, ''));
      }
      return codeLines.join('\n');
    }

    // ─── Teardown ────────────────────────────────────────────────────

    /**
     * Remove the viewer, the worker pool and every listener. Final: a
     * destroyed bridge renders nothing (renderAll answers false).
     */
    destroy() {
      document.removeEventListener('keydown', this._onReaderScrollInput, { capture: true });
      this._endFollow = null;
      this._readerScroll = null;
      document.removeEventListener('pointermove', this._onPointerMove);
      document.removeEventListener('pointerup', this._onPointerUp);
      document.removeEventListener('pointercancel', this._onPointerUp);
      if (this.root) {
        this.root.removeEventListener('pointerdown', this._onRootPointerDown);
        this.root.removeEventListener('click', this._onRootClick, { capture: true });
        this.root.removeEventListener('contextmenu', this._onRootContextMenu, { capture: true });
        this.root.removeEventListener('mousedown', this._onRootPressKind, { capture: true });
        this.root.removeEventListener('touchstart', this._onRootPressKind, { capture: true });
        this.root.removeEventListener('scroll', this._onRootScroll);
        this.root.removeEventListener('wheel', this._onReaderScrollInput, { capture: true });
        this.root.removeEventListener('touchmove', this._onReaderScrollInput, { capture: true });
        this.root.removeEventListener('pointerdown', this._onReaderScrollInput, { capture: true });
      }
      for (const record of new Set([...this._listed.values(), ...this.files.values()])) this._discardRecord(record);
      this.files.clear();
      this._listed.clear();
      this._pendingReconcile = null;
      // Final: a list write that was waiting is cancelled, and nothing
      // renders through this bridge again.
      this._destroyed = true;
      this._listWriteQueued = false;
      this._afterListWrite = [];
      this._mountsTold.clear();
      try {
        this.codeView?.cleanUp();
      } catch (err) {
        console.warn('[PierreBridge] Failed to clean up the viewer.', err);
      }
      this.codeView = null;
      try {
        this.workerManager?.terminate?.();
      } catch (err) {
        console.warn('[PierreBridge] Failed to stop the worker pool.', err);
      }
      this.workerManager = null;
    }
  }

  PierreBridge.COLLAPSED_CONTEXT_THRESHOLD = COLLAPSED_CONTEXT_THRESHOLD;
  PierreBridge.EXPANSION_LINE_COUNT = EXPANSION_LINE_COUNT;
  PierreBridge.ZONE_TYPE = ZONE_TYPE;
  PierreBridge.NOTICE_TYPE = NOTICE_TYPE;

  window.PierreBridge = PierreBridge;
  if (typeof module !== 'undefined') module.exports = PierreBridge;
})();
