// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for JSON extraction utility
 */

const { extractJSON } = require('../../src/utils/json-extractor');

describe('extractJSON', () => {
  describe('Strategy 1: Markdown code blocks', () => {
    it('extracts JSON from ```json block with newlines', () => {
      const response = '```json\n{"key": "value"}\n```';
      const result = extractJSON(response, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });

    it('extracts JSON from ```json block without trailing newline', () => {
      const response = '```json\n{"key": "value"}```';
      const result = extractJSON(response, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });

    it('extracts JSON from ```json block with extra whitespace', () => {
      const response = '```json   \n{"key": "value"}\n```';
      const result = extractJSON(response, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });

    it('extracts JSON from generic ``` block', () => {
      const response = '```\n{"key": "value"}\n```';
      const result = extractJSON(response, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });

    it('extracts complex nested JSON from code block', () => {
      const json = {
        optimizedPrompt: 'Test prompt',
        changes: [
          { section: 'intro', type: 'modified', rationale: 'Made it better' }
        ]
      };
      const response = `Here's the optimized prompt:\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;
      const result = extractJSON(response, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(json);
    });
  });

  describe('Strategy 2: First { to last }', () => {
    it('extracts JSON between braces with surrounding text', () => {
      const response = 'Here is the result: {"key": "value"} and that is all.';
      const result = extractJSON(response, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });

    it('extracts JSON with nested objects', () => {
      const response = 'Output: {"outer": {"inner": "value"}}';
      const result = extractJSON(response, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ outer: { inner: 'value' } });
    });
  });

  describe('Strategy 4: Raw JSON', () => {
    it('parses raw JSON response', () => {
      const response = '{"key": "value"}';
      const result = extractJSON(response, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });

    it('parses raw JSON with leading/trailing whitespace', () => {
      const response = '  \n{"key": "value"}\n  ';
      const result = extractJSON(response, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });
  });

  describe('Error handling', () => {
    it('returns error for empty response', () => {
      const result = extractJSON('', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty response');
    });

    it('returns error for whitespace-only response', () => {
      const result = extractJSON('   \n\t  ', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty response');
    });

    it('returns error for non-JSON response', () => {
      const result = extractJSON('This is just plain text with no JSON', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to extract JSON from response');
    });

    it('returns error for malformed JSON', () => {
      const result = extractJSON('{"key": value}', 'test');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to extract JSON from response');
    });
  });

  describe('Real-world scenarios', () => {
    it('extracts JSON from typical optimizer model response', () => {
      // This is the format that was failing
      const response = `\`\`\`json
{
  "optimizedPrompt": "You are a code reviewer. Analyze the following changes.",
  "changes": [
    {
      "section": "intro",
      "type": "modified",
      "rationale": "Simplified for faster processing"
    }
  ]
}
\`\`\``;
      const result = extractJSON(response, 'optimize');
      expect(result.success).toBe(true);
      expect(result.data.optimizedPrompt).toBe('You are a code reviewer. Analyze the following changes.');
      expect(result.data.changes).toHaveLength(1);
    });

    it('extracts JSON when model adds explanatory text before', () => {
      const response = `I've optimized the prompt. Here's the result:

\`\`\`json
{"key": "value"}
\`\`\`

Let me know if you need anything else.`;
      const result = extractJSON(response, 'test');
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'value' });
    });
  });
});
