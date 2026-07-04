// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PierreBridge - Adapter between @pierre/diffs and pair-review
 *
 * Manages FileDiff instances per file, annotation rendering (comments, suggestions, forms),
 * gap expansion, diffPosition tracking, and theme management.
 *
 * Depends on: window.PierreDiffs (from vendor bundle)
 */

class PierreBridge {
  /**
   * @param {Object} options
   * @param {string} options.theme - 'light' or 'dark'
   * @param {Function} options.onCommentClick - (fileName, lineNumber, side) => void
   * @param {Function} options.onChatClick - (fileName, lineNumber, side, range?) => void
   * @param {Function} options.onLineSelect - (fileName, range) => void
   * @param {Function} options.onHunkExpand - (fileName, hunkIndex, direction, lineCount) => void
   */
  constructor(options = {}) {
    if (!window.PierreDiffs) {
      console.warn('[PierreBridge] window.PierreDiffs not loaded — @pierre/diffs bundle missing. Falling back to legacy rendering.');
      this._disabled = true;
    }
    this.options = options;
    this.theme = options.theme || PierreBridge.detectTheme();

    // Diff layout: 'unified' (single column) or 'split' (side-by-side).
    // Stored as instance state so every FileDiff instance (including lazily
    // created / rebuilt ones) inherits the current style. Toggled at runtime
    // via setDiffStyle(). Invalid values fall back to 'unified'.
    this.diffStyle = PierreBridge.isValidDiffStyle(options.diffStyle)
      ? options.diffStyle
      : 'unified';

    // Per-file state: { instance: FileDiff, metadata: FileDiffMetadata, container: HTMLElement,
    //                   annotations: DiffLineAnnotation[], diffPositions: Map, formElements: Map }
    this.files = new Map();

    // CSS to inject into Shadow DOM for annotations, comments, suggestions
    this._unsafeCSS = null;

    // Monotonic counter for unique annotation IDs
    this._annotationCounter = 0;

    // Cache for gutter button containers — keyed by fileName.
    // Stored here instead of on fileState because renderGutterUtility fires
    // during instance.render(), before fileState is set on this.files.
    this._gutterContainers = new Map();
    this._gutterRowGetters = new Map();
    this._hoveredRows = new Map();

    // Shared options for all FileDiff instances
    this._sharedOptions = null;

    // Shared @pierre/diffs worker pool. Without this, FileDiff falls back to
    // Shiki highlighting on the main thread, which can freeze large reviews.
    this.workerManager = this._createWorkerManager();
    this._workerReady = !this.workerManager;
    this._workersFailed = false;
    this._workerInitTimer = null;
    this._workerStatsUnsubscribe = null;
    this._lastPointerPosition = null;
    this._trackPointerPosition = (event) => {
      if (event.isPrimary === false) return;
      this._lastPointerPosition = {
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        pointerId: event.pointerId || 1,
        pointerType: event.pointerType || 'mouse',
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
    for (const [, fileState] of this.files) {
      if (fileState.instance) {
        fileState.instance.setThemeType(theme);
      }
    }
  }

  // ─── Diff Style (unified / split) ─────────────────────────────────

  /**
   * @param {*} style
   * @returns {boolean} true when `style` is a supported diff layout.
   */
  static isValidDiffStyle(style) {
    return style === 'unified' || style === 'split';
  }

  /**
   * Current diff layout.
   * @returns {'unified'|'split'}
   */
  getDiffStyle() {
    return this.diffStyle;
  }

  /**
   * Switch every rendered file between unified and split (side-by-side) layout.
   *
   * Mirrors setTheme: validate, no-op when unchanged, update instance state,
   * then re-render every FileDiff instance. Unlike theme, diffStyle is NOT a
   * worker render option (it controls layout, not highlighting), so the worker
   * pool is untouched here — only the per-instance FileDiff options change.
   *
   * `setOptions` replaces the instance's whole options object AND re-derives
   * the hunks/interaction sub-managers, so we spread the instance's current
   * options to preserve everything else (theme, gutter, selection, etc.). The
   * instance keeps its stored lineAnnotations across setOptions, and rerender()
   * re-runs the renderAnnotation callback, so user comments, AI suggestions,
   * forms, and external threads survive the switch (they also live in
   * fileState.annotations as the source of truth).
   *
   * @param {'unified'|'split'} style
   */
  setDiffStyle(style) {
    if (!PierreBridge.isValidDiffStyle(style)) {
      console.warn(`[PierreBridge] Ignoring invalid diffStyle "${style}"; expected 'unified' or 'split'.`);
      return;
    }
    if (style === this.diffStyle) return;
    this.diffStyle = style;

    for (const [, fileState] of this.files) {
      const instance = fileState?.instance;
      if (!instance) continue;
      if (typeof instance.setOptions === 'function') {
        instance.setOptions({ ...(instance.options || {}), diffStyle: style });
      } else if (typeof instance.mergeOptions === 'function') {
        instance.mergeOptions({ diffStyle: style });
      }
      instance.rerender?.();
    }
  }

  // ─── CSS Injection ────────────────────────────────────────────────

  /**
   * Build CSS to inject into Shadow DOM for annotation content (comments, suggestions, forms).
   * Called lazily on first use.
   */
  getUnsafeCSS() {
    if (this._unsafeCSS !== null) return this._unsafeCSS;
    this._unsafeCSS = PierreBridge.ANNOTATION_CSS;
    return this._unsafeCSS;
  }

  /**
   * Create the shared worker pool used by @pierre/diffs for syntax highlighting.
   * The main thread still produces the initial plain-text AST, while expensive
   * language highlighting happens off-thread and streams back through rerender().
   * @returns {Object|null}
   * @private
   */
  _createWorkerManager() {
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

  // ─── Patch Parsing & diffPosition Computation ─────────────────────

  /**
   * Parse a unified diff patch for a single file.
   * @param {string} patch - Unified diff patch text (the part after the file header)
   * @returns {import('@pierre/diffs').FileDiffMetadata}
   */
  parsePatch(patch) {
    if (!patch) return null;

    // The patch may already include git diff headers (from parseUnifiedDiff)
    // or may be just hunk content starting with @@.
    // parsePatchFiles handles both formats.
    let input = patch;
    if (!patch.startsWith('diff --git ')) {
      // Bare hunk content — wrap with minimal git diff header
      input = `diff --git a/file b/file\n--- a/file\n+++ b/file\n${patch}`;
    }

    const parsed = window.PierreDiffs.parsePatchFiles(input);
    if (parsed && parsed.length > 0 && parsed[0].files && parsed[0].files.length > 0) {
      return parsed[0].files[0];
    }
    // Fallback: try getSingularPatch
    return window.PierreDiffs.getSingularPatch(patch);
  }

  /**
   * Compute GitHub diffPosition mapping from a patch.
   * diffPosition is a 1-indexed consecutive counter: each hunk header and each line counts.
   * @param {string} patch - Unified diff patch text
   * @returns {Map<string, number>} Map of "side:lineNumber" → diffPosition
   */
  computeDiffPositions(patch) {
    const positions = new Map();
    if (!patch) return positions;

    // Use HunkParser if available for consistent parsing
    const blocks = window.HunkParser
      ? window.HunkParser.parseDiffIntoBlocks(patch)
      : this._parseBlocksFallback(patch);

    let diffPosition = 0;

    blocks.forEach(block => {
      diffPosition++; // Hunk header counts as a position

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
          // Context line: addressable from both sides
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
    if (!fileState) return null;
    const normalizedSide = PierreBridge.normalizeSide(side);
    return fileState.diffPositions.get(`${normalizedSide}:${lineNumber}`) || null;
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
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback) => setTimeout(callback, 0);
    schedule(() => {
      // A fallback (timeout / worker error) can land between scheduling this
      // callback and running it, nulling the worker manager. If so, there is
      // nothing to attach — bail out rather than rebuild with a dead pool.
      if (this._workersFailed || !this.workerManager) return;
      for (const [fileName, fileState] of [...this.files]) {
        if (fileState.usesWorkerManager) {
          // Already worker-backed — a bare rerender picks up the highlighter.
          fileState.instance?.rerender?.();
        } else if (!fileState.forcePlainText) {
          // Rendered before the pool was ready, so its FileDiff was built with
          // an undefined manager and can never gain worker highlighting from a
          // bare rerender(). Reconstruct it through the worker path. Skip
          // forcePlainText (large/plain) files — they are deliberately plain.
          this._rebuildFileInstance(fileName, fileState, { useWorkerManager: true });
        }
      }
    });
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

    for (const [fileName, fileState] of [...this.files]) {
      if (!fileState.usesWorkerManager) continue;
      this._rebuildFileInstance(fileName, fileState, { useWorkerManager: false });
    }
    return true;
  }

  _createFileDiffInstance(fileName, formElements, renderOptions = {}) {
    const workerManager = renderOptions.useWorkerManager === false
      ? undefined
      : this.workerManager || undefined;
    return new window.PierreDiffs.FileDiff({
      theme: this.getThemeConfig(),
      themeType: this.theme,
      disableFileHeader: true,
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
      collapsed: renderOptions.collapsed || false,

      // Custom gutter render — dual buttons (chat + comment) matching legacy UI.
      // Cannot combine with onGutterUtilityClick; use one gutter API at a time.
      renderGutterUtility: (getHoveredRow) => {
        return this._createGutterButtons(fileName, getHoveredRow);
      },

      onLineClick: (props) => {
        if (this.options.onLineClick) {
          this.options.onLineClick(fileName, {
            lineNumber: props.lineNumber,
            side: props.annotationSide === 'deletions' ? 'LEFT' : 'RIGHT',
            lineType: props.lineType,
            element: props.lineElement,
          });
        }
      },

      onLineSelected: (range) => {
        if (this.options.onLineSelect) {
          this.options.onLineSelect(fileName, range);
        }
      },

      onLineSelectionEnd: (range) => {
        if (this.options.onLineSelectionEnd) {
          this.options.onLineSelectionEnd(fileName, range);
        }
      },

      onHunkExpand: (hunkIndex, direction, lineCount) => {
        if (this.options.onHunkExpand) {
          this.options.onHunkExpand(fileName, hunkIndex, direction, lineCount);
        }
      },

      renderAnnotation: (annotation) => {
        return this._renderAnnotation(annotation, fileName, formElements);
      },

      onPostRender: (node, inst) => {
        // Store reference to shadow root for DOM access
        const fileState = this.files.get(fileName);
        if (fileState) {
          fileState.shadowHost = node;
        }
      },
    }, workerManager);
  }

  /**
   * Tear down a file's FileDiff instance and rebuild it from scratch, selecting
   * whether the new instance is worker-backed via `useWorkerManager`.
   *
   * This is the shared multi-step sequence used in BOTH directions:
   *   - Fallback: rebuild WITHOUT workers (`useWorkerManager: false`) when the
   *     worker pool fails/times out (see `_fallbackToMainThreadRendering`).
   *   - Init success: rebuild WITH workers (`useWorkerManager: true`) for files
   *     that rendered before the worker pool finished initializing (see
   *     `_handleWorkerStats`).
   *
   * Both paths need identical cleanup, re-parse, payload reconstruction (including
   * the upgraded oldFile/newFile + contextRanges case), and hover restoration —
   * only the manager differs, so the logic lives here once.
   *
   * @param {string} fileName
   * @param {Object} fileState
   * @param {Object} opts
   * @param {boolean} opts.useWorkerManager - true to attach the worker pool,
   *   false to rebuild on the main thread.
   * @returns {boolean} true if a render occurred
   * @private
   */
  _rebuildFileInstance(fileName, fileState, { useWorkerManager } = {}) {
    if (!fileState?.container || !fileState.patch) return false;

    try {
      fileState.instance?.cleanUp();
    } catch (err) {
      console.warn(`[PierreBridge] Failed to clean up existing diff instance for ${fileName}.`, err);
    }

    this._gutterContainers.delete(fileName);
    fileState.container.innerHTML = '';
    const renderOptions = {
      collapsed: fileState.collapsed,
      forcePlainText: fileState.forcePlainText,
      useWorkerManager,
    };
    const metadata = this.parsePatch(fileState.patch);
    if (metadata) {
      metadata.name = fileName;
      if (renderOptions.forcePlainText) {
        metadata.lang = 'text';
      }
    }
    const instance = this._createFileDiffInstance(fileName, fileState.formElements, renderOptions);
    fileState.instance = instance;
    fileState.metadata = metadata;
    fileState.shadowHost = null;
    fileState.usesWorkerManager = useWorkerManager === true && !!this.workerManager;

    const payload = fileState.oldFile || fileState.newFile
      ? {
        oldFile: fileState.oldFile,
        newFile: fileState.newFile,
        fileDiff: this._effectiveContextRanges(fileState).length && fileState.baseMetadata
          ? window.PierreContext?.mergeContextRanges?.(fileState.baseMetadata, this._effectiveContextRanges(fileState)) || fileState.baseMetadata
          : fileState.baseMetadata || metadata,
        lineAnnotations: fileState.annotations,
        containerWrapper: fileState.container,
      }
      : {
        fileDiff: metadata,
        containerWrapper: fileState.container,
        lineAnnotations: fileState.annotations,
      };
    const rendered = instance.render(payload);
    fileState.shadowHost = fileState.container.querySelector('diffs-container') || fileState.container.firstElementChild;
    if (rendered) this._installFallbackHoverTracking(fileName, fileState);
    if (rendered) this._restoreHoverAfterRender(fileState);
    return rendered;
  }

  _isPointerInsideFile(fileState) {
    const pos = this._lastPointerPosition;
    if (!pos || !fileState?.container?.isConnected) return false;

    const rect = fileState.container.getBoundingClientRect();
    return (
      pos.clientX >= rect.left &&
      pos.clientX <= rect.right &&
      pos.clientY >= rect.top &&
      pos.clientY <= rect.bottom
    );
  }

  isPointerOverFile(fileName) {
    return this._isPointerInsideFile(this.files.get(fileName));
  }

  _restoreHoverAfterRender(fileState) {
    const pos = this._lastPointerPosition;
    if (!pos || !this._isPointerInsideFile(fileState)) return;

    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback) => setTimeout(callback, 0);
    schedule(() => {
      if (!this._isPointerInsideFile(fileState)) return;

      const shadowRoot = fileState.shadowHost?.shadowRoot
        || fileState.container.querySelector('diffs-container')?.shadowRoot;
      const target = shadowRoot?.elementFromPoint?.(pos.clientX, pos.clientY)
        || document.elementFromPoint(pos.clientX, pos.clientY);
      if (!target) return;

      const eventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: pos.clientX,
        clientY: pos.clientY,
        screenX: pos.screenX || 0,
        screenY: pos.screenY || 0,
        pointerId: pos.pointerId || 1,
        pointerType: pos.pointerType || 'mouse',
        isPrimary: true,
      };
      if (typeof window.PointerEvent === 'function') {
        target.dispatchEvent(new window.PointerEvent('pointermove', eventInit));
      }
      target.dispatchEvent(new MouseEvent('mousemove', eventInit));
    });
  }

  _getHoveredRow(fileName) {
    const getter = this._gutterRowGetters.get(fileName);
    if (getter) {
      try {
        const hovered = getter();
        if (hovered) return hovered;
      } catch (_err) {
        // The cached gutter buttons can outlive a FileDiff instance during a
        // rerender. Fall through to the bridge-tracked hover row.
      }
    }
    return this._hoveredRows.get(fileName) || null;
  }

  /**
   * Derive the annotation side ('deletions'|'additions') for a hovered gutter
   * line cell.
   *
   * Unified view stamps only one column, so the line-type string
   * (change-deletion vs change-addition) is authoritative; context lines are
   * addressable from the right (additions) side by convention.
   *
   * Split view renders two independent code columns and a context line's
   * gutter carries a neutral 'context' line-type in BOTH columns — the string
   * can no longer disambiguate. Derive the side from the enclosing
   * `code[data-deletions]` / `code[data-additions]` column instead, falling
   * back to the line-type string if (defensively) neither ancestor is found.
   * @param {Element} lineCell - hovered gutter cell (has data-column-number)
   * @returns {'deletions'|'additions'}
   * @private
   */
  _deriveHoverSide(lineCell) {
    if (this.diffStyle === 'split') {
      if (lineCell.closest?.('code[data-deletions]')) return 'deletions';
      if (lineCell.closest?.('code[data-additions]')) return 'additions';
    }
    const lineType = lineCell.dataset?.lineType || '';
    return lineType.includes('deletion') ? 'deletions' : 'additions';
  }

  _installFallbackHoverTracking(fileName, fileState) {
    fileState._fallbackHoverCleanup?.();

    const shadowRoot = fileState.shadowHost?.shadowRoot
      || fileState.container?.querySelector('diffs-container')?.shadowRoot;
    if (!shadowRoot) return;

    const onPointerMove = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const lineCell = path.find(node =>
        node?.nodeType === 1 &&
        node.dataset?.columnNumber != null &&
        node.dataset?.lineType != null
      );
      if (!lineCell) return;

      const lineNumber = parseInt(lineCell.dataset.columnNumber, 10);
      if (!Number.isFinite(lineNumber)) return;

      this._hoveredRows.set(fileName, {
        lineNumber,
        side: this._deriveHoverSide(lineCell),
      });
      this._positionFallbackGutter(fileName, lineCell);
    };

    const onPointerLeave = () => {
      this._hoveredRows.delete(fileName);
      this._clearFallbackGutterPosition(fileName);
    };

    shadowRoot.addEventListener('pointermove', onPointerMove);
    shadowRoot.addEventListener('mousemove', onPointerMove);
    shadowRoot.addEventListener('pointerleave', onPointerLeave);
    fileState._fallbackHoverCleanup = () => {
      shadowRoot.removeEventListener('pointermove', onPointerMove);
      shadowRoot.removeEventListener('mousemove', onPointerMove);
      shadowRoot.removeEventListener('pointerleave', onPointerLeave);
    };
  }

  _positionFallbackGutter(fileName, lineCell) {
    const container = this._gutterContainers.get(fileName);
    if (!container) return;

    for (const [otherFileName, otherContainer] of this._gutterContainers) {
      if (otherFileName === fileName || !otherContainer.parentElement) continue;
      otherContainer._pierreFallbackParent = otherContainer._pierreFallbackParent || otherContainer.parentElement;
      otherContainer.remove();
    }

    const rect = lineCell.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const fileState = this.files.get(fileName);
    const fallbackParent = fileState?.container?.closest?.('[data-file-name]') || fileState?.container;
    container.dataset.fallbackPositioned = '';
    if (fallbackParent && container.parentElement !== fallbackParent) {
      container._pierreFallbackParent = container._pierreFallbackParent || container.parentElement;
      fallbackParent.prepend(container);
    }
    container.style.position = 'fixed';
    container.style.left = `${rect.right - 12}px`;
    container.style.right = 'auto';
    container.style.top = `${rect.top + (rect.height / 2)}px`;
    container.style.transform = 'translateY(-50%)';
    container.style.zIndex = '1000';
  }

  _clearFallbackGutterPosition(fileName) {
    const container = this._gutterContainers.get(fileName);
    if (!container?.dataset?.fallbackPositioned) return;

    delete container.dataset.fallbackPositioned;
    const fallbackParent = container._pierreFallbackParent;
    if (fallbackParent?.isConnected && container.parentElement !== fallbackParent) {
      fallbackParent.appendChild(container);
    }
    container._pierreFallbackParent = null;
    container.style.removeProperty('position');
    container.style.removeProperty('left');
    container.style.removeProperty('right');
    container.style.removeProperty('top');
    container.style.removeProperty('transform');
    container.style.removeProperty('z-index');
  }

  // ─── File Rendering ───────────────────────────────────────────────

  /**
   * Create and render a FileDiff instance for a file.
   * @param {string} fileName - File path
   * @param {HTMLElement} container - DOM container to render into
   * @param {string} patch - Unified diff patch text
   * @param {Object} [renderOptions] - Additional render options
   * @param {boolean} [renderOptions.collapsed] - Start collapsed
   * @returns {Object} The file state object
   */
  renderFile(fileName, container, patch, renderOptions = {}) {
    if (this._disabled) return null;

    // Clean up existing instance
    this.destroyFile(fileName);

    const metadata = this.parsePatch(patch);
    // Override the file name in metadata to match pair-review's name
    if (metadata) {
      metadata.name = fileName;
      if (renderOptions.forcePlainText) {
        metadata.lang = 'text';
      }
    }

    const diffPositions = this.computeDiffPositions(patch);
    const annotations = [];
    const formElements = new Map();

    const useWorkerManager = !!(this.workerManager && this._workerReady);
    const instance = this._createFileDiffInstance(fileName, formElements, {
      ...renderOptions,
      useWorkerManager,
    });

    const rendered = instance.render({
      fileDiff: metadata,
      containerWrapper: container,
      lineAnnotations: annotations,
    });

    const fileState = {
      instance,
      fileName,
      metadata,
      container,
      patch,
      annotations,
      diffPositions,
      formElements,
      shadowHost: container.querySelector('diffs-container') || container.firstElementChild,
      // Context range support
      oldFile: null,
      newFile: null,
      baseMetadata: null,   // metadata before context range merging
      contextRanges: [],     // [{startLine, endLine}] in NEW file coords
      // Lines the ORIGINAL PATCH rendered, captured at content upgrade. The
      // full-contents re-diff can produce narrower context than the patch;
      // these spans are merged into every render so the upgrade never
      // un-renders visible lines (which would orphan annotations anchored to
      // them). Unlike contextRanges, they survive clearContextRanges.
      patchParityRanges: null,
      forcePlainText: !!renderOptions.forcePlainText,
      collapsed: !!renderOptions.collapsed,
      usesWorkerManager: useWorkerManager,
    };

    this.files.set(fileName, fileState);
    fileState.shadowHost = fileState.container.querySelector('diffs-container') || fileState.container.firstElementChild;
    if (rendered) this._installFallbackHoverTracking(fileName, fileState);
    return fileState;
  }

  /**
   * Upgrade a patch-only render with full file contents to enable hunk expansion.
   * Calls render() again on the existing FileDiff instance — the library detects
   * new content via areFilesEqual() and re-renders with isPartial: false.
   * @param {string} fileName
   * @param {{ name: string, contents: string }|null} oldFile
   * @param {{ name: string, contents: string }|null} newFile
   * @returns {boolean} true if re-render occurred
   */
  upgradeFileContents(fileName, oldFile, newFile) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.instance) return false;
    const nextOldFile = fileState.forcePlainText && oldFile
      ? { ...oldFile, lang: 'text' }
      : oldFile;
    const nextNewFile = fileState.forcePlainText && newFile
      ? { ...newFile, lang: 'text' }
      : newFile;

