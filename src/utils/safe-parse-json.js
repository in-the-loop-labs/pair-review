// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Safely parse JSON with a fallback value.
 * Useful for database columns that may contain malformed JSON.
 *
 * @param {string|null|undefined} str - The JSON string to parse
 * @param {*} [fallback=null] - Value to return if parsing fails
 * @returns {*} Parsed JSON value or the fallback
 */
function safeParseJson(str, fallback = null) {
  if (str == null) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

module.exports = { safeParseJson };
