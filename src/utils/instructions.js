// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Instructions Utility
 *
 * Shared utilities for handling custom instructions merging across analysis modes.
 */

/**
 * Merge global, repository, and request instructions with XML-like tags for AI clarity.
 * Server is the single source of truth for how instructions are merged.
 *
 * Precedence (lowest → highest): global → repo → custom/request
 *
 * @param {Object} instructions - Instructions to merge
 * @param {string|null} [instructions.globalInstructions] - Global instructions from ~/.pair-review/global-instructions.md
 * @param {string|null} [instructions.repoInstructions] - Default instructions from repository settings
 * @param {string|null} [instructions.requestInstructions] - Custom instructions from the analysis request
 * @returns {string|null} Merged instructions with XML tags, or null if all inputs are empty
 */
function mergeInstructions({ globalInstructions, repoInstructions, requestInstructions } = {}) {
  if (!globalInstructions && !repoInstructions && !requestInstructions) {
    return null;
  }

  const parts = [];
  if (globalInstructions) {
    parts.push(`These are global instructions that apply to all reviews:\n<global_instructions>\n${globalInstructions}\n</global_instructions>`);
  }
  if (repoInstructions) {
    const repoPrecedence = globalInstructions
      ? ' They take precedence over global_instructions in areas where they overlap or conflict:'
      : '';
    parts.push(`These are default instructions for this repository.${repoPrecedence}\n<repo_instructions>\n${repoInstructions}\n</repo_instructions>`);
  }
  if (requestInstructions) {
    const overrides = [repoInstructions && 'repo_instructions', globalInstructions && 'global_instructions'].filter(Boolean);
    const customPrecedence = overrides.length
      ? ` They take precedence over ${overrides.join(' and ')} in areas where they overlap or conflict:`
      : '';
    parts.push(`These are custom instructions for this analysis run.${customPrecedence}\n<custom_instructions>\n${requestInstructions}\n</custom_instructions>`);
  }
  return parts.join('\n\n');
}

module.exports = {
  mergeInstructions
};
