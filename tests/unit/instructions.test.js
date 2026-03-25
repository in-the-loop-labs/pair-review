// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tests for instructions utility
 */
import { describe, it, expect } from 'vitest';

const { mergeInstructions } = require('../../src/utils/instructions');

describe('mergeInstructions', () => {
  it('returns null when all inputs are null', () => {
    expect(mergeInstructions({ globalInstructions: null, repoInstructions: null, requestInstructions: null })).toBe(null);
  });

  it('returns null when all inputs are undefined', () => {
    expect(mergeInstructions({})).toBe(null);
  });

  it('returns null when all inputs are empty strings', () => {
    expect(mergeInstructions({ globalInstructions: '', repoInstructions: '', requestInstructions: '' })).toBe(null);
  });

  it('returns null when called with no arguments', () => {
    expect(mergeInstructions()).toBe(null);
  });

  it('returns repo instructions only when others are absent', () => {
    const result = mergeInstructions({ repoInstructions: 'repo instructions' });
    expect(result).toContain('<repo_instructions>');
    expect(result).toContain('repo instructions');
    expect(result).not.toContain('<custom_instructions>');
    expect(result).not.toContain('<global_instructions>');
  });

  it('returns request instructions only when others are absent', () => {
    const result = mergeInstructions({ requestInstructions: 'custom instructions' });
    expect(result).toContain('<custom_instructions>');
    expect(result).toContain('custom instructions');
    expect(result).not.toContain('<repo_instructions>');
    expect(result).not.toContain('<global_instructions>');
  });

  it('returns global instructions only when others are absent', () => {
    const result = mergeInstructions({ globalInstructions: 'global instructions' });
    expect(result).toContain('<global_instructions>');
    expect(result).toContain('global instructions');
    expect(result).not.toContain('<repo_instructions>');
    expect(result).not.toContain('<custom_instructions>');
  });

  it('merges repo and request instructions with proper XML tags', () => {
    const result = mergeInstructions({ repoInstructions: 'repo instructions', requestInstructions: 'custom instructions' });
    expect(result).toContain('<repo_instructions>');
    expect(result).toContain('repo instructions');
    expect(result).toContain('</repo_instructions>');
    expect(result).toContain('<custom_instructions>');
    expect(result).toContain('custom instructions');
    expect(result).toContain('</custom_instructions>');
  });

  it('merges all three instruction levels', () => {
    const result = mergeInstructions({ globalInstructions: 'global', repoInstructions: 'repo', requestInstructions: 'custom' });
    expect(result).toContain('<global_instructions>');
    expect(result).toContain('<repo_instructions>');
    expect(result).toContain('<custom_instructions>');
  });

  it('includes precedence note for custom over repo only when repo present', () => {
    const result = mergeInstructions({ repoInstructions: 'repo', requestInstructions: 'custom' });
    expect(result).toContain('take precedence over repo_instructions');
    expect(result).not.toContain('global_instructions');
  });

  it('includes precedence note for repo over global when global present', () => {
    const result = mergeInstructions({ globalInstructions: 'global', repoInstructions: 'repo' });
    expect(result).toContain('take precedence over global_instructions');
  });

  it('omits precedence note for repo when global absent', () => {
    const result = mergeInstructions({ repoInstructions: 'repo' });
    expect(result).not.toContain('take precedence');
  });

  it('omits precedence note for custom when alone', () => {
    const result = mergeInstructions({ requestInstructions: 'custom' });
    expect(result).not.toContain('take precedence');
  });

  it('custom instructions note mentions both repo and global precedence', () => {
    const result = mergeInstructions({ globalInstructions: 'global', repoInstructions: 'repo', requestInstructions: 'custom' });
    expect(result).toContain('take precedence over repo_instructions and global_instructions');
  });

  it('custom instructions note mentions only global precedence when repo absent', () => {
    const result = mergeInstructions({ globalInstructions: 'global', requestInstructions: 'custom' });
    expect(result).toContain('take precedence over global_instructions');
    expect(result).not.toContain('repo_instructions');
  });

  it('ordering: global before repo before custom', () => {
    const result = mergeInstructions({ globalInstructions: 'global', repoInstructions: 'repo', requestInstructions: 'custom' });
    const globalIndex = result.indexOf('<global_instructions>');
    const repoIndex = result.indexOf('<repo_instructions>');
    const customIndex = result.indexOf('<custom_instructions>');
    expect(globalIndex).toBeLessThan(repoIndex);
    expect(repoIndex).toBeLessThan(customIndex);
  });

  it('handles empty string for repo with valid request', () => {
    const result = mergeInstructions({ repoInstructions: '', requestInstructions: 'custom instructions' });
    expect(result).toContain('<custom_instructions>');
    expect(result).not.toContain('<repo_instructions>');
  });

  it('handles empty string for request with valid repo', () => {
    const result = mergeInstructions({ repoInstructions: 'repo instructions', requestInstructions: '' });
    expect(result).toContain('<repo_instructions>');
    expect(result).not.toContain('<custom_instructions>');
  });

  it('handles empty string for global with valid repo', () => {
    const result = mergeInstructions({ globalInstructions: '', repoInstructions: 'repo instructions' });
    expect(result).toContain('<repo_instructions>');
    expect(result).not.toContain('<global_instructions>');
  });
});
