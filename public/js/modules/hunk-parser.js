/**
 * HunkParser - Hunk header parsing and gap context expansion
 * Handles parsing of unified diff hunk headers and expansion of collapsed sections
 */

class HunkParser {
  // SVG icons for diff expansion controls (GitHub Octicons)
  static FOLD_UP_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M7.823 1.677 4.927 4.573A.25.25 0 0 0 5.104 5H7.25v3.236a.75.75 0 1 0 1.5 0V5h2.146a.25.25 0 0 0 .177-.427L8.177 1.677a.25.25 0 0 0-.354 0ZM13.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5Zm-3.75.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75ZM7.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5ZM4 11.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75ZM1.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5h-.5Z"/>
    </svg>
  `;

  static FOLD_DOWN_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="m8.177 14.323 2.896-2.896a.25.25 0 0 0-.177-.427H8.75V7.764a.75.75 0 1 0-1.5 0V11H5.104a.25.25 0 0 0-.177.427l2.896 2.896a.25.25 0 0 0 .354 0ZM2.25 5a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM6 4.25a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5a.75.75 0 0 1 .75.75ZM8.25 5a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM12 4.25a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5a.75.75 0 0 1 .75.75Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5Z"/>
    </svg>
  `;

  // GitHub Octicons "unfold" icon - arrows pointing outward with dotted line between
  static UNFOLD_ICON = `
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="m8.177.677 2.896 2.896a.25.25 0 0 1-.177.427H8.75v1.25a.75.75 0 0 1-1.5 0V4H5.104a.25.25 0 0 1-.177-.427L7.823.677a.25.25 0 0 1 .354 0ZM7.25 10.75a.75.75 0 0 1 1.5 0V12h2.146a.25.25 0 0 1 .177.427l-2.896 2.896a.25.25 0 0 1-.354 0l-2.896-2.896A.25.25 0 0 1 5.104 12H7.25v-1.25Zm-5-2a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM6 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 6 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5ZM12 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 12 8Zm2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5h.5Z"/>
    </svg>
  `;

  // Keep old name as alias for backward compatibility
  static FOLD_UP_DOWN_ICON = HunkParser.UNFOLD_ICON;

  // Default number of lines to expand when clicking up/down buttons
  static DEFAULT_EXPAND_LINES = 20;

  // Threshold for small gaps - show single "expand all" button instead of directional buttons
  static SMALL_GAP_THRESHOLD = 10;

  // Auto-expand threshold - gaps smaller than this are expanded automatically (2x standard context of 3 lines)
  static AUTO_EXPAND_THRESHOLD = 6;

  /**
   * Extract function context from a unified diff hunk header.
   * Hunk headers have the format: "@@ -old,count +new,count @@ optional context"
   * The context (function/class/selector name) provides orientation.
   * @param {string} header - The raw hunk header string
   * @returns {string|null} The function context, or null if none present
   */
  static extractFunctionContext(header) {
    if (!header) return null;
    // Match: @@ followed by line info, then @@ and optional trailing context
    // The [^@]+ between @@ markers ensures we stop at the closing @@, so even
    // if the function name contains @ characters, they're captured correctly
    const match = header.match(/^@@[^@]+@@\s*(.*)$/);
    const context = match ? match[1].trim() : null;
    return context || null; // Return null for empty strings too
  }

