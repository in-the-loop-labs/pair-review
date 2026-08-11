// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PierreBridge - Adapter between @pierre/diffs and pair-review
 *
 * Owns a SINGLE @pierre/diffs `CodeView` instance that virtualizes the whole
 * changed-file list. Each changed file is one controlled `CodeViewDiffItem`
 * (or `CodeViewFileItem` for context files); annotations (comments,
 * suggestions, forms, hunk summaries, tour stops, external threads) live on the
 * item data and are rendered through CodeView's `renderAnnotation` callback.
 *
 * Design notes for maintainers:
 *   - CodeView pools/recycles the `<diffs-container>` host elements as items
 *     scroll in and out of view. NEVER stash per-file state on the DOM — the
 *     element you get back may belong to a different item, and every light-DOM
 *     insertion (header, annotations, gutter buttons) is regenerated from the
 *     item's data on each remount. The source of truth is `this.files`.
 *   - Every imperative change (annotations, context ranges, collapse, content
 *     upgrade, theme) is published by rebuilding the item and calling
 *     `updateItem` with a BUMPED `version`. `updateItem` is a no-op when the
 *     version is unchanged, so forgetting to bump = nothing renders.
 *   - Always re-`getItem` before `updateItem` (via `_publishItem`) so a change
 *     that resolves after a `setItems` wiped/replaced the item is dropped
 *     instead of resurrecting a stale record.
 *
 * Depends on: window.PierreDiffs (vendor bundle: CodeView, WorkerPoolManager,
 * parsePatchFiles, parseDiffFromFile), window.PierreContext (range math).
 */

class PierreBridge {
  /**
   * @param {Object} options
   * @param {string} options.theme - 'light' or 'dark'
   * @param {Function} options.onCommentClick - (fileName, lineNumber, side, target) => void
   * @param {Function} options.onChatClick - (fileName, lineNumber, side, range?) => void
   * @param {Function} options.onLineSelect - (fileName, range) => void
   */
  constructor(options = {}) {
    if (!window.PierreDiffs || !window.PierreDiffs.CodeView) {
      console.warn('[PierreBridge] window.PierreDiffs.CodeView not loaded — @pierre/diffs bundle missing. Falling back to legacy rendering.');
      this._disabled = true;
    }
    this.options = options;
    this.theme = options.theme || PierreBridge.detectTheme();

    // Diff layout: 'unified' (single column) or 'split' (side-by-side).
    // Applied to the single CodeView via setOptions; toggled at runtime via
    // setDiffStyle(). Invalid values fall back to 'unified'.
    this.diffStyle = PierreBridge.isValidDiffStyle(options.diffStyle)
      ? options.diffStyle
      : 'unified';

    // The single CodeView instance and the scroll-root element it manages.
    // Created lazily on the first renderAll() so the DOM is guaranteed present.
    this.codeView = null;
    this.root = null;

    // Item-height metrics (line-row/header/hunk-separator px) that CodeView uses
    // to estimate item heights and reserve space for virtualized-out lines. The
    // vendor defaults (lineHeight 20, diffHeaderHeight 44) do not match our
    // rendered dimensions (real line ~17.4px, custom header ~53px), which makes
    // every off-screen line over-reserved and the header under-reserved — the
    // reservation then shifts as lines mount on scroll (wandering gaps) and
    // navigation lands off. pr.js measures the real values from the rendered DOM
    // and pushes them via setItemMetrics(); null until then (vendor defaults).
    this._itemMetrics = null;

    // Header factory supplied by the render caller (pr.js) so DiffRenderer /
    // fileCommentManager stay in pr.js — the bridge never reaches into them.
    // (fileName, context) => HTMLElement | null
    this._renderHeader = null;

    // (fileName, itemType) => string[] — caller-supplied domain host classes.
    this._hostClassesFor = null;

    // Per-file item state, keyed by CodeView item id: the file path for diff
    // items, `context:<path>` for context-file items. Public: consumers probe
    // `.files.has(path)` / `.files.get(path)` / iterate `.files`.
    // Shape: {
    //   id, fileName, itemType('diff'|'binary'|'context'), type('diff'|'file'),
    //   metadata, baseMetadata, patch, annotations[], diffPositions:Map,
    //   formElements:Map, contextRanges[], patchParityRanges, oldFile, newFile,
    //   fileContents, collapsed, forcePlainText, binaryMessage, version,
    //   _element, _shadowRoot, _instance, _splitLayoutRaf
    // }
    this.files = new Map();

    // CSS injected into every item's Shadow DOM for annotations/comments/forms.
    this._unsafeCSS = null;

    // Monotonic counter for unique annotation IDs.
    this._annotationCounter = 0;

    // Custom annotation renderers registered by feature modules
    // (hunk-summary, tour-stop, external-comment, and pr.js file-comments).
    this._annotationRenderers = new Map();

    // Live gutter-button containers + hovered-row getters, keyed by file id.
    // Regenerated on each remount (renderGutterUtility runs once per mount).
    this._gutterContainers = new Map();
    this._gutterRowGetters = new Map();

    // Reverse map (VirtualizedFileDiff instance → item id). The instance is
    // stable across an item's mount/unmount, so it resolves the id on the
    // 'unmount' callback even when the context no longer carries the item —
    // guaranteeing evicted items always get their stale DOM refs cleared.
    this._instanceToId = new Map();

    // One-shot resolvers per item id, drained in onPostRender (mount/update)
    // after the vendor has slotted annotations. Backs whenAnnotationsSlotted().
    this._slotWaiters = new Map();

    // Shared @pierre/diffs worker pool. Without this, highlighting happens on
    // the main thread and can freeze large reviews.
    this.workerManager = this._createWorkerManager();
    this._workerReady = !this.workerManager;
    this._workersFailed = false;
    this._workerInitTimer = null;
    this._workerStatsUnsubscribe = null;

    // Last pointer position — used only by isPointerOverFile() so background
    // content upgrades can wait for the pointer to leave a file before
    // re-rendering it (avoids yanking a diff out from under the cursor).
    this._lastPointerPosition = null;
    this._trackPointerPosition = (event) => {
      if (event.isPrimary === false) return;
      this._lastPointerPosition = {
        clientX: event.clientX,
        clientY: event.clientY,
      };
    };
    document.addEventListener('pointermove', this._trackPointerPosition, { passive: true });
    document.addEventListener('mousemove', this._trackPointerPosition, { passive: true });

    if (this.workerManager?.subscribeToStatChanges) {
      this._workerStatsUnsubscribe = this.workerManager.subscribeToStatChanges((stats) => {
        this._handleWorkerStats(stats);
      });
      this._startWorkerInitTimeout();
      const init = this.workerManager.initialize?.();
      if (init?.catch) {
        init.catch((err) => {
          this._fallbackToMainThreadRendering('worker startup failed', err);
        });
      }
    }
  }

  // ─── Theme ────────────────────────────────────────────────────────

  static detectTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  getThemeConfig() {
    return {
      dark: 'github-dark',
      light: 'github-light',
    };
  }

  _getWorkerRenderOptions() {
    return {
      theme: this.getThemeConfig(),
      useTokenTransformer: false,
      lineDiffType: 'word',
      maxLineDiffLength: 1000,
      tokenizeMaxLineLength: 1000,
    };
  }

  setTheme(theme) {
    this.theme = theme;
    if (this.workerManager?.setRenderOptions) {
      const update = this.workerManager.setRenderOptions(this._getWorkerRenderOptions());
      if (update?.catch) {
        update.catch(err => {
          console.warn('[PierreBridge] Failed to update @pierre/diffs worker theme.', err);
        });
      }
    }
    // Re-publish the whole CodeView with the new themeType. setOptions detects
    // the theme change, invalidates the (theme-baked) element pool, and
    // reschedules a render on its own — no explicit render() needed.
    if (this.codeView) {
      this.codeView.setOptions(this._buildCodeViewOptions());
      this.codeView.onThemeChange?.();
    }
  }

  // ─── Diff Style (unified / split) ─────────────────────────────────

  static isValidDiffStyle(style) {
    return style === 'unified' || style === 'split';
  }

  getDiffStyle() {
    return this.diffStyle;
  }

  /**
   * Switch every rendered file between unified and split (side-by-side) layout.
   * diffStyle is a layout-affecting CodeView option, so setOptions relayouts
   * and re-renders all mounted items on its own; the per-mount onPostRender
   * hook re-runs _syncSplitAnnotationLayout for stretched split annotations.
   * @param {'unified'|'split'} style
   */
  setDiffStyle(style) {
    if (!PierreBridge.isValidDiffStyle(style)) {
      console.warn(`[PierreBridge] Ignoring invalid diffStyle "${style}"; expected 'unified' or 'split'.`);
      return;
    }
    if (style === this.diffStyle) return;
    this.diffStyle = style;
    if (this.codeView) {
      this.codeView.setOptions(this._buildCodeViewOptions());
    }
  }

  // ─── Item Height Metrics ──────────────────────────────────────────

