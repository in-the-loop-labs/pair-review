// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { GIT_DIFF_FLAGS_ARRAY, GIT_PATH_CONFIG_ARRAY } = require('../../src/git/diff-flags');
const {
  splitUnifiedDiffPatches,
  parseUnifiedDiffPatches,
  countPatchStats,
  buildChangedFileEntries,
  mergeChangedFilesWithDiff
} = require('../../src/utils/diff-file-list');
const {
  LOOKALIKE_DIFF, LOOKALIKE_STATS, EXHAUSTED_HUNK_PATCH, EXHAUSTED_HUNK_STATS,
  CR_CONTEXT_DIFF, CR_CONTEXT_STATS
} = require('../utils/diff-stat-fixtures');
const {
  QUOTEPATH_FALSE_DIFF,
  QUOTEPATH_FALSE_CHANGED_FILES,
  QUOTEPATH_TRUE_DIFF,
  B_SLASH_RENAME_DIFF,
  B_SLASH_RENAME_CHANGED_FILES
} = require('../utils/git-path-fixtures');

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
      '@@ -1 +1 @@',
      '---triple-minus-content',
      '+++triple-plus-content'
    ].join('\n');

    expect(countPatchStats(patch)).toEqual({ insertions: 1, deletions: 1 });
  });

  describe('hunk lines that look like file headers', () => {
    const patches = parseUnifiedDiffPatches(LOOKALIKE_DIFF);
    const stats = file => {
      const { insertions, deletions } = countPatchStats(patches.get(file));
      return { additions: insertions, deletions };
    };

    it('counts a removed `-- comment` (`--- x`) and an added `++ x` (`+++ x`) line', () => {
      expect(stats('q.sql')).toEqual(LOOKALIKE_STATS['q.sql']);
    });

    it('leaves real headers, `\\ No newline` markers and binary sections uncounted', () => {
      expect(stats('a.js')).toEqual(LOOKALIKE_STATS['a.js']);
      expect(stats('img.bin')).toEqual(LOOKALIKE_STATS['img.bin']);
    });

    it('stops counting once a hunk has delivered its declared lines', () => {
      const { insertions, deletions } = countPatchStats(EXHAUSTED_HUNK_PATCH);
      expect({ additions: insertions, deletions }).toEqual(EXHAUSTED_HUNK_STATS);
    });

    it('counts a hunk whose `@@` context contains a carriage return', () => {
      const { insertions, deletions } = countPatchStats(parseUnifiedDiffPatches(CR_CONTEXT_DIFF).get('f.js'));
      expect({ additions: insertions, deletions }).toEqual(CR_CONTEXT_STATS['f.js']);
    });

    it('returns zeros for an empty or missing patch', () => {
      expect(countPatchStats('')).toEqual({ insertions: 0, deletions: 0 });
      expect(countPatchStats(undefined)).toEqual({ insertions: 0, deletions: 0 });
    });

    it('carries the counts into changed_files entries recovered from the diff', () => {
      const merged = mergeChangedFilesWithDiff([], LOOKALIKE_DIFF);
      const byFile = Object.fromEntries(merged.map(entry =>
        [entry.file, { additions: entry.insertions, deletions: entry.deletions }]));
      expect(byFile).toEqual(LOOKALIKE_STATS);
      expect(merged.find(entry => entry.file === 'q.sql').changes).toBe(4);
      expect(merged.find(entry => entry.file === 'img.bin').binary).toBe(true);
    });
  });

  it('merges missing diff files back into changed_files using full patch paths', () => {
    const longPath = 'areas/internal-services/meteorite/ui/app/frontend/src/routes/repos/$owner/$repo/pulls/$number/route.tsx';
    const diff = [
      `diff --git a/${longPath} b/${longPath}`,
      'index 3333333..4444444 100644',
      `--- a/${longPath}`,
      `+++ b/${longPath}`,
      '@@ -1 +1,3 @@',
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

  it('keys patches by the decoded new path', () => {
    expect([...parseUnifiedDiffPatches(QUOTEPATH_FALSE_DIFF).keys()]).toEqual(
      QUOTEPATH_FALSE_CHANGED_FILES.map(entry => entry.file)
    );
    expect([...parseUnifiedDiffPatches(QUOTEPATH_TRUE_DIFF).keys()]).toEqual([
      'src/café.js',
      'ñew dir/moved é.js'
    ]);
  });

  it('counts a deleted "-- x" and an added "++ x" line as content, like --numstat', () => {
    const patch = parseUnifiedDiffPatches(QUOTEPATH_FALSE_DIFF).get('schema.sql');
    expect(countPatchStats(patch)).toEqual({ insertions: 1, deletions: 1 });
  });

  it('counts nothing for a patch without hunks', () => {
    expect(countPatchStats('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')).toEqual({
      insertions: 0,
      deletions: 0
    });
  });

  describe('buildChangedFileEntries', () => {
    it('builds changed_files from the diff: paths, renames, counts and binary flag', () => {
      expect(buildChangedFileEntries(QUOTEPATH_FALSE_DIFF)).toEqual(
        QUOTEPATH_FALSE_CHANGED_FILES.map(entry => ({ ...entry, generated: false }))
      );
    });

    it('records a rename whose old and new paths share nothing', () => {
      const entry = buildChangedFileEntries(QUOTEPATH_FALSE_DIFF)
        .find(file => file.file === 'totally/different.txt');
      expect(entry).toMatchObject({ renamed: true, renamedFrom: 'old/thing.js' });
    });

    it('names a rename out of a path containing " b/" from its rename lines', () => {
      // `diff --git a/x b/y.js b/z.js` alone would split as `x` -> `y.js b/z.js`
      expect(buildChangedFileEntries(B_SLASH_RENAME_DIFF)).toEqual(
        B_SLASH_RENAME_CHANGED_FILES.map(entry => ({ ...entry, generated: false }))
      );
      expect([...parseUnifiedDiffPatches(B_SLASH_RENAME_DIFF).keys()]).toEqual(['r b/s.js', 'z.js']);
    });

    it('keeps a literal "a => b.md" filename as one unrenamed file', () => {
      const entry = buildChangedFileEntries(QUOTEPATH_FALSE_DIFF).find(file => file.file === 'a => b.md');
      expect(entry).toBeDefined();
      expect(entry.renamed).toBeUndefined();
      expect(entry.renamedFrom).toBeUndefined();
    });

    it('decodes quoted renames in diffs cached with core.quotePath=true', () => {
      expect(buildChangedFileEntries(QUOTEPATH_TRUE_DIFF)).toEqual([
        { file: 'src/café.js', insertions: 1, deletions: 1, changes: 2, binary: false, generated: false },
        {
          file: 'ñew dir/moved é.js', insertions: 1, deletions: 1, changes: 2, binary: false,
          generated: false, renamed: true, renamedFrom: 'lib/moved.js'
        }
      ]);
    });

    it('marks generated files with the .gitattributes matcher', () => {
      const gitattributes = { isGenerated: file => file === 'logo.png' };
      const entries = buildChangedFileEntries(QUOTEPATH_FALSE_DIFF, gitattributes);
      expect(entries.filter(entry => entry.generated).map(entry => entry.file)).toEqual(['logo.png']);
    });

    it('returns no entries for an empty diff', () => {
      expect(buildChangedFileEntries('')).toEqual([]);
      expect(buildChangedFileEntries(undefined)).toEqual([]);
    });
  });

  describe('a file <-> symlink type change', () => {
    // git prints a type change as two blocks for the same path: the old
    // file's deletion, then the symlink's addition.
    let repo;
    let typeChangeDiff;

    beforeAll(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-type-change-'));
      const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test User');
      fs.writeFileSync(path.join(repo, 'link.js'), 'hello\n');
      fs.writeFileSync(path.join(repo, 'target.js'), 'x\n');
      fs.writeFileSync(path.join(repo, 'plain.js'), 'a\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      fs.rmSync(path.join(repo, 'link.js'));
      fs.symlinkSync('target.js', path.join(repo, 'link.js'));
      fs.appendFileSync(path.join(repo, 'plain.js'), 'b\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'head');
      typeChangeDiff = execFileSync('git', [...GIT_PATH_CONFIG_ARRAY, 'diff', ...GIT_DIFF_FLAGS_ARRAY, 'HEAD~1...HEAD'], {
        cwd: repo, encoding: 'utf8', stdio: 'pipe'
      });
    });

    afterAll(() => {
      if (repo) fs.rmSync(repo, { recursive: true, force: true });
    });

    it('is two blocks for one path in git\'s output', () => {
      expect(splitUnifiedDiffPatches(typeChangeDiff).map(([file]) => file)).toEqual(['link.js', 'link.js', 'plain.js']);
    });

    it('builds one entry whose counts cover both blocks, like --numstat', () => {
      const entries = buildChangedFileEntries(typeChangeDiff);
      expect(entries).toEqual([
        { file: 'link.js', insertions: 1, deletions: 1, changes: 2, binary: false, generated: false },
        { file: 'plain.js', insertions: 1, deletions: 0, changes: 1, binary: false, generated: false }
      ]);
    });

    it('adds the same merged entry when the cache is missing the file', () => {
      expect(mergeChangedFilesWithDiff([], typeChangeDiff)).toEqual([
        { file: 'link.js', insertions: 1, deletions: 1, changes: 2, binary: false },
        { file: 'plain.js', insertions: 1, deletions: 0, changes: 1, binary: false }
      ]);
    });

    it('keeps parseUnifiedDiffPatches keyed by path, holding the last block', () => {
      const patches = parseUnifiedDiffPatches(typeChangeDiff);
      expect([...patches.keys()]).toEqual(['link.js', 'plain.js']);
      expect(patches.get('link.js')).toMatch(/^new file mode 120000$/m);
    });
  });

  describe('mergeChangedFilesWithDiff with entries cached by older versions', () => {
    it('re-spells a cached C-quoted entry instead of adding a duplicate', () => {
      const merged = mergeChangedFilesWithDiff([
        { file: String.raw`"src/caf\303\251.js"`, insertions: 1, deletions: 1, changes: 2 },
        String.raw`"\303\261ew dir/moved \303\251.js"`
      ], QUOTEPATH_TRUE_DIFF);

      expect(merged).toEqual([
        { file: 'src/café.js', insertions: 1, deletions: 1, changes: 2 },
        'ñew dir/moved é.js'
      ]);
    });

    it('never mangles a real name that only looks quoted', () => {
      const diff = [
        'diff --git "a/\\"x\\"" "b/\\"x\\""',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        ''
      ].join('\n');
      expect([...parseUnifiedDiffPatches(diff).keys()]).toEqual(['"x"']);

      const merged = mergeChangedFilesWithDiff([{ file: '"x"', insertions: 1, deletions: 1 }], diff);
      expect(merged).toEqual([{ file: '"x"', insertions: 1, deletions: 1 }]);
    });

    it('keeps a quoted-looking entry the diff does not confirm', () => {
      const merged = mergeChangedFilesWithDiff([{ file: '"other.js"' }], QUOTEPATH_TRUE_DIFF);
      expect(merged.map(entry => entry.file)).toEqual(['"other.js"', 'src/café.js', 'ñew dir/moved é.js']);
    });
  });
});
