// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PierreGutter - the two buttons (chat, comment) that follow the hovered line
 * of a diff, for the CodeView bridge.
 *
 * The viewer calls the bridge's `renderGutterUtility` on every render of an
 * item and slots the element it gets into the hovered row's gutter cell. The
 * bridge keeps ONE container per item (an element can live in one host only)
 * and hands the same one back each time.
 *
 * The container needs its own stacking: the viewer's slot wrapper is
 * absolutely positioned inside the gutter cell, and without a z-index on the
 * slotted element the cell's line number is on top of it and takes the click
 * (which then starts a line selection). pr.css gives `.pierre-gutter-buttons`
 * `position: absolute; z-index: 20; pointer-events: auto`; that rule must
 * stay.
 *
 * Wrapped in a function: this file is a classic script, and top-level
 * `const` names are shared by every script on the page.
 */
(function () {
  /** Chat button SVG icon (GitHub-style speech bubble). */
  const CHAT_SVG = `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z"/></svg>`;

  /**
   * What a click on a gutter button applies to.
   *
   * Rules:
   *  - If a multi-line range is selected AND the button is over a line inside
   *    that range (same side), the action applies to the range and the
   *    selection is cleared.
   *  - If a multi-line range is selected but the button has moved to a line
   *    OUTSIDE it, the range is cancelled and the action applies to the single
   *    hovered line.
   *  - Otherwise the action applies to the single hovered line.
   *
   * Sides are the app's ('LEFT' | 'RIGHT').
   *
   * @param {{lineNumber: number, side: string}|null} hovered - the hovered row
   * @param {{start: number, end: number, side: string}|null} selection - the
   *   file's line selection
   * @returns {{target: {start: number, end: number, side: string, isRange: boolean}|null, clearSelection: boolean}}
   */
  function resolveClickTarget(hovered, selection) {
    let clearSelection = false;
    if (selection && selection.start !== selection.end) {
      const inRange = !!hovered
        && hovered.side === selection.side
        && hovered.lineNumber >= selection.start
        && hovered.lineNumber <= selection.end;
      // Either the range is consumed or it is cancelled: cleared in both cases.
      clearSelection = true;
      if (inRange) {
        return {
          target: { start: selection.start, end: selection.end, side: selection.side, isRange: true },
          clearSelection,
        };
      }
      // Fall through to the single hovered line.
    }
    if (!hovered) return { target: null, clearSelection };
    return {
      target: { start: hovered.lineNumber, end: hovered.lineNumber, side: hovered.side, isRange: false },
      clearSelection,
    };
  }

  /**
   * Build the gutter buttons of one item.
   *
   * @param {Object} deps
   * @param {Function} deps.getHoveredRow - () => { lineNumber, side: 'LEFT'|'RIGHT' } | null,
   *   the row the viewer reports as hovered, in the app's sides
   * @param {Function} deps.getLineSelection - () => { start, end, side } | null
   * @param {Function} deps.clearLineSelection - () => void
   * @param {Function} deps.selectLines - (start, end, side) => void; side is 'LEFT'|'RIGHT'
   * @param {Function} [deps.onChatClick] - (start, side, target) => void; no
   *   chat button without it
   * @param {Function} [deps.onCommentClick] - (start, side, target) => void
   * @returns {HTMLElement}
   */
  function createGutterButtons({ getHoveredRow, getLineSelection, clearLineSelection, selectLines, onChatClick, onCommentClick, commentTitle }) {
    const container = document.createElement('div');
    container.className = 'pierre-gutter-buttons';
    // Marks the element as a utility so the viewer recognizes it in pointer path checks.
    container.setAttribute('data-utility-button', '');

    const clickTarget = () => {
      const { target, clearSelection } = resolveClickTarget(getHoveredRow(), getLineSelection());
      if (clearSelection) clearLineSelection();
      return target;
    };

    // Wire a gutter button so that:
    //  - A plain click triggers the action for the hovered line (or the
    //    selected range).
    //  - Press-and-drag creates a multi-line selection (same UX as dragging
    //    from a line number) WITHOUT triggering the action on release.
    //
    // Why this is needed: the viewer cannot start a line selection from a
    // button press, because `data-code` is missing from the composed path
    // through the shadow DOM slot. So the drag is implemented here, through
    // the viewer's own selection API. pointerdown is stopped so the viewer
    // does not interfere, and a drag is remembered to suppress the click that
    // fires when the button, following the hover, ends up under the pointer
    // at the release point.
    const wrapButton = (btn, handler) => {
      let dragInfo = null;

      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const hovered = getHoveredRow();
        if (!hovered) return;
        dragInfo = {
          startLine: hovered.lineNumber,
          side: hovered.side,
          pointerId: e.pointerId,
          dragged: false,
        };

        const onMove = (me) => {
          if (!dragInfo || me.pointerId !== dragInfo.pointerId) return;
          const cur = getHoveredRow();
          if (!cur || cur.lineNumber === dragInfo.startLine) return;
          dragInfo.dragged = true;
          selectLines(
            Math.min(dragInfo.startLine, cur.lineNumber),
            Math.max(dragInfo.startLine, cur.lineNumber),
            dragInfo.side
          );
        };

        const onUp = (ue) => {
          if (!dragInfo || ue.pointerId !== dragInfo.pointerId) return;
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          document.removeEventListener('pointercancel', onUp);
          // dragInfo.dragged is consumed by the click handler below.
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        // Touch and pen pointers can be cancelled by the OS (edge gestures,
        // palm rejection), in which case no pointerup fires.
        document.addEventListener('pointercancel', onUp);
      });

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!dragInfo) return;        // no pointerdown on this button (a line-number drag ended here)
        if (dragInfo.dragged) {       // the click that ends a drag started on the button
          dragInfo = null;
          return;
        }
        dragInfo = null;
        const target = clickTarget();
        if (!target) return;
        handler(target);
      };
    };

    // Chat button (left)
    if (onChatClick) {
      const chatBtn = document.createElement('button');
      chatBtn.className = 'pierre-gutter-btn pierre-chat-btn';
      chatBtn.title = 'Chat about this line';
      chatBtn.innerHTML = CHAT_SVG;
      wrapButton(chatBtn, (target) => onChatClick(target.start, target.side, target));
      container.appendChild(chatBtn);
    }

    // Comment button (right)
    const commentBtn = document.createElement('button');
    commentBtn.className = 'pierre-gutter-btn pierre-comment-btn';
    commentBtn.title = commentTitle || 'Add comment';
    commentBtn.textContent = '+';
    wrapButton(commentBtn, (target) => {
      if (onCommentClick) onCommentClick(target.start, target.side, target);
    });
    container.appendChild(commentBtn);

    return container;
  }

  const PierreGutter = { CHAT_SVG, resolveClickTarget, createGutterButtons };

  if (typeof window !== 'undefined') window.PierreGutter = PierreGutter;
  if (typeof module !== 'undefined') module.exports = PierreGutter;
})();
