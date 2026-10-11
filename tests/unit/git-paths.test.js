// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const serverGitPaths = require('../../src/utils/git-paths');
const browserGitPaths = require('../../public/js/utils/git-paths.js');
const { parseDiffGitPaths: diffFileContentParse } = require('../../src/utils/diff-file-content');
const {
  DECODE_CASES,
  DIFF_HEADER_CASES,
  MALFORMED_DIFF_HEADERS,
  PATCH_PATH_CASES,
  B_SLASH_RENAME_DIFF
} = require('../utils/git-path-fixtures');

const { decodeGitPath, parseDiffGitPaths, parsePatchPaths, quoteGitPath, decodeDiffLinePath, splitNulPaths } = serverGitPaths;

describe('git-paths: one decoder for server and browser', () => {
  it('the server re-exports the browser module rather than a copy', () => {
    expect(serverGitPaths.decodeGitPath).toBe(browserGitPaths.decodeGitPath);
    expect(serverGitPaths.parseDiffGitPaths).toBe(browserGitPaths.parseDiffGitPaths);
    expect(serverGitPaths.parsePatchPaths).toBe(browserGitPaths.parsePatchPaths);
    expect(diffFileContentParse).toBe(browserGitPaths.parseDiffGitPaths);
  });
});

describe('decodeGitPath', () => {
  it.each(DECODE_CASES)('decodes %s', (raw, decoded) => {
    expect(decodeGitPath(raw)).toBe(decoded);
  });

  it('returns non-string input unchanged', () => {
    expect(decodeGitPath(null)).toBeNull();
    expect(decodeGitPath(undefined)).toBeUndefined();
  });

  it('returns a lone quote character unchanged', () => {
    expect(decodeGitPath('"')).toBe('"');
  });
});

describe('parseDiffGitPaths', () => {
  it.each(DIFF_HEADER_CASES)('parses %s', (header, oldPath, newPath) => {
    expect(parseDiffGitPaths(header)).toEqual({ oldPath, newPath });
  });

  it.each(MALFORMED_DIFF_HEADERS)('rejects %s', header => {
    expect(parseDiffGitPaths(header)).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseDiffGitPaths(null)).toBeNull();
  });
});

describe('parsePatchPaths', () => {
  it.each(PATCH_PATH_CASES)('resolves %j', (patch, oldPath, newPath) => {
    expect(parsePatchPaths(patch)).toEqual({ oldPath, newPath });
  });

  it.each(DIFF_HEADER_CASES)('agrees with parseDiffGitPaths for a header without rename lines: %s', (header, oldPath, newPath) => {
    expect(parsePatchPaths(`${header}\nindex 1111111..2222222 100644\n@@ -1 +1 @@\n-a\n+b\n`))
      .toEqual({ oldPath, newPath });
  });

  it('reads a patch out of the whole diff\'s lines from a start index', () => {
    const lines = B_SLASH_RENAME_DIFF.split('\n');
    // The first file is a pure rename; its extended header ends at the next diff --git
    expect(parsePatchPaths(lines, 0)).toEqual({ oldPath: 'p b/q.js', newPath: 'r b/s.js' });
    expect(parsePatchPaths(lines, 4)).toEqual({ oldPath: 'x b/y.js', newPath: 'z.js' });
  });

  it('does not read rename lines from the next file', () => {
    const lines = ['diff --git a/a.js b/a.js', ...B_SLASH_RENAME_DIFF.split('\n')];
    expect(parsePatchPaths(lines, 0)).toEqual({ oldPath: 'a.js', newPath: 'a.js' });
  });

  it('returns null when the patch does not start with a git header', () => {
    expect(parsePatchPaths('@@ -1 +1 @@\n-a\n+b\n')).toBeNull();
    expect(parsePatchPaths('')).toBeNull();
    expect(parsePatchPaths(null)).toBeNull();
    expect(parsePatchPaths(['--- a/x', '+++ b/x'], 0)).toBeNull();
  });
});

describe('quoteGitPath', () => {
  it('leaves plain, spaced and non-ASCII paths unquoted (core.quotePath=false)', () => {
    for (const name of ['src/a.js', 'dir with space/a b.js', 'café.js', '日本語.txt', 'emoji-😀.md', 'a => b.md']) {
      expect(quoteGitPath(name)).toBe(name);
    }
  });

  it('quotes control characters, DEL, quotes and backslashes the way git does', () => {
    // Verbatim from `git -c core.quotePath=false diff` (see git-path-fixtures)
    expect(quoteGitPath('a/quo"te.js')).toBe(String.raw`"a/quo\"te.js"`);
    expect(quoteGitPath('a/back\\slash.js')).toBe(String.raw`"a/back\\slash.js"`);
    expect(quoteGitPath('a/tab\tname.js')).toBe(String.raw`"a/tab\tname.js"`);
    expect(quoteGitPath('del\x7f.js')).toBe(String.raw`"del\177.js"`);
    expect(quoteGitPath('ctl\x01.js')).toBe(String.raw`"ctl\001.js"`);
    expect(quoteGitPath('b/café "x".js')).toBe(String.raw`"b/café \"x\".js"`);
  });

  it('round-trips through decodeGitPath', () => {
    for (const name of ['café.js', 'tab\tname', 'quo"te', 'back\\slash', 'nl\nname', 'bell\x07', 'emoji-😀.md']) {
      expect(decodeGitPath(quoteGitPath(name))).toBe(name);
    }
  });
});

describe('decodeDiffLinePath', () => {
  it('strips the prefix and the trailing tab git adds to paths with spaces', () => {
    expect(decodeDiffLinePath('b/x b/y.js\t', 'b/')).toBe('x b/y.js');
    expect(decodeDiffLinePath('a/src/a.js', 'a/')).toBe('src/a.js');
  });

  it('decodes quoted paths before stripping the prefix', () => {
    expect(decodeDiffLinePath(String.raw`"b/\303\261ew dir/moved \303\251.js"` + '\t', 'b/')).toBe('ñew dir/moved é.js');
    expect(decodeDiffLinePath(String.raw`"a/quo\"te.js"`, 'a/')).toBe('quo"te.js');
  });

  it('returns null for /dev/null', () => {
    expect(decodeDiffLinePath('/dev/null', 'a/')).toBeNull();
  });

  it('decodes rename from / rename to values without a prefix', () => {
    expect(decodeDiffLinePath(String.raw`"\303\261ew dir/moved \303\251.js"`)).toBe('ñew dir/moved é.js');
    expect(decodeDiffLinePath('totally/different.txt')).toBe('totally/different.txt');
  });

  it('leaves a path without the prefix intact', () => {
    expect(decodeDiffLinePath('file.js', 'b/')).toBe('file.js');
  });
});

describe('splitNulPaths', () => {
  it('splits NUL-terminated output verbatim', () => {
    expect(splitNulPaths('café.js\0 lead.js\0new\nline.js\0a => b.md\0')).toEqual([
      'café.js', ' lead.js', 'new\nline.js', 'a => b.md'
    ]);
  });

  it('handles empty and missing output', () => {
    expect(splitNulPaths('')).toEqual([]);
    expect(splitNulPaths(undefined)).toEqual([]);
  });
});
