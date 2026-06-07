// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildDedupInstructions in analyzer.js
 *
 * Verifies the function that builds dedup instruction text for excluding
 * previously identified issues during orchestration/consolidation.
 *
 * The GitHub PR comments section is now rendered from pre-fetched comments
 * (see fetchExistingReviewComments) rather than asking the AI to spawn
 * `gh api` — the analyzer no longer depends on the `gh` CLI.
 */
import { describe, it, expect } from 'vitest';

const { buildDedupInstructions } = require('../../src/ai/analyzer');

describe('buildDedupInstructions', () => {
  const sampleComments = [
    { path: 'src/foo.js', line: 12, original_line: 12, body: 'Missing error handling here' },
    { path: 'src/bar.js', line: 45, original_line: 44, body: 'Consider renaming this variable' }
  ];

  const fullContext = {
    reviewId: 7,
    serverPort: 7247,
    githubComments: sampleComments,
  };

  // ── Falsy / disabled cases ────────────────────────────────────────

  it('returns empty string when excludePrevious is null', () => {
    expect(buildDedupInstructions(null, fullContext)).toBe('');
  });

  it('returns empty string when excludePrevious is undefined', () => {
    expect(buildDedupInstructions(undefined, fullContext)).toBe('');
  });

  it('returns empty string when excludePrevious is false', () => {
    expect(buildDedupInstructions(false, fullContext)).toBe('');
  });

  it('returns empty string when both github and feedback are false', () => {
    expect(buildDedupInstructions({ github: false, feedback: false }, fullContext)).toBe('');
  });

  it('returns empty string when both github and feedback are explicitly undefined', () => {
    expect(buildDedupInstructions({ github: undefined, feedback: undefined }, fullContext)).toBe('');
  });

  // ── GitHub-only ───────────────────────────────────────────────────

  it('returns instructions with GitHub section when github=true and pre-fetched comments are present', () => {
    const result = buildDedupInstructions({ github: true, feedback: false }, fullContext);
    expect(result).toContain('## Exclude Previously Identified Issues');
    expect(result).toContain('### GitHub PR Review Comments');
    expect(result).not.toContain('### Existing Pair-Review Feedback');
  });

  it('GitHub section embeds the pre-fetched comments as JSON (no gh CLI invocation)', () => {
    const result = buildDedupInstructions({ github: true }, {
      githubComments: sampleComments,
    });
    // The shell-out should be gone entirely
    expect(result).not.toContain('gh api');
    expect(result).not.toMatch(/gh\s+api/);
    // The data should be embedded in the prompt
    expect(result).toContain('src/foo.js');
    expect(result).toContain('Missing error handling here');
    expect(result).toContain('src/bar.js');
    expect(result).toContain('Consider renaming this variable');
  });

  it('returns empty string when github=true but no comments were provided (githubComments missing)', () => {
    expect(buildDedupInstructions({ github: true }, {})).toBe('');
  });

  it('returns empty string when github=true but the comments array is empty', () => {
    expect(buildDedupInstructions({ github: true }, { githubComments: [] })).toBe('');
  });

  it('returns empty string when github=true but githubComments is not an array', () => {
    expect(buildDedupInstructions({ github: true }, { githubComments: 'not-an-array' })).toBe('');
  });

  // ── Pair-review feedback-only ─────────────────────────────────────

  it('returns instructions with pair-review section when feedback=true and context has review info', () => {
    const result = buildDedupInstructions({ github: false, feedback: true }, fullContext);
    expect(result).toContain('## Exclude Previously Identified Issues');
    expect(result).toContain('### Existing Pair-Review Feedback');
    expect(result).not.toContain('### GitHub PR Review Comments');
  });

  it('pair-review section includes correct curl commands with port and reviewId', () => {
    const result = buildDedupInstructions({ feedback: true }, {
      reviewId: 13,
      serverPort: 8080,
    });
    expect(result).toContain('curl -s "http://localhost:8080/api/reviews/13/suggestions?allRuns=true&levels=final"');
    expect(result).toContain('curl -s "http://localhost:8080/api/reviews/13/comments?includeDismissed=true"');
  });

  it('pair-review section includes excludeRunId when context.runId is provided', () => {
    const result = buildDedupInstructions({ feedback: true }, {
      reviewId: 13,
      serverPort: 8080,
      runId: 'run-abc-123',
    });
    expect(result).toContain('curl -s "http://localhost:8080/api/reviews/13/suggestions?allRuns=true&levels=final&excludeRunId=run-abc-123"');
  });

  it('pair-review section omits excludeRunId when context.runId is not provided', () => {
    const result = buildDedupInstructions({ feedback: true }, {
      reviewId: 13,
      serverPort: 8080,
    });
    expect(result).not.toContain('excludeRunId');
  });

  it('returns empty string when feedback=true but reviewId is missing from context', () => {
    expect(buildDedupInstructions({ feedback: true }, {
      serverPort: 7247,
    })).toBe('');
  });

  it('returns empty string when feedback=true but serverPort is missing from context', () => {
    expect(buildDedupInstructions({ feedback: true }, {
      reviewId: 7,
    })).toBe('');
  });

  // ── Both sources ──────────────────────────────────────────────────

  it('returns instructions with both sections when both are true and both context bundles are present', () => {
    const result = buildDedupInstructions({ github: true, feedback: true }, fullContext);
    expect(result).toContain('### GitHub PR Review Comments');
    expect(result).toContain('### Existing Pair-Review Feedback');
    expect(result).toContain('## Exclude Previously Identified Issues');
    // No shell-out leaks through
    expect(result).not.toContain('gh api');
  });

  it('includes the exclusion-count reporting instruction when at least one source is active', () => {
    const result = buildDedupInstructions({ github: true }, { githubComments: sampleComments });
    expect(result).toContain('Report how many suggestions were excluded');
  });

  // ── Mixed: one source enabled but its context fields are missing ──

  it('returns GitHub section only when feedback=true but feedback context fields are absent', () => {
    const result = buildDedupInstructions(
      { github: true, feedback: true },
      { githubComments: sampleComments }
    );
    expect(result).toContain('### GitHub PR Review Comments');
    expect(result).not.toContain('### Existing Pair-Review Feedback');
  });

  it('returns pair-review section only when github=true but no comments were pre-fetched', () => {
    const result = buildDedupInstructions(
      { github: true, feedback: true },
      { reviewId: 7, serverPort: 7247 }
    );
    expect(result).not.toContain('### GitHub PR Review Comments');
    expect(result).toContain('### Existing Pair-Review Feedback');
  });

  it('returns empty string when both are true but all context fields are absent', () => {
    expect(buildDedupInstructions({ github: true, feedback: true }, {})).toBe('');
  });

  // ── Undefined context ────────────────────────────────────────────

  it('handles undefined context gracefully', () => {
    expect(buildDedupInstructions({ github: true, feedback: true }, undefined)).toBe('');
  });

  // ── excludeRunIds array support ─────────────────────────────────

  it('excludeRunIds array produces comma-separated excludeRunId in the curl URL', () => {
    const result = buildDedupInstructions({ feedback: true }, {
      reviewId: 13,
      serverPort: 8080,
      excludeRunIds: ['parent-run', 'child-run-1', 'child-run-2'],
    });
    expect(result).toContain('&excludeRunId=parent-run,child-run-1,child-run-2"');
  });

  it('single-element excludeRunIds works the same as runId', () => {
    const resultArray = buildDedupInstructions({ feedback: true }, {
      reviewId: 13,
      serverPort: 8080,
      excludeRunIds: ['run-abc-123'],
    });
    const resultSingle = buildDedupInstructions({ feedback: true }, {
      reviewId: 13,
      serverPort: 8080,
      runId: 'run-abc-123',
    });
    expect(resultArray).toContain('&excludeRunId=run-abc-123"');
    expect(resultSingle).toContain('&excludeRunId=run-abc-123"');
    expect(resultArray).toBe(resultSingle);
  });

  it('excludeRunIds takes precedence over runId when both are provided', () => {
    const result = buildDedupInstructions({ feedback: true }, {
      reviewId: 13,
      serverPort: 8080,
      runId: 'should-be-ignored',
      excludeRunIds: ['id-a', 'id-b'],
    });
    expect(result).toContain('&excludeRunId=id-a,id-b"');
    expect(result).not.toContain('should-be-ignored');
  });

  it('empty excludeRunIds array falls back to runId', () => {
    const result = buildDedupInstructions({ feedback: true }, {
      reviewId: 13,
      serverPort: 8080,
      runId: 'fallback-run',
      excludeRunIds: [],
    });
    expect(result).toContain('&excludeRunId=fallback-run"');
  });
});
