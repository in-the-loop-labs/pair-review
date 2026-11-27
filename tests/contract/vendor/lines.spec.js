// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Vendor contract: the text of a parsed line.
 *
 * Fact (plans/codeview-virtualized-diff.md, "Vendor facts"):
 *   F32  the lines a parse gives (`additionLines`, `deletionLines`) keep their
 *        line ending: "\n", or "\r\n" for a file with Windows line endings.
 *        `parsePatchFiles` gives the lines of the hunks (`isPartial: true`);
 *        `parseDiffFromFile` gives the whole file, line n at index n - 1
 *        (`isPartial: false`).
 *
 * Depends on it: PierreBridge.getCodeFromLines, which builds the block the
 * suggestion button inserts. It strips each line's ending before joining
 * the lines with "\n" (a block of three lines is three lines, with no empty
 * line between them; ledger H181), and reads a line outside the hunks from
 * the full contents, by its number, only when the metadata is not partial.
 */

import { test, expect } from '../harness/contract-test.js';

const PATCH = (eol) => [
  'diff --git a/a.js b/a.js',
  'index 1111111..2222222 100644',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -1,4 +1,5 @@',
  ' one',
  '-two',
  '+TWO',
  '+two-and-a-half',
  ' three',
  ' four',
  '',
].join(eol);

test('F32: parsePatchFiles keeps each line\'s ending, "\\n" or "\\r\\n"', async ({ harness }) => {
  const page = await harness.open();
  const result = await page.evaluate(({ lf, crlf }) => {
    const P = window.PierreDiffs;
    const parse = (patch) => {
      const diff = P.parsePatchFiles(patch)[0].files[0];
      return {
        isPartial: diff.isPartial,
        additionLines: diff.additionLines,
        deletionLines: diff.deletionLines,
        hunk: { additionLineIndex: diff.hunks[0].additionLineIndex, additionStart: diff.hunks[0].additionStart },
      };
    };
    return { lf: parse(lf), crlf: parse(crlf) };
  }, { lf: PATCH('\n'), crlf: PATCH('\r\n') });

  expect(result.lf).toEqual({
    isPartial: true,
    additionLines: ['one\n', 'TWO\n', 'two-and-a-half\n', 'three\n', 'four\n'],
    deletionLines: ['one\n', 'two\n', 'three\n', 'four\n'],
    hunk: { additionLineIndex: 0, additionStart: 1 },
  });
  expect(result.crlf.isPartial).toBe(true);
  expect(result.crlf.additionLines).toEqual(['one\r\n', 'TWO\r\n', 'two-and-a-half\r\n', 'three\r\n', 'four\r\n']);
  expect(result.crlf.deletionLines).toEqual(['one\r\n', 'two\r\n', 'three\r\n', 'four\r\n']);
});

test('F32: parseDiffFromFile holds the whole file, line n at index n - 1, each with its ending', async ({ harness }) => {
  const page = await harness.open();
  const result = await page.evaluate(() => {
    const P = window.PierreDiffs;
    const lines = Array.from({ length: 25 }, (_, i) => `l${i + 1}`);
    const changed = lines.map((line, i) => (i === 1 ? 'L2' : line));
    const diff = P.parseDiffFromFile(
      { name: 'a.js', contents: `${lines.join('\n')}\n` },
      { name: 'a.js', contents: `${changed.join('\n')}\n` }
    );
    const crlf = P.parseDiffFromFile(
      { name: 'b.js', contents: 'one\r\ntwo\r\n' },
      { name: 'b.js', contents: 'one\r\nTWO\r\n' }
    );
    return {
      isPartial: diff.isPartial,
      count: diff.additionLines.length,
      first: diff.additionLines.slice(0, 3),
      line20: diff.additionLines[19],
      last: diff.additionLines[24],
      crlf: crlf.additionLines,
    };
  });

  expect(result).toEqual({
    isPartial: false,
    count: 25,
    first: ['l1\n', 'L2\n', 'l3\n'],
    line20: 'l20\n',
    last: 'l25\n',
    crlf: ['one\r\n', 'TWO\r\n'],
  });
});
