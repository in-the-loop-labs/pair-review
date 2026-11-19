// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Keeps a file header at the same viewport position across a synchronous
 * change that resizes its file, such as collapsing it.
 *
 * A header stuck to the top of the diff pane belongs to a file the reader is
 * partway through. Collapsing that file shrinks it to just the header, which
 * would leave the header far above the viewport. Scrolling the pane by however
 * far the header moved puts the collapsed header back where it was stuck, with
 * the next file directly below it. A header that wasn't stuck doesn't move, so
 * nothing scrolls.
 *
 * @param {Element|null} header - The file header to hold in place
 * @param {() => T} change - Synchronous change that resizes the header's file
 * @returns {T} the change's return value
 * @template T
 */
function keepHeaderInPlace(header, change) {
  if (!header) return change();

  const topBefore = header.getBoundingClientRect().top;
  const result = change();
  const shift = header.getBoundingClientRect().top - topBefore;

  if (shift !== 0) {
    header.closest('.diff-view')?.scrollBy(0, shift);
  }

  return result;
}

if (typeof window !== 'undefined') {
  window.HeaderAnchor = { keepHeaderInPlace };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { keepHeaderInPlace };
}
