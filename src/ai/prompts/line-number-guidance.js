// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared line-number guidance builders.
 *
 * Both the runtime Analyzer (which injects worktree-specific commands)
 * and the skill renderer (which uses the bare `git-diff-lines` command)
 * call these functions so there is a single source of truth for the
 * guidance prose.
 */

/**
 * Build the line-number guidance section used by analysis levels (L1-L3).
 *
 * @param {Object}  [options]
 * @param {string}  [options.scriptCommand='git-diff-lines'] - The command
 *   to run.  The runtime Analyzer passes something like
 *   `git-diff-lines --cwd "/path/to/worktree"`, while the skill renderer
 *   passes the bare `git-diff-lines`.
 * @returns {string} Markdown guidance
 */
function buildAnalysisLineNumberGuidance(options = {}) {
  const fullCommand = options.scriptCommand || 'git-diff-lines';
  return `
## Viewing Code Changes

IMPORTANT: Use the annotated diff tool instead of \`git diff\` directly:
\`\`\`
${fullCommand}
\`\`\`

This shows explicit line numbers in two columns:
\`\`\`
 OLD | NEW |
  10 |  12 |      context line
  11 |  -- | [-]  deleted line (exists only in base)
  -- |  13 | [+]  added line (exists only in PR)
\`\`\`

All git diff arguments work: \`${fullCommand} HEAD~1\`, \`${fullCommand} -- src/\`

## Line Number Precision

Your suggestions MUST reference the EXACT line where the issue exists:

1. **Be literal, not conceptual**
   - BAD: Commenting on function definition (line 10) when the bug is inside the function body (line 25)
   - GOOD: Commenting on line 25 where the actual problematic code is

2. **Use correct line numbers from the annotated diff**
   - For ADDED lines [+]: use the NEW column number
   - For CONTEXT lines: use the NEW column number
   - For DELETED lines [-]: use the OLD column number

3. **Verify before suggesting**
   - Run the annotated diff tool to see exact line numbers
   - Double-check line numbers match the output before submitting suggestions
`;
}

/**
 * Build the line-number guidance section used by the orchestration step.
 *
 * Unlike the analysis guidance, this does NOT instruct the AI to
 * routinely run git-diff-lines or verify every line number.  The
 * orchestration step receives pre-computed suggestions whose line
 * numbers were already determined by the analysis levels; its primary
 * job is to intelligently combine them.  It retains access to
 * git-diff-lines for cases where it needs to investigate conflicting
 * suggestions or verify a specific concern.
 *
 * @param {Object}  [options]
 * @param {string}  [options.scriptCommand='git-diff-lines'] - Same as
 *   {@link buildAnalysisLineNumberGuidance}.
 * @returns {string} Markdown guidance
 */
function buildOrchestrationLineNumberGuidance(options = {}) {
  const fullCommand = options.scriptCommand || 'git-diff-lines';
  return `
## Line Number Handling

You are receiving pre-computed suggestions from the analysis levels. Each suggestion
already carries a \`line\` number and \`old_or_new\` value determined during analysis.
Your primary focus is curation and synthesis, not line number verification.

**Your responsibilities:**
- **Preserve line numbers as-is** when passing suggestions through to the output.
- **Preserve \`old_or_new\` values** from input suggestions.
- **When merging duplicates or near-duplicates** that reference the same line,
  keep the line number and \`old_or_new\` from the suggestion with the richest
  context (prefer higher-level analysis when in doubt).
- **When levels conflict** on the line number or \`old_or_new\` for what appears to
  be the same issue, use your judgment based on the nature of the concern:
  - For **architectural or cross-cutting issues**, prefer the suggestion from the
    level with broader context (Level 3 > Level 2 > Level 1).
  - For **precise line-level bugs or typos**, prefer the suggestion from the level
    that targets the specific line most directly (often Level 1, which works
    closest to the raw diff).

**If you need to inspect a file diff** (e.g., to resolve conflicting suggestions or
verify a specific concern), use the annotated diff tool instead of \`git diff\`:
\`\`\`
${fullCommand}
\`\`\`
All git diff arguments work: \`${fullCommand} HEAD~1\`, \`${fullCommand} -- src/\`
`;
}

module.exports = {
  buildAnalysisLineNumberGuidance,
  buildOrchestrationLineNumberGuidance,
};
