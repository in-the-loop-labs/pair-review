// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildDedupInstructions in analyzer.js
 *
 * Verifies the function that builds dedup instruction text for excluding
 * previously identified issues during orchestration/consolidation.
 */
import { describe, it, expect } from 'vitest';

const { buildDedupInstructions } = require('../../src/ai/analyzer');

describe('buildDedupInstructions', () => {
  const fullContext = {
    owner: 'acme',
    repo: 'widgets',
    pullNumber: 42,
    reviewId: 7,
    serverPort: 7247,
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

  it('returns instructions with GitHub section when github=true and context has PR info', () => {
    const result = buildDedupInstructions({ github: true, feedback: false }, fullContext);
    expect(result).toContain('## Exclude Previously Identified Issues');
    expect(result).toContain('### GitHub PR Review Comments');
    expect(result).not.toContain('### Existing Pair-Review Feedback');
  });

  it('GitHub section includes correct gh api command with owner/repo/pullNumber', () => {
    const result = buildDedupInstructions({ github: true }, {
      owner: 'my-org',
      repo: 'my-repo',
      pullNumber: 99,
    });
    expect(result).toContain('gh api repos/my-org/my-repo/pulls/99/comments --paginate');
  });

  it('returns empty string when github=true but owner is missing from context', () => {
    expect(buildDedupInstructions({ github: true }, {
      repo: 'widgets',
      pullNumber: 42,
    })).toBe('');
  });

  it('returns empty string when github=true but repo is missing from context', () => {
    expect(buildDedupInstructions({ github: true }, {
      owner: 'acme',
      pullNumber: 42,
    })).toBe('');
  });

  it('returns empty string when github=true but pullNumber is missing from context', () => {
    expect(buildDedupInstructions({ github: true }, {
      owner: 'acme',
      repo: 'widgets',
    })).toBe('');
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

  it('returns instructions with both sections when both are true', () => {
    const result = buildDedupInstructions({ github: true, feedback: true }, fullContext);
    expect(result).toContain('### GitHub PR Review Comments');
    expect(result).toContain('### Existing Pair-Review Feedback');
    expect(result).toContain('## Exclude Previously Identified Issues');
  });

  it('includes the exclusion-count reporting instruction when at least one source is active', () => {
    const result = buildDedupInstructions({ github: true }, fullContext);
    expect(result).toContain('Report how many suggestions were excluded');
  });

  // ── Mixed: one source enabled but its context fields are missing ──

  it('returns GitHub section only when feedback=true but feedback context fields are absent', () => {
    const result = buildDedupInstructions(
      { github: true, feedback: true },
      { owner: 'acme', repo: 'widgets', pullNumber: 42 }
    );
    expect(result).toContain('### GitHub PR Review Comments');
    expect(result).not.toContain('### Existing Pair-Review Feedback');
  });

  it('returns pair-review section only when github=true but PR context fields are absent', () => {
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
