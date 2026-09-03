// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

/**
 * Unit tests for the GraphQL implementation of the
 * `pending_review_comments` area. These focus on `buildBatchMutation`,
 * which interpolates user-supplied values (file paths, bodies) into a
 * raw GraphQL document. Path and body must be encoded with
 * JSON.stringify so values containing quotes, backslashes, or
 * newlines do not produce a malformed mutation that fails the whole
 * batch.
 */

const graphqlImpl = require('../../../../../src/github/impl/graphql/pending-review-comments');
const { buildBatchMutation, toDiffSide } = graphqlImpl;

/**
 * Collapse runs of whitespace so a mutation can be asserted as a field
 * SEQUENCE without pinning the document's indentation. Field ORDER is what
 * these assertions care about: `startLine`/`startSide` must travel together and
 * describe the same endpoint.
 */
const flat = (mutation) => mutation.replace(/\s+/g, ' ').trim();

/**
 * Pull out the GraphQL string literal that follows a given field
 * name in the mutation text. Returns the raw literal as it appears
 * in the document (including the surrounding double quotes). Used so
 * tests can JSON.parse it and confirm the embedded value round-trips
 * back to the original input.
 */
function extractStringLiteral(mutation, fieldName) {
  // Matches: <fieldName>: "<contents>" where <contents> is any
  // sequence of non-quote chars or escaped chars (\\, \", \uXXXX, ...).
  const re = new RegExp(`${fieldName}:\\s*("(?:\\\\.|[^"\\\\])*")`);
  const match = mutation.match(re);
  if (!match) {
    throw new Error(`Could not find ${fieldName} string literal in mutation:\n${mutation}`);
  }
  return match[1];
}

