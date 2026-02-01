// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

const {
  buildAnalysisLineNumberGuidance,
  buildOrchestrationLineNumberGuidance,
} = require('../../src/ai/prompts/line-number-guidance');

describe('buildAnalysisLineNumberGuidance', () => {
  it('returns the Viewing Code Changes section', () => {
    const result = buildAnalysisLineNumberGuidance();
    expect(result).toContain('## Viewing Code Changes');
  });

  it('returns the Line Number Precision section', () => {
    const result = buildAnalysisLineNumberGuidance();
    expect(result).toContain('## Line Number Precision');
  });

  it('includes the two-column diff format example', () => {
    const result = buildAnalysisLineNumberGuidance();
    expect(result).toContain('OLD | NEW');
    expect(result).toContain('[+]');
    expect(result).toContain('[-]');
  });

  it('includes guidance for each line type', () => {
    const result = buildAnalysisLineNumberGuidance();
    expect(result).toContain('ADDED lines [+]: use the NEW column number');
    expect(result).toContain('CONTEXT lines: use the NEW column number');
    expect(result).toContain('DELETED lines [-]: use the OLD column number');
  });

  it('defaults to git-diff-lines when no scriptCommand is provided', () => {
    const result = buildAnalysisLineNumberGuidance();
    expect(result).toContain('git-diff-lines');
    expect(result).not.toContain('--cwd');
  });

  it('defaults to git-diff-lines when options is empty', () => {
    const result = buildAnalysisLineNumberGuidance({});
    expect(result).toContain('git-diff-lines');
    expect(result).not.toContain('--cwd');
  });

  it('uses the provided scriptCommand in the code block and examples', () => {
    const cmd = 'git-diff-lines --cwd "/my/worktree"';
    const result = buildAnalysisLineNumberGuidance({ scriptCommand: cmd });

    expect(result).toContain(cmd);
    expect(result).toContain(`${cmd} HEAD~1`);
    expect(result).toContain(`${cmd} -- src/`);
  });

  it('does not contain the orchestration-specific heading', () => {
    const result = buildAnalysisLineNumberGuidance();
    expect(result).not.toContain('## Line Number Handling');
    expect(result).not.toContain('curation and synthesis');
  });
});

describe('buildOrchestrationLineNumberGuidance', () => {
  it('returns the Line Number Handling section', () => {
    const result = buildOrchestrationLineNumberGuidance();
    expect(result).toContain('## Line Number Handling');
  });

  it('instructs to preserve line numbers as-is', () => {
    const result = buildOrchestrationLineNumberGuidance();
    expect(result).toContain('Preserve line numbers as-is');
  });

  it('mentions old_or_new preservation', () => {
    const result = buildOrchestrationLineNumberGuidance();
    expect(result).toContain('old_or_new');
    expect(result).toContain('Preserve `old_or_new` values');
  });

  it('includes the level preference hierarchy for architectural issues', () => {
    const result = buildOrchestrationLineNumberGuidance();
    expect(result).toContain('Level 3 > Level 2 > Level 1');
  });

  it('distinguishes architectural vs line-level issue preferences', () => {
    const result = buildOrchestrationLineNumberGuidance();
    expect(result).toContain('architectural or cross-cutting issues');
    expect(result).toContain('precise line-level bugs or typos');
  });

  it('defaults to git-diff-lines when no scriptCommand is provided', () => {
    const result = buildOrchestrationLineNumberGuidance();
    expect(result).toContain('git-diff-lines');
    expect(result).not.toContain('--cwd');
  });

  it('defaults to git-diff-lines when options is empty', () => {
    const result = buildOrchestrationLineNumberGuidance({});
    expect(result).toContain('git-diff-lines');
    expect(result).not.toContain('--cwd');
  });

  it('uses the provided scriptCommand in the code block and examples', () => {
    const cmd = 'git-diff-lines --cwd "/my/worktree"';
    const result = buildOrchestrationLineNumberGuidance({ scriptCommand: cmd });

    expect(result).toContain(cmd);
    expect(result).toContain(`${cmd} HEAD~1`);
    expect(result).toContain(`${cmd} -- src/`);
  });

  it('does not contain the analysis-specific heading', () => {
    const result = buildOrchestrationLineNumberGuidance();
    expect(result).not.toContain('## Line Number Precision');
    expect(result).not.toContain('## Viewing Code Changes');
  });
});
