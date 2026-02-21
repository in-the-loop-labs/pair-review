// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Timestamp parsing utility for consistent UTC interpretation.
 *
 * SQLite's CURRENT_TIMESTAMP produces strings like "2024-01-20 15:30:00"
 * without a timezone indicator. JavaScript's Date() would interpret these
 * as local time, but they are actually UTC. This helper ensures correct
 * UTC parsing across the entire frontend.
 */

(function () {
  /**
   * Parse a timestamp string, ensuring UTC interpretation for SQLite timestamps.
   * @param {string} timestamp - Timestamp string (ISO 8601 or SQLite format)
   * @returns {Date} Parsed Date object (Invalid Date when input is falsy)
   */
  function parseTimestamp(timestamp) {
    if (!timestamp) return new Date(NaN);

    // If the timestamp already has timezone info (ends with Z or +/-offset), parse as-is
    if (/Z$|[+-]\d{2}:\d{2}$/.test(timestamp)) {
      return new Date(timestamp);
    }

    // SQLite CURRENT_TIMESTAMP format: "YYYY-MM-DD HH:MM:SS" (no timezone, but is UTC)
    // Append 'Z' to interpret as UTC
    return new Date(timestamp + 'Z');
  }

  // Export to global scope
  window.parseTimestamp = parseTimestamp;
})();
