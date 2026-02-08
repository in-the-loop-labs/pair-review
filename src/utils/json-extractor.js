// SPDX-License-Identifier: GPL-3.0-or-later
const logger = require('./logger');

/**
 * Extract JSON from text responses using multiple strategies.
 * This is a shared utility to ensure consistent JSON extraction across the application.
 *
 * Strategies are tried in order:
 *   1. Markdown code blocks (```json ... ```)
 *   2. Direct JSON.parse of the trimmed response
 *   3. First { to last } substring
 *   4. Known JSON key anchors (e.g. {"level", {"suggestions")
 *   5. Forward scan: try JSON.parse from every top-level { in the text
 *   6. Bracket-matched substring from the first {
 *
 * @param {string} response - Raw response text (may include preamble/postamble prose)
 * @param {string|number} level - Level identifier for logging (e.g., 1, 2, 3, 'orchestration', 'unknown')
 * @returns {Object} Extraction result with success flag and data/error
 */
function extractJSON(response, level = 'unknown') {
  const levelPrefix = `[Level ${level}]`;

  if (!response || !response.trim()) {
    return { success: false, error: 'Empty response' };
  }

  const strategies = [
    // Strategy 1: Look for markdown code blocks with 'json' label
    () => {
      // First, try to find ```json specifically (more precise)
      let codeBlockMatch = response.match(/```json\s*\n([\s\S]*?)\n```/);

      // If not found, try generic ``` blocks
      if (!codeBlockMatch) {
        codeBlockMatch = response.match(/```\s*\n([\s\S]*?)\n```/);
      }

      if (codeBlockMatch && codeBlockMatch[1]) {
        const content = codeBlockMatch[1].trim();
        // Verify it looks like JSON before parsing
        if (content.startsWith('{') && content.endsWith('}')) {
          return JSON.parse(content);
        }
      }
      throw new Error('No JSON code block found');
    },

    // Strategy 2: Try the entire response as JSON (fast path for clean responses)
    () => {
      return JSON.parse(response.trim());
    },

    // Strategy 3: Look for JSON between first { and last }
    // Works when the response is just JSON or has minimal wrapping
    () => {
      const firstBrace = response.indexOf('{');
      const lastBrace = response.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return JSON.parse(response.substring(firstBrace, lastBrace + 1));
      }
      throw new Error('No valid JSON braces found');
    },

    // Strategy 4: Anchor-based extraction — look for known JSON key patterns
    // that mark the start of our expected response structures.
    // This handles the common case where preamble text contains { characters
    // (e.g. LLM discussing code: "the function handleEvent(event) { ... }")
    // which would cause Strategy 3 to grab the wrong first brace.
    () => {
      // Look for patterns that start our expected JSON structures
      const anchors = [
        /\{"level"\s*:/,
        /\{"suggestions"\s*:/,
        /\{"fileLevelSuggestions"\s*:/,
        /\{"summary"\s*:/,
        /\{"overview"\s*:/,
      ];

      for (const anchor of anchors) {
        const match = response.match(anchor);
        if (match) {
          const startIdx = match.index;
          // Find the matching closing brace from the end
          const lastBrace = response.lastIndexOf('}');
          if (lastBrace > startIdx) {
            const candidate = response.substring(startIdx, lastBrace + 1);
            return JSON.parse(candidate);
          }
        }
      }
      throw new Error('No known JSON anchor found');
    },

    // Strategy 5: Forward scan — try JSON.parse starting from each { in the text.
    // Handles arbitrary preamble text with braces by trying every { as a potential
    // JSON start. Stops at the first successful parse.
    () => {
      let searchFrom = 0;
      // Limit attempts to avoid excessive parsing on very large non-JSON text
      const maxAttempts = 20;
      let attempts = 0;

      while (searchFrom < response.length && attempts < maxAttempts) {
        const braceIdx = response.indexOf('{', searchFrom);
        if (braceIdx === -1) break;

        attempts++;
        try {
          // Try parsing from this brace to the end of the response.
          // JSON.parse is lenient about trailing content only if we trim to the
          // right boundary, so use lastIndexOf('}') from the end.
          const lastBrace = response.lastIndexOf('}');
          if (lastBrace > braceIdx) {
            const candidate = response.substring(braceIdx, lastBrace + 1);
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') {
              return parsed;
            }
          }
        } catch {
          // This { wasn't the start of valid JSON, try the next one
        }
        searchFrom = braceIdx + 1;
      }
      throw new Error('Forward scan found no valid JSON');
    },

    // Strategy 6: Bracket-matched substring from the first {.
    // Counts balanced braces (ignoring those inside JSON strings) to find
    // the end of the first top-level object. No iteration cap — the loop
    // runs for the full length of the matched region.
    () => {
      const firstBrace = response.indexOf('{');
      if (firstBrace === -1) throw new Error('No opening brace found');

      let braceCount = 0;
      let inString = false;
      let escaped = false;

      for (let i = firstBrace; i < response.length; i++) {
        const ch = response[i];

        if (escaped) {
          escaped = false;
          continue;
        }

        if (ch === '\\' && inString) {
          escaped = true;
          continue;
        }

        if (ch === '"') {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (ch === '{') braceCount++;
        else if (ch === '}') {
          braceCount--;
          if (braceCount === 0) {
            return JSON.parse(response.substring(firstBrace, i + 1));
          }
        }
      }
      throw new Error('No balanced JSON structure found');
    },
  ];

  const strategyErrors = [];
  for (let i = 0; i < strategies.length; i++) {
    try {
      const data = strategies[i]();
      if (data && typeof data === 'object') {
        logger.info(`${levelPrefix} JSON extraction successful using strategy ${i + 1}`);
        return { success: true, data };
      }
    } catch (error) {
      strategyErrors.push(`S${i + 1}: ${error.message}`);
    }
  }

  // All strategies failed — log details for debugging
  logger.warn(`${levelPrefix} All JSON extraction strategies failed`);
  logger.warn(`${levelPrefix} Strategy errors: ${strategyErrors.join('; ')}`);
  logger.warn(`${levelPrefix} Response length: ${response.length} chars, preview: ${response.substring(0, 200)}...`);

  return {
    success: false,
    error: 'Failed to extract JSON from response',
    response: response.substring(0, 500) // Include preview for debugging
  };
}

module.exports = { extractJSON };