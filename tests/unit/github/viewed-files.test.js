// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

const { GitHubClient } = require('../../../src/github/client');
const { DEFAULT_BATCH_SIZE } = require('../../../src/github/operations/viewed-files');

function createClient(binding = 'test-token') {
  const client = new GitHubClient(binding);
  client.octokit.graphql = vi.fn().mockResolvedValue({});
  return client;
}

describe('GitHubClient.markFilesAsViewed', () => {
  it('marks multiple files in one aliased mutation', async () => {
    const client = createClient();

    await client.markFilesAsViewed('PR_node123', [
      'src/first.js',
      'src/second.js'
    ]);

    expect(client.octokit.graphql).toHaveBeenCalledTimes(1);
    const [mutation, variables] = client.octokit.graphql.mock.calls[0];
    expect(mutation).toContain('file0: markFileAsViewed');
    expect(mutation).toContain('file1: markFileAsViewed');
    expect(variables).toEqual({
      pullRequestId: 'PR_node123',
      path0: 'src/first.js',
      path1: 'src/second.js'
    });
  });

  it('does not call GraphQL when there are no viewed files', async () => {
    const client = createClient();

    await client.markFilesAsViewed('PR_node123', []);

    expect(client.octokit.graphql).not.toHaveBeenCalled();
  });

  it('splits large viewed-file lists into batches', async () => {
    const client = createClient();
    const paths = Array.from(
      { length: DEFAULT_BATCH_SIZE + 1 },
      (_, index) => `src/file-${index}.js`
    );

    await client.markFilesAsViewed('PR_node123', paths);

    expect(client.octokit.graphql).toHaveBeenCalledTimes(2);
    expect(client.octokit.graphql.mock.calls[0][1].path49).toBe('src/file-49.js');
    expect(client.octokit.graphql.mock.calls[1][1]).toEqual({
      pullRequestId: 'PR_node123',
      path0: 'src/file-50.js'
    });
  });

  it('skips alternate hosts that do not support GitHub GraphQL', async () => {
    const client = createClient({
      token: 'alt-token',
      apiHost: 'https://example.test/api/v3'
    });

    await client.markFilesAsViewed('PR_node123', ['src/file.js']);

    expect(client.octokit.graphql).not.toHaveBeenCalled();
  });
});
