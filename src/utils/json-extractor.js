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

// Patterns that start our expected JSON response structures.
const JSON_ANCHORS = [
  /\{"level"\s*:/,
  /\{"suggestions"\s*:/,
  /\{"fileLevelSuggestions"\s*:/,
  /\{"summary"\s*:/,
  /\{"overview"\s*:/,
];

// A key, in any spelling or half-quoted (`line:`, `'line':`, `line":`,
// `"line":`), followed by the start of a JSON value: a string, array or
// object, or a number or literal ending at a delimiter. Prose with a colon
// (`here: foo()`, `note: 5 items`) does not match.
const LOOKS_LIKE_FIELD =
  /(?:[A-Za-z_$][\w$]*|["'`])["'`]?\s*:\s*(?:["'[{]|(?:-?\d[\d.eE+-]*|true|false|null)\s*[,}\]])/;

// Upper bound on error-directed repair attempts per response. Each attempt
// escapes one quote (or re-runs the control-character pass), so this caps
// the number of JSON.parse calls on input that is not JSON at all.
const MAX_QUOTE_REPAIR_ITERATIONS = 50;

/**
 * Return true when the `"` at index q closes a string literal, judged by
 * walking the same in-string/escaped state machine as the sanitizer from the
 * start of text.
 * @param {string} text - Candidate JSON text starting at its opening {
 * @param {number} q - Index of a `"` character
 * @returns {boolean}
 */
function isClosingQuote(text, q) {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < q; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
    } else if (ch === '\\' && inString) {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    }
  }
  return inString && !escaped;
}

/**
 * Locate the unescaped `"` that ended a string literal too early, using a
 * JSON.parse error.
 *
 * V8 does not report the bad quote itself: the string ends there, so the
 * reported offset is the first non-whitespace character *after* it, where
 * the parser expected structure but found prose. For
 * `{"d":"say "hi" there"}` the error is "Expected ',' or '}' after property
 * value ... at position 11", pointing at the `h`. So the heuristic is:
 *
 *   - "Expected ',' or '}' after property value" / "Expected ',' or ']'
 *     after array element": the bad quote is the last non-whitespace
 *     character before the offset.
 *   - "Expected double-quoted property name": the early-closed string was
 *     followed by prose starting with a comma (`"called "foo", which"`), so
 *     the bad quote precedes that comma.
 *
 * The candidate is rejected when the character at the offset is `"`, `}` or
 * `]`: that looks like a missing or trailing comma, not a quote in prose,
 * and escaping would merge separate values. The quote must also be a closing
 * quote according to the in-string state machine. Finally, it is rejected
 * when the span escaping it would pull into the string (up to the next
 * unescaped quote) holds a key followed by a value (`, line":3,`), in any
 * quoting style: that is a malformed key, not prose.
 *
 * @param {string} text - Candidate JSON text
 * @param {string} message - JSON.parse error message
 * @returns {number} Index of the quote to escape, or -1 if this is not an
 *   unescaped-quote error
 */
function findPrematureStringEnd(text, message) {
  const posMatch = /at position (\d+)/.exec(message);
  if (!posMatch) return -1;
  const pos = Number(posMatch[1]);
  if (pos >= text.length || '"}]'.includes(text[pos])) return -1;

  let q = pos - 1;
  const skipWhitespace = () => { while (q >= 0 && /\s/.test(text[q])) q--; };

  if (/Expected ',' or '[}\]]' after (property value|array element)/.test(message)) {
    skipWhitespace();
  } else if (/Expected double-quoted property name/.test(message)) {
    skipWhitespace();
    if (text[q] !== ',') return -1;
    q--;
    skipWhitespace();
  } else {
    return -1;
  }

  if (q < 0 || text[q] !== '"' || !isClosingQuote(text, q)) return -1;
  // Escaping q pulls everything up to the next unescaped quote into the
  // string. If that span holds a field (`, line":3,`), the "prose" is really
  // a malformed key: escaping would fold later fields into the string, so
  // leave it to fail. A span ending in `":` is a key whose string value
  // opens with the quote that ends the span (`, kind":"x"`).
  const span = text.slice(q, nextUnescapedQuote(text, q + 1));
  if (LOOKS_LIKE_FIELD.test(span) || /["'`]\s*:\s*$/.test(span)) return -1;
  return q;
}

/**
 * @param {string} text - Candidate JSON text
 * @param {number} from - Index to start scanning at
 * @returns {number} Index of the next `"` not preceded by a backslash
 *   escape, or text.length if there is none
 */
function nextUnescapedQuote(text, from) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i;
  }
  return text.length;
}

/**
 * Escape raw control characters from index pos to the end of the string
 * literal containing it (the next unescaped `"`).
 *
 * Unlike sanitizeControlCharactersInStrings this does not walk string state
 * from the start of the text, so an unescaped quote earlier in the text
 * cannot flip it and make it escape structural newlines between values.
 * Like that sanitizer, a backslash directly before a raw control character
 * (e.g. a shell line continuation) is doubled into a literal '\\'.
 *
 * @param {string} text - Candidate JSON text
 * @param {number} pos - Offset JSON.parse reported for a bad control character
 * @returns {string} Text with that string's control characters escaped
 */
function escapeControlCharactersFrom(text, pos) {
  let span = '';
  let escaped = false;
  let end = pos;
  for (; end < text.length; end++) {
    const ch = text[end];
    const isControl = ch.charCodeAt(0) < 0x20;
    if (escaped) {
      escaped = false;
      span += isControl ? '\\' + escapeControlCharacter(ch) : ch;
    } else if (ch === '\\') {
      escaped = true;
      span += ch;
    } else if (ch === '"') {
      break;
    } else {
      span += isControl ? escapeControlCharacter(ch) : ch;
    }
  }
  return text.slice(0, pos) + span + text.slice(end);
}

/**
 * Repair unescaped `"` characters inside JSON string literals (issue #561),
 * guided by JSON.parse's own error offsets.
 *
 * LLMs writing prose into a string value sometimes quote a word without
 * escaping it (`"description": "rename "foo" to bar"`). The string ends at
 * the first inner quote and the parser fails on the prose that follows. Each
 * attempt parses the text, asks findPrematureStringEnd for the offending
 * quote, escapes it, and retries. Raw control characters are repaired the
 * same way, one string literal per attempt at the reported offset: the
 * whole-text sanitizer can't be trusted here because each unescaped quote
 * flips its in-string state for the rest of the text. Gives up on any other
 * error, when an attempt makes no progress, or after
 * MAX_QUOTE_REPAIR_ITERATIONS attempts.
 *
 * Text that already parses is returned unchanged.
 *
 * @param {string} text - Candidate JSON text (should start at its opening {)
 * @param {number} [maxIterations] - Bound on repair attempts
 * @returns {{data: (Object|null), text: string, repairs: number}} data is the
 *   parsed object, or null if repair failed; text is the (possibly repaired)
 *   candidate; repairs counts the fixes applied
 */
function repairUnescapedQuotes(text, maxIterations = MAX_QUOTE_REPAIR_ITERATIONS) {
  let current = text;
  let repairs = 0;
  let lastQuote = -1;

  for (let attempt = 0; attempt <= maxIterations; attempt++) {
    let message;
    try {
      const data = JSON.parse(current);
      return { data: data && typeof data === 'object' ? data : null, text: current, repairs };
    } catch (error) {
      message = error.message;
    }
    if (attempt === maxIterations) break;

    const controlMatch = /Bad control character in string literal in JSON at position (\d+)/.exec(message);
    if (controlMatch) {
      const repaired = escapeControlCharactersFrom(current, Number(controlMatch[1]));
      if (repaired === current) break;
      current = repaired;
      repairs++;
      continue;
    }

    const q = findPrematureStringEnd(current, message);
    // Each escape moves the string end forward; a quote at or before the
    // previous one means the heuristic is going in circles.
    if (q === -1 || q <= lastQuote) break;
    current = current.slice(0, q) + '\\' + current.slice(q);
    lastQuote = q;
    repairs++;
  }

  return { data: null, text: current, repairs };
}

/**
 * Run repairUnescapedQuotes on the JSON region of a response: from the first
 * known anchor (else the first {) to the last }.
 * @param {string} text - Response text
 * @returns {{data: (Object|null), text: string, repairs: number}|null} null
 *   when the text has no {...} region
 */
function repairCandidate(text) {
  let start = -1;
  for (const anchor of JSON_ANCHORS) {
    const match = text.match(anchor);
    if (match) { start = match.index; break; }
  }
  if (start === -1) start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return repairUnescapedQuotes(text.substring(start, end + 1));
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
      for (const anchor of JSON_ANCHORS) {
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
 * the sanitized text. If that also fails, repairUnescapedQuotes escapes
 * unescaped quotes inside string literals at the offsets JSON.parse reports
 * (issue #561).
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

  // Quote repair: escape unescaped quotes (and control characters) inside
  // string literals at the offsets JSON.parse reports (issue #561). Works on
  // the original response, not `sanitized`: an unescaped quote desyncs the
  // sanitizer, which then escapes structural newlines in pretty-printed JSON.
  // The region runs from the first known anchor (else the first {) to the
  // last }, so offsets refer to the JSON rather than surrounding prose.
  const quoteRepair = repairCandidate(response);
  if (quoteRepair && quoteRepair.data) {
    logger.info(`${levelPrefix} JSON extraction successful after repairing ${quoteRepair.repairs} unescaped quote/control-character error(s)`);
    return { success: true, data: quoteRepair.data };
  }

  // All strategies failed — log the first pass's errors so `position N`
  // offsets line up with the original-response preview below
  const repairNotes = [
    repairAttempted && 'control-character',
    quoteRepair && quoteRepair.repairs > 0 && 'unescaped-quote',
  ].filter(Boolean);
  logger.warn(`${levelPrefix} All JSON extraction strategies failed`);
  logger.warn(`${levelPrefix} Strategy errors: ${firstPass.strategyErrors.join('; ')}${repairNotes.length ? ` (${repairNotes.join(' and ')} repair was also attempted and failed)` : ''}`);
  logger.warn(`${levelPrefix} Response length: ${response.length} chars, preview: ${response.substring(0, 200)}...`);

  return {
    success: false,
    error: 'Failed to extract JSON from response',
    response: response.substring(0, 500) // Include preview for debugging
  };
}

module.exports = { extractJSON, sanitizeControlCharactersInStrings, repairUnescapedQuotes };
