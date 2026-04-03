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

    // Per-file state: { instance: FileDiff, metadata: FileDiffMetadata, container: HTMLElement,
    //                   annotations: DiffLineAnnotation[], diffPositions: Map, formElements: Map }
    this.files = new Map();

    // CSS to inject into Shadow DOM for annotations, comments, suggestions
    this._unsafeCSS = null;

    // Monotonic counter for unique annotation IDs
    this._annotationCounter = 0;

    // Shared options for all FileDiff instances
    this._sharedOptions = null;
  }

  // ─── Theme ────────────────────────────────────────────────────────

  static detectTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  getThemeConfig() {
    return {
      dark: 'pierre-dark',
      light: 'pierre-light',
    };
  }

  setTheme(theme) {
    this.theme = theme;
    for (const [, fileState] of this.files) {
      if (fileState.instance) {
        fileState.instance.setThemeType(theme);
      }
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
    }

    const diffPositions = this.computeDiffPositions(patch);
    const annotations = [];
    const formElements = new Map();

    const instance = new window.PierreDiffs.FileDiff({
      theme: this.getThemeConfig(),
      themeType: this.theme,
      disableFileHeader: true,
      diffStyle: 'unified',
      diffIndicators: 'classic',
      overflow: 'scroll',
      lineHoverHighlight: 'line',
      lineDiffType: 'word',
      enableGutterUtility: true,
      enableLineSelection: true,
      unsafeCSS: this.getUnsafeCSS(),
      hunkSeparators: 'line-info',
      collapsed: renderOptions.collapsed || false,

      // Use onGutterUtilityClick for the built-in "+" button behavior.
      // Cannot combine renderGutterUtility with onGutterUtilityClick —
      // @pierre/diffs enforces one gutter utility API at a time.
      onGutterUtilityClick: (range) => {
        const side = range.side === 'deletions' ? 'LEFT' : 'RIGHT';
        if (this.options.onCommentClick) {
          this.options.onCommentClick(fileName, range.start, side, range);
        }
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
    });

    const rendered = instance.render({
      fileDiff: metadata,
      containerWrapper: container,
      lineAnnotations: annotations,
    });

    const fileState = {
      instance,
      metadata,
      container,
      patch,
      annotations,
      diffPositions,
      formElements,
      shadowHost: container.querySelector('diffs-container') || container.firstElementChild,
    };

    this.files.set(fileName, fileState);
    return fileState;
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
    fileState.instance.setOptions({ collapsed });
  }

  /**
   * Destroy a file's FileDiff instance and clean up.
   * @param {string} fileName
   */
  destroyFile(fileName) {
    const fileState = this.files.get(fileName);
    if (!fileState) return;
    if (fileState.instance) {
      fileState.instance.cleanUp();
    }
    fileState.formElements.clear();
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
    const typeOrder = { 'suggestion': 0, 'comment-form': 1, 'comment': 2 };
    const sorted = [...fileState.annotations].sort((a, b) => {
      if (a.lineNumber !== b.lineNumber || a.side !== b.side) return 0;
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
    const pierreSide = PierreBridge.toPierreSide(side);
    const index = fileState.instance.getLineIndex(lineNumber, pierreSide);
    return index !== undefined;
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
    default:
      return undefined;
    }
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
    container.className = 'user-comment-cell';
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
   * Render a comment form annotation.
   * Reuses existing form DOM if available to preserve user input.
   * @private
   */
  _renderFormAnnotation(data, id, formElements, fileName) {
    // Reuse existing form element to preserve textarea content
    if (formElements.has(id)) {
      return formElements.get(id);
    }

    const container = document.createElement('div');
    container.className = 'pierre-annotation pierre-comment-form';
    container.dataset.annotationId = id;

    const textarea = document.createElement('textarea');
    textarea.className = 'pierre-comment-textarea';
    textarea.placeholder = 'Leave a comment...';
    textarea.rows = 3;
    if (data.initialValue) {
      textarea.value = data.initialValue;
    }
    container.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'pierre-form-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'pierre-btn pierre-btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      if (this.options.onCommentFormCancel) {
        this.options.onCommentFormCancel(fileName, id, data);
      }
    });
    actions.appendChild(cancelBtn);

    const submitBtn = document.createElement('button');
    submitBtn.className = 'pierre-btn pierre-btn-sm pierre-btn-primary';
    submitBtn.textContent = 'Save';
    submitBtn.addEventListener('click', () => {
      if (this.options.onCommentFormSubmit) {
        this.options.onCommentFormSubmit(fileName, id, data, textarea.value);
      }
    });
    actions.appendChild(submitBtn);

    if (data.showSuggestionBtn) {
      const suggestBtn = document.createElement('button');
      suggestBtn.className = 'pierre-btn pierre-btn-sm';
      suggestBtn.textContent = 'Suggest';
      suggestBtn.addEventListener('click', () => {
        if (this.options.onCommentFormSuggest) {
          this.options.onCommentFormSuggest(fileName, id, data, textarea.value);
        }
      });
      actions.appendChild(suggestBtn);
    }

    container.appendChild(actions);

    // Cache form element for reuse
    formElements.set(id, container);
    return container;
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
  static ANNOTATION_CSS = `
    .pierre-annotation {
      padding: 8px 12px;
      margin: 4px 0;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
    }
  `;
}

// Export as global
window.PierreBridge = PierreBridge;

// Also export for CommonJS test environments
if (typeof module !== 'undefined') {
  module.exports = PierreBridge;
}
