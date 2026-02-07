// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeSemanticSimilarity,
  computeLineOverlap,
  matchSuggestions,
} from '../src/matcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '..', 'fixtures');

// ---------------------------------------------------------------------------
// Helper to load fixtures
// ---------------------------------------------------------------------------
function loadGroundTruth(filename) {
  const raw = readFileSync(resolve(FIXTURES_DIR, 'ground-truth', filename), 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function loadSuggestions(filename) {
  const raw = readFileSync(resolve(FIXTURES_DIR, 'suggestions', filename), 'utf-8');
  return JSON.parse(raw);
}

// ===========================================================================
// computeSemanticSimilarity
// ===========================================================================
describe('computeSemanticSimilarity', () => {
  it('returns high similarity for identical text', () => {
    const text = 'Missing validation on the title field allows blank records';
    const score = computeSemanticSimilarity(text, text);
    expect(score).toBe(1);
  });

  it('returns low or zero similarity for completely different text', () => {
    const a = 'SQL injection vulnerability in login form';
    const b = 'CSS flexbox alignment issue on mobile viewport';
    const score = computeSemanticSimilarity(a, b);
    expect(score).toBeLessThan(0.15);
  });

  it('returns moderate similarity for related descriptions of the same issue', () => {
    const a = 'Mass assignment vulnerability allows setting admin attributes';
    const b = 'Unsafe mass assignment permits setting arbitrary attributes';
    const score = computeSemanticSimilarity(a, b);
    // These share tokens like "mass", "assignment", "setting", "attributes"
    // but differ in other words, so similarity is moderate
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('returns 0 for two empty strings', () => {
    expect(computeSemanticSimilarity('', '')).toBe(0);
  });

  it('returns 0 when one string is empty and the other is not', () => {
    expect(computeSemanticSimilarity('', 'some real text here')).toBe(0);
    expect(computeSemanticSimilarity('meaningful words present', '')).toBe(0);
  });

  it('returns 0 when text contains only stop words', () => {
    const stopOnly = 'the a an is are was were be been being have has had do does';
    expect(computeSemanticSimilarity(stopOnly, stopOnly)).toBe(0);
  });

  it('returns 0 when one text has only stop words and the other has real words', () => {
    const stopOnly = 'the is a an to for of with by from';
    const real = 'validation missing on title field';
    expect(computeSemanticSimilarity(stopOnly, real)).toBe(0);
  });

  it('handles null and undefined gracefully', () => {
    expect(computeSemanticSimilarity(null, 'text')).toBe(0);
    expect(computeSemanticSimilarity('text', undefined)).toBe(0);
    expect(computeSemanticSimilarity(null, null)).toBe(0);
  });
});

// ===========================================================================
// computeLineOverlap
// ===========================================================================
describe('computeLineOverlap', () => {
  it('returns overlap for exact same range', () => {
    const result = computeLineOverlap(
      { line_start: 10, line_end: 20 },
      { line_start: 10, line_end: 20 },
      5,
    );
    expect(result).toEqual({ match: true, type: 'overlap' });
  });

  it('returns overlap for partially intersecting ranges', () => {
    const result = computeLineOverlap(
      { line_start: 10, line_end: 20 },
      { line_start: 15, line_end: 25 },
      5,
    );
    expect(result).toEqual({ match: true, type: 'overlap' });
  });

  it('returns proximity when ranges are within tolerance', () => {
    const result = computeLineOverlap(
      { line_start: 10, line_end: 12 },
      { line_start: 16, line_end: 20 },
      5,
    );
    // Gap between 12 and 16 is 4, which is <= 5 tolerance
    expect(result).toEqual({ match: true, type: 'proximity' });
  });

  it('returns none when ranges are beyond tolerance', () => {
    const result = computeLineOverlap(
      { line_start: 10, line_end: 12 },
      { line_start: 30, line_end: 35 },
      5,
    );
    expect(result).toEqual({ match: false, type: 'none' });
  });

  it('returns file_level when suggestion is file-level', () => {
    const result = computeLineOverlap(
      { line_start: null, line_end: null, is_file_level: true },
      { line_start: 10, line_end: 20 },
      5,
    );
    expect(result).toEqual({ match: true, type: 'file_level' });
  });

  it('returns file_level when suggestion has null lines (implicit file-level)', () => {
    const result = computeLineOverlap(
      { line_start: null, line_end: null },
      { line_start: 10, line_end: 20 },
      5,
    );
    expect(result).toEqual({ match: true, type: 'file_level' });
  });

  it('returns file_level when ground truth is file-level', () => {
    const result = computeLineOverlap(
      { line_start: 10, line_end: 20 },
      { line_start: null, line_end: null, is_file_level: true },
      5,
    );
    expect(result).toEqual({ match: true, type: 'file_level' });
  });

  it('returns file_level when both are file-level', () => {
    const result = computeLineOverlap(
      { line_start: null, line_end: null, is_file_level: true },
      { line_start: null, line_end: null, is_file_level: true },
      5,
    );
    expect(result).toEqual({ match: true, type: 'file_level' });
  });

  it('treats null line_end as single-line (same as line_start)', () => {
    // Suggestion line 15, GT line 15 — should overlap even with null line_end
    const result = computeLineOverlap(
      { line_start: 15, line_end: null },
      { line_start: 15, line_end: null },
      0,
    );
    expect(result).toEqual({ match: true, type: 'overlap' });
  });

  it('treats null line_end as single-line range for proximity', () => {
    // Suggestion line 10, GT line 13, tolerance 5 — gap of 3
    const result = computeLineOverlap(
      { line_start: 10, line_end: null },
      { line_start: 13, line_end: null },
      5,
    );
    expect(result).toEqual({ match: true, type: 'proximity' });
  });

  it('matches exact overlap with zero tolerance', () => {
    const result = computeLineOverlap(
      { line_start: 5, line_end: 10 },
      { line_start: 8, line_end: 15 },
      0,
    );
    expect(result).toEqual({ match: true, type: 'overlap' });
  });

  it('does not match proximity with zero tolerance when ranges are adjacent but not overlapping', () => {
    const result = computeLineOverlap(
      { line_start: 5, line_end: 10 },
      { line_start: 11, line_end: 15 },
      0,
    );
    // Gap is 1 (11 - 10 = 1), but tolerance is 0
    expect(result).toEqual({ match: false, type: 'none' });
  });
});

// ===========================================================================
// matchSuggestions
// ===========================================================================
describe('matchSuggestions', () => {
  it('produces an exact match for same file, overlapping lines, same type, related descriptions', () => {
    const gt = [
      {
        id: 'gt-1',
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        severity: 'high',
        title: 'Missing null check on user input',
        description: 'The function does not check for null input before accessing properties.',
      },
    ];
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        title: 'Null check missing on user input',
        description: 'No null check before property access on the input parameter.',
      },
    ];

    const result = matchSuggestions(suggestions, gt);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].quality).toBe('exact');
    expect(result.matches[0].score).toBe(1.0);
    expect(result.misses).toHaveLength(0);
    expect(result.falsePositives).toHaveLength(0);
  });

  it('produces a partial match for same file, nearby lines within tolerance', () => {
    const gt = [
      {
        id: 'gt-1',
        file: 'src/foo.js',
        line_start: 10,
        line_end: 12,
        type: 'bug',
        severity: 'medium',
        title: 'Missing null check on user input',
        description: 'The function does not check for null input before accessing properties.',
      },
    ];
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 16,
        line_end: 18,
        type: 'bug',
        title: 'Null check missing on user input',
        description: 'No null check before property access on the input parameter.',
      },
    ];

    const result = matchSuggestions(suggestions, gt, { line_tolerance: 5 });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].quality).toBe('partial');
    expect(result.matches[0].details.lineMatch).toBe('proximity');
    expect(result.misses).toHaveLength(0);
    expect(result.falsePositives).toHaveLength(0);
  });

  it('flags type_mismatch quality when types differ with allow_type_mismatch=true', () => {
    const gt = [
      {
        id: 'gt-1',
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        severity: 'high',
        title: 'Missing validation on title field',
        description: 'No validation for title presence allowing blank records.',
      },
    ];
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'improvement',
        title: 'Add validation for title field',
        description: 'The title field lacks validation. Add presence validation.',
      },
    ];

    const result = matchSuggestions(suggestions, gt, { allow_type_mismatch: true });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].quality).toBe('type_mismatch');
    expect(result.matches[0].details.typeMatch).toBe(false);
    expect(result.misses).toHaveLength(0);
  });

  it('produces no match when types differ and allow_type_mismatch=false', () => {
    const gt = [
      {
        id: 'gt-1',
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        severity: 'high',
        title: 'Missing validation on title field',
        description: 'No validation for title presence allowing blank records.',
      },
    ];
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'improvement',
        title: 'Add validation for title field',
        description: 'The title field lacks validation. Add presence validation.',
      },
    ];

    const result = matchSuggestions(suggestions, gt, { allow_type_mismatch: false });
    expect(result.matches).toHaveLength(0);
    expect(result.misses).toHaveLength(1);
    expect(result.falsePositives).toHaveLength(1);
  });

  it('reports misses for unmatched ground truth', () => {
    const gt = [
      {
        id: 'gt-1',
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        severity: 'high',
        title: 'Missing null check',
        description: 'No null check before property access.',
      },
    ];
    const suggestions = [];

    const result = matchSuggestions(suggestions, gt);
    expect(result.matches).toHaveLength(0);
    expect(result.misses).toHaveLength(1);
    expect(result.misses[0]).toBe(gt[0]);
    expect(result.falsePositives).toHaveLength(0);
  });

  it('reports false positives for unmatched suggestions', () => {
    const gt = [];
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'code-style',
        title: 'Add frozen string literal',
        description: 'Ruby files should include frozen_string_literal.',
      },
    ];

    const result = matchSuggestions(suggestions, gt);
    expect(result.matches).toHaveLength(0);
    expect(result.misses).toHaveLength(0);
    expect(result.falsePositives).toHaveLength(1);
    expect(result.falsePositives[0]).toBe(suggestions[0]);
  });

  it('enforces 1:1 matching — each GT and suggestion used at most once', () => {
    const gt = [
      {
        id: 'gt-1',
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        severity: 'high',
        title: 'Missing null check on input parameter',
        description: 'No null check before property access on input.',
      },
    ];
    // Two suggestions that could both match the same GT
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        title: 'Null check missing on input parameter',
        description: 'No null check before property access on the input.',
      },
      {
        file: 'src/foo.js',
        line_start: 11,
        line_end: 14,
        type: 'bug',
        title: 'Missing null check on input',
        description: 'Should add null check for input parameter.',
      },
    ];

    const result = matchSuggestions(suggestions, gt);
    // Only one match should be produced, not two
    expect(result.matches).toHaveLength(1);
    // One suggestion should be a false positive
    expect(result.falsePositives).toHaveLength(1);
    expect(result.misses).toHaveLength(0);
  });

  it('uses greedy best-first matching — higher-score matches are preferred', () => {
    const gt = [
      {
        id: 'gt-1',
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        severity: 'high',
        title: 'Missing null check on user input',
        description: 'The function does not check for null input before accessing properties.',
      },
    ];
    // First suggestion: exact type match → should score higher
    const exactSuggestion = {
      file: 'src/foo.js',
      line_start: 10,
      line_end: 15,
      type: 'bug',
      title: 'Missing null check on user input parameter',
      description: 'No null check before accessing properties on user input.',
    };
    // Second suggestion: type mismatch → should score lower
    const mismatchSuggestion = {
      file: 'src/foo.js',
      line_start: 10,
      line_end: 15,
      type: 'improvement',
      title: 'Missing null check on user input',
      description: 'No null check before accessing properties on user input.',
    };
    const suggestions = [mismatchSuggestion, exactSuggestion];

    const result = matchSuggestions(suggestions, gt);
    expect(result.matches).toHaveLength(1);
    // The exact match should be selected, not the type mismatch
    expect(result.matches[0].suggestion).toBe(exactSuggestion);
    expect(result.matches[0].quality).toBe('exact');
  });

  it('matches file-level ground truth with line-level suggestion in same file', () => {
    const gt = [
      {
        id: 'gt-1',
        file: 'src/views/index.html',
        line_start: null,
        line_end: null,
        is_file_level: true,
        type: 'performance',
        severity: 'high',
        title: 'N+1 query on associated records',
        description: 'Iterating records triggers separate query per item.',
      },
    ];
    const suggestions = [
      {
        file: 'src/views/index.html',
        line_start: 5,
        line_end: 10,
        type: 'performance',
        title: 'N+1 query detected in template iteration',
        description: 'Each iteration triggers a separate SQL query for associated records.',
      },
    ];

    const result = matchSuggestions(suggestions, gt);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].details.lineMatch).toBe('file_level');
    expect(result.misses).toHaveLength(0);
  });

  it('does not match suggestions in different files', () => {
    const gt = [
      {
        id: 'gt-1',
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        severity: 'high',
        title: 'Missing null check',
        description: 'No null check before property access.',
      },
    ];
    const suggestions = [
      {
        file: 'src/bar.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        title: 'Missing null check',
        description: 'No null check before property access.',
      },
    ];

    const result = matchSuggestions(suggestions, gt);
    expect(result.matches).toHaveLength(0);
    expect(result.misses).toHaveLength(1);
    expect(result.falsePositives).toHaveLength(1);
  });

  describe('empty inputs', () => {
    it('returns all misses when there are no suggestions', () => {
      const gt = [
        {
          id: 'gt-1',
          file: 'src/foo.js',
          line_start: 10,
          line_end: 15,
          type: 'bug',
          severity: 'high',
          title: 'Issue',
          description: 'An issue.',
        },
      ];
      const result = matchSuggestions([], gt);
      expect(result.matches).toHaveLength(0);
      expect(result.misses).toHaveLength(1);
      expect(result.falsePositives).toHaveLength(0);
    });

    it('returns all false positives when there is no ground truth', () => {
      const suggestions = [
        {
          file: 'src/foo.js',
          line_start: 10,
          line_end: 15,
          type: 'bug',
          title: 'Issue',
          description: 'An issue.',
        },
      ];
      const result = matchSuggestions(suggestions, []);
      expect(result.matches).toHaveLength(0);
      expect(result.misses).toHaveLength(0);
      expect(result.falsePositives).toHaveLength(1);
    });

    it('returns empty results when both are empty', () => {
      const result = matchSuggestions([], []);
      expect(result.matches).toHaveLength(0);
      expect(result.misses).toHaveLength(0);
      expect(result.falsePositives).toHaveLength(0);
      expect(result.bonusFinds).toHaveLength(0);
    });
  });

  describe('integration with pr-03 fixtures', () => {
    it('matches pr-03-good suggestions against ground truth with expected results', () => {
      const gt = loadGroundTruth('pr-03.jsonl');
      const suggestions = loadSuggestions('pr-03-good.json');

      expect(gt).toHaveLength(5);
      expect(suggestions).toHaveLength(5);

      const result = matchSuggestions(suggestions, gt);

      // The "good" suggestions should match most ground truth entries:
      // - 03-002 (security / mass assignment) -> exact match to suggestion[0] (security, same line)
      // - 03-001 (design / fat controller) -> match to suggestion[1] (design, overlapping lines)
      // - 03-003 (performance / N+1) -> match to suggestion[2] (performance, file-level)
      // - 03-004 (bug / missing validation) -> type_mismatch to suggestion[3] (improvement, overlapping lines)
      // - 03-005 (code-style / error handling) -> miss (suggestion[4] is on different lines and unrelated topic)
      expect(result.matches.length).toBeGreaterThanOrEqual(3);

      // Should have few misses
      expect(result.misses.length).toBeLessThanOrEqual(2);

      // Verify matched items reference the actual ground truth and suggestion objects
      for (const match of result.matches) {
        expect(match.groundTruth).toBeDefined();
        expect(match.suggestion).toBeDefined();
        expect(match.quality).toBeDefined();
        expect(match.score).toBeGreaterThan(0);
        expect(match.details.fileMatch).toBe(true);
      }
    });

    it('matches pr-03-poor suggestions against ground truth with worse results', () => {
      const gt = loadGroundTruth('pr-03.jsonl');
      const goodSuggestions = loadSuggestions('pr-03-good.json');
      const poorSuggestions = loadSuggestions('pr-03-poor.json');

      const goodResult = matchSuggestions(goodSuggestions, gt);
      const poorResult = matchSuggestions(poorSuggestions, gt);

      // Poor suggestions should have fewer matches than good suggestions
      expect(poorResult.matches.length).toBeLessThan(goodResult.matches.length);

      // Poor suggestions are mostly about frozen_string_literal and route style,
      // which don't match any ground truth entries
      expect(poorResult.falsePositives.length).toBeGreaterThan(0);
      expect(poorResult.misses.length).toBeGreaterThan(goodResult.misses.length);
    });
  });

  it('normalises leading slashes in file paths', () => {
    const gt = [
      {
        id: 'gt-1',
        file: '/src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        severity: 'high',
        title: 'Missing null check on input',
        description: 'No null check before property access.',
      },
    ];
    const suggestions = [
      {
        file: 'src/foo.js',
        line_start: 10,
        line_end: 15,
        type: 'bug',
        title: 'Null check missing on input',
        description: 'Should add null check for input.',
      },
    ];

    const result = matchSuggestions(suggestions, gt);
    expect(result.matches).toHaveLength(1);
  });
});