  /**
   * Correct the px metrics CodeView uses to estimate item heights (and reserve
   * space for virtualized-out lines). The vendor's static getEstimatedLineHeight
   * returns metrics.lineHeight for EVERY off-screen line and never adapts to
   * measured heights, and the custom header is never measured (fixed at
   * metrics.diffHeaderHeight) — so wrong metrics make reserved heights disagree
   * with rendered heights, which shifts as lines mount on scroll. pr.js measures
   * the real rendered dimensions and pushes them here.
   *
   * Only finite numbers are merged; a change within EPS px is treated as no-op
   * to avoid a needless relayout on every render (sub-pixel measurement jitter).
   * @param {{diffHeaderHeight?:number, lineHeight?:number, hunkSeparatorHeight?:number, spacing?:number}} metrics
   * @returns {boolean} whether the metrics changed (and a relayout was scheduled)
   */
  setItemMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return false;
    const EPS = 0.5;
    const next = { ...(this._itemMetrics || {}) };
    let changed = false;
    for (const key of ['diffHeaderHeight', 'lineHeight', 'hunkSeparatorHeight', 'spacing']) {
      const value = metrics[key];
      if (!Number.isFinite(value) || value <= 0) continue;
      const prev = next[key];
      if (!Number.isFinite(prev) || Math.abs(prev - value) >= EPS) {
        next[key] = value;
        changed = true;
      }
    }
    if (!changed) return false;
    this._itemMetrics = next;
    // setOptions recomputes the metrics cache; when it differs it relayouts and
    // reschedules a render on its own — no explicit render() needed.
    if (this.codeView) {
      this.codeView.setOptions(this._buildCodeViewOptions());
    }
    return true;
  }

  // ─── CSS Injection ────────────────────────────────────────────────

  getUnsafeCSS() {
    if (this._unsafeCSS !== null) return this._unsafeCSS;
    this._unsafeCSS = PierreBridge.ANNOTATION_CSS;
    return this._unsafeCSS;
  }

  /**
   * Create the shared worker pool used by @pierre/diffs for syntax highlighting.
   * @returns {Object|null}
   * @private
   */
  _createWorkerManager() {
    if (this._disabled) return null;
    if (!window.PierreDiffs?.WorkerPoolManager || typeof Worker === 'undefined') {
      return null;
    }

    try {
      const hardwareConcurrency = window.navigator?.hardwareConcurrency || 2;
      const poolSize = Math.max(1, Math.min(2, Math.floor(hardwareConcurrency / 2) || 1));
      return new window.PierreDiffs.WorkerPoolManager({
        workerFactory: () => {
          const worker = new Worker('/js/vendor/pierre-diffs-worker.js');
          worker.addEventListener('error', (event) => {
            if (!this._workerReady) {
              this._fallbackToMainThreadRendering('worker failed to load', event.error || event.message || event);
            }
          }, { once: true });
          return worker;
        },
        poolSize,
        totalASTLRUCacheSize: 50,
      }, {
        langs: ['text'],
        ...this._getWorkerRenderOptions(),
        preferredHighlighter: 'shiki-js',
      });
    } catch (err) {
      console.warn('[PierreBridge] Failed to initialize @pierre/diffs worker pool; falling back to main-thread rendering.', err);
      return null;
    }
  }

  _handleWorkerStats(stats) {
    if (!stats) return;

    if (stats.workersFailed || /fail|error/i.test(stats.managerState || '')) {
      this._fallbackToMainThreadRendering('worker startup failed', stats);
      return;
    }

    if (stats.managerState !== 'initialized' || this._workerReady) return;
    this._workerReady = true;
    this._clearWorkerInitTimeout();
    // The single CodeView already holds the worker manager reference; once the
    // pool reports ready, a fresh render picks up worker highlighting. Bumping
    // every item's version forces that render.
    this._republishAll();
  }

  _startWorkerInitTimeout() {
    this._clearWorkerInitTimeout();
    if (!this.workerManager || this._workerReady) return;
    this._workerInitTimer = setTimeout(() => {
      if (!this._workerReady) {
        this._fallbackToMainThreadRendering('worker startup timed out');
      }
    }, PierreBridge.WORKER_INIT_TIMEOUT_MS);
  }

  _clearWorkerInitTimeout() {
    if (this._workerInitTimer) {
      clearTimeout(this._workerInitTimer);
      this._workerInitTimer = null;
    }
  }

  _fallbackToMainThreadRendering(reason, detail) {
    if (!this.workerManager) return false;

    console.warn(`[PierreBridge] @pierre/diffs ${reason}; falling back to main-thread rendering.`, detail || '');
    this._workersFailed = true;
    this._workerReady = true;
    this._clearWorkerInitTimeout();
    if (this._workerStatsUnsubscribe) {
      this._workerStatsUnsubscribe();
      this._workerStatsUnsubscribe = null;
    }

    const failedManager = this.workerManager;
    this.workerManager = null;
    if (failedManager?.terminate) {
      try {
        failedManager.terminate();
      } catch (err) {
        console.warn('[PierreBridge] Failed to terminate @pierre/diffs worker pool.', err);
      }
    }

    // The CodeView was constructed with the (now dead) worker manager as its
    // second constructor arg; recreate it main-thread-only, preserving items.
    this._recreateCodeViewMainThread();
    return true;
  }

  // ─── Patch Parsing & diffPosition Computation ─────────────────────

  /**
   * Parse a unified diff patch for a single file.
   * @param {string} patch - Unified diff patch text (after the file header)
   * @returns {import('@pierre/diffs').FileDiffMetadata|null}
   */
  parsePatch(patch) {
    if (!patch) return null;

    let input = patch;
    if (!patch.startsWith('diff --git ')) {
      input = `diff --git a/file b/file\n--- a/file\n+++ b/file\n${patch}`;
    }

    const parsed = window.PierreDiffs.parsePatchFiles(input);
    if (parsed && parsed.length > 0 && parsed[0].files && parsed[0].files.length > 0) {
      return parsed[0].files[0];
    }
    return window.PierreDiffs.getSingularPatch(patch);
  }

  /**
   * Compute GitHub diffPosition mapping for a patch.
   * @param {string} patch
   * @param {Object} [metadata] - Pre-parsed Pierre FileDiffMetadata (optional)
   * @returns {Map<string, number>}
   */
  computeDiffPositions(patch, metadata) {
    if (metadata) {
      const fromMeta = this._diffPositionsFromMetadata(metadata);
      if (fromMeta) return fromMeta;
    }
    return this._diffPositionsFromPatch(patch);
  }

  /**
   * Derive the diffPosition map from pre-parsed Pierre metadata's ordered
   * `hunkContent` segments. Returns null when any hunk lacks `hunkContent` or
   * carries an unrecognized segment type, so an unexpected bundle shape can
   * never yield a partial / wrong map.
   * @param {Object} metadata
   * @returns {Map<string, number>|null}
   * @private
   */
  _diffPositionsFromMetadata(metadata) {
    if (!metadata || !Array.isArray(metadata.hunks)) return null;

    const positions = new Map();
    let diffPosition = 0;

    for (const hunk of metadata.hunks) {
      if (!Array.isArray(hunk.hunkContent)) return null;
      diffPosition++;

      let oldLineNum = hunk.deletionStart;
      let newLineNum = hunk.additionStart;

      for (const segment of hunk.hunkContent) {
        if (segment.type === 'context') {
          for (let i = 0; i < segment.lines; i++) {
            diffPosition++;
            positions.set(`RIGHT:${newLineNum}`, diffPosition);
            positions.set(`LEFT:${oldLineNum}`, diffPosition);
            oldLineNum++;
            newLineNum++;
          }
        } else if (segment.type === 'change') {
          for (let i = 0; i < (segment.deletions || 0); i++) {
            diffPosition++;
            positions.set(`LEFT:${oldLineNum}`, diffPosition);
            oldLineNum++;
          }
          for (let i = 0; i < (segment.additions || 0); i++) {
            diffPosition++;
            positions.set(`RIGHT:${newLineNum}`, diffPosition);
            newLineNum++;
          }
        } else {
          return null;
        }
      }
    }

    return positions;
  }

  /**
   * Compute the diffPosition map by parsing the raw patch string.
   * @param {string} patch
   * @returns {Map<string, number>}
   * @private
   */
  _diffPositionsFromPatch(patch) {
    const positions = new Map();
    if (!patch) return positions;

    const blocks = window.HunkParser
      ? window.HunkParser.parseDiffIntoBlocks(patch)
      : this._parseBlocksFallback(patch);

    let diffPosition = 0;

    blocks.forEach(block => {
      diffPosition++;

      let oldLineNum = block.oldStart;
      let newLineNum = block.newStart;

      block.lines.forEach(line => {
        if (!line && line !== '') return;
        diffPosition++;

        if (line.startsWith('+')) {
          positions.set(`RIGHT:${newLineNum}`, diffPosition);
          newLineNum++;
        } else if (line.startsWith('-')) {
          positions.set(`LEFT:${oldLineNum}`, diffPosition);
          oldLineNum++;
        } else {
          positions.set(`RIGHT:${newLineNum}`, diffPosition);
          positions.set(`LEFT:${oldLineNum}`, diffPosition);
          oldLineNum++;
          newLineNum++;
        }
      });
    });

    return positions;
  }

  /**
   * Get diffPosition for a file + line + side.
   * @param {string} fileName
   * @param {number} lineNumber
   * @param {string} side - 'LEFT' or 'RIGHT' (or 'additions'/'deletions')
   * @returns {number|null}
   */
  getDiffPosition(fileName, lineNumber, side) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.diffPositions) return null;
    const normalizedSide = PierreBridge.normalizeSide(side);
    return fileState.diffPositions.get(`${normalizedSide}:${lineNumber}`) || null;
  }

  // ─── CodeView Lifecycle ───────────────────────────────────────────

  /**
   * Build the shared CodeView option object. Rebuilt (and handed to
   * setOptions) whenever a top-level option changes (theme, diffStyle).
   * @returns {Object}
   * @private
   */
  _buildCodeViewOptions() {
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
      unsafeCSS: this.getUnsafeCSS(),
      hunkSeparators: 'line-info',
      expansionLineCount: 20,
      collapsedContextThreshold: 5,
      stickyHeaders: true,
      layout: { paddingTop: 0, paddingBottom: 16, gap: 16 },
      ...(this._itemMetrics ? { itemMetrics: this._itemMetrics } : {}),

      renderCustomHeader: (_fileDiffOrFile, context) => {
        const id = context?.item?.id;
        const fileState = id != null ? this.files.get(id) : null;
        if (!fileState || typeof this._renderHeader !== 'function') return undefined;
        try {
          return this._renderHeader(fileState.fileName, context) || undefined;
        } catch (err) {
          console.error('[PierreBridge] header factory failed:', err);
          return undefined;
        }
      },

      renderAnnotation: (annotation, context) => {
        const id = context?.item?.id;
        const fileState = id != null ? this.files.get(id) : null;
        if (!fileState) return undefined;
        return this._renderAnnotation(annotation, fileState.fileName, fileState.formElements, id);
      },

      renderGutterUtility: (getHoveredRow, context) => {
        const id = context?.item?.id;
        const fileState = id != null ? this.files.get(id) : null;
        if (!fileState || fileState.itemType === 'context') return undefined;
        return this._createGutterButtons(id, fileState.fileName, getHoveredRow);
      },

      onLineClick: (props, context) => {
        const fileName = context?.item ? this._fileNameForItemId(context.item.id) : null;
        if (fileName && this.options.onLineClick) {
          this.options.onLineClick(fileName, {
            lineNumber: props.lineNumber,
            side: props.annotationSide === 'deletions' ? 'LEFT' : 'RIGHT',
            lineType: props.lineType,
            element: props.lineElement,
          });
        }
      },

      onLineSelected: (range, context) => {
        const fileName = context?.item ? this._fileNameForItemId(context.item.id) : null;
        if (fileName && this.options.onLineSelect) {
          this.options.onLineSelect(fileName, range);
        }
      },

      onLineSelectionEnd: (range, context) => {
        const fileName = context?.item ? this._fileNameForItemId(context.item.id) : null;
        if (fileName && this.options.onLineSelectionEnd) {
          this.options.onLineSelectionEnd(fileName, range);
        }
      },

      onPostRender: (fileContainer, instance, phase, context) => {
        // The vendor FileDiff invokes onPostRender(fileContainer, instance,
        // phase) where phase is 'mount'|'update'|'unmount'; CodeView's shared-
        // callback wrapper appends the item context as the LAST arg. So context
        // is the 4th param here, NOT the 3rd (that is the phase string).
        //
        // Resolve the item id from the context, falling back to the per-item
        // instance (stable across mount/unmount) so the 'unmount' path can
        // ALWAYS clear refs even if the context no longer carries the item.
        const id = context?.item?.id
          ?? (instance ? this._instanceToId.get(instance) : undefined);
        if (id == null) return;
        const fileState = this.files.get(id);
        if (!fileState) return;

        if (phase === 'unmount') {
          // Item scrolled out of view — CodeView recycles its <diffs-container>
          // host for a DIFFERENT item and restamps it. If we kept the stale
          // ref, isPointerOverFile / _shadowRoot queries would read the wrong
          // file's live DOM. Clear the refs, but only if they still point at
          // THIS instance/element (a remount could already have re-populated
          // them — pooling releases synchronously before reuse, but guard
          // anyway). Consumers treat null refs as "not mounted" (same as
          // pre-mount): isPointerOverFile → false, isLineVisible → metadata
          // only, scroll flash → skipped.
          const releasedHost = context?.element || fileState._element || fileContainer;
          if (fileState._instance === instance || fileState._element === releasedHost) {
            fileState._element = null;
            fileState.container = null;
            fileState._shadowRoot = null;
            fileState._instance = null;
          }
          // Strip the identity/domain classes + data-file-name from the recycled
          // host so it carries nothing from this item into its next occupant.
          this._cleanHostClasses(releasedHost);
          this._instanceToId.delete(instance);
          return;
        }

        const host = context?.element || fileContainer;
        fileState._element = host || null;
        fileState.container = host || null;
        fileState._shadowRoot = host?.shadowRoot || null;
        fileState._instance = context?.instance || instance || null;
        if (instance) this._instanceToId.set(instance, id);
        // Reconcile the light-DOM host's identity + domain classes so
        // isPointerOverFile / comment-minimizer / summaries-hidden CSS resolve,
        // and a recycled host never keeps a previous item's classes.
        this._applyHostClasses(fileState, host);
        this._syncSplitAnnotationLayout(id);
        // This callback runs AFTER the vendor's renderAnnotations() in the same
        // render pass (FileDiff.js: renderAnnotations() then emitPostRender()),
        // so the annotation slots are now in the DOM — resolve any waiters.
        this._resolveSlotWaiters(id);
      },
    };
  }

  _ensureCodeView(root) {
    // An external wipe of #diff-container (a stray diffContainer.innerHTML —
    // refreshPR's spinner, error states) detaches the CodeView's managed
    // container while root === root; a bare early-return would then keep updating
    // the now-orphaned node forever (the visible root stays frozen). Detect the
    // detach positively (container is an element no longer parented by root) and
    // treat it like a root change — fall through to a full re-setup. (Not
    // isConnected: `root` is detached from the document in unit tests, so that
    // would false-trigger; parentNode holds in both real and test DOM.)
    const container = this.codeView && this.codeView.container;
    const containerWiped = container && container.parentNode !== root;
    if (this.codeView && this.root === root && !containerWiped) return this.codeView;

    // Root changed, first render, or our container was externally wiped: tear
    // down any prior CodeView and rebind.
    if (this.codeView) {
      try { this.codeView.cleanUp(); } catch (_err) { /* ignore */ }
      this.codeView = null;
    }
    this.root = root;
    root.innerHTML = '';
    // Mark the root so pr.css can make it the overflow scroll container that
    // CodeView.setup() requires (it scrolls the root directly). Scoped so the
    // legacy per-file-table path is untouched.
    root.classList.add('pierre-codeview-root');
    const CodeView = window.PierreDiffs.CodeView;
    this.codeView = new CodeView(this._buildCodeViewOptions(), this.workerManager || undefined);
    this.codeView.setup(root);
    return this.codeView;
  }

  /**
   * Render (or re-render) the whole changed-file list into `root`.
   *
   * This is the single render entry, replacing the old per-file renderFile /
   * renderBinaryFile. `root` becomes the CodeView-managed scroll container.
   *
   * @param {HTMLElement} root - the #diff-container scroll element
   * @param {Array<Object>} entries - ordered descriptors:
   *   { id, type:'diff'|'binary'|'context', fileName, patch?, collapsed?,
   *     forcePlainText?, contents?, binaryMessage? }
   * @param {Object} [options]
   * @param {Function} [options.renderHeader] - (fileName, context) => HTMLElement|null
   * @returns {Map} this.files
   */
  renderAll(root, entries, options = {}) {
    if (this._disabled || !root) return this.files;
    if (typeof options.renderHeader === 'function') {
      this._renderHeader = options.renderHeader;
    }
    // Optional per-item domain host classes (generated-file, summaries-hidden-
    // file, …). The bridge owns applying/cleaning them so a pooled/recycled
    // host never carries a previous item's classes. (fileName, itemType) => string[]
    if (typeof options.hostClasses === 'function') {
      this._hostClassesFor = options.hostClasses;
    }

    this._ensureCodeView(root);

    // Rebuild per-file state from scratch. Any file dropped from `entries` is
    // torn down; ids that persist are rebuilt (their annotations are reset —
    // callers re-add them after renderAll, mirroring the legacy flow where
    // destroyAll() preceded a fresh render).
    this._teardownAllFileState();

    const items = [];
    for (const entry of entries || []) {
      const fileState = this._createFileState(entry);
      if (!fileState) continue;
      this.files.set(fileState.id, fileState);
      items.push(this._buildItem(fileState));
    }

    this.codeView.setItems(items);
    return this.files;
  }

  /**
   * Identity + domain classes the bridge manages on each item's light-DOM
   * host. Reconciled on every mount and stripped on recycle so a pooled
   * <diffs-container> never carries a previous item's classes.
   * `d2h-file-wrapper` is the always-on base; the rest are conditional.
   */
  static MANAGED_HOST_CLASSES = [
    'd2h-file-wrapper', 'context-file', 'collapsed', 'generated-file', 'summaries-hidden-file',
  ];

  /**
   * Reconcile the managed classes + data-file-name on an item's host. Strips
   * all managed classes first (a recycled host may carry a prior item's), then
   * applies this item's: base + context-file/collapsed (bridge-known) + any
   * caller-supplied domain classes (generated-file, summaries-hidden-file).
   * @private
   */
  _applyHostClasses(fileState, host) {
    if (!host || !host.classList) return;
    host.classList.remove(...PierreBridge.MANAGED_HOST_CLASSES);
    host.classList.add('d2h-file-wrapper');
    if (fileState.itemType === 'context') host.classList.add('context-file');
    if (fileState.collapsed) host.classList.add('collapsed');
    if (typeof this._hostClassesFor === 'function') {
      let extra;
      try {
        extra = this._hostClassesFor(fileState.fileName, fileState.itemType);
      } catch (err) {
        console.error('[PierreBridge] hostClasses callback failed:', err);
      }
      if (Array.isArray(extra)) {
        for (const cls of extra) if (cls) host.classList.add(cls);
      }
    }
    if (host.dataset) host.dataset.fileName = fileState.fileName;
  }

  /**
   * Strip all managed classes + data-file-name from a recycled host.
   * @private
   */
  _cleanHostClasses(host) {
    if (!host || !host.classList) return;
    host.classList.remove(...PierreBridge.MANAGED_HOST_CLASSES);
    if (host.dataset && 'fileName' in host.dataset) delete host.dataset.fileName;
  }

  /**
   * Build the per-file state record for one render entry.
   * @param {Object} entry
   * @returns {Object|null}
   * @private
   */
  _createFileState(entry) {
    if (!entry || !entry.id || !entry.fileName) return null;
    const itemType = entry.type || 'diff';

    const fileState = {
      id: entry.id,
      fileName: entry.fileName,
      itemType,
      type: itemType === 'context' ? 'file' : 'diff',
      metadata: null,
      baseMetadata: null,
      patch: entry.patch || null,
      annotations: [],
      diffPositions: new Map(),
      formElements: new Map(),
      contextRanges: [],
      patchParityRanges: null,
      oldFile: null,
      newFile: null,
      fileContents: null,
      collapsed: !!entry.collapsed,
      forcePlainText: !!entry.forcePlainText,
      binaryMessage: entry.binaryMessage || 'Binary file not shown',
      version: 1,
      _element: null,
      _shadowRoot: null,
      _instance: null,
      _splitLayoutRaf: null,
    };

    if (itemType === 'context') {
      fileState.fileContents = {
        name: entry.fileName,
        contents: entry.contents || '',
      };
      if (fileState.forcePlainText) fileState.fileContents.lang = 'text';
    } else if (itemType === 'binary') {
      // Zero-hunk diff item: header-only. The binary message rides on the
      // header (pr.js factory) so no body content is needed.
      fileState.metadata = this._buildBinaryMetadata(entry.fileName);
    } else {
      const metadata = this.parsePatch(entry.patch);
      if (metadata) {
        metadata.name = entry.fileName;
        if (fileState.forcePlainText) metadata.lang = 'text';
      }
      // A patch that fails to parse (or an empty patch) must never publish a
      // null fileDiff — CodeView would throw. Fall back to a header-only item.
      fileState.metadata = metadata || this._buildBinaryMetadata(entry.fileName);
      fileState.diffPositions = this.computeDiffPositions(entry.patch, metadata);
    }

    return fileState;
  }

  /**
   * Build a zero-hunk FileDiffMetadata for a binary file (header only).
   * @param {string} fileName
   * @returns {Object}
   * @private
   */
  _buildBinaryMetadata(fileName) {
    return {
      name: fileName,
      type: 'change',
      hunks: [],
      splitLineCount: 0,
      unifiedLineCount: 0,
      isPartial: true,
      deletionLines: [],
      additionLines: [],
    };
  }

  /**
   * Build the CodeViewItem for a file state from its current data + version.
   * @param {Object} fileState
   * @returns {Object}
   * @private
   */
  _buildItem(fileState) {
    const annotations = this._sortedAnnotations(fileState);
    if (fileState.type === 'file') {
      return {
        id: fileState.id,
        type: 'file',
        file: fileState.fileContents,
        annotations,
        version: fileState.version,
        collapsed: fileState.collapsed,
      };
    }
    return {
      id: fileState.id,
      type: 'diff',
      fileDiff: fileState.metadata,
      annotations,
      version: fileState.version,
      collapsed: fileState.collapsed,
    };
  }

  /**
   * Publish the current state of a file to the CodeView by bumping its version
   * and calling updateItem. Re-reads the live record first so a change that
   * resolves after the item was removed/replaced is dropped, not resurrected.
   * @param {string} id
   * @returns {boolean}
   * @private
   */
  _publishItem(id) {
    const fileState = this.files.get(id);
    if (!fileState || !this.codeView) return false;
    // Guard against stale writes: if the CodeView no longer holds this id
    // (a newer setItems replaced the list), skip.
    if (!this.codeView.getItem(id)) return false;
    fileState.version = (fileState.version || 0) + 1;
    return this.codeView.updateItem(this._buildItem(fileState));
  }

  /**
   * Bump every item's version to force a full re-render (worker-ready, main
   * thread fallback). Uses setItems so ordering is preserved.
   * @private
   */
  _republishAll() {
    if (!this.codeView || this.files.size === 0) return;
    const items = [];
    for (const fileState of this.files.values()) {
      fileState.version = (fileState.version || 0) + 1;
      items.push(this._buildItem(fileState));
    }
    this.codeView.setItems(items);
  }

  /**
   * Recreate the CodeView main-thread-only (after a worker pool failure),
   * preserving the current items and scroll position.
   * @private
   */
  _recreateCodeViewMainThread() {
    if (!this.codeView || !this.root) return;
    const scrollTop = this.codeView.getScrollTop?.() || 0;
    try { this.codeView.cleanUp(); } catch (_err) { /* ignore */ }
    // cleanUp() disconnects observers/listeners but leaves its container <div> in
    // the root, and setup() appends a fresh one — clear the root first (as
    // _ensureCodeView does) or the old container leaks as orphaned DOM.
    this.root.innerHTML = '';
    const CodeView = window.PierreDiffs.CodeView;
    this.codeView = new CodeView(this._buildCodeViewOptions(), undefined);
    this.codeView.setup(this.root);
    // Recreating bypasses the per-item unmount callbacks that normally drop
    // instance→id entries, and every instance the old CodeView made is now dead —
    // without this the map grows by one entry per file on every worker failure.
    this._instanceToId.clear();
    const items = [];
    for (const fileState of this.files.values()) {
      fileState.version = (fileState.version || 0) + 1;
      // Clear ALL FOUR mount refs, symmetric with the onPostRender unmount path
      // — consumers (external-comment-manager, tour-renderer) read
      // fileState.container and treat non-null as mounted; leaving a stale
      // detached container makes an off-screen file look mounted after recreate.
      fileState._element = null;
      fileState.container = null;
      fileState._shadowRoot = null;
      fileState._instance = null;
      items.push(this._buildItem(fileState));
    }
    this.codeView.setItems(items);
    if (scrollTop) this.codeView.scrollTo({ type: 'position', position: scrollTop });
  }

  /**
   * Tear down all per-file state (gutter caches, split-layout rAFs) without
   * touching the CodeView itself.
   * @private
   */
  _teardownAllFileState() {
    for (const fileState of this.files.values()) {
      if (fileState._splitLayoutRaf != null) {
        cancelAnimationFrame(fileState._splitLayoutRaf);
      }
      fileState.formElements?.clear?.();
    }
    // Resolve any outstanding slot waiters as not-mounted before dropping them,
    // so awaiters of a torn-down item never hang. Snapshot and clear the map
    // BEFORE resolving (as _resolveSlotWaiters does): each waiter's finish()
    // splices itself out of the live array, so resolving while iterating it skips
    // every second waiter — those then settle frames later via their own rAF
    // fallback with the wrong reason instead of 'destroyed'.
    const pendingWaiters = [...this._slotWaiters.values()];
    this._slotWaiters.clear();
    for (const waiters of pendingWaiters) {
      // Same result shape destroyFile resolves with, element key included.
      for (const w of waiters) w({ element: null, mounted: false, slotted: false, reason: 'destroyed' });
    }
    this.files.clear();
    this._gutterContainers.clear();
    this._gutterRowGetters.clear();
    this._instanceToId.clear();
  }

  /**
   * Destroy all items — resets the CodeView to an empty list and clears state.
   * The CodeView instance and its root binding are preserved so the next
   * renderAll() reuses them.
   */
  destroyAll() {
    this._teardownAllFileState();
    if (this.codeView) {
      this.codeView.setItems([]);
    }
  }

  /**
   * Remove a single file's item. Rare (renderAll rebuilds wholesale) but kept
   * for API parity.
   * @param {string} fileName
   */
  destroyFile(fileName) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;
    if (fileState._splitLayoutRaf != null) cancelAnimationFrame(fileState._splitLayoutRaf);
    fileState.formElements?.clear?.();
    this._gutterContainers.delete(fileName);
    this._gutterRowGetters.delete(fileName);
    // Resolve + drop any pending slot waiters so awaiters never hang, and drop
    // the instance→id mapping — otherwise these leak for every destroyed file /
    // removed context item.
    this._resolveSlotWaiters(fileName, { element: null, mounted: false, slotted: false, reason: 'destroyed' });
    if (fileState._instance) this._instanceToId.delete(fileState._instance);
    this.files.delete(fileName);
    if (this.codeView) {
      const remaining = [];
      for (const fs of this.files.values()) remaining.push(this._buildItem(fs));
      this.codeView.setItems(remaining);
    }
  }

  // ─── Context Files (whole-file reference items) ───────────────────

  /**
   * CodeView item id for a context file (namespaced so a context entry never
   * collides with a diff entry that shares the same path — see fix #540).
   * @private
   */
  _contextIdFor(fileName) {
    return `context:${fileName}`;
  }

  hasContextFile(fileName) {
    return this.files.has(this._contextIdFor(fileName));
  }

  /**
   * Add (or update the contents of) a context-file item — a whole-file
   * reference view appended after the diff items. Idempotent per path.
   * @param {string} fileName
   * @param {string} contents - full file text
   * @param {Object} [opts] - { collapsed }
   * @returns {boolean}
   */
  addContextFile(fileName, contents, opts = {}) {
    if (this._disabled || !this.codeView) return false;
    const id = this._contextIdFor(fileName);
    const existing = this.files.get(id);
    if (existing) {
      existing.fileContents = { name: fileName, contents: contents || '' };
      if (existing.forcePlainText) existing.fileContents.lang = 'text';
      return this._publishItem(id);
    }
    const fileState = this._createFileState({
      id, type: 'context', fileName, contents, collapsed: !!opts.collapsed,
    });
    if (!fileState) return false;
    this.files.set(id, fileState);
    this.codeView.addItems([this._buildItem(fileState)]);
    return true;
  }

  /**
   * Remove a context-file item.
   * @param {string} fileName
   */
  removeContextFileItem(fileName) {
    this.destroyFile(this._contextIdFor(fileName));
  }

  /**
   * Collapse/expand a context-file item.
   * @param {string} fileName
   * @param {boolean} collapsed
   */
  setContextFileCollapsed(fileName, collapsed) {
    this.setCollapsed(this._contextIdFor(fileName), collapsed);
  }

  // ─── Content Upgrade (full contents → hunk expansion) ─────────────

  /**
   * Upgrade a patch-only diff item to full-contents metadata so hunk expansion
   * (the vendor's line-info expand arrows) and context-range reveal work.
   *
   * Builds a non-partial FileDiffMetadata via parseDiffFromFile(old, new) and
   * publishes it with a bumped version. Captures the patch's visible line spans
   * so the full re-diff never un-renders lines the patch showed (which would
   * orphan anchored comments/annotations).
   *
   * @param {string} fileName
   * @param {{ name: string, contents: string }|null} oldFile
   * @param {{ name: string, contents: string }|null} newFile
   * @returns {boolean} true if the upgrade published
   */
  upgradeFileContents(fileName, oldFile, newFile) {
    const fileState = this.files.get(fileName);
    if (!fileState || fileState.itemType !== 'diff') return false;
    if (fileState.baseMetadata) return true; // already upgraded

    const nextOldFile = fileState.forcePlainText && oldFile
      ? { ...oldFile, lang: 'text' }
      : oldFile;
    const nextNewFile = fileState.forcePlainText && newFile
      ? { ...newFile, lang: 'text' }
      : newFile;

    const parseFrom = window.PierreDiffs.parseDiffFromFile;
    if (typeof parseFrom !== 'function') return false;

    let fullMetadata;
    try {
      fullMetadata = parseFrom(
        nextOldFile || { name: fileName, contents: '' },
        nextNewFile || { name: fileName, contents: '' }
      );
    } catch (err) {
      console.warn(`[PierreBridge] parseDiffFromFile failed for ${fileName}; keeping patch-only diff.`, err);
      return false;
    }
    if (!fullMetadata) return false;
    fullMetadata.name = fileName;
    if (fileState.forcePlainText) fullMetadata.lang = 'text';

    // Capture the patch's addition-side spans BEFORE swapping metadata: the
    // full-contents re-diff can compute narrower context than the patch, which
    // would silently drop lines the patch (and anchored annotations) showed.
    const prevHunks = fileState.metadata?.hunks;
    if (!fileState.patchParityRanges && Array.isArray(prevHunks) && prevHunks.length) {
      fileState.patchParityRanges = prevHunks
        .filter(h => h.additionCount > 0)
        .map(h => ({
          startLine: h.additionStart,
          endLine: h.additionStart + h.additionCount - 1,
        }));
    }

    fileState.oldFile = nextOldFile;
    fileState.newFile = nextNewFile;
    fileState.baseMetadata = fullMetadata;
    fileState.metadata = this._effectiveMetadata(fileState);
    return this._publishItem(fileName);
  }

  // ─── Context Ranges ──────────────────────────────────────────────

  /**
   * Add context ranges (NEW-file coords, 1-indexed) to reveal non-contiguous
   * lines. Queued until content is upgraded (baseMetadata present).
   * @param {string} fileName
   * @param {Array<{startLine:number, endLine:number}>} ranges
   * @returns {boolean} true if applied immediately
   */
  addContextRanges(fileName, ranges) {
    const fileState = this.files.get(fileName);
    if (!fileState || fileState.itemType !== 'diff') return false;

    const { mergeOverlapping } = window.PierreContext || {};
    if (!mergeOverlapping) {
      console.warn('[PierreBridge] window.PierreContext not loaded — cannot add context ranges');
      return false;
    }

    const existing = fileState.contextRanges || [];
    fileState.contextRanges = mergeOverlapping([...existing, ...ranges]);

    if (!fileState.baseMetadata) return false;
    fileState.metadata = this._effectiveMetadata(fileState);
    return this._publishItem(fileName);
  }

  /**
   * Remove specific context ranges from a file.
   * @param {string} fileName
   * @param {Array<{startLine:number, endLine:number}>} ranges
   * @returns {boolean}
   */
  removeContextRanges(fileName, ranges) {
    const fileState = this.files.get(fileName);
    if (!fileState || fileState.itemType !== 'diff') return false;

    const { subtractRanges } = window.PierreContext || {};
    if (!subtractRanges) return false;

    fileState.contextRanges = subtractRanges(fileState.contextRanges || [], ranges);
    if (!fileState.baseMetadata) return false;
    fileState.metadata = this._effectiveMetadata(fileState);
    return this._publishItem(fileName);
  }

  /**
   * Remove all dynamically-added context ranges, restoring the diff view.
   * Patch-parity spans are never shrunk below what the original patch showed.
   * @param {string} fileName
   * @returns {boolean}
   */
  clearContextRanges(fileName) {
    const fileState = this.files.get(fileName);
    if (!fileState || fileState.itemType !== 'diff') return false;
    fileState.contextRanges = [];
    if (!fileState.baseMetadata) return false;
    fileState.metadata = this._effectiveMetadata(fileState);
    return this._publishItem(fileName);
  }

  /**
   * All spans that must stay visible: immutable patch-parity + dynamic ranges.
   * @param {Object} fileState
   * @returns {Array<{startLine:number, endLine:number}>}
   * @private
   */
  _effectiveContextRanges(fileState) {
    return [
      ...(fileState?.patchParityRanges || []),
      ...(fileState?.contextRanges || []),
    ];
  }

  /**
   * Compute the metadata to publish for a diff item: the base (full-contents)
   * metadata with all effective context ranges merged in. Falls back to the
   * patch-only metadata before an upgrade.
   * @param {Object} fileState
   * @returns {Object}
   * @private
   */
  _effectiveMetadata(fileState) {
    if (!fileState.baseMetadata) return fileState.metadata;
    const ranges = this._effectiveContextRanges(fileState);
    if (!ranges.length) return fileState.baseMetadata;
    const { mergeContextRanges } = window.PierreContext || {};
    if (!mergeContextRanges) return fileState.baseMetadata;
    return mergeContextRanges(fileState.baseMetadata, ranges) || fileState.baseMetadata;
  }

  /**
   * Convert OLD-file (deletion-side) line numbers to NEW-file coordinates.
   * @param {string} fileName
   * @param {number} oldStart
   * @param {number} oldEnd
   * @returns {{startLine:number, endLine:number}|null}
   */
  convertOldToNew(fileName, oldStart, oldEnd) {
    const fileState = this.files.get(fileName);
    if (!fileState?.baseMetadata) return null;
    const { convertOldToNew } = window.PierreContext || {};
    if (!convertOldToNew) return null;
    return convertOldToNew(fileState.baseMetadata, oldStart, oldEnd);
  }

  // ─── Collapse / Viewed ────────────────────────────────────────────

  /**
   * Collapse/expand a file's diff body. CodeView re-renders the body on a
   * collapsed:true→false transition when the version is bumped, so no manual
   * re-kick is needed (unlike the old per-FileDiff instance path).
   * @param {string} fileName
   * @param {boolean} collapsed
   */
  setCollapsed(fileName, collapsed) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;
    // Always publish (even when the flag is unchanged): callers use this to
    // force a header refresh after a viewed-state change that did not alter
    // the collapse flag.
    fileState.collapsed = collapsed;
    this._publishItem(fileName);
  }

  // ─── Layout ───────────────────────────────────────────────────────

  /**
   * Push already-measured item heights into the DOM scroll extent.
   *
   * CodeView reconciles item heights OUTSIDE a render pass — its ResizeObserver
   * watches the sticky container that parents every rendered item, so content
   * growing inside a mounted item does update `item.height` and the vendor's own
   * `scrollHeight`. But only a RENDER pass calls `syncContainerHeight()`: compare
   * computeRenderRangeAndEmit (CodeView.js:1284-1286) with the resize handler
   * (CodeView.js:1404-1412), which reconciles and repositions but never syncs the
   * container element's height. Until the next render the DOM container stays
   * SHORT by exactly the growth: measured here as a scroll extent of 1216px while
   * the vendor already believed 1430px after a file-comment form opened. The user
   * cannot scroll to content in that gap, so on a file whose body already fills
   * the viewport the form's Save button is unreachable.
   *
   * Requests a QUEUED render, which the vendor coalesces to one pass per frame:
   * a resize storm (a textarea autogrowing on every keystroke) costs one layout
   * flush per frame, with no version bump, no annotation re-render and no
   * layout-cache reset — unlike republishing the item.
   * @returns {boolean} true when a render was requested
   */
  syncScrollExtent() {
    if (this._disabled || typeof this.codeView?.render !== 'function') return false;
    this.codeView.render(false);
    return true;
  }

  // ─── Scrolling ────────────────────────────────────────────────────

  /**
   * Scroll a file into view.
   * @param {string} fileName
   * @param {Object} [opts] - { align, behavior }
   * @returns {boolean}
   */
  scrollToFile(fileName, opts = {}) {
    if (!this.codeView || !this.files.has(fileName)) return false;
    const align = opts.align || 'start';
    let offset = opts.offset || 0;
    // With stickyHeaders, an align:'start' item scroll positions the target's
    // top edge at the viewport top — but the PRECEDING file's sticky header is
    // still pinned there, so the target's own header renders one header-height
    // below it (a visible empty gap). The vendor compensates line/range scrolls
    // with getStickyHeaderOffset() but NOT item scrolls, so do it here: scroll
    // an extra header-height past item.top (align:'start' ⇒ scrollTop =
    // item.top − offset), which pushes the preceding header out and pins the
    // target's own header at the top. The FIRST item has no preceding header,
    // so it is left alone (offsetting it would scroll past the file's top).
    const isFirstItem = this.files.keys().next().value === fileName;
    if (align === 'start' && !isFirstItem) {
      // Prefer the caller's measured header height (opts.stickyOffset — the
      // actual rendered header, e.g. pr.js's --diff-file-header-height). The
      // vendor's getStickyHeaderOffset() is only an itemMetrics ESTIMATE
      // (default ~44) and undershoots a taller custom header, leaving a residual
      // gap.
      const stickyOffset = Number.isFinite(opts.stickyOffset)
        ? opts.stickyOffset
        : (typeof this.codeView.getStickyHeaderOffset === 'function'
          ? (this.codeView.getStickyHeaderOffset() || 0)
          : 0);
      offset -= stickyOffset;
    }
    this.codeView.scrollTo({
      type: 'item',
      id: fileName,
      align,
      offset,
      behavior: opts.behavior || 'smooth',
    });
    return true;
  }

  /**
   * Scroll to a specific line in a file and flash it.
   * @param {string} fileName
   * @param {number} lineNumber
   * @param {string} [side] - 'LEFT' or 'RIGHT'
   * @param {boolean} [shouldScroll]
   * @returns {boolean} false when the line cannot be resolved, so callers can
   *   fall back to file-level navigation (scrollToFile).
   */
  scrollToLine(fileName, lineNumber, side = 'RIGHT', shouldScroll = true) {
    const fileState = this.files.get(fileName);
    if (!fileState || !this.codeView) return false;

    // Answer from the parsed diff data, not the DOM: under virtualization an
    // off-screen row is legitimately unmounted, but a line that is not in the
    // file at all should still report failure so callers can fall back.
    // Undecidable (metadata not parsed yet, context item) stays optimistic —
    // callers treat false as "give up on this line".
    if (this._lineInDiffData(fileState, lineNumber, side) === false) return false;

    if (shouldScroll) {
      this.codeView.scrollTo({
        type: 'line',
        id: fileName,
        lineNumber,
        side: PierreBridge.toPierreSide(side),
        align: 'center',
        behavior: 'smooth',
      });
    }
    // Flash the target line once it is (or becomes) mounted. Best-effort:
    // resolves the shadow-DOM row via the persisted instance.
    this._flashLine(fileState, lineNumber, side);
    return true;
  }

  /**
   * Apply a brief highlight flash to a line's shadow-DOM element.
   * @private
   */
  _flashLine(fileState, lineNumber, side, { maxFrames = 60 } = {}) {
    const pierreSide = PierreBridge.toPierreSide(side);
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    // The preceding scrollToLine uses behavior:'smooth', so a virtualized-out
    // target mounts many frames later — a fixed 2-frame wait would query before
    // the row exists and silently no-op. Poll (bounded) for the row, re-reading
    // fileState._instance each frame since virtualization can (re)mount the item.
    let frames = 0;
    const tryFlash = () => {
      const instance = fileState._instance;
      const indices = instance && typeof instance.getLineIndex === 'function'
        ? instance.getLineIndex(lineNumber, pierreSide)
        : undefined;
      const lineEl = PierreBridge._queryLineElement(instance, indices, pierreSide);
      if (lineEl) {
        lineEl.classList.remove('pierre-line-highlight');
        void lineEl.offsetWidth;
        lineEl.classList.add('pierre-line-highlight');
        lineEl.addEventListener('animationend', () => {
          lineEl.classList.remove('pierre-line-highlight');
        }, { once: true });
        return;
      }
      if (++frames < maxFrames) schedule(tryFlash);
    };
    schedule(tryFlash);
  }

  // ─── Line Selection ───────────────────────────────────────────────

  /**
   * Active line selection for a file, if any.
   * @param {string} fileName
   * @returns {{start:number, end:number, side:string}|null}
   */
  getLineSelection(fileName) {
    if (!this.codeView) return null;
    const selection = this.codeView.getSelectedLines?.();
    if (!selection || selection.id !== fileName || !selection.range) return null;
    const range = selection.range;
    return {
      start: range.start,
      end: range.end,
      side: range.side === 'deletions' ? 'LEFT' : 'RIGHT',
    };
  }

  /**
   * Clear the active line selection.
   * @param {string} fileName
   */
  clearLineSelection(fileName) {
    if (!this.codeView) return;
    const selection = this.codeView.getSelectedLines?.();
    if (selection && selection.id !== fileName) return;
    this.codeView.clearSelectedLines?.();
  }

  // ─── Hunk visibility / expansion ──────────────────────────────────

  /**
   * Whether a line is currently rendered (inside a hunk of the published
   * metadata) and not hidden in a collapsed gap.
   * @param {string} fileName
   * @param {number} lineNumber
   * @param {string} side
   * @returns {boolean}
   */
  isLineVisible(fileName, lineNumber, side) {
    const fileState = this.files.get(fileName);
    if (!fileState || fileState.collapsed) return false;
    return this._lineInDiffData(fileState, lineNumber, side) === true;
  }

  /**
   * Whether a line number falls inside the file's parsed diff data (published
   * hunks, widened by any vendor-arrow expansion), independent of collapse
   * state and of what is currently mounted.
   *
   * Returns `null` when the question is undecidable — a non-diff item (context
   * files carry whole-file line numbers) or a file whose metadata has not been
   * parsed yet. Callers must treat null as "assume present": a false answer is
   * a give-up signal.
   *
   * @returns {boolean|null}
   * @private
   */
  _lineInDiffData(fileState, lineNumber, side) {
    if (!fileState || fileState.itemType !== 'diff') return null;
    const hunks = fileState.metadata?.hunks;
    if (!Array.isArray(hunks) || hunks.length === 0) return null;

    const sideKey = PierreBridge.toPierreSide(side) === 'deletions' ? 'deletion' : 'addition';
    const instance = fileState._instance;
    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      const count = hunk[`${sideKey}Count`];
      if (!count) continue;
      const start = hunk[`${sideKey}Start`];
      // Widen by any vendor-arrow expansion tracked on the mounted instance.
      const expanded = instance?.hunksRenderer?.getExpandedHunk?.(i);
      const from = start - (expanded?.fromStart || 0);
      const to = start + count - 1 + (expanded?.fromEnd || 0);
      if (lineNumber >= from && lineNumber <= to) return true;
    }
    return false;
  }

  // ─── Shadow DOM / instance access ─────────────────────────────────

  getShadowRoot(fileName) {
    const fileState = this.files.get(fileName);
    return fileState?._shadowRoot || fileState?._element?.shadowRoot || null;
  }

  getInstance(fileName) {
    const fileState = this.files.get(fileName);
    return fileState?._instance || null;
  }

  getHoveredLine(fileName) {
    const instance = this.files.get(fileName)?._instance;
    return instance?.getHoveredLine ? instance.getHoveredLine() : undefined;
  }

  isPointerOverFile(fileName) {
    const fileState = this.files.get(fileName);
    const el = fileState?._element;
    const pos = this._lastPointerPosition;
    if (!el || !el.isConnected || !pos) return false;
    const rect = el.getBoundingClientRect();
    return (
      pos.clientX >= rect.left &&
      pos.clientX <= rect.right &&
      pos.clientY >= rect.top &&
      pos.clientY <= rect.bottom
    );
  }

  // ─── Render / slot signals ────────────────────────────────────────

  /**
   * True when an item is currently rendered (mounted host in the DOM, or in
   * CodeView's rendered set). Used to decide "will slot" vs "virtualized out".
   * @param {string} id
   * @returns {boolean}
   * @private
   */
  _isItemRendered(id) {
    const fileState = this.files.get(id);
    if (fileState?._element && fileState._element.isConnected) return true;
    try {
      const rendered = this.codeView?.getRenderedItems?.() || [];
      return rendered.some(r => r && r.id === id);
    } catch (_err) {
      return false;
    }
  }

  /**
   * Resolve (and clear) any slot waiters for an item. Called from onPostRender
   * once annotations are slotted. `result` defaults to the mounted/slotted
   * success shape.
   * @private
   */
  _resolveSlotWaiters(id, result) {
    const waiters = this._slotWaiters.get(id);
    if (!waiters || waiters.length === 0) return;
    this._slotWaiters.delete(id);
    for (const waiter of waiters) waiter(result);
  }

  /**
   * Shared machinery behind whenAnnotationsSlotted (per-file) and
   * whenAnnotationSlotted (per-annotation): one waiter registered on
   * `_slotWaiters` for the onPostRender signal, plus a bounded rAF poll so the
   * Promise NEVER hangs. Owns the settle-once bookkeeping and de-registration;
   * callers supply only what differs — the probe and the terminal results.
   *
   * @param {string} fileName
   * @param {Object} spec
   * @param {Function} spec.probe - () => result|null. Non-null settles.
   * @param {Function} spec.onBudgetExhausted - () => result once the frame
   *   budget runs out with no probe hit.
   * @param {Function} [spec.onSignal] - (forced) => result|null, run on the
   *   onPostRender signal. Defaults to `forced || probe()`; a forced result
   *   (teardown) always wins.
   * @param {number} [spec.maxFrames=6]
   * @param {boolean} [spec.probeFirst=false] - probe synchronously before
   *   registering (steady state already satisfied).
   * @returns {Promise<Object>}
   * @private
   */
  _awaitSlot(fileName, { probe, onBudgetExhausted, onSignal, maxFrames = 6, probeFirst = false }) {
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);

    return new Promise((resolve) => {
      let settled = false;
      // `waiter` is declared (as let, initialized to null) BEFORE finish() so no
      // reference to it can land in a temporal dead zone: finish() reads it via
      // arr.indexOf(waiter), and probeFirst can call finish() synchronously
      // while a CONCURRENT waiter for the same file already exists — which is
      // exactly the path that reaches indexOf.
      let waiter = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        const arr = this._slotWaiters.get(fileName);
        if (arr) {
          const idx = arr.indexOf(waiter);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this._slotWaiters.delete(fileName);
        }
        resolve(result);
      };
      waiter = (forced) => {
        const result = onSignal ? onSignal(forced) : (forced || probe());
        if (result) finish(result);
      };

      if (probeFirst) {
        const immediate = probe();
        if (immediate) { finish(immediate); return; }
      }

      // Primary deterministic signal: the next onPostRender for this item.
      const arr = this._slotWaiters.get(fileName) || [];
      arr.push(waiter);
      this._slotWaiters.set(fileName, arr);

      // Bounded fallback — never hangs. An unrendered item is given the FULL
      // frame budget to mount (supports "scrollTo then await" with a larger
      // maxFrames); onPostRender resolves the common case first.
      let frames = 0;
      const check = () => {
        if (settled) return;
        const result = probe();
        if (result) { finish(result); return; }
        if (++frames >= maxFrames) { finish(onBudgetExhausted()); return; }
        raf(check);
      };
      raf(check);
    });
  }

  /**
   * Deterministic Promise that resolves once a file's annotations have been
   * slotted into the DOM by the next render pass. Replaces fixed-duration waits
   * (E2E, consumer read-back) — annotation publishing is async (updateItem
   * schedules a rAF-batched CodeView render, and the vendor slots annotations
   * during that render).
   *
   * The signal is `onPostRender`, which the vendor fires AFTER renderAnnotations
   * in the same synchronous pass (FileDiff.js), so when it runs the
   * `[data-annotation-slot]` wrappers exist. A bounded rendered-set fallback
   * covers the two non-signal cases so the Promise NEVER hangs:
   *   - item virtualized out of the render window → resolves not-mounted
   *     (its annotations legitimately have no DOM until it scrolls in).
   *   - item already mounted with no pending render (steady state) → resolves
   *     slotted (its annotations are already in the DOM).
   *
   * Typical use: `await bridge.addAnnotation(...); const r = await
   * bridge.whenAnnotationsSlotted(file); if (r.slotted) { ...query the DOM... }`.
   *
   * @param {string} fileName
   * @param {Object} [options]
   * @param {number} [options.maxFrames=6] - frame budget before the fallback
   *   resolves a mounted-but-signal-less item as slotted.
   * @returns {Promise<{mounted: boolean, slotted: boolean, reason?: string}>}
   */
  whenAnnotationsSlotted(fileName, options = {}) {
    const maxFrames = Number.isFinite(options.maxFrames) ? options.maxFrames : 6;
    if (!this.codeView || !this.files.has(fileName)) {
      return Promise.resolve({ mounted: false, slotted: false, reason: 'unknown-file' });
    }
    // A rendered item has its annotations slotted (renderAnnotations already ran
    // in the mount pass), so the frame probe resolves it slotted; an unrendered
    // one resolves not-mounted once the budget runs out.
    return this._awaitSlot(fileName, {
      maxFrames,
      probe: () => (this._isItemRendered(fileName) ? { mounted: true, slotted: true } : null),
      onSignal: (forced) => forced || { mounted: true, slotted: true },
      onBudgetExhausted: () => ({ mounted: false, slotted: false, reason: 'not-mounted' }),
    });
  }

  /**
   * Locate the slotted light-DOM element for a specific annotation id inside a
   * mounted item's host. Returns null when the host is unmounted or the line
   * carrying the annotation is outside the item's current render window.
   * @private
   */
  _findSlottedAnnotationElement(fileState, annotationId) {
    const host = fileState?._element;
    if (!host || !host.isConnected || typeof host.querySelector !== 'function') return null;
    let selector;
    try {
      const escaped = typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(String(annotationId))
        : String(annotationId).replace(/["\\]/g, '\\$&');
      selector = `[data-pr-annotation-id="${escaped}"]`;
    } catch (_err) {
      return null;
    }
    // Annotation content lives in the host's LIGHT DOM (the vendor wraps it in
    // [data-annotation-slot] and projects it into a shadow <slot>), so a plain
    // host.querySelector reaches it without crossing the shadow boundary.
    return host.querySelector(selector) || null;
  }

  /**
   * Deterministic Promise resolving to the slotted DOM element for ONE
   * annotation (by id), for consumers that read a specific row back after
   * adding it (tour stops, external threads). Companion to the per-file
   * whenAnnotationsSlotted().
   *
   * Resolves { element, mounted, slotted, reason? }:
   *   - element (HTMLElement) + slotted:true once the annotation's node is in
   *     the DOM (signalled by onPostRender, which the vendor fires after
   *     renderAnnotations in the same pass — never a bare timeout).
   *   - element:null, mounted:false, reason:'not-mounted' when the item is
   *     virtualized out. Its annotations legitimately have NO DOM until it
   *     scrolls into view; the data anchor is intact and the element is
   *     (re)created on remount. Callers should scrollTo/scrollToLine (which
   *     mounts it) and await again — pass a larger `maxFrames` on that second
   *     call so the waiter survives the scroll-driven mount.
   *   - element:null, mounted:true, reason:'line-not-rendered' when the item is
   *     mounted but the anchor line is outside its internal render window.
   *   - reason 'unknown-file' / 'unknown-annotation' for bad inputs.
   * NEVER hangs.
   *
   * @param {string} fileName
   * @param {string} annotationId
   * @param {Object} [options]
   * @param {number} [options.maxFrames=6] - frame budget for the mount/slot
   *   determination (raise it when awaiting a scroll-driven mount).
   * @returns {Promise<{element: HTMLElement|null, mounted: boolean, slotted: boolean, reason?: string}>}
   */
  whenAnnotationSlotted(fileName, annotationId, options = {}) {
    const maxFrames = Number.isFinite(options.maxFrames) ? options.maxFrames : 6;
    const notMounted = (reason) => ({ element: null, mounted: false, slotted: false, reason });
    const fileState = this.files.get(fileName);
    if (!this.codeView || !fileState) return Promise.resolve(notMounted('unknown-file'));
    if (!fileState.annotations.some(a => a.metadata.id === annotationId)) {
      return Promise.resolve(notMounted('unknown-annotation'));
    }
    // At budget exhaustion the reason reflects the final state: not-mounted if
    // the item never rendered, line-not-rendered if it is mounted but the anchor
    // line is outside its internal render window.
    return this._awaitSlot(fileName, {
      maxFrames,
      probeFirst: true, // steady state: already slotted
      probe: () => {
        const el = this._findSlottedAnnotationElement(fileState, annotationId);
        return el ? { element: el, mounted: true, slotted: true } : null;
      },
      onBudgetExhausted: () => (this._isItemRendered(fileName)
        ? { element: null, mounted: true, slotted: false, reason: 'line-not-rendered' }
        : notMounted('not-mounted')),
    });
  }

  // ─── Annotations (data API) ───────────────────────────────────────

  /**
   * Add one annotation and publish.
   * @param {string} fileName
   * @param {Object} annotation - { lineNumber, side, type, data, id? }
   */
  addAnnotation(fileName, annotation) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;
    this._pushAnnotation(fileState, annotation);
    this._publishItem(fileName);
  }

  /**
   * Add many annotations with a single publish.
   * @param {string} fileName
   * @param {Array<Object>} annotations
   */
  addAnnotations(fileName, annotations) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;
    if (!Array.isArray(annotations) || annotations.length === 0) return;
    for (const annotation of annotations) {
      this._pushAnnotation(fileState, annotation);
    }
    this._publishItem(fileName);
  }

  /**
   * Add a BATCH of annotations in a SINGLE publish, then resolve each one's
   * slotted element from the single render pass. This is the perf-correct way
   * to mount many annotations on a file: it costs ONE CodeView render + ONE
   * onPostRender wait, instead of the N render cycles + N frame-waits a
   * per-annotation `addAnnotation` + `await whenAnnotationSlotted` loop incurs
   * (that pattern was the ~6x annotation-publish regression).
   *
   * Per-annotation semantics match whenAnnotationSlotted:
   *   { element: HTMLElement, slotted:true, mounted:true }        — in the DOM
   *   { element:null, mounted:false, reason:'not-mounted' }       — item virtualized out
   *   { element:null, mounted:true, reason:'line-not-rendered' }  — line outside window
   *   { element:null, ..., reason:'unknown-file'|'unknown-annotation' } — bad input
   *
   * Callers MUST supply a stable `id` on each annotation (that is the Map key
   * and the data-pr-annotation-id used to locate the slotted element).
   *
   * @param {string} fileName
   * @param {Array<Object>} annotations - each { lineNumber, side?, type, data, id }
   * @param {Object} [options]
   * @param {number} [options.maxFrames=6] - slot-await frame budget (raise it
   *   when the file may need to mount, e.g. after a scrollTo).
   * @returns {Promise<Map<string, {element: HTMLElement|null, mounted: boolean, slotted: boolean, reason?: string}>>}
   */
  async addAnnotationsAndAwait(fileName, annotations, options = {}) {
    const maxFrames = Number.isFinite(options.maxFrames) ? options.maxFrames : 6;
    const results = new Map();
    const list = Array.isArray(annotations) ? annotations : [];
    const fileState = this.files.get(fileName);
    if (!this.codeView || !fileState) {
      for (const a of list) {
        if (a && a.id != null) {
          results.set(a.id, { element: null, mounted: false, slotted: false, reason: 'unknown-file' });
        }
      }
      return results;
    }
    if (list.length === 0) return results;

    // ONE publish for the whole batch (addAnnotations → single updateItem/render).
    this.addAnnotations(fileName, list);

    // ONE slot-await riding onPostRender (the render that slotted the batch).
    await this.whenAnnotationsSlotted(fileName, { maxFrames });

    // Resolve each annotation from that single pass.
    const rendered = this._isItemRendered(fileName);
    for (const a of list) {
      if (!a || a.id == null) continue;
      const el = this._findSlottedAnnotationElement(fileState, a.id);
      if (el) {
        results.set(a.id, { element: el, mounted: true, slotted: true });
      } else if (!rendered) {
        results.set(a.id, { element: null, mounted: false, slotted: false, reason: 'not-mounted' });
      } else {
        results.set(a.id, { element: null, mounted: true, slotted: false, reason: 'line-not-rendered' });
      }
    }
    return results;
  }

  /**
   * Push a single annotation onto a file's list (no publish).
   * @private
   */
  _pushAnnotation(fileState, annotation) {
    const entry = {
      lineNumber: annotation.lineNumber,
      metadata: {
        type: annotation.type,
        data: annotation.data,
        id: annotation.id
          || `${annotation.type}-${annotation.lineNumber}-${annotation.side || ''}-${++this._annotationCounter}`,
      },
    };
    // Diff items carry a side; file (context) items do not.
    if (fileState.type === 'diff') {
      entry.side = PierreBridge.toPierreSide(annotation.side);
    }
    fileState.annotations.push(entry);
  }

  /**
   * Remove an annotation by id and publish.
   * @param {string} fileName
   * @param {string} annotationId
   */
  removeAnnotation(fileName, annotationId) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;
    fileState.annotations = fileState.annotations.filter(a => a.metadata.id !== annotationId);
    fileState.formElements.delete(annotationId);
    this._publishItem(fileName);
  }

  /**
   * Remove all annotations of a type for a file and publish.
   * @param {string} fileName
   * @param {string} type
   */
  removeAnnotationsByType(fileName, type) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;
    const removed = fileState.annotations.filter(a => a.metadata.type === type);
    if (removed.length === 0) return;
    fileState.annotations = fileState.annotations.filter(a => a.metadata.type !== type);
    for (const ann of removed) fileState.formElements.delete(ann.metadata.id);
    this._publishItem(fileName);
  }

  /**
   * Get all annotations for a file, optionally filtered by type.
   * @param {string} fileName
   * @param {string} [type]
   * @returns {Array}
   */
  getAnnotations(fileName, type) {
    const fileState = this.files.get(fileName);
    if (!fileState) return [];
    if (type) return fileState.annotations.filter(a => a.metadata.type === type);
    return [...fileState.annotations];
  }

  /**
   * Merge a patch into an annotation's stored `data` in place, so a later
   * virtualization remount re-renders the annotation from the UPDATED data
   * (e.g. an edited comment body). Does NOT publish/re-render — the caller has
   * already updated the currently-mounted card in the DOM; this only keeps the
   * data model current so the edit survives a remount instead of reverting.
   * The annotation objects are shared with the CodeView-held item, so the next
   * render (remount or any publish) reflects the change.
   * @param {string} fileName
   * @param {string} annotationId
   * @param {Object} patch - shallow-merged into the annotation's data
   * @returns {boolean} true if the annotation was found and updated
   */
  updateAnnotationData(fileName, annotationId, patch) {
    const fileState = this.files.get(fileName);
    if (!fileState) return false;
    const ann = fileState.annotations.find(a => a.metadata.id === annotationId);
    if (!ann) return false;
    if (patch && typeof patch === 'object') {
      ann.metadata.data = { ...ann.metadata.data, ...patch };
    }
    return true;
  }

  /**
   * Sorted copy of a file's annotations. At one line, hunk summaries and tour
   * stops stack above suggestions/forms/comments/external threads (matching the
   * legacy insertion order).
   * @param {Object} fileState
   * @returns {Array}
   * @private
   */
  _sortedAnnotations(fileState) {
    const typeOrder = {
      'file-comments': -3,
      'hunk-summary': -2,
      'tour-stop': -1,
      'suggestion': 0,
      'comment-form': 1,
      'comment': 2,
      'external-comment': 3,
    };
    return [...fileState.annotations].sort((a, b) => {
      if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
      const sideA = a.side || '';
      const sideB = b.side || '';
      if (sideA !== sideB) return sideA < sideB ? -1 : 1;
      return (typeOrder[a.metadata.type] ?? 1) - (typeOrder[b.metadata.type] ?? 1);
    });
  }

  // ─── Split-view annotation stretching ─────────────────────────────

  /**
   * Schedule a rAF-debounced split-annotation layout pass for a file.
   * @private
   */
  _syncSplitAnnotationLayout(id) {
    const fileState = this.files.get(id);
    if (!fileState || fileState._splitLayoutRaf != null) return;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    fileState._splitLayoutRaf = raf(() => {
      fileState._splitLayoutRaf = null;
      this._applySplitAnnotationLayout(id);
    });
  }

  /**
   * Stretch lone annotation cards across both columns in split view. See the
   * ANNOTATION_CSS comment block for the geometry rationale. No-op in unified
   * mode (the bridge's own diffStyle is the gate).
   * @private
   */
  _applySplitAnnotationLayout(id) {
    if (this.diffStyle !== 'split') return;
    const fileState = this.files.get(id);
    const shadowRoot = fileState?._shadowRoot || fileState?._element?.shadowRoot;
    if (!shadowRoot) return;
    const pre = shadowRoot.querySelector(
      'pre[data-diff-type="split"], pre[data-diff-type="single"]'
    );
    if (!pre) return;

    const gutter = pre.getAttribute('data-diff-type') === 'split'
      ? pre.querySelector('[data-additions] [data-gutter]')
      : pre.querySelector('[data-gutter]');
    const gutterWidth = gutter?.getBoundingClientRect?.().width || 0;
    if (gutterWidth > 0) {
      pre.style.setProperty('--pr-split-gutter-width', `${gutterWidth}px`);
    }

    const byRow = new Map();
    for (const cell of pre.querySelectorAll('[data-line-annotation]')) {
      const key = cell.getAttribute('data-line-annotation');
      if (!byRow.has(key)) byRow.set(key, []);
      byRow.get(key).push(cell);
    }
    for (const cells of byRow.values()) {
      const withContent = cells.filter((cell) => cell.querySelector('slot'));
      for (const cell of cells) {
        cell.classList.toggle(
          'pr-annotation-fullwidth',
          withContent.length === 1 && cell === withContent[0]
        );
      }
    }
  }

  // ─── Gutter Buttons ───────────────────────────────────────────────

  static CHAT_SVG = `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>`;

  /**
   * Get the currently hovered row for a file from the vendor getter installed
   * by renderGutterUtility.
   * @private
   */
  _getHoveredRow(fileName) {
    const getter = this._gutterRowGetters.get(fileName);
    if (!getter) return null;
    try {
      return getter() || null;
    } catch (_err) {
      return null;
    }
  }

  /**
   * Create dual gutter buttons (chat + comment) for renderGutterUtility.
   * Rendered once per mount; the vendor slots the element and repositions it to
   * follow the hovered row. Drag from a button creates a multi-line selection
   * (the library can't start selection from a button click).
   * @param {string} id - item id
   * @param {string} fileName
   * @param {Function} getHoveredRow
   * @returns {HTMLElement}
   * @private
   */
  _createGutterButtons(id, fileName, getHoveredRow) {
    this._gutterRowGetters.set(id, getHoveredRow);
    // Reuse the cached container if the vendor re-invokes this for the same
    // item (e.g. on a remount), so gutter buttons don't accumulate — matches
    // the pre-migration bridge. (The vendor renders the gutter once per mount.)
    if (this._gutterContainers.has(id)) {
      return this._gutterContainers.get(id);
    }

    const container = document.createElement('div');
    container.className = 'pierre-gutter-buttons';
    container.setAttribute('data-utility-button', '');

    const resolveClickTarget = () => {
      const hovered = this._getHoveredRow(id);
      const hoveredSide = hovered
        ? (hovered.side === 'deletions' ? 'LEFT' : 'RIGHT')
        : null;
      const sel = this.getLineSelection(fileName);

      if (sel && sel.start !== sel.end) {
        const inRange = hovered
          && hoveredSide === sel.side
          && hovered.lineNumber >= sel.start
          && hovered.lineNumber <= sel.end;
        this.clearLineSelection(fileName);
        if (inRange) {
          return { start: sel.start, end: sel.end, side: sel.side, isRange: true };
        }
      }

      if (!hovered) return null;
      return {
        start: hovered.lineNumber,
        end: hovered.lineNumber,
        side: hoveredSide,
        isRange: false,
      };
    };

    const wrapButton = (btn, handler) => {
      let dragInfo = null;

      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const hovered = this._getHoveredRow(id);
        if (!hovered) return;
        dragInfo = {
          startLine: hovered.lineNumber,
          side: hovered.side,
          pointerId: e.pointerId,
          dragged: false,
        };

        const onMove = (me) => {
          if (!dragInfo || me.pointerId !== dragInfo.pointerId) return;
          const cur = this._getHoveredRow(id);
          if (!cur || cur.lineNumber === dragInfo.startLine) return;
          dragInfo.dragged = true;
          const start = Math.min(dragInfo.startLine, cur.lineNumber);
          const end = Math.max(dragInfo.startLine, cur.lineNumber);
          this.codeView?.setSelectedLines?.({
            id: fileName,
            range: { start, end, side: dragInfo.side },
          });
        };

        const onUp = (ue) => {
          if (!dragInfo || ue.pointerId !== dragInfo.pointerId) return;
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          document.removeEventListener('pointercancel', onUp);
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
      });

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // No pointerdown on this button — e.g. a line-number drag that ended
        // over it. The click is a side effect of that drag, not a real
        // activation, so ignore it. (Consequence: keyboard activation, which
        // fires click with no pointerdown, also lands here. Pre-existing; these
        // controls are pointer-revealed.)
        if (!dragInfo) return;
        if (dragInfo.dragged) {
          dragInfo = null;
          return;
        }
        dragInfo = null;
        const target = resolveClickTarget();
        if (!target) return;
        handler(target);
      };
    };

    if (this.options.onChatClick) {
      const chatBtn = document.createElement('button');
      chatBtn.className = 'pierre-gutter-btn pierre-chat-btn';
      chatBtn.title = 'Chat about this line';
      chatBtn.innerHTML = PierreBridge.CHAT_SVG;
      wrapButton(chatBtn, (target) => {
        this.options.onChatClick(fileName, target.start, target.side, target);
      });
      container.appendChild(chatBtn);
    }

    const commentBtn = document.createElement('button');
    commentBtn.className = 'pierre-gutter-btn pierre-comment-btn';
    commentBtn.title = 'Add comment';
    commentBtn.textContent = '+';
    wrapButton(commentBtn, (target) => {
      if (this.options.onCommentClick) {
        this.options.onCommentClick(fileName, target.start, target.side, target);
      }
    });
    container.appendChild(commentBtn);

    this._gutterContainers.set(id, container);
    return container;
  }

  // ─── Internal Rendering Callbacks ─────────────────────────────────

  /**
   * Render an annotation element by dispatching on its type. Rebuilds fresh DOM
   * on every call so it is idempotent under virtualization remounts (comment
   * forms reuse a cached element per id to preserve textarea content).
   * @private
   */
  _renderAnnotation(annotation, fileName, formElements, id) {
    const { type, data, id: annotationId } = annotation.metadata;
    const element = this._renderAnnotationContent(type, data, annotationId, formElements, fileName);
    // Stamp the annotation id so whenAnnotationSlotted() can locate the exact
    // slotted element post-render (the vendor wraps this in [data-annotation-slot]).
    if (element && element.nodeType === 1 && element.dataset) {
      element.dataset.prAnnotationId = annotationId;
    }
    return element;
  }

  /**
   * Dispatch to the type-specific annotation renderer.
   * @private
   */
  _renderAnnotationContent(type, data, annotationId, formElements, fileName) {
    switch (type) {
    case 'comment':
      return this._renderCommentAnnotation(data, annotationId);
    case 'suggestion':
      return this._renderSuggestionAnnotation(data, annotationId);
    case 'comment-form':
      return this._renderFormAnnotation(data, annotationId, formElements, fileName);
    default: {
      const customRenderer = this._annotationRenderers?.get(type);
      if (customRenderer) {
        try {
          return customRenderer(data, annotationId, fileName) || undefined;
        } catch (err) {
          console.error(`[PierreBridge] custom annotation renderer for "${type}" failed:`, err);
          return undefined;
        }
      }
      return undefined;
    }
    }
  }

  registerAnnotationRenderer(type, renderFn) {
    if (!this._annotationRenderers) this._annotationRenderers = new Map();
    this._annotationRenderers.set(type, renderFn);
  }

  unregisterAnnotationRenderer(type) {
    this._annotationRenderers?.delete(type);
  }

  /**
   * Render a user comment annotation using the legacy comment UI.
   * @private
   */
  _renderCommentAnnotation(comment, id) {
    const escapeHtml = window.prManager?.escapeHtml?.bind(window.prManager) || ((s) => s);

    const lineInfo = comment.line_end && comment.line_end !== comment.line_start
      ? `Lines ${comment.line_start}-${comment.line_end}`
      : `Line ${comment.line_start}`;

    let metadataHTML = '';
    if (comment.parent_id && comment.type && comment.type !== 'comment') {
      const badgeHTML = comment.type === 'praise'
        ? `<span class="adopted-praise-badge" title="Nice Work"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>Nice Work</span>`
        : '';
      metadataHTML = `
        ${badgeHTML}
        ${comment.title ? `<span class="adopted-title">${escapeHtml(comment.title)}</span>` : ''}
      `;
    }

    const commentIcon = comment.parent_id
      ? `<svg class="octicon octicon-comment-ai" viewBox="0 0 16 16" width="16" height="16">
           <path d="M7.75 1a.75.75 0 0 1 0 1.5h-5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2c.199 0 .39.079.53.22.141.14.22.331.22.53v2.19l2.72-2.72a.747.747 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-2a.75.75 0 0 1 1.5 0v2c0 .464-.184.909-.513 1.237A1.746 1.746 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25v-7.5C1 1.784 1.784 1 2.75 1h5Zm4.519-.837a.248.248 0 0 1 .466 0l.238.648a3.726 3.726 0 0 0 2.218 2.219l.649.238a.249.249 0 0 1 0 .467l-.649.238a3.725 3.725 0 0 0-2.218 2.218l-.238.649a.248.248 0 0 1-.466 0l-.239-.649a3.725 3.725 0 0 0-2.218-2.218l-.649-.238a.249.249 0 0 1 0-.467l.649-.238A3.726 3.726 0 0 0 12.03.811l.239-.648Z"/>
         </svg>`
      : `<svg class="octicon octicon-person" viewBox="0 0 16 16" width="16" height="16">
           <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
         </svg>`;

    const baseClasses = ['user-comment'];
    if (comment.parent_id) {
      baseClasses.push('adopted-comment', 'comment-ai-origin');
    } else {
      baseClasses.push('comment-user-origin');
    }

    const container = document.createElement('div');
    container.className = 'user-comment-row';
    container.dataset.commentId = comment.id;
    container.dataset.file = comment.file;
    container.dataset.lineStart = comment.line_start;
    container.dataset.lineEnd = comment.line_end || comment.line_start;
    if (comment.side) container.dataset.side = comment.side;

    container.innerHTML = `
      <div class="${baseClasses.join(' ')}">
        <div class="user-comment-header">
          <div class="user-comment-header-left">
            <span class="comment-origin-icon">${commentIcon}</span>
            <span class="user-comment-line-info">${lineInfo}</span>
            ${metadataHTML}
          </div>
          <div class="user-comment-actions">
            <button class="btn-chat-comment" title="Chat about comment"
                    data-chat-comment-id="${comment.id}"
                    data-chat-file="${escapeHtml(comment.file || '')}"
                    data-chat-line-start="${comment.line_start ?? ''}"
                    data-chat-line-end="${comment.line_end || comment.line_start || ''}"
                    data-chat-parent-id="${comment.parent_id || ''}">
              <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>
            </button>
            <button class="btn-edit-comment" onclick="prManager.editUserComment(${comment.id})" title="Edit comment">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"></path>
              </svg>
            </button>
            <button class="btn-delete-comment" onclick="prManager.deleteUserComment(${comment.id})" title="Dismiss comment">
              <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
                <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19c.9 0 1.652-.681 1.741-1.576l.66-6.6a.75.75 0 00-1.492-.149l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"></path>
              </svg>
            </button>
          </div>
        </div>
        <div class="user-comment-body" data-original-markdown="${window.escapeHtmlAttribute ? window.escapeHtmlAttribute(comment.body) : ''}">${window.renderMarkdown ? window.renderMarkdown(comment.body || '') : escapeHtml(comment.body || '')}</div>
      </div>
    `;

    return container;
  }

  /**
   * Render an AI suggestion annotation using the legacy suggestion UI.
   * @private
   */
  _renderSuggestionAnnotation(suggestion, id) {
    const suggestionManager = window.prManager?.suggestionManager;
    if (suggestionManager) {
      const targetInfo = {
        fileName: suggestion.file || '',
        lineNumber: suggestion.line_start || suggestion.line_end || '',
        side: suggestion.side || 'RIGHT',
        diffPosition: suggestion.diff_position || '',
        isFileLevel: !suggestion.line_start && !suggestion.line_end,
      };

      const row = suggestionManager.createSuggestionRow([suggestion], targetInfo);
      const suggestionDiv = row.querySelector('.ai-suggestion');
      if (suggestionDiv) {
        return suggestionDiv;
      }
    }

    return this._renderSuggestionFallback(suggestion, id);
  }

  /**
   * Fallback suggestion rendering when SuggestionManager is unavailable.
   * @private
   */
  _renderSuggestionFallback(suggestion, id) {
    const container = document.createElement('div');
    container.className = `ai-suggestion ai-type-${suggestion.type || 'info'}`;
    container.dataset.suggestionId = suggestion.id || '';

    const escapeHtml = window.prManager?.escapeHtml?.bind(window.prManager) || ((s) => s);
    const displayBody = suggestion.formattedBody || suggestion.body || '';
    const bodyHTML = window.renderMarkdown ? window.renderMarkdown(displayBody) : escapeHtml(displayBody);

    container.innerHTML = `
      <div class="ai-suggestion-header">
        <div class="ai-suggestion-header-left">
          <span class="ai-suggestion-category">${escapeHtml(suggestion.type || '')}</span>
          <span class="ai-title">${escapeHtml(suggestion.title || '')}</span>
        </div>
      </div>
      <div class="ai-suggestion-body">${bodyHTML}</div>
      <div class="ai-suggestion-actions">
        <button class="ai-action ai-action-adopt" onclick="prManager.adoptSuggestion(${suggestion.id})">Adopt</button>
        <button class="ai-action ai-action-dismiss" onclick="prManager.dismissSuggestion(${suggestion.id})">Dismiss</button>
      </div>
    `;
    return container;
  }

  static SUGGESTION_ICON_SVG = `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073ZM8 3.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0V7h-1.5a.75.75 0 0 1 0-1.5h1.5V4A.75.75 0 0 1 8 3.25Zm-3 8a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z"></path></svg>`;

  static CHAT_FORM_SVG = `<svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>`;

  /**
   * Render a comment form annotation. Reuses cached form DOM per id so textarea
   * content survives re-renders (and virtualization remounts).
   * @private
   */
  _renderFormAnnotation(data, id, formElements, fileName) {
    if (formElements.has(id)) {
      return formElements.get(id);
    }

    const container = document.createElement('div');
    container.className = 'pierre-annotation user-comment-form';
    container.dataset.annotationId = id;

    const header = document.createElement('div');
    header.className = 'comment-form-header';
    const icon = document.createElement('span');
    icon.className = 'comment-icon';
    icon.textContent = '💬';
    header.appendChild(icon);
    const title = document.createElement('span');
    title.className = 'comment-title';
    title.textContent = data.headerTitle || 'Add comment';
    header.appendChild(title);
    if (data.lineStart && data.lineEnd && data.lineEnd !== data.lineStart) {
      const rangeLabel = document.createElement('span');
      rangeLabel.className = 'line-range-indicator';
      rangeLabel.textContent = `Lines ${data.lineStart}-${data.lineEnd}`;
      header.appendChild(rangeLabel);
    }
    container.appendChild(header);

    let suggestionBtn = null;
    if (data.showSuggestionBtn) {
      const toolbar = document.createElement('div');
      toolbar.className = 'comment-form-toolbar';
      suggestionBtn = document.createElement('button');
      suggestionBtn.type = 'button';
      suggestionBtn.className = 'btn btn-sm suggestion-btn';
      suggestionBtn.title = 'Insert a suggestion';
      suggestionBtn.innerHTML = PierreBridge.SUGGESTION_ICON_SVG;
      suggestionBtn.addEventListener('click', () => {
        if (!suggestionBtn.disabled && this.options.onSuggestionInsert) {
          this.options.onSuggestionInsert(textarea, suggestionBtn);
        }
      });
      toolbar.appendChild(suggestionBtn);
      container.appendChild(toolbar);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'comment-textarea';
    textarea.placeholder = 'Leave a comment... (Cmd/Ctrl+Enter to save)';
    textarea.dataset.line = data.lineStart || '';
    textarea.dataset.lineEnd = data.lineEnd || data.lineStart || '';
    textarea.dataset.file = fileName;
    textarea.dataset.diffPosition = data.diffPosition || '';
    textarea.dataset.side = data.side || 'RIGHT';
    if (data.initialValue) {
      textarea.value = data.initialValue;
    }
    container.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'comment-form-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm btn-primary save-comment-btn';
    saveBtn.textContent = 'Save';
    saveBtn.disabled = !textarea.value.trim();
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.dataset.saving === 'true') return;
      if (!this.options.onCommentFormSubmit) return;
      saveBtn.dataset.saving = 'true';
      saveBtn.disabled = true;
      try {
        await this.options.onCommentFormSubmit(fileName, id, data, textarea.value);
      } finally {
        if (saveBtn.isConnected) {
          saveBtn.dataset.saving = 'false';
          saveBtn.disabled = !textarea.value.trim();
        }
      }
    });
    actions.appendChild(saveBtn);

    const chatBtn = document.createElement('button');
    chatBtn.className = 'ai-action ai-action-chat btn-chat-from-comment';
    chatBtn.title = 'Chat about these lines';
    chatBtn.innerHTML = PierreBridge.CHAT_FORM_SVG + ' Chat';
    chatBtn.addEventListener('click', () => {
      if (!window.chatPanel) return;
      if (this.options.onCommentFormCancel) {
        this.options.onCommentFormCancel(fileName, id, data);
      }
      window.chatPanel.open({
        commentContext: {
          type: 'line',
          body: textarea.value.trim() || null,
          file: fileName || '',
          line_start: parseInt(textarea.dataset.line) || null,
          line_end: parseInt(textarea.dataset.lineEnd) || parseInt(textarea.dataset.line) || null,
          side: textarea.dataset.side || 'RIGHT',
          source: 'user'
        }
      });
    });
    actions.appendChild(chatBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-sm btn-secondary cancel-comment-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      if (this.options.onCommentFormCancel) {
        this.options.onCommentFormCancel(fileName, id, data);
      }
    });
    actions.appendChild(cancelBtn);

    container.appendChild(actions);

    const hasSuggestionBlock = (text) => /^\s*(`{3,})suggestion\s*$/m.test(text);
    textarea.addEventListener('input', () => {
      saveBtn.disabled = !textarea.value.trim();
      if (suggestionBtn) {
        const hasSuggestion = hasSuggestionBlock(textarea.value);
        suggestionBtn.disabled = hasSuggestion;
        suggestionBtn.title = hasSuggestion
          ? 'Only one suggestion per comment'
          : 'Insert a suggestion';
      }
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    });

    formElements.set(id, container);

    requestAnimationFrame(() => {
      textarea.focus();
      if (window.emojiPicker) window.emojiPicker.attach(textarea);
      if (data.initialValue) {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
        if (suggestionBtn) {
          const has = hasSuggestionBlock(textarea.value);
          suggestionBtn.disabled = has;
          if (has) suggestionBtn.title = 'Only one suggestion per comment';
        }
      }
    });

    return container;
  }

  // ─── Code Extraction ──────────────────────────────────────────────

  /**
   * Get code content from stored metadata for a line range.
   * @param {string} fileName
   * @param {number} startLine
   * @param {number} endLine
   * @param {string} side - 'LEFT' or 'RIGHT'
   * @returns {string|null}
   */
  getCodeFromLines(fileName, startLine, endLine, side) {
    const fileState = this.files.get(fileName);
    if (!fileState) return null;

    const metadata = fileState.baseMetadata || fileState.metadata;
    if (!metadata) return null;
    const useAdditions = (side || 'RIGHT') === 'RIGHT';
    const lines = useAdditions ? metadata.additionLines : metadata.deletionLines;
    const hunks = metadata.hunks;
    if (!lines || !hunks) return null;

    const codeLines = [];
    for (const hunk of hunks) {
      const hunkStart = useAdditions ? hunk.additionStart : hunk.deletionStart;
      const hunkCount = useAdditions ? hunk.additionCount : hunk.deletionCount;
      const hunkLineIndex = useAdditions ? hunk.additionLineIndex : hunk.deletionLineIndex;
      const hunkEnd = hunkStart + hunkCount - 1;

      if (hunkEnd < startLine || hunkStart > endLine) continue;

      for (let i = 0; i < hunkCount; i++) {
        const lineNum = hunkStart + i;
        if (lineNum >= startLine && lineNum <= endLine) {
          const idx = hunkLineIndex + i;
          if (idx < lines.length) {
            codeLines.push(lines[idx]);
          }
        }
      }
    }

    return codeLines.length > 0 ? codeLines.join('\n') : null;
  }

  // ─── Utility ──────────────────────────────────────────────────────

  /**
   * Resolve the display file name for a CodeView item id (strips the
   * `context:` prefix for context items).
   * @private
   */
  _fileNameForItemId(id) {
    const fileState = this.files.get(id);
    return fileState ? fileState.fileName : id;
  }

  static toPierreSide(side) {
    if (side === 'LEFT' || side === 'deletions') return 'deletions';
    return 'additions';
  }

  static toPairReviewSide(side) {
    if (side === 'deletions' || side === 'LEFT') return 'LEFT';
    return 'RIGHT';
  }

  static normalizeSide(side) {
    if (side === 'deletions' || side === 'LEFT') return 'LEFT';
    return 'RIGHT';
  }

  /**
   * Resolve the rendered shadow-DOM element for a line from getLineIndex()
   * indices. Kept from the legacy bridge for scroll-to-line flashing.
   * @private
   */
  static _queryLineElement(instance, indices, side) {
    if (!instance || !indices) return null;
    const [unifiedIndex] = indices;
    if (unifiedIndex == null) return null;
    const pre = instance.pre;
    if (!pre) return null;
    const compositeKey = Array.isArray(indices) ? indices.join(',') : String(unifiedIndex);
    for (const codeEl of PierreBridge._codeColumnsForSide(instance, pre, side)) {
      if (!codeEl) continue;
      const el = codeEl.querySelector(`[data-line][data-line-index="${compositeKey}"]`)
        || codeEl.querySelector(`[data-line][data-line-index="${unifiedIndex}"]`);
      if (el) return el;
    }
    return null;
  }

  /**
   * @private
   */
  static _codeColumnsForSide(instance, pre, side) {
    const unified = instance.codeUnified || pre.querySelector('code[data-unified]');
    if (unified) return [unified];
    const deletions = instance.codeDeletions || pre.querySelector('code[data-deletions]');
    const additions = instance.codeAdditions || pre.querySelector('code[data-additions]');
    if (deletions || additions) {
      return side === 'deletions' ? [deletions, additions] : [additions, deletions];
    }
    return [pre];
  }

  /**
   * Fallback patch parser if HunkParser is not available.
   * @private
   */
  _parseBlocksFallback(patch) {
    const blocks = [];
    const lines = patch.split('\n');
    let currentBlock = null;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)/);
      if (hunkMatch) {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = {
          header: line,
          oldStart: parseInt(hunkMatch[1], 10),
          newStart: parseInt(hunkMatch[2], 10),
          lines: [],
        };
      } else if (currentBlock && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        currentBlock.lines.push(line);
      }
    }
    if (currentBlock) blocks.push(currentBlock);
    return blocks;
  }

  // ─── CSS for Annotations ──────────────────────────────────────────

  static ANNOTATION_CSS = `
    .pierre-annotation {
      padding: 8px 12px;
      margin: 4px 0;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
    [data-line-annotation] { min-width: 0; }
    [data-annotation-content] { min-width: 0; }
    [data-diff-type='split'] .pr-annotation-fullwidth {
      position: relative;
      z-index: 4;
      width: calc(200% + var(--pr-split-gutter-width, 0px));
    }
    [data-diff-type='split'] [data-additions] .pr-annotation-fullwidth {
      margin-left: calc(-100% - var(--pr-split-gutter-width, 0px));
    }
    [data-diff-type='single']:has(> [data-additions], > [data-deletions]) {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }
    [data-diff-type='single'] > [data-deletions] {
      grid-column: 1;
      border-right: 1px solid var(--diffs-bg);
    }
    [data-diff-type='single'] > [data-additions] {
      grid-column: 2;
      border-left: 1px solid var(--diffs-bg);
    }
    [data-diff-type='single'][data-overflow='wrap'] > [data-deletions],
    [data-diff-type='single'][data-overflow='wrap'] > [data-additions] {
      overflow: visible;
      contain: layout style;
    }
    [data-diff-type='single'] .pr-annotation-fullwidth {
      position: relative;
      z-index: 4;
    }
    [data-diff-type='single'] [data-deletions] .pr-annotation-fullwidth {
      width: calc(200% + var(--pr-split-gutter-width, 0px));
    }
    [data-diff-type='single'] [data-additions] .pr-annotation-fullwidth {
      width: calc(200% + 2 * var(--pr-split-gutter-width, 0px));
      margin-left: calc(-100% - 2 * var(--pr-split-gutter-width, 0px));
    }
    [data-line].pierre-line-highlight {
      animation: pierre-line-highlight-flash 3.5s ease-out forwards;
    }
    @keyframes pierre-line-highlight-flash {
      0% {
        background-color: rgba(227, 179, 65, var(--pierre-highlight-start, 0.20));
        box-shadow: inset 3px 0 0 #e3b341;
      }
      57% {
        background-color: rgba(227, 179, 65, var(--pierre-highlight-mid, 0.08));
        box-shadow: inset 3px 0 0 #e3b341;
      }
      100% {
        background-color: transparent;
        box-shadow: inset 3px 0 0 transparent;
      }
    }
  `;

  static WORKER_INIT_TIMEOUT_MS = 15000;
}

// Export as global
window.PierreBridge = PierreBridge;

// Also export for CommonJS test environments
if (typeof module !== 'undefined') {
  module.exports = PierreBridge;
}
