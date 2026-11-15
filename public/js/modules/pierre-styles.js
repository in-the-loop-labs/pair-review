// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PierreStyles - the CSS pair-review injects into the shadow root of every
 * @pierre/diffs host (the vendor's `unsafeCSS` option).
 *
 * One copy for both diff bridges: PierreBridge (one FileDiff per file) uses
 * ANNOTATION_CSS; PierreCodeViewBridge (one virtualized CodeView) uses all
 * three blocks through unsafeCSS(). Page CSS (pr.css) cannot reach into a
 * shadow root, so everything that styles vendor rows lives here.
 *
 * Wrapped in a function: this file is a classic script, and top-level
 * `const` names are shared by every script on the page.
 */
(function () {
  // Annotation CSS injected into Shadow DOM via unsafeCSS.
  // Suggestions and comments use legacy classes (.ai-suggestion, .user-comment)
  // styled by the page stylesheet. Only the comment form annotation lives
  // entirely within the shadow DOM and needs styles here.
  //
  // Split layout: @pierre/diffs anchors each annotation to ONE code column —
  // a 'deletions' annotation renders in the LEFT column, an 'additions'
  // annotation in the RIGHT column — and emits an EMPTY paired cell in the
  // opposite column on the same shared grid row (see getAnnotations()/
  // pushLineWithAnnotation in DiffHunksRenderer). A lone card would only get
  // half the width, so PierreAnnotations.applySplitAnnotationLayout marks such
  // cards with .pr-annotation-fullwidth and the rules below stretch them across
  // both content tracks (the tracks are equal 1fr shares, so 200% + the
  // measured middle-gutter width spans exactly to the far edge). min-width:0
  // lets unstretched cards (both sides annotated on one row) wrap inside their
  // half-width cell rather than force horizontal overflow.
  const ANNOTATION_CSS = `
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
    /* Split view: stretch a lone card across both columns. The class and
       --pr-split-gutter-width are maintained by _syncSplitAnnotationLayout
       (the middle gutter track is min-content sized — unknowable in pure
       CSS). Without the var the card degrades to stopping at the seam.
       z-index clears the middle gutter, which the vendor paints at 3. */
    [data-diff-type='split'] .pr-annotation-fullwidth {
      position: relative;
      z-index: 4;
      width: calc(200% + var(--pr-split-gutter-width, 0px));
    }
    /* Right-column cards anchor at the additions track; pull them back to
       the left content track's start edge. */
    [data-diff-type='split'] [data-additions] .pr-annotation-fullwidth {
      margin-left: calc(-100% - var(--pr-split-gutter-width, 0px));
    }
    /* Split view, entirely added/removed file: the vendor emits ONE code
       column stamped data-diff-type='single' and ships no rule for it, so
       it stretches full width. Box it into the split layout instead:
       deletions in the left half, additions in the right, other half empty.
       The lone <code> keeps its internal gutter+content grid, so gutter and
       content both live inside their 1fr half and can never cross the
       center seam. The :has() guard skips unified mode, where every pre is
       'single' but its code column is data-unified. */
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
    /* The vendor's [data-code] ships overflow: scroll clip AND
       contain: content. Both must be neutralized here, for different reasons:
         - overflow: scroll clip is a scroll/clip box that would clip the
           stretched cards; reset to visible (lines wrap in wrap mode, so
           there is nothing to scroll).
         - contain: content implies contain: PAINT, which clips descendant
           paint to the code column's own border box REGARDLESS of overflow.
           The .pr-annotation-fullwidth cards below reach past this box (a
           right-half card sits at margin-left: calc(-100% - 2g)), so paint
           containment would hide their left portion — header text and body —
           while the right-aligned action buttons, which fall inside the box,
           still paint (the "empty card" bug). Drop paint containment; keep
           layout+style containment (cheap, no visual effect) so the vendor's
           perf intent is mostly preserved.
       Two-sided split columns escape both: they are display: contents and
       generate no box, so neither overflow nor contain has anything to clip —
       which is why this only bites one-sided (single) files, whose columns
       ARE real boxes (display: grid children, above). */
    [data-diff-type='single'][data-overflow='wrap'] > [data-deletions],
    [data-diff-type='single'][data-overflow='wrap'] > [data-additions] {
      overflow: visible;
      contain: layout style;
    }
    /* One-sided file: every card is lone, stretch across both halves.
       Geometry (g = the file's own gutter, published by
       _applySplitAnnotationLayout as --pr-split-gutter-width; 100% = the
       content track = half minus g): a left-half card starts after its
       gutter, so 200% + g reaches the far edge; a right-half card must
       also cross the empty left half AND its own gutter — shift back by
       100% + 2g and span 200% + 2g. */
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

  /**
   * Makes a file-level (lineNumber 0) annotation on a ROW-LESS item (binary,
   * mode-only, pure rename, empty file) measure correctly under CodeView.
   *
   * The vendor keeps 8 px of bottom padding below the code area and only
   * counts it when the item has rows. With an annotation but no rows the DOM
   * is 8 px taller than the vendor's layout (contract: layout.spec.js, F10).
   *
   * Two things make the selector more than "code without lines":
   *
   *  - The padding is on a different element per diff style: `code[data-code]`
   *    in unified (pre is a block), `pre[data-diff]` in split (pre is the grid
   *    and code is display: contents). Hence two rules.
   *  - An ordinary item is sometimes mounted with NO rows in its rendered
   *    window (a header-only mount at the edge of the viewport). There the
   *    vendor DOES count the 8 px, so the rule must not match. Such a mount
   *    renders no annotation wrapper either, while a row-less item with a
   *    file-level annotation always has one. Hence `:has([data-line-annotation])`.
   */
  const ROWLESS_FIX = [
    '[data-code]:has([data-line-annotation]):not(:has([data-line])) { padding-bottom: 0 !important; }',
    'pre[data-diff]:has([data-line-annotation]):not(:has([data-line])) { padding-bottom: 0 !important; }',
  ].join('\n');

  /**
   * Context files (files outside the diff, shown as ranges of lines) are
   * CodeView items whose metadata is one-sided (`type: 'new'`), so that split
   * layout draws ONE column and not the same lines twice. Every rule is
   * scoped to `:host(.context-file)`; the bridge stamps that class on the
   * host of a record of kind 'context', so no changed file is affected.
   *
   * The block does three things:
   *
   *  1. Shows the vendor's own "Expand all" control. The vendor renders it for
   *     every gap larger than expansionLineCount and hides it; shown, a plain
   *     click reveals the whole gap, which is what a context file's "N hidden
   *     lines" label did before.
   *  2. Undoes ANNOTATION_CSS's "box a one-sided file into its half" rules
   *     for a context host: the one column is the whole width, in split
   *     layout too.
   *  3. Gives the separators of the lone `code[data-additions]` column the
   *     controls and the width the unified column's separators have. (In a
   *     two-column split the vendor draws them in the deletions column and
   *     hides them here.)
   *
   * It depends on the vendor's separator markup, which is not API
   * ([data-separator-wrapper], [data-separator-content], [data-expand-button],
   * [data-expand-all-button]); the version is pinned and
   * tests/contract/vendor/context-items.spec.js and gate G13 click every
   * control in both layouts with the height validator on. These rules must
   * keep winning against ANNOTATION_CSS's one-sided rules above: edit the two
   * together.
   */
  const CONTEXT_CSS = `
/* One-click whole-gap expansion, which main's context files have ("N hidden lines" is a button there).
   The vendor renders an "Expand all" control for every gap larger than expansionLineCount and hides it. */
:host(.context-file) [data-gutter] [data-separator='line-info'][data-expand-index] [data-separator-wrapper] { grid-template-columns: 34px 1fr max-content !important; }
:host(.context-file) [data-gutter] [data-separator] [data-expand-button][data-expand-all-button] {
  display: flex !important; grid-column: 3 !important; grid-row: 1 / -1 !important;
  padding-inline: 1.5ch; white-space: nowrap; border-right: 0; border-left: 2px solid var(--diffs-bg);
  border-top-right-radius: 6px; border-bottom-right-radius: 6px;
}
:host(.context-file) [data-gutter] [data-separator] [data-separator-wrapper]:has([data-expand-all-button]) [data-separator-content] { border-top-right-radius: 0 !important; border-bottom-right-radius: 0 !important; }
/* Split layout. A context item's metadata is one-sided (type 'new'), so the vendor emits ONE column,
   code[data-additions]. Undo the app's own "box a one-sided file into its half" rule for it ... */
:host(.context-file) [data-diff-type='single']:has(> [data-additions]) { display: block !important; }
:host(.context-file) [data-diff-type='single'] > [data-additions] { border-left: 0 !important; }
:host(.context-file) [data-diff-type='single'] [data-additions] .pr-annotation-fullwidth { width: auto !important; margin-left: 0 !important; }
/* ... and give its separators what the unified column's separators have: the controls live in the gutter
   cell's wrapper, which spans the whole column. */
:host(.context-file) [data-additions] [data-gutter] [data-separator='line-info'] [data-separator-wrapper] {
  display: grid !important; width: 100cqi; height: 100%;
  padding-inline: var(--diffs-gap-inline, var(--diffs-gap-fallback));
  background-color: var(--diffs-bg) !important; border-radius: 0 !important;
}
:host(.context-file) [data-additions] [data-gutter] [data-separator='line-info'] [data-separator-wrapper] [data-separator-content] { display: flex !important; border-top-right-radius: 6px; border-bottom-right-radius: 6px; }
:host(.context-file) [data-additions] [data-gutter] [data-separator='line-info'] [data-separator-wrapper] [data-expand-button]:not([data-expand-all-button]) { display: flex !important; }
:host(.context-file) [data-additions] [data-content] [data-separator='line-info'] [data-separator-wrapper] { display: none !important; }
`;

  const PierreStyles = {
    ANNOTATION_CSS,
    ROWLESS_FIX,
    CONTEXT_CSS,
    /** Everything the CodeView bridge passes as `unsafeCSS`, in cascade order. */
    unsafeCSS() {
      return [ANNOTATION_CSS, ROWLESS_FIX, CONTEXT_CSS].join('\n');
    },
  };

  if (typeof window !== 'undefined') window.PierreStyles = PierreStyles;
  if (typeof module !== 'undefined') module.exports = PierreStyles;
})();
