// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Matches AI suggestions from pair-review against ground truth annotations.
 *
 * Uses greedy 1:1 matching: scores all potential (groundTruth, suggestion) pairs,
 * then assigns the best matches first so each item participates at most once.
 */

// ---------------------------------------------------------------------------
// Stop words — common English + generic code-review words that carry no
// differentiating signal when comparing issue descriptions.
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  // English
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'its',
  'they', 'them', 'their', 'what', 'which', 'who', 'whom',
  'this', 'that', 'these', 'those',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'up', 'about',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
  'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
  'just', 'also', 'now', 'here', 'there', 'when', 'where', 'why', 'how',
  'if', 'because', 'as', 'until', 'while',
  // Code-review generic
  'should', 'could', 'consider', 'code', 'use', 'using', 'instead',
  'better', 'change', 'need', 'needs', 'make', 'add', 'remove',
]);

// ---------------------------------------------------------------------------
// Default matching configuration
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  line_tolerance: 5,
  allow_type_mismatch: true,
  type_mismatch_penalty: 0.5,
  semantic_threshold: 0.2,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a file path by stripping a leading slash (if any) so that
 * "app/foo.rb" and "/app/foo.rb" compare equal.
 */
function normalizePath(filePath) {
  if (typeof filePath !== 'string') return '';
  return filePath.replace(/^\/+/, '');
}

/**
 * Tokenize a piece of text into a set of significant lowercase words,
 * filtering out stop words and very short tokens.
 */
