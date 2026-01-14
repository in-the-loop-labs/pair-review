// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Diff instructions section - shared across prompt types
 *
 * This section explains how to interpret unified diff format
 * and the old_or_new field for line references.
 */

/**
 * Section definition for diff instructions
 */
const diffInstructionsSection = {
  name: 'diff-instructions',
  required: true,
  content: `## Line Number Reference (old_or_new field)
The "old_or_new" field indicates which line number column to use:
- **"NEW"** (default): Use the NEW column number. This is correct for:
  - ADDED lines marked with [+]
  - CONTEXT lines (unchanged lines that appear in both versions)
- **"OLD"**: Use the OLD column number. ONLY use this for DELETED lines marked with [-].

**IMPORTANT**: Context lines exist in BOTH the old and new file - always use "NEW" for context lines.
Only use "OLD" when the line is prefixed with [-] indicating it was deleted.

If you are unsure, use "NEW" - it is correct for the vast majority of suggestions.`
};

/**
 * Section definition for file-level suggestions guidance
 */
const fileLevelGuidanceSection = {
  name: 'file-level-guidance',
  optional: true,
  tier: 'balanced,thorough',
  content: `## File-Level Suggestions
In addition to line-specific suggestions, you may include file-level observations in the "fileLevelSuggestions" array. These are observations about an entire file that are not tied to specific lines, such as:
- Overall file architecture or organization issues
- Naming convention concerns for the file/module
- Missing tests for the file
- File structure improvements
- Module-level design patterns
- Overall code organization within the file

File-level suggestions should NOT have a line number. They apply to the entire file.`
};

module.exports = {
  diffInstructionsSection,
  fileLevelGuidanceSection
};
