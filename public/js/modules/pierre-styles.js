// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * PierreStyles - the CSS pair-review injects into the shadow root of every
 * @pierre/diffs host (the vendor's `unsafeCSS` option).
 *
 * One copy for both diff bridges: PierreBridge (one FileDiff per file) uses
 * ANNOTATION_CSS; PierreCodeViewBridge (one virtualized CodeView) uses every
 * block through unsafeCSS(). Page CSS (pr.css) cannot reach into a
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

  /**
   * What the viewer is told a file's code block has below its last row
   * (`itemMetrics.paddingBottom`): the vendor's own 8 px and the 1 px bottom
   * border FRAME_CSS adds. The viewer counts it for every item that has a
   * line and for no other, and it is one number for every item, so FRAME_CSS
   * must make it true for changed files and for context files alike.
   */
  const ITEM_PADDING_BOTTOM = 9;

  /**
   * The frame of a file under the virtualized viewer: what the per-file
   * renderer's `.pierre-diff-body` (pr.css) draws around a file's lines, a
   * 1 px border left, right and below with 6 px bottom corners. There the
   * body is an element of the page around the vendor's host; here the host is
   * the file, so the frame is on the code block inside it.
   *
   *  - Left and right borders add no height. The bottom border adds 1 px,
   *    which the viewer is told (ITEM_PADDING_BOTTOM). The colour is the
   *    page's; the 1 px must be there on a page that does not define it, so
   *    the colour has a fallback.
   *  - A file without a line has no bottom padding in the viewer's layout
   *    (and ROWLESS_FIX removes the vendor's), so it gets no bottom border
   *    either; pr.css draws its 1 px line in the file's comment zone, which
   *    the viewer measures.
   *    Such a file has no code background either: what it shows (its
   *    comments, a notice, that line) is on the pane, as on the other engine.
   *    Its side borders keep their width (the comment zone's row is sized
   *    with it, ZONE_CSS) and are not drawn: beside a notice or the 1 px
   *    line they would be two strokes the other engine does not have.
   *  - A context file has no frame on the other engine and none here; its
   *    bottom border is transparent, because the 1 px is counted for it too.
   *  - The viewer paints its host and its sticky header's box with the code
   *    background. The page's header has rounded top corners and the pane
   *    shows through them, also while the header is pinned over the code;
   *    and the frame's translucent border is over the pane.
   *  - The row of a file-level annotation (the file's comment zone, a notice)
   *    is painted like a context line by the viewer. On the per-file renderer
   *    those are elements of the page above the code block, on the code
   *    background; the 8 px pr.css puts under the zone are the code block's
   *    top padding there.
   *  - Nothing clips the code block. The per-file renderer's body clips its
   *    rows at the rounded corners (`overflow-x: auto`); here nothing a file
   *    draws reaches them: its rows end 8 px above the bottom border (the
   *    code block's bottom padding, 6 px corners), the code columns have no
   *    background of their own (ZONE_CSS) and the block's own background is
   *    clipped to its rounded padding box. A clip is left out on purpose:
   *    `overflow: clip` cuts at the padding box, and the file's comment zone
   *    is drawn over the frame's side borders (ZONE_CSS); `clip-path` is
   *    anti-aliased at a fractional offset and thins the bottom border
   *    (measured: 246 for 232 of 255 on a file 441.67 px tall). What the
   *    body's clip does for the cards under lines, ZONE_CSS does per card.
   *  - The border colour is translucent. The body has no background of its
   *    own, so its border is over the pane; `background-clip: padding-box`
   *    keeps the code background from under this one, for the same pixels.
   */
  const FRAME_CSS = `
:host(:not(.context-file)) pre[data-diff] {
  border: 1px solid var(--color-border-default, transparent);
  border-top: 0;
  border-radius: 0 0 6px 6px;
  background-clip: padding-box;
}
[data-line-annotation='-1,-1'],
[data-gutter] > [data-gutter-buffer='annotation']:first-child { background-color: var(--diffs-bg) !important; }
:host(.context-file) pre[data-diff] { border-bottom: 1px solid transparent; }
pre[data-diff]:has([data-line-annotation]):not(:has([data-line])) { border-bottom: 0 !important; border-color: transparent !important; }
pre[data-diff]:has([data-line-annotation]):not(:has([data-line])) { background-color: transparent !important; }
pre[data-diff]:has([data-line-annotation]):not(:has([data-line])) * { background-color: transparent !important; border-color: transparent !important; }
[data-diffs-header] { background-color: transparent !important; }
:host { background-color: transparent !important; }
`;

  /**
   * The file's comment zone under the virtualized viewer spans the file from
   * edge to edge, as it does on the per-file renderer, where it is an element
   * of the page between the header and the code block: as wide as the file,
   * over the line-number column and outside the frame's side borders.
   *
   * Here the zone is the item's first annotation (line 0), so the viewer
   * draws its row in the code's content column: to the right of the
   * line-number column and between the frame's borders. These rules stretch
   * that one row. They add no height.
   *
   * What each layout needs (b = the frame's side border, 1 px on a changed
   * file and 0 on a context file, set here as --pr-frame-inline;
   * g = --pr-split-gutter-width, published together with the
   * .pr-annotation-fullwidth class by
   * PierreAnnotations.applySplitAnnotationLayout):
   *
   *  - Unified, and a context file in either layout: the row ends at the
   *    right edge of the one code column, which is a size container, so its
   *    width is known without knowing the line-number column's
   *    (100cqw = the column's content box). The column is a scroll container
   *    with paint containment and clips at its padding box, so on a changed
   *    file it is widened by b on both sides (a negative margin and the same
   *    padding: its rows stay where they are) to reach under the frame's
   *    borders.
   *  - Split, a two-sided file: the columns generate no box, the <pre> is
   *    the four-track grid, and the row is in the last track. From the
   *    row's own width (100%) and g: the first number track is g minus the
   *    1 px seam border the second one carries.
   *  - Split, an entirely added or removed file: ANNOTATION_CSS boxes the
   *    lone column into its half; each half is 1 px of seam border, g and
   *    the content track.
   *
   * The row is transparent: under it are the line-number column's buffer
   * cell, the paired empty cell and the frame's borders, which show beside
   * the 8 px pr.css puts under the zone's content (they are the code
   * block's own top padding on the per-file renderer). The zone's content
   * has its own background (pr.css). z-index 4 is above the line-number
   * column, which the vendor paints at 3.
   *
   * The code columns of a changed file have no background of their own:
   * the <pre>'s is behind them, clipped to its padding box, so the widened
   * column does not paint over the frame's translucent borders.
   *
   * With the zone over the frame's borders the code block can no longer
   * clip at its padding box (FRAME_CSS), which is what kept a card's
   * outline off the frame on the right: an annotation's row ends at the
   * frame's inner edge, and a card that fills it and draws around itself
   * (the active tour stop's 2 px ring) would paint over the border and past
   * the file. Every annotation's content except line 0's is therefore
   * clipped at its own right edge, and nowhere else: on the left the
   * per-file renderer shows such a ring over the line-number column in
   * split layout, and above and below nothing clips there either.
   *
   * Depends on vendor markup that is not API ([data-line-annotation='-1,-1']
   * for the row of line 0, [data-unified], [data-additions], [data-deletions],
   * [data-content]); tests/parity/visual.mjs measures the zone against the
   * per-file renderer in every layout these rules name.
   */
  const ZONE_CSS = `
:host(:not(.context-file)) pre[data-diff] { --pr-frame-inline: 1px; }
:host(:not(.context-file)) pre[data-diff] > code { background-color: transparent; }
:host(:not(.context-file)) pre[data-diff] > code[data-unified] { margin-inline: -1px; padding-inline: 1px; }
pre[data-diff] [data-unified] > [data-content] > [data-line-annotation='-1,-1'],
:host(.context-file) pre[data-diff] [data-additions] > [data-content] > [data-line-annotation='-1,-1'] {
  z-index: 4;
  width: calc(100cqw + 2 * var(--pr-frame-inline, 0px)) !important;
  margin-left: calc(100% - 100cqw - var(--pr-frame-inline, 0px)) !important;
  background-color: transparent !important;
}
:host(:not(.context-file)) [data-line-annotation]:not([data-line-annotation='-1,-1']) > [data-annotation-content] { clip-path: inset(-10000px 0 -10000px -10000px); }
[data-diff-type='split'] [data-additions] [data-line-annotation='-1,-1'].pr-annotation-fullwidth,
:host(:not(.context-file)) [data-diff-type='single'] [data-line-annotation='-1,-1'].pr-annotation-fullwidth { background-color: transparent !important; }
[data-diff-type='split'] [data-additions] [data-line-annotation='-1,-1'].pr-annotation-fullwidth {
  width: calc(200% + 2 * var(--pr-split-gutter-width, 0px) - 1px + 2 * var(--pr-frame-inline, 0px));
  margin-left: calc(-100% - 2 * var(--pr-split-gutter-width, 0px) + 1px - var(--pr-frame-inline, 0px));
}
:host(:not(.context-file)) [data-diff-type='single'] [data-additions] [data-line-annotation='-1,-1'].pr-annotation-fullwidth {
  width: calc(200% + 2 * var(--pr-split-gutter-width, 0px) + 2px + 2 * var(--pr-frame-inline, 0px));
  margin-left: calc(-100% - 2 * var(--pr-split-gutter-width, 0px) - 2px - var(--pr-frame-inline, 0px));
}
:host(:not(.context-file)) [data-diff-type='single'] [data-deletions] [data-line-annotation='-1,-1'].pr-annotation-fullwidth {
  width: calc(200% + 2 * var(--pr-split-gutter-width, 0px) + 2px + 2 * var(--pr-frame-inline, 0px));
  margin-left: calc(-1 * var(--pr-split-gutter-width, 0px) - var(--pr-frame-inline, 0px));
}
`;

  const PierreStyles = {
    ANNOTATION_CSS,
    ROWLESS_FIX,
    CONTEXT_CSS,
    FRAME_CSS,
    ZONE_CSS,
    ITEM_PADDING_BOTTOM,
    /** Everything the CodeView bridge passes as `unsafeCSS`, in cascade order. */
    unsafeCSS() {
      return [ANNOTATION_CSS, ROWLESS_FIX, CONTEXT_CSS, FRAME_CSS, ZONE_CSS].join('\n');
    },
  };

  if (typeof window !== 'undefined') window.PierreStyles = PierreStyles;
  if (typeof module !== 'undefined') module.exports = PierreStyles;
})();
