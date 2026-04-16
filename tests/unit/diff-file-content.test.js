// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const {
  findFileBlobInfoInDiff,
  parseDiffGitPaths,
  resolveOriginalFileContentSpecs,
  resolveOriginalFileContentSpec
} = require('../../src/utils/diff-file-content');

describe('diff-file-content', () => {
  describe('parseDiffGitPaths', () => {
    it('parses plain diff headers', () => {
      expect(parseDiffGitPaths('diff --git a/src/file.js b/src/file.js')).toEqual({
        oldPath: 'src/file.js',
        newPath: 'src/file.js'
      });
    });

    it('parses quoted diff headers', () => {
      expect(parseDiffGitPaths('diff --git "a/src/file name.js" "b/src/file name.js"')).toEqual({
        oldPath: 'src/file name.js',
        newPath: 'src/file name.js'
      });
    });
  });

  describe('findFileBlobInfoInDiff', () => {
    it('finds the blob IDs for a matching file', () => {
      const diff = [
        'diff --git a/src/file.js b/src/file.js',
        'index abc1234..def5678 100644',
        '--- a/src/file.js',
        '+++ b/src/file.js',
        '@@ -1 +1 @@',
        '-old',
        '+new'
      ].join('\n');

      expect(findFileBlobInfoInDiff(diff, 'src/file.js')).toEqual({
        oldPath: 'src/file.js',
        newPath: 'src/file.js',
        oldBlob: 'abc1234',
        newBlob: 'def5678'
      });
    });

    it('matches renamed files by the new path', () => {
      const diff = [
        'diff --git a/src/old.js b/src/new.js',
        'index aa11bb2..cc33dd4 100644',
        '--- a/src/old.js',
        '+++ b/src/new.js'
      ].join('\n');

      expect(findFileBlobInfoInDiff(diff, 'src/new.js')).toEqual({
        oldPath: 'src/old.js',
        newPath: 'src/new.js',
        oldBlob: 'aa11bb2',
        newBlob: 'cc33dd4'
      });
    });
  });

  describe('resolveOriginalFileContentSpec', () => {
    it('prefers the diff blob over base_sha', () => {
      const prData = {
        base_sha: 'base123',
        diff: [
          'diff --git a/src/file.js b/src/file.js',
          'index abc1234..def5678 100644'
        ].join('\n')
      };

      expect(resolveOriginalFileContentSpec(prData, 'src/file.js')).toEqual({
        gitSpec: 'abc1234',
        source: 'diff blob'
      });
    });

    it('falls back to base_sha when the file is missing from the diff', () => {
      const prData = {
        base_sha: 'base123',
        diff: 'diff --git a/src/other.js b/src/other.js\nindex aaa1111..bbb2222 100644'
      };

      expect(resolveOriginalFileContentSpec(prData, 'src/file.js')).toEqual({
        gitSpec: 'base123:src/file.js',
        source: 'base commit'
      });
    });

    it('falls back to base_sha when the diff represents a new file', () => {
      const prData = {
        base_sha: 'base123',
        diff: [
          'diff --git a/src/new.js b/src/new.js',
          'new file mode 100644',
          'index 0000000..def5678 100644'
        ].join('\n')
      };

      expect(resolveOriginalFileContentSpec(prData, 'src/new.js')).toEqual({
        gitSpec: 'base123:src/new.js',
        source: 'base commit'
      });
    });
  });

  describe('resolveOriginalFileContentSpecs', () => {
    it('returns diff blob first and base commit second', () => {
      const prData = {
        base_sha: 'base123',
        diff: [
          'diff --git a/src/file.js b/src/file.js',
          'index abc1234..def5678 100644'
        ].join('\n')
      };

      expect(resolveOriginalFileContentSpecs(prData, 'src/file.js')).toEqual([
        { gitSpec: 'abc1234', source: 'diff blob' },
        { gitSpec: 'base123:src/file.js', source: 'base commit' }
      ]);
    });

    it('uses the old path for rename-aware base commit fallback', () => {
      const prData = {
        base_sha: 'base123',
        diff: [
          'diff --git a/src/old-name.js b/src/new-name.js',
          'similarity index 100%',
          'rename from src/old-name.js',
          'rename to src/new-name.js',
          'index aa11bb22..cc33dd44 100644'
        ].join('\n')
      };

      expect(resolveOriginalFileContentSpecs(prData, 'src/new-name.js')).toEqual([
        { gitSpec: 'aa11bb22', source: 'diff blob' },
        { gitSpec: 'base123:src/old-name.js', source: 'base commit' }
      ]);
    });

    it('still returns a base commit fallback for new files', () => {
      const prData = {
        base_sha: 'base123',
        diff: [
          'diff --git a/src/new.js b/src/new.js',
          'new file mode 100644',
          'index 0000000..def5678 100644'
        ].join('\n')
      };

      expect(resolveOriginalFileContentSpecs(prData, 'src/new.js')).toEqual([
        { gitSpec: 'base123:src/new.js', source: 'base commit' }
      ]);
    });
  });
});
