// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Stats Calculator Utility
 * Calculates AI suggestion stats for display in the summary modal.
 *
 * This utility provides a shared implementation for calculating stats
 * from AI suggestions, used by both PR mode (analysis.js) and local mode (local.js).
 */

/**
 * Calculate stats from AI suggestion query results.
 * Counts suggestions by type into three buckets:
 * - issues: actual problems (bug, security, performance)
 * - suggestions: recommendations (suggestion, improvement, design, code-style, etc.)
 * - praise: positive feedback (praise)
 *
 * @param {Array<{type: string, count: number}>} rows - Query results with type and count
 * @returns {{issues: number, suggestions: number, praise: number}} Stats object
 */
function calculateStats(rows) {
  const stats = { issues: 0, suggestions: 0, praise: 0 };

  // Types that represent actual problems/issues
  const issueTypes = ['bug', 'security', 'performance'];

  for (const row of rows) {
    const typeLower = (row.type || '').toLowerCase();
    if (typeLower === 'praise') {
      stats.praise += row.count;
    } else if (issueTypes.includes(typeLower)) {
      stats.issues += row.count;
    } else {
      // All other types (suggestion, improvement, design, code-style, etc.) are suggestions
      stats.suggestions += row.count;
    }
  }

  return stats;
}

/**
 * Build the SQL query for getting stats.
 * Only counts final/overall level suggestions from the latest analysis run,
 * ignoring status (adopted/dismissed).
 * Final suggestions have ai_level IS NULL (orchestrated/curated results).
 *
 * Note: The review_id parameter must be passed twice (once for the outer WHERE,
 * once for the subquery that finds the latest ai_run_id).
 *
 * @returns {string} SQL query string
 */
function getStatsQuery() {
  return `
    SELECT type, COUNT(*) as count FROM comments
    WHERE review_id = ? AND source = 'ai' AND ai_level IS NULL
      AND ai_run_id = (
        SELECT ai_run_id FROM comments
        WHERE review_id = ? AND source = 'ai' AND ai_run_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
      )
    GROUP BY type
  `;
}

module.exports = {
  calculateStats,
  getStatsQuery
};
