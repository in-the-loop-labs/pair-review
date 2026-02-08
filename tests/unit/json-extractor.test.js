// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { extractJSON } from '../../src/utils/json-extractor.js';

describe('extractJSON', () => {
  describe('empty/null input', () => {
    it('should return failure for null input', () => {
      const result = extractJSON(null, 'test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty response');
    });

    it('should return failure for undefined input', () => {
      const result = extractJSON(undefined, 'test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty response');
    });

    it('should return failure for empty string', () => {
      const result = extractJSON('', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty response');
    });

    it('should return failure for whitespace-only string', () => {
      const result = extractJSON('   \n\t  ', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty response');
    });
  });

  describe('pure JSON response', () => {
    it('should parse a simple JSON object', () => {
      const json = '{"level": 2, "suggestions": []}';
      const result = extractJSON(json, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ level: 2, suggestions: [] });
    });

    it('should parse JSON with whitespace padding', () => {
      const json = '  \n  {"level": 1, "suggestions": [{"file": "a.js"}]}  \n  ';
      const result = extractJSON(json, 'test');
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(1);
      expect(result.data.suggestions).toHaveLength(1);
    });

    it('should parse a JSON array', () => {
      const json = '[{"id": 1}, {"id": 2}]';
      const result = extractJSON(json, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('should parse deeply nested JSON', () => {
      const nested = {
        level: 3,
        suggestions: [{
          file: 'test.js',
          details: {
            context: {
              before: { lines: [1, 2, 3] },
              after: { lines: [4, 5, 6] }
            },
            metadata: { tags: ['bug', 'critical'] }
          }
        }]
      };
      const result = extractJSON(JSON.stringify(nested), 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(nested);
    });
  });

  describe('JSON with text preamble (the main bug case)', () => {
    it('should extract JSON after simple preamble text', () => {
      const text = 'Now I have a thorough understanding of the changes. Let me produce the review.\n\n' +
        '{"level": 2, "suggestions": [{"file": "test.js", "line": 1, "type": "bug"}]}';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(2);
      expect(result.data.suggestions).toHaveLength(1);
    });

    it('should extract JSON after preamble containing curly braces', () => {
      const text = 'I see the function handleEvent(event) { could be improved. ' +
        'Also the config = {} initialization looks wrong.\n\n' +
        '{"level": 2, "suggestions": [{"file": "test.js", "line": 5, "type": "improvement"}]}';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(2);
      expect(result.data.suggestions).toHaveLength(1);
      expect(result.data.suggestions[0].type).toBe('improvement');
    });

    it('should extract JSON after preamble with multiple brace pairs', () => {
      const text = 'Looking at function() { if (x) { while (true) { doStuff() } } } ' +
        'and also obj = { a: { b: 1 } }\n\n' +
        '{"level": 1, "suggestions": [{"file": "a.js", "line": 10, "type": "bug"}]}';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(1);
    });

    it('should extract JSON after preamble with backtick code blocks containing braces', () => {
      const text = 'The code uses `const obj = { key: value }` pattern and `if (cond) { return }` flow.\n\n' +
        '{"level": 2, "suggestions": []}';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(2);
    });

    it('should extract JSON after multi-line preamble', () => {
      const text = 'I have analyzed the changes carefully.\n' +
        'Here are the key findings:\n' +
        '1. The error handling is incomplete\n' +
        '2. The function uses { incorrectly\n' +
        '3. The config object { key: val } should be refactored\n\n' +
        '{"suggestions": [{"file": "main.js", "line": 42, "type": "bug", "title": "Missing error handling"}]}';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.suggestions).toHaveLength(1);
      expect(result.data.suggestions[0].title).toBe('Missing error handling');
    });
  });

  describe('JSON wrapped in markdown code blocks', () => {
    it('should extract JSON from ```json code block', () => {
      const text = 'Here is the review:\n\n```json\n{"level": 1, "suggestions": []}\n```\n\nDone.';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ level: 1, suggestions: [] });
    });

    it('should extract JSON from generic ``` code block', () => {
      const text = 'Review:\n\n```\n{"level": 2, "suggestions": [{"file": "a.js"}]}\n```';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(2);
    });

    it('should prefer ```json block over surrounding text', () => {
      const text = 'Some text with {"noise": true} in it.\n\n' +
        '```json\n{"level": 3, "suggestions": [{"file": "real.js"}]}\n```\n\n' +
        'More text with {"more": "noise"}.';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(3);
      expect(result.data.suggestions[0].file).toBe('real.js');
    });
  });

  describe('large responses', () => {
    it('should handle JSON larger than 100K characters', () => {
      const suggestions = [];
      for (let i = 0; i < 500; i++) {
        suggestions.push({
          file: `src/module-${i}.js`,
          line: i + 1,
          type: 'improvement',
          title: 'Consider improving pattern ' + 'x'.repeat(100),
          description: 'Detailed explanation ' + 'y'.repeat(200),
          suggestion: 'Use this approach instead: ' + 'z'.repeat(200),
          confidence: 0.85
        });
      }
      const json = JSON.stringify({ level: 2, suggestions });
      expect(json.length).toBeGreaterThan(100000);

      const result = extractJSON(json, 'test');
      expect(result.success).toBe(true);
      expect(result.data.suggestions).toHaveLength(500);
    });

    it('should handle large JSON with preamble (> 100K chars)', () => {
      const suggestions = [];
      for (let i = 0; i < 500; i++) {
        suggestions.push({
          file: `src/module-${i}.js`,
          line: i + 1,
          type: 'bug',
          title: 'Fix ' + 'a'.repeat(100),
          description: 'b'.repeat(200)
        });
      }
      const json = JSON.stringify({ level: 2, suggestions });
      const preamble = 'Here is my thorough analysis of all the changes.\n\n';
      const text = preamble + json;
      expect(json.length).toBeGreaterThan(100000);

      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.suggestions).toHaveLength(500);
    });

    it('should handle large JSON with preamble containing braces (> 100K chars)', () => {
      const suggestions = [];
      for (let i = 0; i < 500; i++) {
        suggestions.push({
          file: `src/module-${i}.js`,
          line: i + 1,
          type: 'bug',
          title: 'Fix ' + 'a'.repeat(100),
          description: 'b'.repeat(200)
        });
      }
      const json = JSON.stringify({ level: 2, suggestions });
      const preamble = 'The function foo() { bar() } needs work.\n\n';
      const text = preamble + json;
      expect(json.length).toBeGreaterThan(100000);

      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.suggestions).toHaveLength(500);
    });
  });

  describe('invalid/malformed JSON', () => {
    it('should return failure for plain text', () => {
      const result = extractJSON('Just some plain text with no JSON at all.', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to extract JSON');
    });

    it('should return failure for truncated JSON', () => {
      const result = extractJSON('{"level": 2, "suggestions": [{"file": "test.js"', 'test');
      expect(result.success).toBe(false);
    });

    it('should return failure for malformed JSON with unbalanced braces', () => {
      const result = extractJSON('{"broken json', 'test');
      expect(result.success).toBe(false);
    });

    it('should return failure for text with only opening braces', () => {
      const result = extractJSON('some text { with { braces but no closing', 'test');
      expect(result.success).toBe(false);
    });

    it('should extract valid JSON even when followed by garbage', () => {
      // Note: first-to-last-brace strategy would fail here, but anchor strategy handles it
      const text = '{"level": 1, "suggestions": []} some trailing text';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(1);
    });
  });

  describe('edge cases with special characters', () => {
    it('should handle JSON with escaped quotes in strings', () => {
      const json = '{"title": "Fix the \\"broken\\" function", "suggestions": []}';
      const result = extractJSON(json, 'test');
      expect(result.success).toBe(true);
      expect(result.data.title).toBe('Fix the "broken" function');
    });

    it('should handle JSON with braces inside string values', () => {
      const json = JSON.stringify({
        suggestions: [{
          file: 'test.js',
          title: 'Fix { brace } handling',
          description: 'The code uses obj = { a: 1 } incorrectly',
          suggestion: 'if (cond) { return; }'
        }]
      });
      const result = extractJSON(json, 'test');
      expect(result.success).toBe(true);
      expect(result.data.suggestions[0].title).toBe('Fix { brace } handling');
    });

    it('should handle JSON with newlines in string values', () => {
      const json = JSON.stringify({
        suggestions: [{
          description: 'Line 1\nLine 2\nLine 3'
        }]
      });
      const result = extractJSON(json, 'test');
      expect(result.success).toBe(true);
      expect(result.data.suggestions[0].description).toContain('Line 1');
    });

    it('should handle JSON with unicode characters', () => {
      const json = JSON.stringify({
        suggestions: [{
          title: 'Fix unicode handling \u2026 \u2019 \u201c'
        }]
      });
      const result = extractJSON(json, 'test');
      expect(result.success).toBe(true);
    });

    it('should handle JSON with backslashes in strings', () => {
      const json = JSON.stringify({
        suggestions: [{
          title: 'Fix path: C:\\Users\\test\\file.js'
        }]
      });
      const result = extractJSON(json, 'test');
      expect(result.success).toBe(true);
      expect(result.data.suggestions[0].title).toContain('C:\\Users\\test\\file.js');
    });
  });

  describe('known JSON anchor patterns', () => {
    it('should find JSON anchored by {"level":', () => {
      const text = 'Here is some discussion about { stuff }.\n\n{"level": 2, "suggestions": []}';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(2);
    });

    it('should find JSON anchored by {"suggestions":', () => {
      const text = 'Analysis of function() { return x; }\n\n{"suggestions": [{"file": "a.js"}]}';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.suggestions).toHaveLength(1);
    });

    it('should find JSON anchored by {"summary":', () => {
      const text = 'Looking at the { config } object.\n\n{"summary": "Good overall", "score": 8}';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.summary).toBe('Good overall');
    });

    it('should find JSON anchored by {"overview":', () => {
      const text = 'The obj = {} needs work.\n\n{"overview": "Major refactoring needed"}';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.overview).toBe('Major refactoring needed');
    });

    it('should find JSON anchored by {"fileLevelSuggestions":', () => {
      const text = 'Check function() { }\n\n{"fileLevelSuggestions": [{"file": "b.js"}]}';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.fileLevelSuggestions).toHaveLength(1);
    });
  });

  describe('forward scan strategy', () => {
    it('should find JSON after multiple invalid brace pairs in preamble', () => {
      // This tests the forward scan: multiple { in preamble, none forming valid JSON,
      // then the actual JSON appears later
      const text = 'func() { } obj = { a } map = { b: c }\n\n{"level": 1, "suggestions": []}';
      const result = extractJSON(text, 'test');
      expect(result.success).toBe(true);
      expect(result.data.level).toBe(1);
    });
  });

  describe('bracket-matching strategy', () => {
    it('should handle JSON with braces inside strings via bracket matching', () => {
      // Bracket matching with string-awareness is needed here
      const json = '{"code": "function() { if (x) { return } }", "valid": true}';
      const result = extractJSON(json, 'test');
      expect(result.success).toBe(true);
      expect(result.data.valid).toBe(true);
    });
  });

  describe('result structure', () => {
    it('should return success: true and data on success', () => {
      const result = extractJSON('{"ok": true}', 'test');
      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('data');
      expect(result.data.ok).toBe(true);
    });

    it('should return success: false and error on failure', () => {
      const result = extractJSON('no json here', 'test');
      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error');
      expect(typeof result.error).toBe('string');
    });

    it('should include response preview on failure', () => {
      const result = extractJSON('this is not json at all', 'test');
      expect(result).toHaveProperty('response');
      expect(result.response).toContain('this is not json');
    });
  });

  describe('level parameter for logging', () => {
    it('should accept numeric level', () => {
      const result = extractJSON('{"ok": true}', 1);
      expect(result.success).toBe(true);
    });

    it('should accept string level', () => {
      const result = extractJSON('{"ok": true}', 'orchestration');
      expect(result.success).toBe(true);
    });

    it('should use default level when not provided', () => {
      const result = extractJSON('{"ok": true}');
      expect(result.success).toBe(true);
    });
  });
});
