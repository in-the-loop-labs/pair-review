// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';

const {
  parseUnifiedDiffPatches,
  countPatchStats,
  mergeChangedFilesWithDiff
} = require('../../src/utils/diff-file-list');

describe('diff-file-list utils', () => {
  it('parses full file paths from unified diff headers', () => {
    const diff = [
      'diff --git a/src/short.js b/src/short.js',
      'index 1111111..2222222 100644',
      '--- a/src/short.js',
      '+++ b/src/short.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx b/areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx',
      'index 3333333..4444444 100644',
      '--- a/areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx',
      '+++ b/areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx',
      '@@ -1 +1 @@',
      '-before',
      '+after'
    ].join('\n');

    const patches = parseUnifiedDiffPatches(diff);

    expect([...patches.keys()]).toEqual([
      'src/short.js',
      'areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx'
    ]);
  });

  it('counts patch additions and deletions without including file headers', () => {
    const patch = [
      'diff --git a/file.js b/file.js',
      '--- a/file.js',
      '+++ b/file.js',
      '@@ -1,2 +1,3 @@',
      ' context',
      '-removed',
      '+added',
      '+also-added'
    ].join('\n');

    expect(countPatchStats(patch)).toEqual({ insertions: 2, deletions: 1 });
  });

  it('counts content lines that legitimately begin with +++ or ---', () => {
    const patch = [
      'diff --git a/file.js b/file.js',
      '--- a/file.js',
      '+++ b/file.js',
      '@@ -1,2 +1,2 @@',
      '---triple-minus-content',
      '+++triple-plus-content'
    ].join('\n');

    expect(countPatchStats(patch)).toEqual({ insertions: 1, deletions: 1 });
  });

  it('merges missing diff files back into changed_files using full patch paths', () => {
    const longPath = 'areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx';
    const diff = [
      `diff --git a/${longPath} b/${longPath}`,
      'index 3333333..4444444 100644',
      `--- a/${longPath}`,
      `+++ b/${longPath}`,
      '@@ -1 +1,2 @@',
      ' export const Route = {};',
      '+Route.component = View;',
      '+Route.loader = loader;'
    ].join('\n');

    const merged = mergeChangedFilesWithDiff([
      { file: 'areas/internal-services/.../$number/route.tsx', insertions: 2, deletions: 0 }
    ], diff);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      file: longPath,
      insertions: 2,
      deletions: 0,
      changes: 2
    });
  });
});
