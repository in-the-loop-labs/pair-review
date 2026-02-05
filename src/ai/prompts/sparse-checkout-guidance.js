// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Sparse-checkout guidance for analysis prompts.
 * Injected when the worktree uses sparse-checkout.
 */

/**
 * Build sparse-checkout guidance for analysis prompts.
 *
 * When called with `conditional: true` (the skill/standalone path),
 * produces softer language that doesn't assert sparse-checkout is active
 * — only advises what to do *if* it is.  The live Analyzer path omits
 * this flag because it has already verified sparse-checkout is enabled.
 *
 * @param {Object} options
 * @param {string[]} options.patterns - Current sparse-checkout patterns
 * @param {boolean} [options.conditional=false] - Use conditional language
 *   (for contexts where we don't know whether sparse-checkout is active)
 * @returns {string} Markdown guidance
 */
function buildSparseCheckoutGuidance(options = {}) {
  const { patterns = [], conditional = false } = options;

  if (conditional) {
    return buildConditionalGuidance();
  }

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

/**
 * Build conditional sparse-checkout guidance for contexts where we cannot
 * determine whether sparse-checkout is active (e.g., standalone skills
 * that lack worktree access).
 * @returns {string} Markdown guidance with conditional framing
 */
function buildConditionalGuidance() {
  return `
## Monorepo / Sparse Checkout Considerations

If this repository uses sparse-checkout, only a subset of directories may be checked out. You can check by running:
\`\`\`
git sparse-checkout list
\`\`\`

If sparse-checkout is active and you need to examine code outside the checked-out directories to understand dependencies, patterns, or impacts, you can expand the checkout:
\`\`\`
git sparse-checkout add <directory>
\`\`\`

This is non-destructive and only adds to what's visible in the worktree.
`;
}

module.exports = { buildSparseCheckoutGuidance };
