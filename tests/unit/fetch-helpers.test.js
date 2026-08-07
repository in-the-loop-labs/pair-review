// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fetchNoTags,
  rawFetchNoTags,
  isRefHierarchyConflict,
  fetchWithPruneRecovery,
} = require('../../src/git/fetch-helpers');
const logger = require('../../src/utils/logger');

describe('git fetch helpers', () => {
  it('prepends --no-tags to simple-git fetch arguments', async () => {
    const git = {
      fetch: vi.fn().mockResolvedValue('ok'),
    };

    const result = await fetchNoTags(git, ['--prune', 'origin']);

    expect(result).toBe('ok');
    expect(git.fetch).toHaveBeenCalledWith(['--no-tags', '--prune', 'origin']);
  });

  it('prepends fetch --no-tags to raw fetch arguments', async () => {
    const git = {
      raw: vi.fn().mockResolvedValue('ok'),
    };

    const result = await rawFetchNoTags(git, ['origin', 'abc123']);

    expect(result).toBe('ok');
    expect(git.raw).toHaveBeenCalledWith(['fetch', '--no-tags', 'origin', 'abc123']);
  });
});

describe('isRefHierarchyConflict', () => {
  it('matches a ref lock failure', () => {
    expect(isRefHierarchyConflict(new Error(
      "cannot lock ref 'refs/remotes/origin/foo/bar': 'refs/remotes/origin/foo' exists"
    ))).toBe(true);
  });

  it('matches an existing-ref creation failure', () => {
    expect(isRefHierarchyConflict(new Error(
      "refs/remotes/origin/foo exists; cannot create refs/remotes/origin/foo/bar"
    ))).toBe(true);
  });

  it('matches a tag clobber failure', () => {
    expect(isRefHierarchyConflict(new Error(
      'would clobber existing tag'
    ))).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isRefHierarchyConflict(new Error('CANNOT LOCK REF refs/remotes/origin/x'))).toBe(true);
  });

  it('does not match unrelated fetch failures', () => {
    expect(isRefHierarchyConflict(new Error('fatal: could not read from remote repository'))).toBe(false);
  });

  it('does not match a null or undefined error', () => {
    expect(isRefHierarchyConflict(null)).toBe(false);
    expect(isRefHierarchyConflict(undefined)).toBe(false);
  });
});

describe('fetchWithPruneRecovery', () => {
  const refspec = '+refs/heads/main:refs/remotes/origin/main';

  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches once and never prunes when the fetch succeeds', async () => {
    const git = {
      fetch: vi.fn().mockResolvedValue('ok'),
      raw: vi.fn().mockResolvedValue(''),
    };

    const result = await fetchWithPruneRecovery(git, 'origin', refspec);

    expect(result).toBe('ok');
    expect(git.fetch).toHaveBeenCalledTimes(1);
    expect(git.fetch).toHaveBeenCalledWith(['--no-tags', 'origin', refspec]);
    expect(git.raw).not.toHaveBeenCalled();
  });

  it('prunes stale remote-tracking refs and retries on a ref hierarchy conflict', async () => {
    const git = {
      fetch: vi.fn()
        .mockRejectedValueOnce(new Error("cannot lock ref 'refs/remotes/origin/foo/bar'"))
        .mockResolvedValue('ok'),
      raw: vi.fn().mockResolvedValue(''),
    };

    const result = await fetchWithPruneRecovery(git, 'origin', refspec);

    expect(result).toBe('ok');
    expect(git.raw).toHaveBeenCalledWith(['remote', 'prune', 'origin']);
    expect(git.fetch).toHaveBeenCalledTimes(2);
    expect(git.fetch).toHaveBeenNthCalledWith(2, ['--no-tags', 'origin', refspec]);
  });

  it('propagates non-conflict errors without pruning', async () => {
    const git = {
      fetch: vi.fn().mockRejectedValue(new Error('fatal: could not read from remote repository')),
      raw: vi.fn().mockResolvedValue(''),
    };

    await expect(fetchWithPruneRecovery(git, 'origin', refspec))
      .rejects.toThrow('could not read from remote repository');

    expect(git.raw).not.toHaveBeenCalled();
    expect(git.fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates the second failure when the retry after pruning also fails', async () => {
    const git = {
      fetch: vi.fn()
        .mockRejectedValueOnce(new Error("cannot lock ref 'refs/remotes/origin/foo/bar'"))
        .mockRejectedValueOnce(new Error('retry failed')),
      raw: vi.fn().mockResolvedValue(''),
    };

    await expect(fetchWithPruneRecovery(git, 'origin', refspec))
      .rejects.toThrow('retry failed');

    expect(git.raw).toHaveBeenCalledWith(['remote', 'prune', 'origin']);
    expect(git.fetch).toHaveBeenCalledTimes(2);
  });
});
