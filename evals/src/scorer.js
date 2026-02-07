// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Scorer module — takes match results from the matcher and computes
 * evaluation metrics (recall, precision, F1, weighted recall, breakdowns
 * by type and severity, and notable misses).
 */

const DEFAULT_SEVERITY_WEIGHTS = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const NOTABLE_MISS_SEVERITIES = new Set(['critical', 'high']);

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Safe division that returns 0 when the denominator is 0.
 */
function safeDivide(numerator, denominator) {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Compute the harmonic mean (F1) of precision and recall.
 * Returns 0 when both are 0.
 */
function f1Score(precision, recall) {
  const sum = precision + recall;
  if (sum === 0) return 0;
  return (2 * precision * recall) / sum;
}

/**
 * Compute overall metrics from match results.
 */
function computeOverall(matchResults, severityWeights) {
  const { matches, misses, falsePositives } = matchResults;

  const totalGroundTruth = matches.length + misses.length;
  const totalSuggestions = matches.length + falsePositives.length;
  const totalMatches = matches.length;
  const totalMisses = misses.length;
  const totalFalsePositives = falsePositives.length;

  const recall = safeDivide(totalMatches, totalGroundTruth);
  const precision = safeDivide(totalMatches, totalSuggestions);
  const f1 = f1Score(precision, recall);

  // Weighted recall: Σ(match.score × severity_weight) / Σ(severity_weight for all ground truth)
  let weightedNumerator = 0;
  for (const match of matches) {
    const severity = match.groundTruth.severity || 'medium';
    const weight = severityWeights[severity] ?? severityWeights.medium ?? 1;
    weightedNumerator += match.score * weight;
  }

  let weightedDenominator = 0;
  // All ground truth = matched ground truths + misses
  for (const match of matches) {
    const severity = match.groundTruth.severity || 'medium';
    const weight = severityWeights[severity] ?? severityWeights.medium ?? 1;
    weightedDenominator += weight;
  }
  for (const miss of misses) {
    const severity = miss.severity || 'medium';
    const weight = severityWeights[severity] ?? severityWeights.medium ?? 1;
    weightedDenominator += weight;
  }

  const weightedRecall = safeDivide(weightedNumerator, weightedDenominator);

  return {
    recall: roundTo(recall),
    precision: roundTo(precision),
    f1: roundTo(f1),
    weightedRecall: roundTo(weightedRecall),
    totalGroundTruth,
    totalSuggestions,
    totalMatches,
    totalMisses,
    totalFalsePositives,
  };
}

/**
 * Compute per-type breakdown.
 *
 * Only includes types that have at least one ground truth entry
 * OR at least one suggestion.
 */
function computeByType(matchResults) {
  const { matches, misses, falsePositives } = matchResults;

  // Collect all types that appear in ground truth or suggestions
  const typeBuckets = new Map();

  function ensureBucket(type) {
    if (!typeBuckets.has(type)) {
      typeBuckets.set(type, {
        groundTruthCount: 0,
        matchCount: 0,
        suggestionCount: 0,
      });
    }
    return typeBuckets.get(type);
  }

  // Matched ground truth entries
  for (const match of matches) {
    const gtType = match.groundTruth.type;
    const sugType = match.suggestion.type;

    const gtBucket = ensureBucket(gtType);
    gtBucket.groundTruthCount++;
    gtBucket.matchCount++;

    // Count the suggestion side — the suggestion's type determines which
    // bucket gets credited for the suggestion count.
    const sugBucket = ensureBucket(sugType);
    sugBucket.suggestionCount++;
  }

  // Misses (unmatched ground truth)
  for (const miss of misses) {
    const bucket = ensureBucket(miss.type);
    bucket.groundTruthCount++;
  }

  // False positives (unmatched suggestions)
  for (const fp of falsePositives) {
    const bucket = ensureBucket(fp.type);
    bucket.suggestionCount++;
  }

  // Build result object
  const byType = {};
  for (const [type, bucket] of typeBuckets) {
    const recall = safeDivide(bucket.matchCount, bucket.groundTruthCount);
    const precision = safeDivide(bucket.matchCount, bucket.suggestionCount);
    const f1Val = f1Score(precision, recall);

    byType[type] = {
      recall: roundTo(recall),
      precision: roundTo(precision),
      f1: roundTo(f1Val),
      groundTruthCount: bucket.groundTruthCount,
      matchCount: bucket.matchCount,
      suggestionCount: bucket.suggestionCount,
    };
  }

  return byType;
}

/**
 * Compute per-severity breakdown.
 *
 * Only computes recall (precision doesn't apply since suggestions
 * don't carry severity).
 */
function computeBySeverity(matchResults) {
  const { matches, misses } = matchResults;

  const severityBuckets = new Map();

  function ensureBucket(severity) {
    if (!severityBuckets.has(severity)) {
      severityBuckets.set(severity, { count: 0, matchCount: 0 });
    }
    return severityBuckets.get(severity);
  }

  for (const match of matches) {
    const severity = match.groundTruth.severity || 'medium';
    const bucket = ensureBucket(severity);
    bucket.count++;
    bucket.matchCount++;
  }

  for (const miss of misses) {
    const severity = miss.severity || 'medium';
    const bucket = ensureBucket(severity);
    bucket.count++;
  }

  const bySeverity = {};
  for (const [severity, bucket] of severityBuckets) {
    bySeverity[severity] = {
      recall: roundTo(safeDivide(bucket.matchCount, bucket.count)),
      count: bucket.count,
      matchCount: bucket.matchCount,
    };
  }

  return bySeverity;
}

/**
 * Collect notable misses — ground truth items with critical or high severity
 * that were NOT matched. Sorted by severity (critical first).
 */
function computeNotableMisses(matchResults) {
  const { misses } = matchResults;

  const notable = misses
    .filter((miss) => NOTABLE_MISS_SEVERITIES.has(miss.severity))
    .map((miss) => ({
      id: miss.id,
      file: miss.file,
      type: miss.type,
      severity: miss.severity,
      title: miss.title,
    }))
    .sort((a, b) => {
      const orderA = SEVERITY_ORDER[a.severity] ?? 99;
      const orderB = SEVERITY_ORDER[b.severity] ?? 99;
      return orderA - orderB;
    });

  return notable;
}

/**
 * Round a number to two decimal places.
 */
function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Compute all evaluation scores from match results.
 *
 * @param {object} matchResults - Output from matcher.js
 * @param {object} [config] - Scoring configuration
 * @param {object} [config.severity_weights] - Weight per severity level
 * @returns {object} Computed scores
 */
export function computeScores(matchResults, config = {}) {
  const severityWeights = {
    ...DEFAULT_SEVERITY_WEIGHTS,
    ...(config.severity_weights || {}),
  };

  // Normalise: ensure arrays exist so downstream code doesn't blow up
  const normalised = {
    matches: matchResults.matches || [],
    misses: matchResults.misses || [],
    falsePositives: matchResults.falsePositives || [],
    bonusFinds: matchResults.bonusFinds || [],
  };

  return {
    overall: computeOverall(normalised, severityWeights),
    byType: computeByType(normalised),
    bySeverity: computeBySeverity(normalised),
    notableMisses: computeNotableMisses(normalised),
    bonusFinds: normalised.bonusFinds,
  };
}
