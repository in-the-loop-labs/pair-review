// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Sparse-checkout guidance for analysis prompts.
 * Injected when the worktree uses sparse-checkout.
 */

/**
 * Build sparse-checkout guidance for analysis prompts
 * @param {Object} options
 * @param {string[]} options.patterns - Current sparse-checkout patterns
 * @returns {string} Markdown guidance
 */
function buildSparseCheckoutGuidance(options = {}) {
  const { patterns = [] } = options;

  const patternList = patterns.length > 0
    ? patterns.map(p => `  - ${p}`).join('\n')
    : '  (run `git sparse-checkout list` to see current patterns)';

  return `
## Sparse Checkout Active

This repository uses sparse-checkout. Only a subset of directories are checked out:
${patternList}

**Exploring related code**: If you need to examine code outside the checked-out directories to understand dependencies, patterns, or impacts, you can expand the checkout:
\`\`\`
git sparse-checkout add <directory>
\`\`\`

For example, if you see an import from \`packages/shared-utils\` but that directory isn't checked out, run:
\`\`\`
git sparse-checkout add packages/shared-utils
\`\`\`

This is non-destructive and only adds to what's visible in this review worktree.
`;
}

module.exports = { buildSparseCheckoutGuidance };
