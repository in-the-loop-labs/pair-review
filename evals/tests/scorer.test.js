// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { computeScores } from '../src/scorer.js';

// ===========================================================================
// Helper to build match results quickly
// ===========================================================================
function makeMatch(gtOverrides = {}, sugOverrides = {}, matchOverrides = {}) {
  return {
    groundTruth: {
      id: 'gt-1',
      file: 'src/foo.js',
      line_start: 10,
      line_end: 15,
      type: 'bug',
      severity: 'medium',
      title: 'Some issue',
      description: 'A description.',
      ...gtOverrides,
    },
    suggestion: {
      file: 'src/foo.js',
      line_start: 10,
      line_end: 15,
      type: 'bug',
      title: 'Some issue',
      description: 'A description.',
      ...sugOverrides,
    },
    quality: 'exact',
    score: 1.0,
    details: {
      fileMatch: true,
      lineMatch: 'overlap',
      typeMatch: true,
      semanticScore: 0.8,
    },
    ...matchOverrides,
  };
}

function makeMiss(overrides = {}) {
  return {
    id: 'miss-1',
    file: 'src/bar.js',
    line_start: 20,
    line_end: 25,
    type: 'bug',
    severity: 'medium',
    title: 'Missed issue',
    description: 'A missed issue.',
    ...overrides,
  };
}

function makeFalsePositive(overrides = {}) {
  return {
    file: 'src/baz.js',
    line_start: 30,
    line_end: 35,
    type: 'code-style',
    title: 'Spurious suggestion',
    description: 'Not a real issue.',
    ...overrides,
  };
}