describe('impl/graphql/pending-review-comments', () => {
  describe('buildBatchMutation', () => {
    it('produces a working mutation for a normal path (regression guard)', () => {
      const mutation = buildBatchMutation([
        { path: 'src/foo.js', line: 10, side: 'RIGHT', body: 'looks good' }
      ]);

      expect(mutation).toContain('comment0: addPullRequestReviewThread');
      expect(mutation).toContain('path: "src/foo.js"');
      expect(mutation).toContain('body: "looks good"');
      expect(mutation).toContain('line: 10');
      expect(mutation).toContain('side: RIGHT');

      // The interpolated path should be a valid JSON string literal.
      const pathLiteral = extractStringLiteral(mutation, 'path');
      expect(JSON.parse(pathLiteral)).toBe('src/foo.js');
    });

    it('escapes double quotes in line-comment paths', () => {
      const weirdPath = 'weird"file.js';
      const mutation = buildBatchMutation([
        { path: weirdPath, line: 3, side: 'RIGHT', body: 'note' }
      ]);

      const pathLiteral = extractStringLiteral(mutation, 'path');
      // The literal must round-trip back to the original path via
      // JSON.parse — proving the GraphQL string is well-formed and
      // the unescaped quote did not break out of the literal.
      expect(JSON.parse(pathLiteral)).toBe(weirdPath);
      // And the raw quote must NOT appear unescaped inside the
      // literal (which would split the GraphQL string in two).
      expect(pathLiteral).toBe('"weird\\"file.js"');
    });

    it('escapes backslashes in line-comment paths', () => {
      const backslashPath = 'dir\\file.js';
      const mutation = buildBatchMutation([
        { path: backslashPath, line: 1, side: 'RIGHT', body: 'note' }
      ]);

      const pathLiteral = extractStringLiteral(mutation, 'path');
      expect(JSON.parse(pathLiteral)).toBe(backslashPath);
      expect(pathLiteral).toBe('"dir\\\\file.js"');
    });

    it('escapes newlines in line-comment paths', () => {
      const newlinePath = 'a\nb.js';
      const mutation = buildBatchMutation([
        { path: newlinePath, line: 1, side: 'RIGHT', body: 'note' }
      ]);

      const pathLiteral = extractStringLiteral(mutation, 'path');
      expect(JSON.parse(pathLiteral)).toBe(newlinePath);
      // The newline must be escaped, not raw, or the GraphQL parser
      // will reject the unterminated string literal.
      expect(pathLiteral).not.toContain('\n');
      expect(pathLiteral).toContain('\\n');
    });

    it('escapes special characters in file-level comment paths', () => {
      const weirdPath = 'weird"file\\with\nnewline.md';
      const mutation = buildBatchMutation([
        { path: weirdPath, body: 'whole file', isFileLevel: true }
      ]);

      expect(mutation).toContain('subjectType: FILE');
      const pathLiteral = extractStringLiteral(mutation, 'path');
      expect(JSON.parse(pathLiteral)).toBe(weirdPath);
      // Sanity-check: no raw control characters or unescaped quotes
      // inside the literal.
      expect(pathLiteral).not.toContain('\n');
      const innerLiteral = pathLiteral.slice(1, -1); // strip the surrounding quotes
      // Every unescaped char must not be a bare double-quote.
      // Walk the literal and verify no unescaped quote remains.
      let i = 0;
      while (i < innerLiteral.length) {
        if (innerLiteral[i] === '\\') {
          i += 2;
          continue;
        }
        expect(innerLiteral[i]).not.toBe('"');
        i++;
      }
    });

    it('still escapes quote characters inside bodies (existing behavior regression guard)', () => {
      const trickyBody = 'this has a " in it';
      const mutation = buildBatchMutation([
        { path: 'src/foo.js', line: 1, side: 'RIGHT', body: trickyBody }
      ]);

      const bodyLiteral = extractStringLiteral(mutation, 'body');
      expect(JSON.parse(bodyLiteral)).toBe(trickyBody);
    });

    /**
     * `AddPullRequestReviewThreadInput` (the published schema at
     * docs.github.com/public/fpt/schema.docs.graphql) declares FOUR positional
     * fields for a multi-line thread, and both sides default to RIGHT
     * independently:
     *
     *   line: Int        "... The end of the line range for multi-line comments."
     *   side: DiffSide = RIGHT
     *                    "... For multi-line comments, this is the side for the
     *                     end of the line range."
     *   startLine: Int   "The first line of the range to which the comment refers."
     *   startSide: DiffSide = RIGHT
     *                    "The side of the diff on which the start line resides."
     *
     * So a LEFT range that emits `side: LEFT` and no `startSide` does not ask
     * for a LEFT range — it asks for one that starts on the NEW side and ends on
     * the OLD one. These tests assert the FINAL mutation text because that is
     * the only place the omission was visible: the provider's intermediate
     * object carried `start_side` and the transport silently dropped it.
     */
    describe('multi-line ranges carry a side per endpoint', () => {
      it('emits startSide: LEFT beside startLine for a LEFT range', () => {
        const mutation = buildBatchMutation([
          { path: 'src/foo.js', line: 12, start_line: 9, side: 'LEFT', start_side: 'LEFT', body: 'old code' }
        ]);

        expect(flat(mutation)).toContain('startLine: 9 startSide: LEFT line: 12 side: LEFT');
      });

      it('emits startSide: RIGHT beside startLine for a RIGHT range', () => {
        const mutation = buildBatchMutation([
          { path: 'src/foo.js', line: 4, start_line: 2, side: 'RIGHT', start_side: 'RIGHT', body: 'new code' }
        ]);

        expect(flat(mutation)).toContain('startLine: 2 startSide: RIGHT line: 4 side: RIGHT');
      });

      it('falls back to the END side when a caller sends start_line alone', () => {
        // Older callers (and any transport-level caller that has not been
        // updated) send only `start_line`. Inheriting `side` is the only answer
        // that cannot produce a mixed-side range.
        const mutation = buildBatchMutation([
          { path: 'src/foo.js', line: 12, start_line: 9, side: 'LEFT', body: 'old code' }
        ]);

        expect(flat(mutation)).toContain('startLine: 9 startSide: LEFT line: 12 side: LEFT');
      });

      it('emits NEITHER range field for a single-line comment', () => {
        // `startSide` describes where the start line lives; with no start line
        // it describes nothing, so it is not sent at all.
        const mutation = buildBatchMutation([
          { path: 'src/foo.js', line: 7, side: 'LEFT', body: 'one line' }
        ]);

        expect(mutation).not.toContain('startLine');
        expect(mutation).not.toContain('startSide');
        expect(flat(mutation)).toContain('line: 7 side: LEFT');
      });

      it('keeps each comment in a mixed batch on its own sides', () => {
        const mutation = flat(buildBatchMutation([
          { path: 'a.js', line: 3, start_line: 1, side: 'RIGHT', start_side: 'RIGHT', body: 'added' },
          { path: 'b.js', line: 8, start_line: 6, side: 'LEFT', start_side: 'LEFT', body: 'removed' },
          { path: 'c.js', body: 'whole file', isFileLevel: true }
        ]));

        expect(mutation).toContain('startLine: 1 startSide: RIGHT line: 3 side: RIGHT');
        expect(mutation).toContain('startLine: 6 startSide: LEFT line: 8 side: LEFT');
        // The file-level thread has no coordinates at all.
        expect(mutation).toContain('subjectType: FILE');
        expect([...mutation.matchAll(/startSide:/g)]).toHaveLength(2);
      });
    });

    describe('DiffSide enum safety', () => {
      // Enum values are interpolated UNQUOTED, so unlike `path`/`body` they
      // cannot be escaped — anything but the two legal values must be coerced,
      // not passed through into the document.
      it('coerces an unknown side to RIGHT rather than injecting it', () => {
        const mutation = buildBatchMutation([
          { path: 'a.js', line: 2, start_line: 1, side: 'BOTH}) { x } #', body: 'b' }
        ]);

        expect(mutation).not.toContain('BOTH');
        expect(mutation).not.toContain('#');
        expect(flat(mutation)).toContain('startLine: 1 startSide: RIGHT line: 2 side: RIGHT');
      });

      it('maps only the two legal values, defaulting everything else to RIGHT', () => {
        expect(toDiffSide('LEFT')).toBe('LEFT');
        expect(toDiffSide('RIGHT')).toBe('RIGHT');
        expect(toDiffSide('left')).toBe('RIGHT');
        expect(toDiffSide(undefined)).toBe('RIGHT');
        expect(toDiffSide(null)).toBe('RIGHT');
      });
    });

    it('handles a mixed batch with a malicious path next to a normal one', () => {
      const mutation = buildBatchMutation([
        { path: 'src/foo.js', line: 10, side: 'RIGHT', body: 'normal' },
        { path: 'weird"file.js', line: 5, side: 'RIGHT', body: 'still works' }
      ]);

      expect(mutation).toContain('comment0:');
      expect(mutation).toContain('comment1:');

      // Pull both path literals (one per inner mutation).
      const matches = [...mutation.matchAll(/path:\s*("(?:\\.|[^"\\])*")/g)];
      expect(matches).toHaveLength(2);
      expect(JSON.parse(matches[0][1])).toBe('src/foo.js');
      expect(JSON.parse(matches[1][1])).toBe('weird"file.js');
    });
  });
});
