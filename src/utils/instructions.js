// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Instructions Utility
 *
 * Shared utilities for handling custom instructions merging across analysis modes.
 */

/**
 * Merge repository and request instructions with XML-like tags for AI clarity
 * Server is the single source of truth for how instructions are merged.
 *
 * @param {string|null} repoInstructions - Default instructions from repository settings
 * @param {string|null} requestInstructions - Custom instructions from the analysis request
 * @returns {string|null} Merged instructions with XML tags, or null if both inputs are empty
 */
function mergeInstructions(repoInstructions, requestInstructions) {
  if (!repoInstructions && !requestInstructions) {
    return null;
  }

  const parts = [];
  if (repoInstructions) {
    parts.push(`These are default instructions for this repository:\n<repo_instructions>\n${repoInstructions}\n</repo_instructions>`);
  }
  if (requestInstructions) {
    parts.push(`These are custom instructions for this analysis run. The following instructions take precedence over the repo_instructions in areas where they overlap or conflict:\n<custom_instructions>\n${requestInstructions}\n</custom_instructions>`);
  }
  return parts.join('\n\n');
}

module.exports = {
  mergeInstructions
};
