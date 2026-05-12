// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';

const { fetchNoTags, rawFetchNoTags } = require('../../src/git/fetch-helpers');

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