    // Snapshot the currently-rendered hunk spans BEFORE render() replaces
    // instance.fileDiff: the full-contents re-diff can compute narrower
    // context than the original patch, silently un-rendering lines that
    // annotations, comments, and the user's eyes are anchored to.
    const prevHunks = fileState.instance.fileDiff?.hunks;

    const rendered = fileState.instance.render({
      oldFile: nextOldFile,
      newFile: nextNewFile,
      lineAnnotations: fileState.annotations,
      containerWrapper: fileState.container,
    });
    // Cache full-file contents for re-render calls (context ranges, etc.)
    fileState.oldFile = nextOldFile;
    fileState.newFile = nextNewFile;
    // Snapshot metadata whenever the instance has a fileDiff,
    // even if render() returned false (e.g. files-equal early exit)
    if (fileState.instance.fileDiff) {
      fileState.baseMetadata = fileState.instance.fileDiff;
      if (!fileState.patchParityRanges && Array.isArray(prevHunks) && prevHunks.length) {
        fileState.patchParityRanges = prevHunks
          .filter(h => h.additionCount > 0)
          .map(h => ({
            startLine: h.additionStart,
            endLine: h.additionStart + h.additionCount - 1,
          }));
      }
      if (this._effectiveContextRanges(fileState).length) this._applyContextRanges(fileName);
    }
    if (rendered) this._installFallbackHoverTracking(fileName, fileState);
    if (rendered) this._restoreHoverAfterRender(fileState);
    return rendered;
  }

  /**
   * Render a binary file placeholder (no diff).
   * @param {HTMLElement} container
   * @param {string} message
   */
  renderBinaryFile(container, message = 'Binary file') {
    container.innerHTML = `<div class="pierre-binary-file">${message}</div>`;
  }

  /**
   * Collapse/expand a file's diff rendering.
   * @param {string} fileName
   * @param {boolean} collapsed
   */
  setCollapsed(fileName, collapsed) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;
    const wasCollapsed = fileState.collapsed;
    fileState.collapsed = collapsed;
    // Vendor setOptions REPLACES the whole options object (it does not
    // merge), so a bare { collapsed } would silently drop diffStyle, theme,
    // renderAnnotation, and every other option — spread the live options in.
    fileState.instance.setOptions({ ...(fileState.instance.options || {}), collapsed });
    // A file rendered while collapsed has zero shadow-DOM lines (the vendor
    // skips line rendering for collapsed instances). Flipping the option
    // alone leaves the body empty on expand — force a rerender so the lines
    // materialize. Cheap no-op when the lines already exist, and rerender
    // re-applies fileState.annotations so nothing is lost.
    if (wasCollapsed && !collapsed && typeof fileState.instance.rerender === 'function') {
      fileState.instance.rerender();
    }
  }

  /**
   * Destroy a file's FileDiff instance and clean up.
   * @param {string} fileName
   */
  destroyFile(fileName) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;
    const gutterContainer = this._gutterContainers.get(fileName);
    if (fileState.instance) {
      fileState.instance.cleanUp();
    }
    fileState._fallbackHoverCleanup?.();
    this._clearFallbackGutterPosition(fileName);
    gutterContainer?.remove();
    fileState.formElements.clear();
    this._gutterContainers.delete(fileName);
    this._gutterRowGetters.delete(fileName);
    this._hoveredRows.delete(fileName);
    this.files.delete(fileName);
  }

  /**
   * Destroy all file instances.
   */
  destroyAll() {
    for (const [fileName] of this.files) {
      this.destroyFile(fileName);
    }
  }

  // ─── Context Ranges ──────────────────────────────────────────────

  /**
   * Add context ranges to reveal non-contiguous lines in a file's diff.
   * Ranges are in NEW file coordinates (1-indexed).
   * If file contents aren't loaded yet, ranges are queued for later application.
   * @param {string} fileName
   * @param {Array<{startLine: number, endLine: number}>} ranges
   * @returns {boolean} true if ranges were applied immediately
   */
  addContextRanges(fileName, ranges) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.instance) return false;

    const { mergeOverlapping } = window.PierreContext || {};
    if (!mergeOverlapping) {
      console.warn('[PierreBridge] window.PierreContext not loaded — cannot add context ranges');
      return false;
    }

    // Merge with existing context ranges (deduplicate)
    const existing = fileState.contextRanges || [];
    fileState.contextRanges = mergeOverlapping([...existing, ...ranges]);

    // If file contents aren't loaded yet, ranges will be applied in upgradeFileContents
    if (!fileState.baseMetadata) return false;

    return this._applyContextRanges(fileName);
  }

  /**
   * Re-render a file with new fileDiff metadata, preserving cached file contents.
   * Clears expandedHunks to avoid stale hunk-index references.
   * @param {Object} fileState
   * @param {Object} fileDiff - merged or base metadata
   * @returns {boolean}
   * @private
   */
  _renderWithFileDiff(fileState, fileDiff) {
    fileState.instance.hunksRenderer?.expandedHunks?.clear();
    const rendered = fileState.instance.render({
      oldFile: fileState.oldFile,
      newFile: fileState.newFile,
      fileDiff,
      lineAnnotations: fileState.annotations,
      containerWrapper: fileState.container,
    });
    if (rendered) this._installFallbackHoverTracking(fileState.fileName, fileState);
    if (rendered) this._restoreHoverAfterRender(fileState);
    return rendered;
  }

  /**
   * All ranges that must be visible: patch-parity spans (immutable, captured
   * at content upgrade) plus dynamically added context ranges.
   * @param {Object} fileState
   * @returns {Array<{startLine: number, endLine: number}>}
   * @private
   */
  _effectiveContextRanges(fileState) {
    return [
      ...(fileState?.patchParityRanges || []),
      ...(fileState?.contextRanges || []),
    ];
  }

  _applyContextRanges(fileName) {
    const fileState = this.files.get(fileName);
    if (!fileState?.baseMetadata) return false;
    const ranges = this._effectiveContextRanges(fileState);
    if (!ranges.length) return false;

    const { mergeContextRanges } = window.PierreContext || {};
    if (!mergeContextRanges) return false;

    const merged = mergeContextRanges(fileState.baseMetadata, ranges);
    return this._renderWithFileDiff(fileState, merged);
  }

  /**
   * Remove specific context ranges from a file.
   * @param {string} fileName
   * @param {Array<{startLine: number, endLine: number}>} ranges
   * @returns {boolean} true if re-render occurred
   */
  removeContextRanges(fileName, ranges) {
    const fileState = this.files.get(fileName);
    if (!fileState) return false;

    const { subtractRanges } = window.PierreContext || {};
    if (!subtractRanges) return false;

    fileState.contextRanges = subtractRanges(fileState.contextRanges || [], ranges);

    if (!fileState.baseMetadata) return false;
    if (this._effectiveContextRanges(fileState).length === 0) {
      return this._renderWithFileDiff(fileState, fileState.baseMetadata);
    }
    return this._applyContextRanges(fileName);
  }

  /**
   * Remove all context ranges for a file, restoring original diff view.
   * @param {string} fileName
   * @returns {boolean} true if re-render occurred
   */
  clearContextRanges(fileName) {
    const fileState = this.files.get(fileName);
    if (!fileState) return false;

    fileState.contextRanges = [];

    if (!fileState.baseMetadata) return false;
    // Patch-parity spans are not "context ranges" — clearing must never
    // shrink the view below what the original patch rendered.
    if (this._effectiveContextRanges(fileState).length) {
      return this._applyContextRanges(fileName);
    }
    return this._renderWithFileDiff(fileState, fileState.baseMetadata);
  }

  /**
   * Convert OLD-file (deletion-side) line numbers to NEW-file coordinates.
   * Delegates to PierreContext using the file's baseMetadata for offset computation.
   * @param {string} fileName
   * @param {number} oldStart - OLD-file line (1-indexed)
   * @param {number} oldEnd - OLD-file line (1-indexed)
   * @returns {{startLine: number, endLine: number}|null}
   */
  convertOldToNew(fileName, oldStart, oldEnd) {
    const fileState = this.files.get(fileName);
    if (!fileState?.baseMetadata) return null;
    const { convertOldToNew } = window.PierreContext || {};
    if (!convertOldToNew) return null;
    return convertOldToNew(fileState.baseMetadata, oldStart, oldEnd);
  }

  // ─── Gutter Buttons ───────────────────────────────────────────────

  /**
   * Chat button SVG icon (GitHub-style speech bubble, matches legacy DiffRenderer).
   * @private
   */
  static CHAT_SVG = `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>`;

  /**
   * Create dual gutter buttons (chat + comment) for renderGutterUtility.
   *
   * @pierre/diffs calls this once per render. The returned element is placed
   * in the light DOM and slotted into Shadow DOM. The library moves it to
   * follow the hovered line's number cell automatically.
   *
   * @param {string} fileName
   * @param {Function} getHoveredRow - () => { lineNumber, side } | undefined
   * @returns {HTMLElement}
   * @private
   */
  /**
   * Get the active line selection for a file, if any.
   * Reads directly from @pierre/diffs' InteractionManager.
   * @param {string} fileName
   * @returns {{ start: number, end: number, side: string }|null}
   */
  getLineSelection(fileName) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.instance) return null;
    const range = fileState.instance.interactionManager.getSelection();
    if (!range) return null;
    return {
      start: range.start,
      end: range.end,
      side: range.side === 'deletions' ? 'LEFT' : 'RIGHT',
    };
  }

  /**
   * Clear the active line selection for a file.
   * @param {string} fileName
   */
  clearLineSelection(fileName) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.instance) return;
    fileState.instance.setSelectedLines(null);
  }

  /**
   * Scroll to a specific line in a Pierre-rendered file.
   *
   * Line number cells live inside the @pierre/diffs shadow root, so light-DOM
   * queries for `.line-num2`/`tr` return nothing. This reaches into the shadow
   * DOM, resolves the line by index (via the instance's `getLineIndex`), scrolls
   * it into view, and applies a brief highlight flash.
   *
   * @param {string} fileName
   * @param {number} lineNumber
   * @param {string} [side] - 'LEFT' or 'RIGHT' (defaults to 'RIGHT')
   * @returns {boolean} true if the line was found and scrolled to
   */
  scrollToLine(fileName, lineNumber, side = 'RIGHT', shouldScroll = true) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.instance) return false;
    const instance = fileState.instance;

    const pierreSide = PierreBridge.toPierreSide(side);
    const indices = typeof instance.getLineIndex === 'function'
      ? instance.getLineIndex(lineNumber, pierreSide)
      : undefined;
    const lineEl = PierreBridge._queryLineElement(instance, indices, pierreSide);
    if (!lineEl) return false;

    // Use scrollIntoView on the shadow DOM element — it still scrolls the
    // host document relative to the viewport.
    if (shouldScroll) {
      const rect = lineEl.getBoundingClientRect();
      const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
      if (!isVisible) {
        lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    // Brief highlight flash so the user can locate the target line.
    // The class is styled by ANNOTATION_CSS (injected into shadow DOM).
    lineEl.classList.remove('pierre-line-highlight');
    void lineEl.offsetWidth; // force reflow to restart animation
    lineEl.classList.add('pierre-line-highlight');
    lineEl.addEventListener('animationend', () => {
      lineEl.classList.remove('pierre-line-highlight');
    }, { once: true });

    return true;
  }

  _createGutterButtons(fileName, getHoveredRow) {
    this._gutterRowGetters.set(fileName, getHoveredRow);
    // Reuse existing container if already created for this file
    if (this._gutterContainers.has(fileName)) return this._gutterContainers.get(fileName);

    const container = document.createElement('div');
    container.className = 'pierre-gutter-buttons';
    // Mark as utility so @pierre/diffs recognizes it in pointer path checks
    container.setAttribute('data-utility-button', '');

    /**
     * Resolve the target for a gutter button click.
     *
     * Rules:
     *  - If a multi-line range is active AND the button is currently over a
     *    line inside that range (same side), apply the action to the range
     *    and clear the selection.
     *  - If a multi-line range is active but the button has moved to a line
     *    OUTSIDE the range, cancel the range and apply the action to the
     *    single hovered line.
     *  - Otherwise, apply the action to the single hovered line.
     */
    const resolveClickTarget = () => {
      const hovered = this._getHoveredRow(fileName);
      const hoveredSide = hovered
        ? (hovered.side === 'deletions' ? 'LEFT' : 'RIGHT')
        : null;
      const sel = this.getLineSelection(fileName);

      if (sel && sel.start !== sel.end) {
        const inRange = hovered
          && hoveredSide === sel.side
          && hovered.lineNumber >= sel.start
          && hovered.lineNumber <= sel.end;
        // Either we consume the range or we cancel it — in both cases clear.
        this.clearLineSelection(fileName);
        if (inRange) {
          return { start: sel.start, end: sel.end, side: sel.side, isRange: true };
        }
        // Fall through to single-line resolution on the hovered line.
      }

      if (!hovered) return null;
      return {
        start: hovered.lineNumber,
        end: hovered.lineNumber,
        side: hoveredSide,
        isRange: false,
      };
    };

    // Wire a gutter button so that:
    //  - A plain click triggers the action for the hovered line (or active
    //    multi-line selection).
    //  - Press-and-drag creates a multi-line selection (same UX as dragging
    //    from a line number) WITHOUT triggering the action on release.
    //
    // Why this is needed:
    //  @pierre/diffs cannot start line selection from button clicks — its
    //  resolvePointerTarget fails because `data-code` is missing from the
    //  composed path through the shadow DOM slot.  So we implement the drag
    //  ourselves, calling setSelectedLines to set the selection in the
    //  library.  We also stopPropagation on pointerdown to prevent the
    //  library from interfering, and track whether a drag occurred to
    //  suppress the spurious click that fires when the button DOM element
    //  follows the hover and ends up under the cursor at the release point.
    const wrapButton = (btn, handler) => {
      let dragInfo = null;

      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); // library can't handle buttons; avoid interference
        const hovered = this._getHoveredRow(fileName);
        if (!hovered) return;
        dragInfo = {
          startLine: hovered.lineNumber,
          side: hovered.side,          // 'additions' | 'deletions'
          pointerId: e.pointerId,
          dragged: false,
        };

        const onMove = (me) => {
          if (!dragInfo || me.pointerId !== dragInfo.pointerId) return;
          const cur = this._getHoveredRow(fileName);
          if (!cur || cur.lineNumber === dragInfo.startLine) return;
          dragInfo.dragged = true;
          const fileState = this.files.get(fileName);
          if (fileState?.instance) {
            const start = Math.min(dragInfo.startLine, cur.lineNumber);
            const end = Math.max(dragInfo.startLine, cur.lineNumber);
            fileState.instance.setSelectedLines({
              start, end, side: dragInfo.side,
            });
          }
        };

        const onUp = (ue) => {
          if (!dragInfo || ue.pointerId !== dragInfo.pointerId) return;
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          document.removeEventListener('pointercancel', onUp);
          // dragInfo.dragged is consumed by onclick below
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        // Touch/pen pointers can be canceled by the OS (edge gestures, palm
        // rejection) in which case no pointerup fires. Clean up on cancel
        // too so the document-level listeners don't leak.
        document.addEventListener('pointercancel', onUp);
      });

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!dragInfo) return;        // no pointerdown on this button (e.g. line-number drag landed here)
        if (dragInfo.dragged) {       // suppress click that ends a button-initiated drag
          dragInfo = null;
          return;
        }
        dragInfo = null;
        const target = resolveClickTarget();
        if (!target) return;
        handler(target);
      };
    };

    // Chat button (left)
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

    // Comment button (right)
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

    // Cache so we return the same element on rerender
    this._gutterContainers.set(fileName, container);

    return container;
  }

  // ─── Annotations (Comments, Suggestions, Forms) ───────────────────

  /**
   * Add an annotation for a comment, suggestion, or form.
   * @param {string} fileName
   * @param {Object} annotation - { lineNumber, side, type, data }
   *   side: 'LEFT'/'RIGHT' or 'additions'/'deletions'
   *   type: 'comment' | 'suggestion' | 'comment-form'
   *   data: type-specific data (comment object, suggestion object, form config)
   */
  addAnnotation(fileName, annotation) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;

    const pierreSide = PierreBridge.toPierreSide(annotation.side);
    fileState.annotations.push({
      side: pierreSide,
      lineNumber: annotation.lineNumber,
      metadata: {
        type: annotation.type,
        data: annotation.data,
        id: annotation.id || `${annotation.type}-${annotation.lineNumber}-${pierreSide}-${++this._annotationCounter}`,
      },
    });

    this._updateAnnotations(fileName);
  }

  /**
   * Remove an annotation by id.
   * @param {string} fileName
   * @param {string} annotationId
   */
  removeAnnotation(fileName, annotationId) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;

    fileState.annotations = fileState.annotations.filter(
      a => a.metadata.id !== annotationId
    );
    // Clean up form element if it was a form
    fileState.formElements.delete(annotationId);

    this._updateAnnotations(fileName);
  }

  /**
   * Remove all annotations of a given type for a file.
   * @param {string} fileName
   * @param {string} type - 'comment' | 'suggestion' | 'comment-form'
   */
  removeAnnotationsByType(fileName, type) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;

    const removed = fileState.annotations.filter(a => a.metadata.type === type);
    fileState.annotations = fileState.annotations.filter(a => a.metadata.type !== type);

    // Clean up form elements
    for (const ann of removed) {
      fileState.formElements.delete(ann.metadata.id);
    }

    this._updateAnnotations(fileName);
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
    if (type) {
      return fileState.annotations.filter(a => a.metadata.type === type);
    }
    return [...fileState.annotations];
  }

  /**
   * Update annotations on the FileDiff instance.
   * @private
   */
  _updateAnnotations(fileName) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.instance) return;
    // Sort so that at the same line, suggestions appear before comments.
    // This matches the legacy rendering order where the suggestion row is
    // inserted first, then the adopted comment row appears below it.
    // Hunk summaries and tour stops describe the surrounding code, so they
    // stack above suggestion/comment feedback anchored to the same line.
    const typeOrder = {
      'hunk-summary': -2,
      'tour-stop': -1,
      'suggestion': 0,
      'comment-form': 1,
      'comment': 2,
      // External (host-synced) threads stack below user comments on the same
      // line, mirroring the legacy insertion order (AI → user → external).
      'external-comment': 3,
    };
    const sorted = [...fileState.annotations].sort((a, b) => {
      if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
      if (a.side !== b.side) return a.side < b.side ? -1 : 1;
      return (typeOrder[a.metadata.type] ?? 1) - (typeOrder[b.metadata.type] ?? 1);
    });
    fileState.instance.setLineAnnotations(sorted);
    // setLineAnnotations only stores data — rerender() is needed to
    // trigger the renderAnnotation callback and slot elements into the
    // light DOM of the <diffs-container> host.
    fileState.instance.rerender();
  }

  // ─── Gap Expansion ────────────────────────────────────────────────

  /**
   * Expand a hunk in a file's diff.
   * @param {string} fileName
   * @param {number} hunkIndex
   * @param {string} direction - 'up' | 'down' | 'both'
   * @param {number} [lineCount] - Override default expansion count
   */
  expandHunk(fileName, hunkIndex, direction, lineCount) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.instance) return;
    fileState.instance.expandHunk(hunkIndex, direction, lineCount);
  }

  /**
   * Check if a line is visible (not in a collapsed gap) in a file's diff.
   * @param {string} fileName
   * @param {number} lineNumber
   * @param {string} side - 'LEFT'/'RIGHT' or 'additions'/'deletions'
   * @returns {boolean}
   */
  isLineVisible(fileName, lineNumber, side) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.instance) return false;
    // A collapsed file renders zero code lines regardless of metadata.
    if (fileState.collapsed) return false;
    const instance = fileState.instance;
    const hunks = instance.fileDiff?.hunks;
    if (!Array.isArray(hunks) || hunks.length === 0) return false;

    // Decide from the instance's CURRENT logical state, never the DOM.
    // render()/rerender() paint asynchronously (worker highlighting), so the
    // shadow DOM lags behind the latest render call — a DOM query here returns
    // stale answers (e.g. a line still on screen right after
    // clearContextRanges dropped it). instance.fileDiff is assigned
    // synchronously inside render(), so hunk membership reflects the state the
    // in-flight paint will converge to. A line is rendered iff it falls inside
    // a hunk of the current (context-range-merged) metadata, widened by any
    // user gap expansion tracked per hunk in hunksRenderer.expandedHunks.
    const sideKey = PierreBridge.toPierreSide(side) === 'deletions' ? 'deletion' : 'addition';
    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      const count = hunk[`${sideKey}Count`];
      if (!count) continue;
      const start = hunk[`${sideKey}Start`];
      const expanded = instance.hunksRenderer?.getExpandedHunk?.(i);
      const from = start - (expanded?.fromStart || 0);
      const to = start + count - 1 + (expanded?.fromEnd || 0);
      if (lineNumber >= from && lineNumber <= to) return true;
    }
    return false;
  }

  /**
   * Resolve the rendered shadow-DOM element for a line from the indices
   * returned by instance.getLineIndex(). The vendor stamps data-line-index
   * as a composite "unifiedIndex,splitIndex" key on content lines in BOTH
   * unified and split layouts (see @pierre/diffs renderDiffWithHighlighter);
   * fall back to the bare unified index for bundle versions that stamped a
   * single number.
   *
   * Column scoping avoids matching ghost lines from other files rendered in
   * the same document, and — in split view — targets the requested side:
   *   - unified: the single `code[data-unified]` column.
   *   - split:   `code[data-deletions]` (LEFT) or `code[data-additions]`
   *     (RIGHT). A context line exists in BOTH columns with the SAME composite
   *     key, so we search the requested side first and fall back to the other.
   * @param {Object} instance - FileDiff instance
   * @param {Array<number>|undefined} indices - [unifiedIndex, splitIndex]
   * @param {'deletions'|'additions'} [side] - preferred split column
   * @returns {Element|null}
   * @private
   */
  static _queryLineElement(instance, indices, side) {
    if (!indices) return null;
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
   * Ordered list of code-column elements to search for a line, scoped to a
   * single FileDiff instance. Unified returns the one unified column; split
   * returns both columns with the requested `side` first. Falls back to the
   * whole `pre` when no column element is resolvable.
   * @param {Object} instance
   * @param {Element} pre
   * @param {'deletions'|'additions'} [side]
   * @returns {Array<Element|null>}
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
   * Expand collapsed gaps so that the given line becomes visible.
   * Iterates over hunks to find which gap the line falls in, then
   * expands that hunk upward/downward by enough lines to reveal it.
   * @param {string} fileName
   * @param {number} lineNumber
   * @param {string} side - 'LEFT'/'RIGHT'
   */
  expandToLine(fileName, lineNumber, side = 'RIGHT') {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.instance) return;
    const instance = fileState.instance;
    if (!instance.fileDiff || !instance.fileDiff.hunks) return;

    const hunks = instance.fileDiff.hunks;
    const sideKey = PierreBridge.toPierreSide(side) === 'deletions' ? 'deletion' : 'addition';

    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      const hunkStart = hunk[`${sideKey}Start`];
      const hunkEnd = hunkStart + hunk[`${sideKey}Count`] - 1;

      // Target line is before this hunk — it's in the collapsed gap above
      if (lineNumber < hunkStart) {
        instance.expandHunk(i, 'up', hunk.collapsedBefore);
        instance.rerender();
        return;
      }

      // Target line is within this hunk — already visible (or should be)
      if (lineNumber <= hunkEnd) {
        return;
      }

      // If this is the last hunk and the line is after it — expand down
      if (i === hunks.length - 1 && lineNumber > hunkEnd) {
        instance.expandHunk(i, 'down', lineNumber - hunkEnd);
        instance.rerender();
        return;
      }
    }
  }

  // ─── Shadow DOM Access ────────────────────────────────────────────

  /**
   * Get the shadow root of a file's diff, if accessible.
   * @param {string} fileName
   * @returns {ShadowRoot|null}
   */
  getShadowRoot(fileName) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.shadowHost) return null;
    return fileState.shadowHost.shadowRoot || null;
  }

  /**
   * Get the FileDiff instance for a file.
   * @param {string} fileName
   * @returns {FileDiff|null}
   */
  getInstance(fileName) {
    const fileState = this.files.get(fileName);
    return fileState ? fileState.instance : null;
  }

  /**
   * Get the currently hovered line info for a file.
   * @param {string} fileName
   * @returns {Object|undefined} { lineNumber, side }
   */
  getHoveredLine(fileName) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.instance) return undefined;
    return fileState.instance.getHoveredLine();
  }

  // ─── Internal Rendering Callbacks ─────────────────────────────────

  /**
   * Render an annotation element (comment, suggestion, or form).
   * Reuses form DOM elements to preserve user input.
   * @private
   */
  _renderAnnotation(annotation, fileName, formElements) {
    const { type, data, id } = annotation.metadata;

    switch (type) {
    case 'comment':
      return this._renderCommentAnnotation(data, id);
    case 'suggestion':
      return this._renderSuggestionAnnotation(data, id);
    case 'comment-form':
      return this._renderFormAnnotation(data, id, formElements, fileName);
    default: {
      // Custom annotation types (e.g. 'tour-stop', 'hunk-summary') are
      // rendered by externally registered renderers so feature modules can
      // plug in without modifying the bridge.
      const customRenderer = this._annotationRenderers?.get(type);
      if (customRenderer) {
        try {
          return customRenderer(data, id, fileName) || undefined;
        } catch (err) {
          console.error(`[PierreBridge] custom annotation renderer for "${type}" failed:`, err);
          return undefined;
        }
      }
      return undefined;
    }
    }
  }

  /**
   * Register a renderer for a custom annotation type. The callback receives
   * (data, id, fileName) and must return a DOM element (or null to skip).
   * Elements are slotted into the light DOM below their anchor line, so page
   * CSS and inline event handlers work as they do for comments/suggestions.
   * @param {string} type - Annotation type (e.g. 'tour-stop', 'hunk-summary')
   * @param {Function} renderFn - (data, id, fileName) => Element|null
   */
  registerAnnotationRenderer(type, renderFn) {
    if (!this._annotationRenderers) this._annotationRenderers = new Map();
    this._annotationRenderers.set(type, renderFn);
  }

  /**
   * Remove a previously registered custom annotation renderer.
   * @param {string} type
   */
  unregisterAnnotationRenderer(type) {
    this._annotationRenderers?.delete(type);
  }

  /**
   * Render a user comment annotation using the legacy comment UI.
   * Produces DOM matching CommentManager.displayUserComment() so all existing
   * CSS and event handling applies. Elements live in the light DOM (slotted).
   * @private
   */
  _renderCommentAnnotation(comment, id) {
    const escapeHtml = window.prManager?.escapeHtml?.bind(window.prManager) || ((s) => s);

    const lineInfo = comment.line_end && comment.line_end !== comment.line_start
      ? `Lines ${comment.line_start}-${comment.line_end}`
      : `Line ${comment.line_start}`;

    // Build metadata display for adopted comments (praise badge + title)
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

    // Icon based on origin (AI-adopted vs user-originated)
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
   * Delegates to SuggestionManager.createSuggestionRow() for zero duplication,
   * then extracts the inner .ai-suggestion div. The element lives in the light
   * DOM (slotted) so all existing CSS and document.querySelector() navigation
   * works unchanged.
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

    // Fallback: minimal rendering if SuggestionManager unavailable
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

  /**
   * Suggestion toolbar icon SVG (GitHub Primer file-diff-16 octicon).
   * Matches CommentManager.SUGGESTION_ICON_SVG.
   * @private
   */
  static SUGGESTION_ICON_SVG = `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073ZM8 3.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0V7h-1.5a.75.75 0 0 1 0-1.5h1.5V4A.75.75 0 0 1 8 3.25Zm-3 8a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z"></path></svg>`;

  /**
   * Chat icon SVG for comment form (matches legacy CommentManager).
   * @private
   */
  static CHAT_FORM_SVG = `<svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>`;

  /**
   * Render a comment form annotation.
   * Reuses existing form DOM if available to preserve user input.
   * Elements live in the light DOM (slotted) and use legacy comment form
   * classes so page CSS applies.
   * @private
   */
  _renderFormAnnotation(data, id, formElements, fileName) {
    // Reuse existing form element to preserve textarea content
    if (formElements.has(id)) {
      return formElements.get(id);
    }

    const container = document.createElement('div');
    container.className = 'pierre-annotation user-comment-form';
    container.dataset.annotationId = id;

    // Header — matches legacy comment form
    const header = document.createElement('div');
    header.className = 'comment-form-header';
    const icon = document.createElement('span');
    icon.className = 'comment-icon';
    icon.textContent = '\uD83D\uDCAC'; // 💬
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

    // Suggestion toolbar — suggestionBtn is declared in the outer scope so
    // the textarea input listener below can re-evaluate its disabled state.
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

    // Textarea
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

    // Actions — order matches legacy: Save, Chat, Cancel
    const actions = document.createElement('div');
    actions.className = 'comment-form-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm btn-primary save-comment-btn';
    saveBtn.textContent = 'Save';
    // Sync disabled state with initial textarea content — when `initialValue`
    // is set programmatically above, the `input` event does not fire, so we
    // must compute this here rather than relying on the listener.
    saveBtn.disabled = !textarea.value.trim();
    // Guard against duplicate submits from rapid clicks or repeated
    // Cmd+Enter. Parity with CommentManager.saveComment which notes:
    // "Prevent duplicate saves from rapid clicks or Cmd+Enter".
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.dataset.saving === 'true') return;
      if (!this.options.onCommentFormSubmit) return;
      saveBtn.dataset.saving = 'true';
      saveBtn.disabled = true;
      try {
        await this.options.onCommentFormSubmit(fileName, id, data, textarea.value);
      } finally {
        // On success the form annotation has been removed and the button
        // is detached; only touch the button if it's still connected.
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

    // Enable/disable save button and re-evaluate suggestion button on input.
    // Mirrors CommentManager.updateSuggestionButtonState so that manually
    // deleting a ```suggestion block re-enables the toolbar button.
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
      // Auto-resize
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    });

    // Keyboard shortcuts (Cmd/Ctrl+Enter, Escape) are handled by the
    // delegated listener in PRManager.setupCommentFormDelegation() which
    // matches .comment-textarea — no inline handler needed here.

    // Cache form element for reuse
    formElements.set(id, container);

    // Focus textarea and attach emoji picker after it's in the DOM.
    // Matches parity with legacy CommentManager.showCommentForm — emoji
    // autocomplete (typing `:`) should work in Pierre-rendered forms too.
    requestAnimationFrame(() => {
      textarea.focus();
      if (window.emojiPicker) window.emojiPicker.attach(textarea);
      // Initial auto-resize for pre-filled content (input event doesn't
      // fire for programmatic .value assignment).
      if (data.initialValue) {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
        // Sync suggestion button disabled state with pre-filled content —
        // the input event listener doesn't fire for programmatic .value.
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
   * Used by the suggestion button to pre-fill suggestion blocks.
   * @param {string} fileName
   * @param {number} startLine - 1-based start line
   * @param {number} endLine - 1-based end line
   * @param {string} side - 'LEFT' or 'RIGHT'
   * @returns {string|null} Code text, or null if file not found
   */
  getCodeFromLines(fileName, startLine, endLine, side) {
    const fileState = this.files.get(fileName);
    if (!fileState || !fileState.metadata) return null;

    const metadata = fileState.baseMetadata || fileState.metadata;
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

      // Skip hunks entirely outside the requested range
      if (hunkEnd < startLine || hunkStart > endLine) continue;

      // Walk lines in this hunk
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
   * Normalize side from pair-review ('LEFT'/'RIGHT') to @pierre/diffs ('deletions'/'additions').
   */
  static toPierreSide(side) {
    if (side === 'LEFT' || side === 'deletions') return 'deletions';
    return 'additions';
  }

  /**
   * Normalize side from @pierre/diffs to pair-review format.
   */
  static toPairReviewSide(side) {
    if (side === 'deletions' || side === 'LEFT') return 'LEFT';
    return 'RIGHT';
  }

  /**
   * Normalize side to pair-review format for diffPosition lookup.
   */
  static normalizeSide(side) {
    if (side === 'deletions' || side === 'LEFT') return 'LEFT';
    return 'RIGHT';
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

  // Annotation CSS injected into Shadow DOM via unsafeCSS.
  // Suggestions and comments use legacy classes (.ai-suggestion, .user-comment)
  // styled by the page stylesheet. Only the comment form annotation lives
  // entirely within the shadow DOM and needs styles here.
  //
  // Split-layout constraint: @pierre/diffs anchors each annotation to ONE code
  // column — a 'deletions' annotation renders in the LEFT column, an
  // 'additions' annotation in the RIGHT column (see getAnnotations()/
  // pushLineWithAnnotation in DiffHunksRenderer). The column is a subgrid cell,
  // so a card CANNOT span both columns via CSS; it fills the width of its own
  // side. min-width:0 lets cards wrap inside that (roughly half-width) cell
  // rather than force horizontal overflow. This matches the vendor's layout;
  // most pair-review annotations are RIGHT/additions, so they land in the
  // right column in split view.
  static ANNOTATION_CSS = `
    .pierre-annotation {
      padding: 8px 12px;
      margin: 4px 0;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
    /* Let annotation cards wrap within a split column instead of overflowing. */
    [data-line-annotation] { min-width: 0; }
    [data-annotation-content] { min-width: 0; }
    /* Brief flash applied by PierreBridge.scrollToLine. Generic [data-line]
       match so it flashes whichever column (unified/deletions/additions) the
       target line resolves to. */
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
