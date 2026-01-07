import { describe, it, expect, beforeEach, vi } from 'vitest';

const { PRArgumentParser } = require('../../src/github/parser');

describe('PRArgumentParser', () => {
  let parser;

  beforeEach(() => {
    parser = new PRArgumentParser();
    // Mock git methods to avoid actual filesystem operations
    parser.git = {
      checkIsRepo: vi.fn(),
      getRemotes: vi.fn(),
      revparse: vi.fn()
    };
  });

  describe('parseGitHubURL', () => {
    it('should parse standard GitHub PR URL', () => {
      const result = parser.parseGitHubURL('https://github.com/owner/repo/pull/123');
      expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 123 });
    });

    it('should parse GitHub PR URL with trailing segments', () => {
      const result = parser.parseGitHubURL('https://github.com/owner/repo/pull/456/files');
      expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 456 });
    });

    it('should parse GitHub PR URL with commits tab', () => {
      const result = parser.parseGitHubURL('https://github.com/owner/repo/pull/789/commits');
      expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 789 });
    });

    it('should throw error for invalid GitHub URL', () => {
      expect(() => parser.parseGitHubURL('https://github.com/owner/repo')).toThrow('Invalid GitHub URL format');
    });

    it('should throw error for GitHub URL with invalid PR number', () => {
      expect(() => parser.parseGitHubURL('https://github.com/owner/repo/pull/abc')).toThrow('Invalid GitHub URL format');
    });
  });

  describe('parseGraphiteURL', () => {
    it('should parse Graphite URL with .dev domain', () => {
      const result = parser.parseGraphiteURL('https://app.graphite.dev/github/pr/shop/world/337891');
      expect(result).toEqual({ owner: 'shop', repo: 'world', number: 337891 });
    });

    it('should parse Graphite URL with .com domain', () => {
      const result = parser.parseGraphiteURL('https://app.graphite.com/github/pr/shop/world/337891');
      expect(result).toEqual({ owner: 'shop', repo: 'world', number: 337891 });
    });

    it('should parse Graphite URL with encoded title segment', () => {
      const result = parser.parseGraphiteURL('https://app.graphite.com/github/pr/shop/world/338808/%5BConveyor%5D-Minor-update-to-audit-release-cycle-help');
      expect(result).toEqual({ owner: 'shop', repo: 'world', number: 338808 });
    });

    it('should parse Graphite URL with plain title segment', () => {
      const result = parser.parseGraphiteURL('https://app.graphite.dev/github/pr/my-org/my-repo/12345/fix-bug-in-parser');
      expect(result).toEqual({ owner: 'my-org', repo: 'my-repo', number: 12345 });
    });

    it('should handle org/repo with hyphens', () => {
      const result = parser.parseGraphiteURL('https://app.graphite.dev/github/pr/my-cool-org/my-cool-repo/999');
      expect(result).toEqual({ owner: 'my-cool-org', repo: 'my-cool-repo', number: 999 });
    });

    it('should throw error for invalid Graphite URL missing PR number', () => {
      expect(() => parser.parseGraphiteURL('https://app.graphite.dev/github/pr/owner/repo')).toThrow('Invalid Graphite URL format');
    });

    it('should throw error for Graphite URL with invalid PR number', () => {
      expect(() => parser.parseGraphiteURL('https://app.graphite.dev/github/pr/owner/repo/abc')).toThrow('Invalid Graphite URL format');
    });

    it('should throw error for non-Graphite URL', () => {
      expect(() => parser.parseGraphiteURL('https://other-site.com/github/pr/owner/repo/123')).toThrow('Invalid Graphite URL format');
    });

    it('should throw error for Graphite URL with wrong path structure', () => {
      expect(() => parser.parseGraphiteURL('https://app.graphite.dev/gitlab/pr/owner/repo/123')).toThrow('Invalid Graphite URL format');
    });
  });

  describe('parsePRArguments', () => {
    it('should parse GitHub URL', async () => {
      const result = await parser.parsePRArguments(['https://github.com/owner/repo/pull/123']);
      expect(result).toEqual({ owner: 'owner', repo: 'repo', number: 123 });
    });

    it('should parse Graphite .dev URL', async () => {
      const result = await parser.parsePRArguments(['https://app.graphite.dev/github/pr/shop/world/337891']);
      expect(result).toEqual({ owner: 'shop', repo: 'world', number: 337891 });
    });

    it('should parse Graphite .com URL', async () => {
      const result = await parser.parsePRArguments(['https://app.graphite.com/github/pr/shop/world/337891']);
      expect(result).toEqual({ owner: 'shop', repo: 'world', number: 337891 });
    });

    it('should parse Graphite URL with title', async () => {
      const result = await parser.parsePRArguments(['https://app.graphite.com/github/pr/shop/world/338808/%5BConveyor%5D-Minor-update-to-audit-release-cycle-help']);
      expect(result).toEqual({ owner: 'shop', repo: 'world', number: 338808 });
    });

    it('should parse PR number and fetch repo from git remote', async () => {
      parser.git.checkIsRepo.mockResolvedValue(true);
      parser.git.getRemotes.mockResolvedValue([
        { name: 'origin', refs: { fetch: 'https://github.com/my-owner/my-repo.git' } }
      ]);

      const result = await parser.parsePRArguments(['42']);
      expect(result).toEqual({ owner: 'my-owner', repo: 'my-repo', number: 42 });
    });

    it('should throw error for empty arguments', async () => {
      await expect(parser.parsePRArguments([])).rejects.toThrow('Pull request number or URL is required');
    });

    it('should throw error for invalid input', async () => {
      await expect(parser.parsePRArguments(['not-a-number-or-url'])).rejects.toThrow('Invalid input format');
    });
  });

  describe('parseRepositoryFromURL', () => {
    it('should parse HTTPS URL with .git suffix', () => {
      const result = parser.parseRepositoryFromURL('https://github.com/owner/repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse HTTPS URL without .git suffix', () => {
      const result = parser.parseRepositoryFromURL('https://github.com/owner/repo');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse SSH URL with .git suffix', () => {
      const result = parser.parseRepositoryFromURL('git@github.com:owner/repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should parse SSH URL without .git suffix', () => {
      const result = parser.parseRepositoryFromURL('git@github.com:owner/repo');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    it('should throw error for non-GitHub URL', () => {
      expect(() => parser.parseRepositoryFromURL('https://gitlab.com/owner/repo')).toThrow('not a git repository or has no GitHub remote origin');
    });
  });

  describe('validatePRArguments', () => {
    it('should accept valid PR info', () => {
      expect(() => parser.validatePRArguments({ owner: 'owner', repo: 'repo', number: 123 })).not.toThrow();
    });

    it('should throw for missing owner', () => {
      expect(() => parser.validatePRArguments({ repo: 'repo', number: 123 })).toThrow('Invalid repository owner');
    });

    it('should throw for empty owner', () => {
      expect(() => parser.validatePRArguments({ owner: '', repo: 'repo', number: 123 })).toThrow('Invalid repository owner');
    });

    it('should throw for missing repo', () => {
      expect(() => parser.validatePRArguments({ owner: 'owner', number: 123 })).toThrow('Invalid repository name');
    });

    it('should throw for invalid PR number', () => {
      expect(() => parser.validatePRArguments({ owner: 'owner', repo: 'repo', number: 0 })).toThrow('Invalid pull request number');
    });

    it('should throw for negative PR number', () => {
      expect(() => parser.validatePRArguments({ owner: 'owner', repo: 'repo', number: -1 })).toThrow('Invalid pull request number');
    });
  });
});