// ===========================================================================
// Overall metrics
// ===========================================================================
describe('computeScores — overall metrics', () => {
  it('computes perfect detection: all matched, no misses, no false positives', () => {
    const matchResults = {
      matches: [
        makeMatch({ severity: 'high' }),
        makeMatch({ id: 'gt-2', severity: 'medium' }),
      ],
      misses: [],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    expect(scores.overall.recall).toBe(1);
    expect(scores.overall.precision).toBe(1);
    expect(scores.overall.f1).toBe(1);
    expect(scores.overall.totalMatches).toBe(2);
    expect(scores.overall.totalMisses).toBe(0);
    expect(scores.overall.totalFalsePositives).toBe(0);
    expect(scores.overall.totalGroundTruth).toBe(2);
    expect(scores.overall.totalSuggestions).toBe(2);
  });

  it('computes zero detection: no matches, all misses', () => {
    const matchResults = {
      matches: [],
      misses: [makeMiss({ severity: 'critical' }), makeMiss({ id: 'miss-2', severity: 'high' })],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    expect(scores.overall.recall).toBe(0);
    // With no suggestions at all, precision is 0/0 → 0
    expect(scores.overall.precision).toBe(0);
    expect(scores.overall.f1).toBe(0);
    expect(scores.overall.totalMatches).toBe(0);
    expect(scores.overall.totalMisses).toBe(2);
  });

  it('computes mixed results correctly', () => {
    // 2 matches, 1 miss, 1 false positive
    const matchResults = {
      matches: [
        makeMatch({ severity: 'high' }),
        makeMatch({ id: 'gt-2', severity: 'low' }),
      ],
      misses: [makeMiss({ severity: 'medium' })],
      falsePositives: [makeFalsePositive()],
    };

    const scores = computeScores(matchResults);
    // recall = 2/3 ≈ 0.67
    expect(scores.overall.recall).toBeCloseTo(0.67, 2);
    // precision = 2/3 ≈ 0.67
    expect(scores.overall.precision).toBeCloseTo(0.67, 2);
    // f1 = 2 * (2/3 * 2/3) / (2/3 + 2/3) = 2/3 ≈ 0.67
    expect(scores.overall.f1).toBeCloseTo(0.67, 2);
  });

  it('computes weighted recall with severity weights', () => {
    // One critical match (score=1.0, weight=4) and one critical miss (weight=4)
    const matchResults = {
      matches: [makeMatch({ severity: 'critical' }, {}, { score: 1.0 })],
      misses: [makeMiss({ severity: 'critical' })],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    // weightedRecall = (1.0 * 4) / (4 + 4) = 4/8 = 0.5
    expect(scores.overall.weightedRecall).toBe(0.5);
  });

  it('accounts for partial scores in weighted recall', () => {
    // One high match with partial score (0.6), one low miss
    const matchResults = {
      matches: [makeMatch({ severity: 'high' }, {}, { score: 0.6 })],
      misses: [makeMiss({ severity: 'low' })],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    // Default weights: high=3, low=1
    // weightedRecall = (0.6 * 3) / (3 + 1) = 1.8 / 4 = 0.45
    expect(scores.overall.weightedRecall).toBe(0.45);
  });
});

// ===========================================================================
// By-type breakdown
// ===========================================================================
describe('computeScores — byType breakdown', () => {
  it('computes recall=1 for a type with all matched', () => {
    const matchResults = {
      matches: [makeMatch({ type: 'bug' }, { type: 'bug' })],
      misses: [],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    expect(scores.byType.bug).toBeDefined();
    expect(scores.byType.bug.recall).toBe(1);
    expect(scores.byType.bug.precision).toBe(1);
    expect(scores.byType.bug.f1).toBe(1);
  });

  it('computes recall=0 for a type with none matched', () => {
    const matchResults = {
      matches: [],
      misses: [makeMiss({ type: 'security' })],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    expect(scores.byType.security).toBeDefined();
    expect(scores.byType.security.recall).toBe(0);
    expect(scores.byType.security.groundTruthCount).toBe(1);
    expect(scores.byType.security.matchCount).toBe(0);
  });

  it('handles mixed types with different match rates', () => {
    const matchResults = {
      matches: [
        makeMatch({ type: 'bug' }, { type: 'bug' }),
        makeMatch({ id: 'gt-2', type: 'performance' }, { type: 'performance' }),
      ],
      misses: [
        makeMiss({ type: 'bug' }),
        makeMiss({ id: 'miss-2', type: 'security' }),
      ],
      falsePositives: [makeFalsePositive({ type: 'code-style' })],
    };

    const scores = computeScores(matchResults);
    // bug: 1 match, 1 miss → recall = 0.5
    expect(scores.byType.bug.recall).toBe(0.5);
    expect(scores.byType.bug.groundTruthCount).toBe(2);
    // performance: 1 match, 0 miss → recall = 1
    expect(scores.byType.performance.recall).toBe(1);
    // security: 0 match, 1 miss → recall = 0
    expect(scores.byType.security.recall).toBe(0);
    // code-style: only in false positives → no ground truth, suggestion count = 1
    expect(scores.byType['code-style'].suggestionCount).toBe(1);
    expect(scores.byType['code-style'].groundTruthCount).toBe(0);
  });

  it('counts type mismatch correctly in each bucket', () => {
    // GT type is 'bug', suggestion type is 'improvement'
    const matchResults = {
      matches: [makeMatch({ type: 'bug' }, { type: 'improvement' })],
      misses: [],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    // The GT's type bucket ('bug') gets groundTruthCount++ and matchCount++
    expect(scores.byType.bug.groundTruthCount).toBe(1);
    expect(scores.byType.bug.matchCount).toBe(1);
    // The suggestion's type bucket ('improvement') gets suggestionCount++
    expect(scores.byType.improvement.suggestionCount).toBe(1);
  });
});

// ===========================================================================
// By-severity breakdown
// ===========================================================================
describe('computeScores — bySeverity breakdown', () => {
  it('handles all severities with different match rates', () => {
    const matchResults = {
      matches: [
        makeMatch({ severity: 'critical' }),
        makeMatch({ id: 'gt-2', severity: 'high' }),
      ],
      misses: [
        makeMiss({ severity: 'critical' }),
        makeMiss({ id: 'miss-2', severity: 'low' }),
      ],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    // critical: 1 match + 1 miss = 2 total → recall = 0.5
    expect(scores.bySeverity.critical.recall).toBe(0.5);
    expect(scores.bySeverity.critical.count).toBe(2);
    expect(scores.bySeverity.critical.matchCount).toBe(1);
    // high: 1 match, 0 miss → recall = 1
    expect(scores.bySeverity.high.recall).toBe(1);
    expect(scores.bySeverity.high.count).toBe(1);
    // low: 0 match, 1 miss → recall = 0
    expect(scores.bySeverity.low.recall).toBe(0);
    expect(scores.bySeverity.low.count).toBe(1);
  });

  it('defaults missing severity to medium', () => {
    const matchResults = {
      matches: [makeMatch({ severity: undefined })],
      misses: [makeMiss({ severity: undefined })],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    expect(scores.bySeverity.medium).toBeDefined();
    expect(scores.bySeverity.medium.count).toBe(2);
    expect(scores.bySeverity.medium.matchCount).toBe(1);
    expect(scores.bySeverity.medium.recall).toBe(0.5);
  });
});

// ===========================================================================
// Notable misses
// ===========================================================================
describe('computeScores — notableMisses', () => {
  it('includes critical and high misses, excludes medium and low', () => {
    const matchResults = {
      matches: [],
      misses: [
        makeMiss({ id: 'miss-c', severity: 'critical', title: 'Critical bug' }),
        makeMiss({ id: 'miss-h', severity: 'high', title: 'High sev issue' }),
        makeMiss({ id: 'miss-m', severity: 'medium', title: 'Medium issue' }),
        makeMiss({ id: 'miss-l', severity: 'low', title: 'Low issue' }),
      ],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    expect(scores.notableMisses).toHaveLength(2);
    const ids = scores.notableMisses.map((m) => m.id);
    expect(ids).toContain('miss-c');
    expect(ids).toContain('miss-h');
    expect(ids).not.toContain('miss-m');
    expect(ids).not.toContain('miss-l');
  });

  it('sorts notable misses by severity with critical first', () => {
    const matchResults = {
      matches: [],
      misses: [
        makeMiss({ id: 'miss-h', severity: 'high', title: 'High issue' }),
        makeMiss({ id: 'miss-c', severity: 'critical', title: 'Critical issue' }),
      ],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    expect(scores.notableMisses).toHaveLength(2);
    expect(scores.notableMisses[0].severity).toBe('critical');
    expect(scores.notableMisses[1].severity).toBe('high');
  });

  it('returns empty notable misses when there are no misses', () => {
    const matchResults = {
      matches: [makeMatch({ severity: 'critical' })],
      misses: [],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    expect(scores.notableMisses).toHaveLength(0);
  });

  it('returns empty notable misses when all misses are medium or low', () => {
    const matchResults = {
      matches: [],
      misses: [
        makeMiss({ severity: 'medium' }),
        makeMiss({ id: 'miss-2', severity: 'low' }),
      ],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    expect(scores.notableMisses).toHaveLength(0);
  });

  it('includes correct fields in notable miss entries', () => {
    const matchResults = {
      matches: [],
      misses: [
        makeMiss({
          id: 'miss-c',
          file: 'src/auth.js',
          type: 'security',
          severity: 'critical',
          title: 'SQL injection',
        }),
      ],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    expect(scores.notableMisses).toHaveLength(1);
    const notable = scores.notableMisses[0];
    expect(notable).toEqual({
      id: 'miss-c',
      file: 'src/auth.js',
      type: 'security',
      severity: 'critical',
      title: 'SQL injection',
    });
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================
describe('computeScores — edge cases', () => {
  it('handles empty match results with all arrays empty — no NaN', () => {
    const matchResults = {
      matches: [],
      misses: [],
      falsePositives: [],
    };

    const scores = computeScores(matchResults);
    expect(scores.overall.recall).toBe(0);
    expect(scores.overall.precision).toBe(0);
    expect(scores.overall.f1).toBe(0);
    expect(scores.overall.weightedRecall).toBe(0);
    expect(scores.overall.totalGroundTruth).toBe(0);
    expect(scores.overall.totalSuggestions).toBe(0);
    expect(scores.overall.totalMatches).toBe(0);
    // No NaN values
    for (const value of Object.values(scores.overall)) {
      if (typeof value === 'number') {
        expect(Number.isNaN(value)).toBe(false);
      }
    }
  });

  it('handles all false positives with no ground truth', () => {
    const matchResults = {
      matches: [],
      misses: [],
      falsePositives: [makeFalsePositive(), makeFalsePositive({ type: 'bug' })],
    };

    const scores = computeScores(matchResults);
    expect(scores.overall.recall).toBe(0);
    expect(scores.overall.precision).toBe(0);
    expect(scores.overall.f1).toBe(0);
    expect(scores.overall.totalFalsePositives).toBe(2);
    expect(scores.overall.totalSuggestions).toBe(2);
    expect(scores.overall.totalGroundTruth).toBe(0);
  });

  it('uses custom severity weights when provided', () => {
    const matchResults = {
      matches: [makeMatch({ severity: 'critical' }, {}, { score: 1.0 })],
      misses: [makeMiss({ severity: 'critical' })],
      falsePositives: [],
    };

    // Custom weight: critical = 10 instead of default 4
    const scores = computeScores(matchResults, {
      severity_weights: { critical: 10 },
    });

    // weightedRecall = (1.0 * 10) / (10 + 10) = 0.5
    expect(scores.overall.weightedRecall).toBe(0.5);
  });

  it('handles missing arrays in matchResults gracefully', () => {
    // The scorer normalises missing arrays to []
    const scores = computeScores({});
    expect(scores.overall.recall).toBe(0);
    expect(scores.overall.precision).toBe(0);
    expect(scores.overall.f1).toBe(0);
    expect(scores.overall.totalGroundTruth).toBe(0);
  });

  it('includes bonusFinds passthrough', () => {
    const matchResults = {
      matches: [],
      misses: [],
      falsePositives: [],
      bonusFinds: [{ note: 'extra finding' }],
    };

    const scores = computeScores(matchResults);
    expect(scores.bonusFinds).toEqual([{ note: 'extra finding' }]);
  });
});