  /**
   * Extract first/last valid old/new line coordinates from a diff block
   * Handles asymmetric diffs where deletion-only lines lack newNumber and vice versa
   * @param {Object} block - Diff block containing lines array
   * @param {'first' | 'last'} mode - Whether to find first or last valid coordinates
   * @returns {{ old: number|null, new: number|null }} Line coordinates in each system
   */
  static getBlockCoordinateBounds(block, mode) {
    let foundOld = null, foundNew = null;
    const lines = block.lines;

    if (mode === 'first') {
      // Scan forward for first valid coordinates
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (foundOld === null && line.oldNumber) foundOld = line.oldNumber;
        if (foundNew === null && line.newNumber) foundNew = line.newNumber;
        // Early break is safe: we're finding the first valid coordinate in each system
        // independently, so subsequent lines can only have higher (not lower) numbers
        if (foundOld !== null && foundNew !== null) break;
      }
    } else {
      // Scan backward for last valid coordinates
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (foundOld === null && line.oldNumber) foundOld = line.oldNumber;
        if (foundNew === null && line.newNumber) foundNew = line.newNumber;
        // Early break is safe: we're finding the last valid coordinate in each system
        // independently, so earlier lines can only have lower (not higher) numbers
        if (foundOld !== null && foundNew !== null) break;
      }
    }

    return { old: foundOld, new: foundNew };
  }

  /**
   * Create gap section for expandable context between diff blocks
   * @param {HTMLElement} tbody - Table body element
   * @param {string} fileName - File name
   * @param {number} startLine - Start line number
   * @param {number} endLine - End line number
   * @param {number} gapSize - Number of hidden lines
   * @param {string} position - Position ('above', 'below', or 'between')
   * @param {Function} expandCallback - Callback function for expanding gaps
   * @returns {HTMLElement} The created gap row
   */
  static createGapSection(tbody, fileName, startLine, endLine, gapSize, position, expandCallback) {
    // Create a row for the gap between diff blocks
    const row = document.createElement('tr');
    row.className = 'context-expand-row';

    // Create separate cells for old and new line numbers
    const oldLineCell = document.createElement('td');
    oldLineCell.className = 'diff-line-num';
    oldLineCell.style.padding = '0';
    oldLineCell.style.textAlign = 'center';

    const newLineCell = document.createElement('td');
    newLineCell.className = 'diff-line-num';
    newLineCell.style.padding = '0';
    newLineCell.style.textAlign = 'center';

    // Put expand buttons in the first line number cell
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'expand-button-container';

    // Create expand controls container for metadata
    const expandControls = document.createElement('div');
    expandControls.className = 'context-expand-controls';

    // Store metadata for expansion
    expandControls.dataset.fileName = fileName;
    expandControls.dataset.startLine = startLine;
    expandControls.dataset.endLine = endLine;
    expandControls.dataset.hiddenCount = gapSize;
    expandControls.dataset.position = position;
    expandControls.dataset.isGap = 'true'; // Mark this as a gap section

    // Create the expand buttons with GitHub Octicons
    // For short sections (<=SMALL_GAP_THRESHOLD lines) or single-direction, show single button
    // For larger sections with both directions, show stacked buttons
    if (gapSize <= HunkParser.SMALL_GAP_THRESHOLD || position !== 'between') {
      // Single button - either fold-up, fold-down, or fold-up-down
      const expandBtn = document.createElement('button');
      expandBtn.className = 'expand-button expand-all-short';

      if (position === 'above') {
        // At top - expand up to reveal lines above first visible line
        expandBtn.title = 'Expand up';
        expandBtn.innerHTML = HunkParser.FOLD_UP_ICON;
        expandBtn.addEventListener('click', () => expandCallback(expandControls, 'up', HunkParser.DEFAULT_EXPAND_LINES));
      } else if (position === 'below') {
        // At bottom - expand down to reveal lines below last visible line
        expandBtn.title = 'Expand down';
        expandBtn.innerHTML = HunkParser.FOLD_DOWN_ICON;
        expandBtn.addEventListener('click', () => expandCallback(expandControls, 'down', HunkParser.DEFAULT_EXPAND_LINES));
      } else {
        // Between - short section, expand all
        expandBtn.title = 'Expand all';
        expandBtn.innerHTML = HunkParser.FOLD_UP_DOWN_ICON;
        expandBtn.addEventListener('click', () => expandCallback(expandControls, 'all', gapSize));
      }
      buttonContainer.appendChild(expandBtn);
    } else {
      // Large gap between changes - show separate up/down buttons with GitHub fold icons
      const expandAbove = document.createElement('button');
      expandAbove.className = 'expand-button expand-up';
      expandAbove.title = 'Expand up';
      expandAbove.innerHTML = HunkParser.FOLD_UP_ICON;

      const expandBelow = document.createElement('button');
      expandBelow.className = 'expand-button expand-down';
      expandBelow.title = 'Expand down';
      expandBelow.innerHTML = HunkParser.FOLD_DOWN_ICON;

      // Stack buttons: down on top (visually), up below - matches GitHub behavior
      buttonContainer.appendChild(expandBelow);
      buttonContainer.appendChild(expandAbove);

      // Add event listeners - capture expandControls in closure at creation time
      expandAbove.addEventListener('click', () => expandCallback(expandControls, 'up', HunkParser.DEFAULT_EXPAND_LINES));
      expandBelow.addEventListener('click', () => expandCallback(expandControls, 'down', HunkParser.DEFAULT_EXPAND_LINES));
    }
    oldLineCell.appendChild(buttonContainer);

    // Create content cell for hidden lines text - clickable to expand all
    const contentCell = document.createElement('td');
    contentCell.className = 'diff-code expand-content clickable-expand';
    contentCell.colSpan = 2;
    contentCell.title = 'Expand all';

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'expand-content-wrapper';

    const expandIcon = document.createElement('span');
    expandIcon.className = 'expand-icon';
    expandIcon.innerHTML = HunkParser.FOLD_UP_DOWN_ICON;

    const expandInfo = document.createElement('span');
    expandInfo.className = 'expand-info';
    expandInfo.textContent = `${gapSize} hidden lines`;

    contentWrapper.appendChild(expandIcon);
    contentWrapper.appendChild(expandInfo);
    contentCell.appendChild(contentWrapper);

    // Make content cell clickable to expand all
    contentCell.addEventListener('click', (e) => {
      const row = e.currentTarget.closest('tr');
      const hiddenCount = parseInt(expandControls.dataset.hiddenCount) || gapSize;
      expandCallback(row.expandControls, 'all', hiddenCount);
    });

    // Store expand controls reference on row
    row.expandControls = expandControls;

    row.appendChild(oldLineCell);
    row.appendChild(newLineCell);
    row.appendChild(contentCell);

    if (tbody) {
      tbody.appendChild(row);
    }

    return row;
  }

  /**
   * Create a gap row element for partial expansion
   * Similar to createGapSection but returns the element instead of appending to tbody
   * @param {string} fileName - File name
   * @param {number} startLine - Start line number
   * @param {number} endLine - End line number
   * @param {number} gapSize - Number of hidden lines
   * @param {string} position - Position ('above', 'below', or 'between')
   * @param {Function} expandCallback - Callback function for expanding gaps
   * @returns {HTMLElement} The created gap row element
   */
  static createGapRowElement(fileName, startLine, endLine, gapSize, position, expandCallback) {
    const row = document.createElement('tr');
    row.className = 'context-expand-row';

    // Create line number cells
    const oldLineCell = document.createElement('td');
    oldLineCell.className = 'diff-line-num';
    oldLineCell.style.padding = '0';
    oldLineCell.style.textAlign = 'center';

    const newLineCell = document.createElement('td');
    newLineCell.className = 'diff-line-num';
    newLineCell.style.padding = '0';
    newLineCell.style.textAlign = 'center';

    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'expand-button-container';

    // Create expand controls with metadata
    const expandControls = document.createElement('div');
    expandControls.className = 'context-expand-controls';
    expandControls.dataset.fileName = fileName;
    expandControls.dataset.startLine = startLine;
    expandControls.dataset.endLine = endLine;
    expandControls.dataset.hiddenCount = gapSize;
    expandControls.dataset.position = position;
    expandControls.dataset.isGap = 'true';

    // Create expand button
    const expandBtn = document.createElement('button');
    expandBtn.className = 'expand-button expand-all-short';
    expandBtn.title = `Expand ${gapSize} lines`;
    expandBtn.innerHTML = HunkParser.FOLD_UP_DOWN_ICON;
    expandBtn.addEventListener('click', () => expandCallback(expandControls, 'all', gapSize));
    buttonContainer.appendChild(expandBtn);
    oldLineCell.appendChild(buttonContainer);

    // Create content cell
    const contentCell = document.createElement('td');
    contentCell.className = 'diff-code expand-content clickable-expand';
    contentCell.colSpan = 2;
    contentCell.title = 'Expand all';

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'expand-content-wrapper';

    const expandIcon = document.createElement('span');
    expandIcon.className = 'expand-icon';
    expandIcon.innerHTML = HunkParser.FOLD_UP_DOWN_ICON;

    const expandInfo = document.createElement('span');
    expandInfo.className = 'expand-info';
    expandInfo.textContent = `${gapSize} hidden lines`;

    contentWrapper.appendChild(expandIcon);
    contentWrapper.appendChild(expandInfo);
    contentCell.appendChild(contentWrapper);

    contentCell.addEventListener('click', () => {
      expandCallback(expandControls, 'all', gapSize);
    });

    row.expandControls = expandControls;
    row.appendChild(oldLineCell);
    row.appendChild(newLineCell);
    row.appendChild(contentCell);

    // NOTE: Do NOT auto-expand small gaps here. This function is used by expandGapRange
    // for partial expansion, and auto-expanding those gaps would cause infinite loops.
    // Auto-expansion only happens in createGapSection for initial diff rendering.

    return row;
  }

  /**
   * Check if a gap should be auto-expanded based on size
   * @param {number} gapSize - Number of hidden lines
   * @returns {boolean} True if the gap should be auto-expanded
   */
  static shouldAutoExpand(gapSize) {
    return gapSize < HunkParser.AUTO_EXPAND_THRESHOLD;
  }
}

// Make HunkParser available globally
window.HunkParser = HunkParser;
