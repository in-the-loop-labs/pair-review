// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const logger = require('./logger');

/**
 * Escape a single control character (U+0000 - U+001F) to its JSON string form.
 * @param {string} ch - Single control character
 * @returns {string} Escaped form (e.g. '\\n', '\\u0001')
 */
function escapeControlCharacter(ch) {
  switch (ch) {
    case '\n': return '\\n';
    case '\r': return '\\r';
    case '\t': return '\\t';
    case '\b': return '\\b';
    case '\f': return '\\f';
    default: return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  }
}

/**
 * Escape raw (unescaped) control characters found inside JSON string literals.
 *
 * LLM responses that embed code snippets in string values sometimes contain
 * literal newlines/tabs instead of the \n / \t escapes JSON requires. A single
 * such character makes JSON.parse reject the entire response ("Bad control
 * character in string literal"), which can silently discard every suggestion
 * in a large consolidation response (issue #560).
 *
 * Walks the text tracking string/escape state (the same state machine used by
 * the bracket-matching strategy) and rewrites control characters (U+0000 -
 * U+001F) that appear inside string literals to their escaped forms. Text
 * outside string literals is left untouched — control characters there are
 * legal JSON whitespace or would be a structural error sanitization cannot fix.
 *
 * @param {string} text - Candidate JSON text
 * @returns {string} Text with in-string control characters escaped
 */
function sanitizeControlCharactersInStrings(text) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (!inString) {
      if (ch === '"') inString = true;
      result += ch;
      continue;
    }

    if (escaped) {
      escaped = false;
      if (ch.charCodeAt(0) < 0x20) {
        // A raw control character cannot follow a backslash in valid JSON.
        // Double the dangling backslash into a literal '\\' and escape the
        // control character itself.
        result += '\\' + escapeControlCharacter(ch);
      } else {
        result += ch;
      }
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      result += ch;
      continue;
    }

    if (ch === '"') {
      inString = false;
      result += ch;
      continue;
    }

    if (ch.charCodeAt(0) < 0x20) {
      result += escapeControlCharacter(ch);
      continue;
    }

    result += ch;
  }

  return result;
}

/**
 * Run all extraction strategies against a candidate text.
 *
 * Strategies are tried in order:
 *   1. Markdown code blocks (```json ... ```)
 *   2. Direct JSON.parse of the trimmed text
 *   3. First { to last } substring
 *   4. Known JSON key anchors (e.g. {"level", {"suggestions")
 *   5. Forward scan: try JSON.parse from every top-level { in the text
 *   6. Bracket-matched substring from the first {
 *
 * @param {string} text - Candidate text (may include preamble/postamble prose)
 * @returns {{data: (Object|null), strategy: number|undefined, strategyErrors: Array<string>}}
 *   data is null when every strategy failed; strategyErrors collects per-strategy failures
 */
function runExtractionStrategies(text) {
  const strategies = [
    // Strategy 1: Look for markdown code blocks with 'json' label
    () => {
      // First, try to find ```json specifically (more precise)
      let codeBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);

      // If not found, try generic ``` blocks
      if (!codeBlockMatch) {
        codeBlockMatch = text.match(/```\s*\n([\s\S]*?)\n```/);
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

    // Strategy 2: Try the entire text as JSON (fast path for clean responses)
    () => {
      return JSON.parse(text.trim());
    },

    // Strategy 3: Look for JSON between first { and last }
    // Works when the text is just JSON or has minimal wrapping
    () => {
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return JSON.parse(text.substring(firstBrace, lastBrace + 1));
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
        const match = text.match(anchor);
        if (match) {
          const startIdx = match.index;
          // Find the matching closing brace from the end
          const lastBrace = text.lastIndexOf('}');
          if (lastBrace > startIdx) {
            const candidate = text.substring(startIdx, lastBrace + 1);
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
      const lastBrace = text.lastIndexOf('}');

      while (searchFrom < text.length && attempts < maxAttempts) {
        const braceIdx = text.indexOf('{', searchFrom);
        if (braceIdx === -1) break;

        attempts++;
        try {
          // Try parsing from this brace to the end of the text.
          // JSON.parse is lenient about trailing content only if we trim to the
          // right boundary, so use lastIndexOf('}') from the end.
          if (lastBrace > braceIdx) {
            const candidate = text.substring(braceIdx, lastBrace + 1);
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
      const firstBrace = text.indexOf('{');
      if (firstBrace === -1) throw new Error('No opening brace found');

      let braceCount = 0;
      let inString = false;
      let escaped = false;

      for (let i = firstBrace; i < text.length; i++) {
        const ch = text[i];

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
            return JSON.parse(text.substring(firstBrace, i + 1));
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
        return { data, strategy: i + 1, strategyErrors };
      }
    } catch (error) {
      strategyErrors.push(`S${i + 1}: ${error.message}`);
    }
  }
  return { data: null, strategy: undefined, strategyErrors };
}

/**
 * Extract JSON from text responses using multiple strategies.
 * This is a shared utility to ensure consistent JSON extraction across the application.
 *
 * The strategies (see runExtractionStrategies) run against the original
 * response first. If all fail, a repair pass escapes raw control characters
 * inside string literals (issue #560) and the strategies run once more against
 * the sanitized text.
 *
 * @param {string} response - Raw response text (may include preamble/postamble prose)
 * @param {string|number} level - Level identifier for logging (e.g., 1, 2, 3, 'orchestration', 'unknown')
 * @param {string} [logPrefix] - Custom log prefix to use instead of `[Level <level>]`.
 *   Used by callers (e.g., summary generation, council mode) that have a more
 *   meaningful identifier than a numeric analysis level.
 * @returns {Object} Extraction result with success flag and data/error
 */
function extractJSON(response, level = 'unknown', logPrefix) {
  const levelPrefix = logPrefix || `[Level ${level}]`;

  if (!response || !response.trim()) {
    return { success: false, error: 'Empty response' };
  }

  const firstPass = runExtractionStrategies(response);
  if (firstPass.data) {
    logger.info(`${levelPrefix} JSON extraction successful using strategy ${firstPass.strategy}`);
    return { success: true, data: firstPass.data };
  }

  // Repair pass: escape raw control characters inside string literals and
  // retry. Sanitize only from the first { onward so quotes in surrounding
  // prose don't desync the in-string state machine.
  const braceIdx = response.indexOf('{');
  const sanitized = braceIdx === -1
    ? response
    : response.slice(0, braceIdx) + sanitizeControlCharactersInStrings(response.slice(braceIdx));
  const repairAttempted = sanitized !== response;
  if (repairAttempted) {
    const repairPass = runExtractionStrategies(sanitized);
    if (repairPass.data) {
      logger.info(`${levelPrefix} JSON extraction successful using strategy ${repairPass.strategy} after control-character repair`);
      return { success: true, data: repairPass.data };
    }
  }

  // All strategies failed — log the first pass's errors so `position N`
  // offsets line up with the original-response preview below
  logger.warn(`${levelPrefix} All JSON extraction strategies failed`);
  logger.warn(`${levelPrefix} Strategy errors: ${firstPass.strategyErrors.join('; ')}${repairAttempted ? ' (a control-character repair pass was also attempted and failed)' : ''}`);
  logger.warn(`${levelPrefix} Response length: ${response.length} chars, preview: ${response.substring(0, 200)}...`);

  return {
    success: false,
    error: 'Failed to extract JSON from response',
    response: response.substring(0, 500) // Include preview for debugging
  };
}

module.exports = { extractJSON, sanitizeControlCharactersInStrings };
