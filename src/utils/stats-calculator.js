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
 * Counts suggestions by type: praise vs not-praise (issues).
 *
 * @param {Array<{type: string, count: number}>} rows - Query results with type and count
 * @returns {{issues: number, praise: number}} Stats object
 */
function calculateStats(rows) {
  const stats = { issues: 0, praise: 0 };

  for (const row of rows) {
    const typeLower = (row.type || '').toLowerCase();
    if (typeLower === 'praise') {
      stats.praise += row.count;
    } else {
      // All non-praise types count as issues
      stats.issues += row.count;
    }
  }

  return stats;
}

/**
 * Build the SQL query for getting stats.
 * Only counts final/overall level suggestions, ignoring status (adopted/dismissed).
 * Final suggestions have ai_level IS NULL (orchestrated/curated results).
 *
 * @returns {string} SQL query string
 */
function getStatsQuery() {
  return `
    SELECT type, COUNT(*) as count FROM comments
    WHERE pr_id = ? AND source = 'ai' AND ai_level IS NULL
    GROUP BY type
  `;
}

module.exports = {
  calculateStats,
  getStatsQuery
};
