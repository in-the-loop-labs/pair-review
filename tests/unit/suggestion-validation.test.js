// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const logger = require('../../src/utils/logger');
const {
  partitionSuggestionPaths, filterSuggestionPaths, finalizeSuggestions
} = require('../../src/utils/suggestion-validation');

const finding = (overrides = {}) => ({
  file: 'unchanged.js', line_start: 30, line_end: 35, old_or_new: 'OLD',
  type: 'bug', title: 'Cross-file problem', description: 'The caller breaks.', ...overrides
});

describe('suggestion path validation', () => {
  let root, repoRoot;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'suggestion-validation-'));
    repoRoot = path.join(root, 'repo');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'unchanged.js'), 'code\n'.repeat(100));
    fs.writeFileSync(path.join(repoRoot, 'a => b.md'), 'literal\n');
    fs.writeFileSync(path.join(root, 'outside.js'), 'outside\n');
    fs.symlinkSync(path.join(root, 'outside.js'), path.join(repoRoot, 'escape.js'));
    fs.symlinkSync(path.join(repoRoot, 'unchanged.js'), path.join(repoRoot, 'inside-link.js'));
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps changed-file findings with their side and the canonical path', () => {
    const input = [finding({ file: './changed.js' }), finding({ file: 'changed.js' })];
    const kept = filterSuggestionPaths(input, ['changed.js'], repoRoot);
    expect(kept).toEqual([finding({ file: 'changed.js' }), finding({ file: 'changed.js' })]);
    expect(kept[1]).toBe(input[1]);
  });

  it('keeps findings on existing unchanged files on the NEW side', () => {
    const input = finding();
    expect(filterSuggestionPaths([input], ['changed.js'], repoRoot))
      .toEqual([finding({ old_or_new: 'NEW' })]);
    expect(input.old_or_new).toBe('OLD');
  });

  it('keeps a file literally named like a git rename, under its own path', () => {
    expect(filterSuggestionPaths([finding({ file: 'a => b.md' })], ['changed.js'], repoRoot))
      .toEqual([finding({ file: 'a => b.md', old_or_new: 'NEW' })]);
    expect(filterSuggestionPaths([finding({ file: 'a => b.md' })], ['b.md'], repoRoot))
      .toEqual([finding({ file: 'a => b.md', old_or_new: 'NEW' })]);
  });

  it('follows a symlink that stays inside the checkout', () => {
    expect(filterSuggestionPaths([finding({ file: 'inside-link.js' })], ['changed.js'], repoRoot))
      .toEqual([finding({ file: 'inside-link.js', old_or_new: 'NEW' })]);
  });

  it.each([
    ['a missing file', 'missing.js'],
    ['a directory', 'src'],
    ['a symlink escaping the checkout', 'escape.js'],
    ['a parent-relative path', '../outside.js'],
    ['an absolute path', null],
    ['an empty path', ''],
    ['a NUL byte', 'unchanged.js\0x']
  ])('discards %s', (_label, file) => {
    const target = file ?? path.join(root, 'outside.js');
    expect(filterSuggestionPaths([finding({ file: target })], ['changed.js'], repoRoot)).toEqual([]);
  });

  it('discards unchanged-file findings when there is no checkout to verify them', () => {
    expect(filterSuggestionPaths([finding()], ['changed.js'], null)).toEqual([]);
  });

  it('passes everything through when the changed-file list is unknown', () => {
    const input = [finding({ file: 'missing.js' }), finding()];
    const result = partitionSuggestionPaths(input, [], repoRoot);
    expect(result).toEqual({ kept: input, discarded: [], bypassed: true });
    expect(filterSuggestionPaths(input, null, repoRoot)).toBe(input);
  });

  it('checks each unchanged path in the checkout once', () => {
    const realpath = vi.spyOn(fs, 'realpathSync');
    filterSuggestionPaths([finding(), finding({ line_start: 40 }), finding({ line_start: 50 })], ['changed.js'], repoRoot);
    const fileCalls = realpath.mock.calls.filter(([p]) => String(p).endsWith('unchanged.js'));
    expect(fileCalls).toHaveLength(1);
  });

  it('reports discarded suggestions separately from kept ones', () => {
    const missing = finding({ file: 'missing.js' });
    const result = partitionSuggestionPaths([missing, finding({ file: 'changed.js' })], ['changed.js'], repoRoot);
    expect(result.discarded).toEqual([missing]);
    expect(result.kept.map(s => s.file)).toEqual(['changed.js']);
    expect(result.bypassed).toBe(false);
  });

  it('returns an empty list for no suggestions', () => {
    expect(filterSuggestionPaths(null, ['changed.js'], repoRoot)).toEqual([]);
    expect(filterSuggestionPaths([], ['changed.js'], repoRoot)).toEqual([]);
  });
});

describe('finalizeSuggestions', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'suggestion-finalize-'));
    fs.writeFileSync(path.join(root, 'unchanged.js'), 'code\n'.repeat(100));
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('checks unchanged-file line numbers against the checkout', async () => {
    const valid = finding({ line_start: 90, line_end: 100 });
    const outOfRange = finding({ line_start: 150, line_end: 155 });
    const result = await finalizeSuggestions([valid, outOfRange], { changedFiles: ['changed.js'], repoRoot: root });
    expect(result).toEqual([
      { ...valid, old_or_new: 'NEW' },
      { ...outOfRange, old_or_new: 'NEW', line_start: null, line_end: null, is_file_level: true }
    ]);
  });

  it('checks changed-file line numbers against the caller counts, not the checkout', async () => {
    const result = await finalizeSuggestions(
      [finding({ file: 'changed.js', line_start: 20, line_end: 20 })],
      { changedFiles: ['changed.js'], fileLineCountMap: new Map([['changed.js', 10]]), repoRoot: root }
    );
    expect(result).toMatchObject([{ file: 'changed.js', old_or_new: 'OLD', line_start: null, is_file_level: true }]);
  });

  it('validates a single `line` as a range', async () => {
    const result = await finalizeSuggestions(
      [{ file: 'unchanged.js', line: 7, type: 'bug', title: 'T', description: 'D' }],
      { changedFiles: ['changed.js'], repoRoot: root }
    );
    expect(result).toMatchObject([{ file: 'unchanged.js', line_start: 7, line_end: 7, old_or_new: 'NEW' }]);
  });

  it('does not count lines when membership is unknown', async () => {
    const outOfRange = finding({ line_start: 150, line_end: 155 });
    expect(await finalizeSuggestions([outOfRange], { changedFiles: [], repoRoot: root })).toEqual([outOfRange]);
  });

  it('handles null and empty input', async () => {
    expect(await finalizeSuggestions(null, { changedFiles: ['changed.js'], repoRoot: root })).toEqual([]);
    expect(await finalizeSuggestions([], { changedFiles: [], repoRoot: null })).toEqual([]);
  });
});
