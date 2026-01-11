// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for instructions utility
 */
import { describe, it, expect } from 'vitest';

const { mergeInstructions } = require('../../src/utils/instructions');

describe('mergeInstructions', () => {
  it('returns null when both inputs are null', () => {
    expect(mergeInstructions(null, null)).toBe(null);
  });

  it('returns null when both inputs are undefined', () => {
    expect(mergeInstructions(undefined, undefined)).toBe(null);
  });

  it('returns null when both inputs are empty strings', () => {
    expect(mergeInstructions('', '')).toBe(null);
  });

  it('returns repo instructions only when request is null', () => {
    const result = mergeInstructions('repo instructions', null);
    expect(result).toContain('<repo_instructions>');
    expect(result).toContain('repo instructions');
    expect(result).not.toContain('<custom_instructions>');
  });

  it('returns request instructions only when repo is null', () => {
    const result = mergeInstructions(null, 'custom instructions');
    expect(result).toContain('<custom_instructions>');
    expect(result).toContain('custom instructions');
    expect(result).not.toContain('<repo_instructions>');
  });

  it('merges both instructions with proper XML tags', () => {
    const result = mergeInstructions('repo instructions', 'custom instructions');
    expect(result).toContain('<repo_instructions>');
    expect(result).toContain('repo instructions');
    expect(result).toContain('</repo_instructions>');
    expect(result).toContain('<custom_instructions>');
    expect(result).toContain('custom instructions');
    expect(result).toContain('</custom_instructions>');
  });

  it('includes precedence note for custom instructions', () => {
    const result = mergeInstructions('repo', 'custom');
    expect(result).toContain('take precedence over the repo_instructions');
  });

  it('repo instructions appear before custom instructions', () => {
    const result = mergeInstructions('repo', 'custom');
    const repoIndex = result.indexOf('<repo_instructions>');
    const customIndex = result.indexOf('<custom_instructions>');
    expect(repoIndex).toBeLessThan(customIndex);
  });

  it('handles empty string for repo with valid request', () => {
    const result = mergeInstructions('', 'custom instructions');
    expect(result).toContain('<custom_instructions>');
    expect(result).not.toContain('<repo_instructions>');
  });

  it('handles empty string for request with valid repo', () => {
    const result = mergeInstructions('repo instructions', '');
    expect(result).toContain('<repo_instructions>');
    expect(result).not.toContain('<custom_instructions>');
  });
});
