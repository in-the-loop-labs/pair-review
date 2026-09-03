// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const {
  getDiffFileList,
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

  it('keys a C-quoted diff header under the real on-disk path', () => {
    // Git quotes the WHOLE token, `a/` prefix included, so the old
    // `^diff --git a\/` regex matched nothing and the file vanished from the
    // map entirely — no patch to render, while `hasFile` answered under a
    // path with quotes and octal escapes still in it.
    const diff = [
      String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"`,
      'index de98044..7be73ce 100644',
      String.raw`--- "a/caf\303\251.txt"`,
      String.raw`+++ "b/caf\303\251.txt"`,
      '@@ -1 +1 @@',
      '-b',
      '+B',
      ''
    ].join('\n');

    expect([...parseUnifiedDiffPatches(diff).keys()]).toEqual(['café.txt']);
  });

  it('decodes quoted rename names in merged changed_files', () => {
    const diff = [
      String.raw`diff --git a/old space.txt "b/n\303\274w space.txt"`,
      'similarity index 100%',
      'rename from old space.txt',
      String.raw`rename to "n\303\274w space.txt"`,
      ''
    ].join('\n');

    const merged = mergeChangedFilesWithDiff([], diff);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      file: 'nüw space.txt',
      renamed: true,
      renamedFrom: 'old space.txt'
    });
  });
});

describe('getDiffFileList (local mode)', () => {
  // A real throwaway repository: `git diff --name-only` and `git ls-files`
  // apply git's own quoting rules, and those rules are the thing under test.
  // Per-file mkdtemp so parallel test forks cannot collide.
  let repoDir;

  // U+03BB has no canonical decomposition, so the name survives APFS/HFS
  // Unicode normalization byte-for-byte. A name like "café.txt" would be
  // stored NFD on macOS and NFC elsewhere — a platform-dependent flake.
  const TRACKED = 'λ-tracked.txt';
  const UNTRACKED = 'λ-untracked.txt';

  const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-file-list-git-'));
    git('init', '-q', '.');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    // Make the quoting explicit rather than inherited from whatever the
    // developer's global config happens to say.
    git('config', 'core.quotePath', 'true');
    fs.writeFileSync(path.join(repoDir, TRACKED), 'one\ntwo\n');
    fs.writeFileSync(path.join(repoDir, 'plain.txt'), 'one\ntwo\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    fs.writeFileSync(path.join(repoDir, TRACKED), 'one\nTWO\n');
    fs.writeFileSync(path.join(repoDir, 'plain.txt'), 'one\nTWO\n');
    fs.writeFileSync(path.join(repoDir, UNTRACKED), 'new\n');
  });

  afterAll(() => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns decoded paths for changed and untracked files', async () => {
    const files = await getDiffFileList(null, { local_path: repoDir });

    // Decoded, exactly as the UI and the comment records spell them. Before
    // decoding these came back as `"\316\273-tracked.txt"`, so
    // `diffFiles.includes(file)` said the file was not in the diff.
    expect(files).toContain(TRACKED);
    expect(files).toContain(UNTRACKED);
    expect(files).toContain('plain.txt');
    expect(files.some(f => f.startsWith('"'))).toBe(false);
    expect(files.some(f => f.includes('\\316'))).toBe(false);
  });

  it('returns an empty list when the path is not a repository', async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-file-list-empty-'));
    try {
      expect(await getDiffFileList(null, { local_path: notARepo })).toEqual([]);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
