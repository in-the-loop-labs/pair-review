// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Path spelling against a real git repository.
 *
 * The repo sets core.quotePath=true (git's default) explicitly, so every
 * assertion here proves pair-review's own `-c core.quotePath=false` and -z
 * win over repo config: non-ASCII names come out verbatim, and the only names
 * still quoted in diff headers are the ones git always quotes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { GitWorktreeManager } = require('../../src/git/worktree');
const { generateScopedDiff, getUntrackedFiles, computeScopedDigest } = require('../../src/local-review');
const { getDiffFileList, parseUnifiedDiffPatches } = require('../../src/utils/diff-file-list');
const { getChangedFiles: getExecutableChangedFiles } = require('../../src/routes/executable-analysis');
const Analyzer = require('../../src/ai/analyzer');
const { listScopedChangedFiles } = require('../../src/git/scoped-changed-files');
const { diffContainsPath } = require('../../src/utils/diff-file-content');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

const BASE_FILES = {
  'café.js': 'base\n',
  'quo"te.js': 'base\n',
  'a => b.md': 'base\n',
  'x b/y.js': 'base\n',
  'lib/moved.js': 'keep\nold\n',
  'old/thing.js': 'one\ntwo\nthree\nfour\nfive\n',
  'p b/q.js': 'one\ntwo\nthree\nfour\n'
};

// An untracked name with replacement patterns: a string replacement would
// expand `$&` into the matched header.
const DOLLAR_UNTRACKED = 'do$&l $1.js';

let repo;
let baseSha;
let headSha;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-review-quoted-paths-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@test.com');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'core.quotePath', 'true');
  for (const [file, content] of Object.entries(BASE_FILES)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  baseSha = git(repo, 'rev-parse', 'HEAD').trim();

  fs.mkdirSync(path.join(repo, 'ñew dir'));
  fs.mkdirSync(path.join(repo, 'totally'));
  git(repo, 'mv', 'lib/moved.js', 'ñew dir/moved é.js');
  fs.writeFileSync(path.join(repo, 'ñew dir/moved é.js'), 'keep\nnew\n');
  git(repo, 'mv', 'old/thing.js', 'totally/different.txt');
  // Out of a path containing " b/": the header alone is ambiguous
  git(repo, 'mv', 'p b/q.js', 'zed.js');
  fs.appendFileSync(path.join(repo, 'zed.js'), 'five\n');
  for (const file of ['café.js', 'quo"te.js', 'a => b.md', 'x b/y.js']) {
    fs.appendFileSync(path.join(repo, file), 'changed\n');
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'head');
  headSha = git(repo, 'rev-parse', 'HEAD').trim();

  // Working-tree state for Local mode
  fs.appendFileSync(path.join(repo, 'café.js'), 'unstaged\n');
  fs.writeFileSync(path.join(repo, 'ünt racked.js'), 'new\n');
  fs.writeFileSync(path.join(repo, 'quo"ted new.js'), 'new\n');
  fs.writeFileSync(path.join(repo, DOLLAR_UNTRACKED), 'new\n');
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

/** `git diff --numstat -z` counts, keyed by new path (test oracle only). */
function numstatCounts(cwd, range) {
  const fields = git(cwd, 'diff', '--numstat', '-z', range).split('\0');
  const counts = {};
  for (let i = 0; i < fields.length - 1; i++) {
    const [insertions, deletions, file] = fields[i].split('\t');
    // A rename prints an empty path followed by old and new as their own fields
    const newPath = file === '' ? fields[i += 2] : file;
    counts[newPath] = { insertions: Number(insertions), deletions: Number(deletions) };
  }
  return counts;
}

describe('PR changed_files from a real diff', () => {
  it('generates headers with verbatim non-ASCII names despite core.quotePath=true in the repo', async () => {
    const manager = new GitWorktreeManager(null);
    const diff = await manager.generateUnifiedDiff(repo, { base_sha: baseSha, head_sha: headSha });

    expect(diff).toContain('diff --git a/café.js b/café.js');
    expect(diff).toContain('diff --git a/lib/moved.js b/ñew dir/moved é.js');
    expect(diff).toContain(String.raw`diff --git "a/quo\"te.js" "b/quo\"te.js"`);
    expect(diff).toContain('diff --git a/p b/q.js b/zed.js');
    expect(diff).not.toMatch(/\\3\d\d/);
  });

  it('builds changed_files that match the diff headers and --numstat counts', async () => {
    const manager = new GitWorktreeManager(null);
    const diff = await manager.generateUnifiedDiff(repo, { base_sha: baseSha, head_sha: headSha });
    const changedFiles = await manager.getChangedFiles(repo, diff);

    const byFile = Object.fromEntries(changedFiles.map(entry => [entry.file, entry]));
    expect(Object.keys(byFile).sort()).toEqual([
      'a => b.md', 'café.js', 'quo"te.js', 'totally/different.txt', 'x b/y.js', 'zed.js', 'ñew dir/moved é.js'
    ].sort());
    expect(Object.keys(byFile).sort()).toEqual([...parseUnifiedDiffPatches(diff).keys()].sort());

    // Renames come from rename from/to, including one whose paths share nothing
    expect(byFile['ñew dir/moved é.js']).toMatchObject({ renamed: true, renamedFrom: 'lib/moved.js' });
    expect(byFile['totally/different.txt']).toMatchObject({ renamed: true, renamedFrom: 'old/thing.js' });
    expect(byFile['zed.js']).toMatchObject({ renamed: true, renamedFrom: 'p b/q.js', insertions: 1 });
    expect(byFile['a => b.md'].renamed).toBeUndefined();

    const numstat = numstatCounts(repo, `${baseSha}...${headSha}`);
    for (const entry of changedFiles) {
      expect({ file: entry.file, insertions: entry.insertions, deletions: entry.deletions })
        .toEqual({ file: entry.file, ...numstat[entry.file] });
    }
  });
});

describe('Local mode paths from a real working tree', () => {
  it('lists untracked files verbatim', async () => {
    const untracked = await getUntrackedFiles(repo);
    expect(untracked.map(entry => entry.file).sort()).toEqual([DOLLAR_UNTRACKED, 'quo"ted new.js', 'ünt racked.js']);
  });

  it('spells untracked diff headers the way git does and decodes them to the real names', async () => {
    const { diff } = await generateScopedDiff(repo, 'unstaged', 'untracked', null);

    expect(diff).toContain('diff --git a/café.js b/café.js');
    expect(diff).toContain('diff --git a/ünt racked.js b/ünt racked.js');
    expect(diff).toContain('+++ b/ünt racked.js\t');
    expect(diff).toContain(String.raw`diff --git "a/quo\"ted new.js" "b/quo\"ted new.js"`);
    expect(diff).toContain(`diff --git a/${DOLLAR_UNTRACKED} b/${DOLLAR_UNTRACKED}`);
    expect(diff).toContain(`+++ b/${DOLLAR_UNTRACKED}\t`);
    expect(diff).not.toContain(repo);

    expect([...parseUnifiedDiffPatches(diff).keys()].sort()).toEqual(['café.js', DOLLAR_UNTRACKED, 'quo"ted new.js', 'ünt racked.js']);
  });

  it('lists the review file list verbatim', async () => {
    const files = await getDiffFileList(null, { local_path: repo });
    expect(files.sort()).toEqual(['café.js', DOLLAR_UNTRACKED, 'quo"ted new.js', 'ünt racked.js']);
  });

  it('lists executable-analysis changed files verbatim', async () => {
    const files = await getExecutableChangedFiles(repo, { scopeStart: 'unstaged', scopeEnd: 'untracked' });
    expect(files.sort()).toEqual(['café.js', DOLLAR_UNTRACKED, 'quo"ted new.js', 'ünt racked.js']);
  });

  it('lists PR-range executable-analysis changed files verbatim', async () => {
    const files = await getExecutableChangedFiles(repo, { baseSha, headSha });
    expect(files.sort()).toEqual([
      'a => b.md', 'café.js', 'quo"te.js', 'totally/different.txt', 'x b/y.js', 'zed.js', 'ñew dir/moved é.js'
    ].sort());
  });
});

describe('Local scoped changed-file listing from a real working tree', () => {
  beforeAll(() => {
    // A base branch for the branch scope stop: the PR range's base commit
    git(repo, 'branch', '-f', 'scope-base', baseSha);
  });

  it('lists the default Local files (unstaged, untracked, staged) verbatim', async () => {
    const files = await listScopedChangedFiles(repo);
    expect(files.sort()).toEqual(['café.js', DOLLAR_UNTRACKED, 'quo"ted new.js', 'ünt racked.js']);
  });

  it('lists a branch scope verbatim, including committed renames and quoted names', async () => {
    const files = await listScopedChangedFiles(repo, {
      scopeStart: 'branch', scopeEnd: 'untracked', baseBranch: 'scope-base'
    });
    expect(files.sort()).toEqual([
      'a => b.md', 'café.js', DOLLAR_UNTRACKED, 'quo"te.js', 'quo"ted new.js', 'totally/different.txt',
      'x b/y.js', 'zed.js', 'ñew dir/moved é.js', 'ünt racked.js'
    ].sort());
  });
});

describe('diff membership for the file-content route', () => {
  it('finds quoted, non-ASCII and ambiguous-header paths in a real diff', async () => {
    const manager = new GitWorktreeManager(null);
    const diff = await manager.generateUnifiedDiff(repo, { base_sha: baseSha, head_sha: headSha });

    for (const file of ['café.js', 'quo"te.js', 'x b/y.js', 'zed.js', 'p b/q.js', 'ñew dir/moved é.js', 'lib/moved.js']) {
      expect(diffContainsPath(diff, file), file).toBe(true);
    }
    // Neither half of an ambiguous rename header is a file of its own
    expect(diffContainsPath(diff, 'p')).toBe(false);
    expect(diffContainsPath(diff, 'q.js b/zed.js')).toBe(false);
  });

  it('finds the real name in a Local diff with a C-quoted untracked header', async () => {
    const { diff } = await generateScopedDiff(repo, 'unstaged', 'untracked', null);
    expect(diffContainsPath(diff, 'quo"ted new.js')).toBe(true);
    expect(diffContainsPath(diff, 'ünt racked.js')).toBe(true);
    expect(diffContainsPath(diff, '"quo\\"ted new.js"')).toBe(false);
  });
});

describe('Analyzer changed-file lists from a real repository', () => {
  it('lists PR files verbatim', async () => {
    const analyzer = new Analyzer({}, 'sonnet', 'claude');
    const files = await analyzer.getChangedFilesList(repo, { base_sha: baseSha, head_sha: headSha });
    expect(files.sort()).toEqual([
      'a => b.md', 'café.js', 'quo"te.js', 'totally/different.txt', 'x b/y.js', 'zed.js', 'ñew dir/moved é.js'
    ].sort());
  });

  it('pins core.quotePath=false in the diff command it runs for snapshots', () => {
    const analyzer = new Analyzer({}, 'sonnet', 'claude');
    expect(analyzer.buildGitDiffCommand({ base_sha: 'b', head_sha: 'h' }))
      .toMatch(/^git -c core\.quotePath=false diff .* b\.\.\.h$/);
    expect(analyzer.buildGitDiffCommand({ reviewType: 'local' }, '--name-only -z'))
      .toMatch(/^git -c core\.quotePath=false diff .* HEAD --name-only -z$/);
  });

  it('captures a diff snapshot with verbatim non-ASCII headers', () => {
    const analyzer = new Analyzer({}, 'sonnet', 'claude');
    const diff = git(repo, ...analyzer.buildGitDiffCommand({ base_sha: baseSha, head_sha: headSha }).split(' ').slice(1));
    expect(diff).toContain('diff --git a/café.js b/café.js');
  });
});

describe('Local staleness digest from a real working tree', () => {
  it('stats untracked non-ASCII files by their real names', async () => {
    const before = await computeScopedDigest(repo, 'unstaged', 'untracked');
    // A quoted ls-files spelling would stat a path that does not exist and
    // hash as "missing" both times, so this edit would go unnoticed.
    fs.appendFileSync(path.join(repo, 'ünt racked.js'), 'more\n');
    const after = await computeScopedDigest(repo, 'unstaged', 'untracked');

    expect(before).toMatch(/^[0-9a-f]{16}$/);
    expect(after).not.toBe(before);
  });
});
