// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * DiffRenderer - File headers of the diff pane and file-path helpers.
 * The lines of a file are drawn by the viewer (PierreBridge); this module
 * builds the header a file is shown under and resolves the forms a path
 * comes in.
 */

class DiffRenderer {
  // Chevron icon for expand/collapse (pointing right when collapsed)
  static CHEVRON_RIGHT_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path fill-rule="evenodd" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>
    </svg>
  `;

  // Chevron icon pointing down (when expanded)
  static CHEVRON_DOWN_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path fill-rule="evenodd" d="M12.78 6.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L8 9.94l3.72-3.72a.75.75 0 0 1 1.06 0Z"/>
    </svg>
  `;

  // Eye icon for showing hidden content (GitHub Octicons "eye")
  static EYE_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.831.88 9.577.43 8.899a1.62 1.62 0 0 1 0-1.798c.45-.678 1.367-1.932 2.637-3.023C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.824.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"/>
    </svg>
  `;

  // Eye-closed icon for hiding content (GitHub Octicons "eye-closed")
  static EYE_CLOSED_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M.143 2.31a.75.75 0 0 1 1.047-.167l14.5 10.5a.75.75 0 1 1-.88 1.214l-2.248-1.628C11.346 13.19 9.792 14 8 14c-1.981 0-3.67-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.797c.353-.533 1.063-1.502 2.063-2.487L.31 3.357A.75.75 0 0 1 .143 2.31Zm3.386 3.378a14.21 14.21 0 0 0-1.85 2.244.12.12 0 0 0 0 .136c.412.621 1.242 1.75 2.366 2.717C5.175 11.758 6.527 12.5 8 12.5c1.195 0 2.31-.488 3.29-1.191L9.063 9.695A2 2 0 0 1 6.058 7.52L3.529 5.688Zm6.728 4.873-1.676-1.214a.5.5 0 1 0 .798.59l.878.624ZM8 3.5c-.516 0-1.017.09-1.499.251a.75.75 0 0 1-.473-1.423A6.23 6.23 0 0 1 8 2c1.981 0 3.67.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.11.166-.248.365-.41.587a.75.75 0 1 1-1.21-.887c.148-.201.272-.382.371-.53a.119.119 0 0 0 0-.137c-.412-.621-1.242-1.75-2.366-2.717C10.825 4.242 9.473 3.5 8 3.5Z"/>
    </svg>
  `;

  // Generated file indicator icon (gear/cog icon)
  static GENERATED_FILE_ICON = `
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.585.52a2.678 2.678 0 0 0-3.17 0l-.928.68a1.178 1.178 0 0 1-.518.215L3.83 1.59a2.678 2.678 0 0 0-2.24 2.24l-.175 1.14a1.178 1.178 0 0 1-.215.518l-.68.928a2.678 2.678 0 0 0 0 3.17l.68.928c.113.153.186.33.215.518l.175 1.138a2.678 2.678 0 0 0 2.24 2.24l1.138.175c.187.029.365.102.518.215l.928.68a2.678 2.678 0 0 0 3.17 0l.928-.68a1.17 1.17 0 0 1 .518-.215l1.138-.175a2.678 2.678 0 0 0 2.241-2.241l.175-1.138c.029-.187.102-.365.215-.518l.68-.928a2.678 2.678 0 0 0 0-3.17l-.68-.928a1.179 1.179 0 0 1-.215-.518L14.41 3.83a2.678 2.678 0 0 0-2.24-2.24l-1.138-.175a1.179 1.179 0 0 1-.518-.215L9.585.52ZM7.303 1.728c.415-.305.979-.305 1.394 0l.928.68c.348.256.752.423 1.18.489l1.136.174c.51.078.909.478.987.987l.174 1.137c.066.427.233.831.489 1.18l.68.927c.305.415.305.98 0 1.394l-.68.928a2.678 2.678 0 0 0-.489 1.18l-.174 1.136a1.178 1.178 0 0 1-.987.987l-1.137.174a2.678 2.678 0 0 0-1.18.489l-.927.68c-.415.305-.98.305-1.394 0l-.928-.68a2.678 2.678 0 0 0-1.18-.489l-1.136-.174a1.178 1.178 0 0 1-.987-.987l-.174-1.137a2.678 2.678 0 0 0-.489-1.18l-.68-.927a1.178 1.178 0 0 1 0-1.394l.68-.928c.256-.348.423-.752.489-1.18l.174-1.136c.078-.51.478-.909.987-.987l1.137-.174a2.678 2.678 0 0 0 1.18-.489l.927-.68ZM8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4Z"/>
    </svg>
  `;