function tokenize(text) {
  if (!text) return new Set();
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

// ---------------------------------------------------------------------------
// Exported: computeSemanticSimilarity
// ---------------------------------------------------------------------------

/**
 * Compute the Jaccard similarity between two pieces of text after tokenizing
 * into significant words.
 *
 * @param {string} text1
 * @param {string} text2
 * @returns {number} similarity in [0, 1]
 */
export function computeSemanticSimilarity(text1, text2) {
  const a = tokenize(text1);
  const b = tokenize(text2);
  if (a.size === 0 && b.size === 0) return 0;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Exported: computeLineOverlap
// ---------------------------------------------------------------------------

/**
 * Determine whether a suggestion and a ground truth entry match on location.
 *
 * @param {{ line_start?: number|null, line_end?: number|null, is_file_level?: boolean }} suggestion
 * @param {{ line_start?: number|null, line_end?: number|null, is_file_level?: boolean }} groundTruth
 * @param {number} tolerance  +-N lines for "proximity" matching
 * @returns {{ match: boolean, type: 'overlap'|'proximity'|'file_level'|'none' }}
 */
export function computeLineOverlap(suggestion, groundTruth, tolerance) {
  const sugFileLevel =
    suggestion.is_file_level ||
    (suggestion.line_start == null && suggestion.line_end == null);
  const gtFileLevel =
    groundTruth.is_file_level ||
    (groundTruth.line_start == null && groundTruth.line_end == null);

  // If either side is file-level, location is considered matching.
  if (sugFileLevel || gtFileLevel) {
    return { match: true, type: 'file_level' };
  }

  // Normalise ranges: if line_end is missing, treat as single-line.
  const sStart = suggestion.line_start;
  const sEnd = suggestion.line_end ?? suggestion.line_start;
  const gStart = groundTruth.line_start;
  const gEnd = groundTruth.line_end ?? groundTruth.line_start;

  // Check direct overlap: ranges [sStart, sEnd] and [gStart, gEnd] intersect.
  if (sStart <= gEnd && gStart <= sEnd) {
    return { match: true, type: 'overlap' };
  }

  // Check proximity: closest edges within tolerance.
  const gap = Math.min(
    Math.abs(sStart - gEnd),
    Math.abs(gStart - sEnd),
    Math.abs(sStart - gStart),
    Math.abs(sEnd - gEnd),
  );
  if (gap <= tolerance) {
    return { match: true, type: 'proximity' };
  }

  return { match: false, type: 'none' };
}

// ---------------------------------------------------------------------------
// Internal scoring helpers
// ---------------------------------------------------------------------------

/**
 * Build a combined text blob from the title and description of an entry so we
 * can compute semantic similarity across both fields.
 */
function semanticText(entry) {
  return [entry.title, entry.description].filter(Boolean).join(' ');
}

/**
 * Score a single (suggestion, groundTruth) candidate pair.
 *
 * Returns null when the pair cannot match at all (different file, below
 * semantic threshold, etc.).
 *
 * @returns {{ quality: string, score: number, details: object } | null}
 */
function scorePair(suggestion, groundTruth, config) {
  // 1. File match
  const fileMatch =
    normalizePath(suggestion.file) === normalizePath(groundTruth.file);
  if (!fileMatch) return null;

  // 2. Line overlap / proximity / file-level
  const lineResult = computeLineOverlap(
    suggestion,
    groundTruth,
    config.line_tolerance,
  );
  if (!lineResult.match) return null;

  // 3. Semantic similarity
  const semanticScore = computeSemanticSimilarity(
    semanticText(suggestion),
    semanticText(groundTruth),
  );
  if (semanticScore < config.semantic_threshold) return null;

  // 4. Type match
  const typeMatch =
    suggestion.type != null &&
    groundTruth.type != null &&
    suggestion.type === groundTruth.type;

  // 5. Determine quality tier and base score
  let quality;
  let score;

  if (lineResult.type === 'overlap' || lineResult.type === 'file_level') {
    if (typeMatch && semanticScore >= 0.3) {
      quality = 'exact';
      score = 1.0;
    } else if (semanticScore >= 0.2) {
      // Overlapping lines but either wrong type or semantic < 0.3
      quality = 'partial';
      // Scale partial score: 0.5 base + up to 0.25 bonus from semantic
      score = 0.5 + Math.min(semanticScore, 1) * 0.25;
    } else {
      return null; // semantic too low (already guarded above, but defensive)
    }
  } else if (lineResult.type === 'proximity') {
    if (semanticScore >= 0.2) {
      quality = 'partial';
      score = 0.5 + Math.min(semanticScore, 1) * 0.25;
    } else {
      return null;
    }
  } else {
    return null;
  }

  // 6. Apply type-mismatch penalty
  if (!typeMatch) {
    if (!config.allow_type_mismatch) return null;
    quality = 'type_mismatch';
    score *= 1 - config.type_mismatch_penalty;
  }

  return {
    quality,
    score,
    details: {
      fileMatch: true,
      lineMatch: lineResult.type,
      typeMatch,
      semanticScore,
    },
  };
}

// ---------------------------------------------------------------------------
// Exported: matchSuggestions
// ---------------------------------------------------------------------------

/**
 * Match AI suggestions against ground truth issues using greedy 1:1 matching.
 *
 * @param {Array} suggestions  AI suggestions from pair-review
 * @param {Array} groundTruth  Ground truth annotations (JSONL entries)
 * @param {object} [config]    Optional matching configuration overrides
 * @returns {{ matches: Array, misses: Array, falsePositives: Array, bonusFinds: Array }}
 */
export function matchSuggestions(suggestions, groundTruth, config) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Build all candidate (gt, suggestion) pairs with their scores.
  const candidates = [];
  for (let gi = 0; gi < groundTruth.length; gi++) {
    for (let si = 0; si < suggestions.length; si++) {
      const result = scorePair(suggestions[si], groundTruth[gi], cfg);
      if (result) {
        candidates.push({ gi, si, ...result });
      }
    }
  }

  // Sort descending by score (higher is better). Break ties by preferring
  // exact > partial > type_mismatch.
  const qualityRank = { exact: 0, partial: 1, type_mismatch: 2 };
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (qualityRank[a.quality] ?? 3) - (qualityRank[b.quality] ?? 3);
  });

  // Greedy assignment — each gt and suggestion used at most once.
  const matchedGT = new Set();
  const matchedSug = new Set();
  const matches = [];

  for (const cand of candidates) {
    if (matchedGT.has(cand.gi) || matchedSug.has(cand.si)) continue;
    matchedGT.add(cand.gi);
    matchedSug.add(cand.si);
    matches.push({
      groundTruth: groundTruth[cand.gi],
      suggestion: suggestions[cand.si],
      quality: cand.quality,
      score: cand.score,
      details: cand.details,
    });
  }

  // Unmatched ground truth = misses
  const misses = groundTruth.filter((_, i) => !matchedGT.has(i));

  // Unmatched suggestions = false positives
  const falsePositives = suggestions.filter((_, i) => !matchedSug.has(i));

  return {
    matches,
    misses,
    falsePositives,
    bonusFinds: [], // placeholder for future manual review flagging
  };
}