  /**
   * Escape HTML characters
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  static escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Normalize a file path for DOM matching.
   *
   * Frontend mirror of `normalizePath()` + `resolveRenamedFile()` from
   * `src/utils/paths.js`. Browser code cannot `require()` the backend module,
   * so the logic is duplicated here. Keep this function in sync with those two
   * when modifying normalization rules, otherwise the frontend and backend
   * will disagree on which paths are equivalent.
   *
   * @param {string} filePath - File path to normalize
   * @returns {string} Normalized file path
   */
  static normalizeFilePath(filePath) {
    if (typeof filePath !== 'string') return '';

    let normalized = filePath.trim();
    if (!normalized) return '';

    // Resolve git rename syntax to the new path.
    normalized = normalized.replace(/\{[^}]*\s*=>\s*([^}]*)\}/, '$1');
    normalized = normalized.replace(/\/+/g, '/');

    // Strip leading './' and '/' segments until the string stops changing.
    // This mirrors normalizePath in src/utils/paths.js for interleaved cases
    // like '/./src/foo.js'.
    let prevLength;
    do {
      prevLength = normalized.length;

      while (normalized.startsWith('./')) {
        normalized = normalized.slice(2);
      }

      while (normalized.startsWith('/')) {
        normalized = normalized.slice(1);
      }
    } while (normalized.length !== prevLength);

    return normalized;
  }

  /**
   * Check whether two file paths should be treated as the same DOM target.
   * @param {string} left - First file path
   * @param {string} right - Second file path
   * @returns {boolean} True when the paths refer to the same file
   */
  static pathsMatch(left, right) {
    const normalizedLeft = DiffRenderer.normalizeFilePath(left);
    const normalizedRight = DiffRenderer.normalizeFilePath(right);

    if (!normalizedLeft || !normalizedRight) return false;

    return normalizedLeft === normalizedRight ||
      normalizedLeft.endsWith(`/${normalizedRight}`) ||
      normalizedRight.endsWith(`/${normalizedLeft}`);
  }

  /**
   * Try a direct selector lookup for a file path.
   * Falls back silently when CSS.escape is unavailable or the selector is invalid.
   * @param {string} attribute - data attribute to match (without brackets)
   * @param {string} filePath - File path to search for
   * @returns {Element|null} Matching element if found
   */
  static queryFileElement(attribute, filePath) {
    if (!filePath) {
      return null;
    }

    const css = globalThis.CSS;
    const escapedValue = css && typeof css.escape === 'function'
      ? css.escape(filePath)
      : filePath;

    try {
      // Scope to `.d2h-file-wrapper` so a nested `.file-comments-zone` (which
      // also carries data-file-name) can never be returned, and skip context
      // entries (a changed file and a context file can share a path; the
      // changed file wins). No unguarded fallback here:
      // findFileElement's pathsMatch loop handles rename syntax and
      // context-only files, and prefers the diff wrapper itself.
      const selector = `.d2h-file-wrapper[${attribute}="${escapedValue}"]:not(.context-file)`;
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  /**
   * Create file header element
   * @param {string} filePath - File path
   * @param {Object} options - Header options
   * @param {boolean} [options.isGenerated=false] - Whether file is generated
   * @param {boolean} [options.isExpanded=true] - Whether file is expanded
   * @param {boolean} [options.isViewed=false] - Whether file is marked as viewed
   * @param {Object} [options.generatedInfo] - Info about generated file (insertions, deletions)
   * @param {Object} [options.fileStats] - File stats for collapsed view {insertions, deletions}
   * @param {boolean} [options.renamed=false] - Whether the file was renamed
   * @param {string|null} [options.renamedFrom=null] - Original file path before rename
   * @param {Function} [options.onToggleCollapse] - Callback for toggling collapse state
   * @param {Function} [options.onToggleViewed] - Callback for toggling viewed state
   * @returns {HTMLElement} File header element
   */
  static createFileHeader(filePath, options = {}) {
    const {
      isGenerated = false,
      isExpanded = true,
      isViewed = false,
      generatedInfo = null,
      fileStats = null,
      renamed = false,
      renamedFrom = null,
      onToggleCollapse = null,
      onToggleViewed = null
    } = options;

    const fileHeader = document.createElement('div');
    fileHeader.className = 'd2h-file-header';

    // Chevron toggle button for expand/collapse (all files)
    const chevronBtn = document.createElement('button');
    chevronBtn.className = 'file-collapse-toggle';
    chevronBtn.title = isExpanded ? 'Collapse file' : 'Expand file';
    chevronBtn.innerHTML = isExpanded ? DiffRenderer.CHEVRON_DOWN_ICON : DiffRenderer.CHEVRON_RIGHT_ICON;
    chevronBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onToggleCollapse) onToggleCollapse(filePath);
    });
    fileHeader.appendChild(chevronBtn);

    // Add generated file indicators if applicable
    if (isGenerated) {
      // Add generated badge
      const badge = document.createElement('span');
      badge.className = 'generated-badge';
      badge.textContent = 'Generated file';
      badge.title = 'This file is marked as generated in .gitattributes';
      fileHeader.appendChild(badge);
    }

    // File name
    const fileName = document.createElement('span');
    fileName.className = 'd2h-file-name';
    if (renamed && renamedFrom) {
      const oldPath = document.createElement('span');
      oldPath.className = 'file-rename-old-path';
      oldPath.textContent = renamedFrom;
      const arrow = document.createElement('span');
      arrow.className = 'file-rename-arrow';
      arrow.textContent = '\u2192';
      const newPath = document.createTextNode(filePath);
      fileName.appendChild(oldPath);
      fileName.appendChild(arrow);
      fileName.appendChild(newPath);
    } else {
      fileName.textContent = filePath;
    }
    DiffRenderer.applyFilePathTruncation(
      fileName,
      renamed && renamedFrom ? `${renamedFrom} \u2192 ${filePath}` : filePath
    );
    fileHeader.appendChild(fileName);

    // File stats summary (visible in collapsed view)
    const stats = generatedInfo || fileStats;
    if (stats) {
      const statsSummary = document.createElement('span');
      statsSummary.className = 'file-stats-summary';
      statsSummary.innerHTML = `<span class="additions">+${stats.insertions || 0}</span> <span class="deletions">-${stats.deletions || 0}</span>`;
      fileHeader.appendChild(statsSummary);
    }

    // Viewed checkbox (right side)
    const viewedLabel = document.createElement('label');
    viewedLabel.className = 'file-viewed-label';
    viewedLabel.title = 'Mark file as viewed';

    const viewedCheckbox = document.createElement('input');
    viewedCheckbox.type = 'checkbox';
    viewedCheckbox.className = 'file-viewed-checkbox';
    viewedCheckbox.checked = isViewed;
    viewedCheckbox.addEventListener('change', (e) => {
      e.stopPropagation();
      if (onToggleViewed) onToggleViewed(filePath, viewedCheckbox.checked);
    });

    viewedLabel.appendChild(viewedCheckbox);
    viewedLabel.appendChild(document.createTextNode('Viewed'));
    fileHeader.appendChild(viewedLabel);

    // Add click handler to header for collapse toggle (excluding checkbox area)
    fileHeader.addEventListener('click', (e) => {
      // Ignore clicks on the checkbox, label, or chevron button (which has its own handler)
      if (e.target.closest('.file-viewed-label') || e.target.closest('.file-collapse-toggle')) {
        return;
      }
      if (onToggleCollapse) onToggleCollapse(filePath);
    });

    return fileHeader;
  }

  /**
   * Front-truncate a file path ("…/dir/file.js") with a full-path tooltip
   * @param {HTMLElement} el - Element containing the path
   * @param {string} fullText - Tooltip text
   */
  static applyFilePathTruncation(el, fullText) {
    window.SmartTruncate?.apply(el, { mode: 'start', fullText });
  }

  /**
   * Update file header expand/collapse state
   * @param {HTMLElement} header - The file header element
   * @param {boolean} isExpanded - Whether the file is now expanded
   */
  static updateFileHeaderState(header, isExpanded) {
    const chevronBtn = header.querySelector('.file-collapse-toggle');
    if (chevronBtn) {
      chevronBtn.innerHTML = isExpanded ? DiffRenderer.CHEVRON_DOWN_ICON : DiffRenderer.CHEVRON_RIGHT_ICON;
      chevronBtn.title = isExpanded ? 'Collapse file' : 'Expand file';
    }
  }

  /**
   * Update file viewed checkbox state
   * @param {HTMLElement} header - The file header element
   * @param {boolean} isViewed - Whether the file is marked as viewed
   */
  static updateFileViewedState(header, isViewed) {
    const checkbox = header.querySelector('.file-viewed-checkbox');
    if (checkbox) {
      checkbox.checked = isViewed;
    }
  }

  /**
   * Find a file wrapper element by file path
   * Tries multiple selectors and partial path matching for robustness
   * @param {string} filePath - File path to find
   * @returns {Element|null} The file wrapper element or null if not found
   */
  static findFileElement(filePath) {
    const normalizedPath = DiffRenderer.normalizeFilePath(filePath);

    // Try direct selector lookups first when we can safely escape the value.
    const selectorCandidates = [filePath];
    if (normalizedPath && normalizedPath !== filePath) {
      selectorCandidates.push(normalizedPath);
    }

    for (const candidate of selectorCandidates) {
      let fileElement = DiffRenderer.queryFileElement('data-file-name', candidate);
      if (fileElement) return fileElement;

      fileElement = DiffRenderer.queryFileElement('data-file-path', candidate);
      if (fileElement) return fileElement;
    }

    // Fall back to normalized iteration so special characters, rename syntax,
    // and formatted variants still resolve to the rendered wrapper. Prefer a
    // diff wrapper over a context entry that shares the file path.
    const allFileWrappers = document.querySelectorAll('.d2h-file-wrapper');
    let contextMatch = null;
    for (const wrapper of allFileWrappers) {
      const fileName = wrapper.dataset.fileName;
      const filePathAttr = wrapper.dataset.filePath;
      if (DiffRenderer.pathsMatch(fileName, filePath) || DiffRenderer.pathsMatch(filePathAttr, filePath)) {
        if (!wrapper.classList?.contains('context-file')) {
          return wrapper;
        }
        if (!contextMatch) contextMatch = wrapper;
      }
    }

    return contextMatch;
  }
}

// Make DiffRenderer available globally in browser
if (typeof window !== 'undefined') {
  window.DiffRenderer = DiffRenderer;
}

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DiffRenderer };
}
