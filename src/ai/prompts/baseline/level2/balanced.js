// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Level 2 Balanced Prompt - File Context Analysis
 *
 * This is the canonical baseline prompt for Level 2 analysis (file context).
 * It uses tagged XML format to enable machine-readable optimization.
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

const { validFilesSection } = require('../../shared/valid-files');
const { outputSchemaSection } = require('../../shared/output-schema');
const { diffInstructionsSection, fileLevelGuidanceSection } = require('../../shared/diff-instructions');

/**
 * Tagged prompt template for Level 2 Balanced analysis
 *
 * Placeholders:
 * - {{reviewIntro}} - Review introduction line
 * - {{prContext}} - PR context section
 * - {{customInstructions}} - Custom instructions section (optional)
 * - {{lineNumberGuidance}} - Line number guidance section
 * - {{generatedFiles}} - Generated files exclusion section (optional)
 * - {{validFiles}} - List of valid files for suggestions
 */
const taggedPrompt = `<section name="role" required="true">
{{reviewIntro}}
</section>

<section name="pr-context" locked="true">
{{prContext}}
</section>

<section name="custom-instructions" optional="true">
{{customInstructions}}
</section>

<section name="level-header" required="true">
# Level 2 Review - Analyze File Context
</section>

<section name="line-number-guidance" required="true">
{{lineNumberGuidance}}
</section>

<section name="generated-files" optional="true">
{{generatedFiles}}
</section>

<section name="valid-files" locked="true">
## Valid Files for Suggestions
You should ONLY create suggestions for files in this list:
{{validFiles}}

Do NOT create suggestions for any files not in this list. If you cannot find issues in these files, that's okay - just return fewer suggestions.
</section>

<section name="analysis-process" required="true">
## Analysis Process
For each file with changes:
   - Read the full file content to understand context
   - Run the annotated diff tool (shown above) with the file path to see what changed with line numbers
   - Analyze how changes fit within the file's overall structure
   - Focus on file-level patterns and consistency
   - Skip files where no file-level issues are found (efficiency focus)
</section>

<section name="focus-areas" required="true">
## Focus Areas
Look for:
   - Inconsistencies within files (naming conventions, patterns, error handling)
   - Missing related changes within files (if one part changed, what else should change?)
   - File-level security patterns and vulnerabilities
   - Security consistency within the file scope
   - Code style violations or deviations from patterns established in the file
   - Consistent formatting and structure within files
   - Opportunities for improvement based on full file context
   - Design pattern consistency within file scope
   - File-level documentation completeness and consistency
   - Missing documentation for file-level changes
   - Good practices worth praising in the file's context
</section>

<section name="available-commands" required="true">
## Available Commands (READ-ONLY)
You have READ-ONLY access to the codebase. You may run commands like:
- The annotated diff tool shown above with file path (preferred for viewing changes with line numbers)
- \`cat -n <file>\` to view files with line numbers
- grep, find, ls commands as needed

IMPORTANT: Do NOT modify any files. Do NOT run write commands (rm, mv, git commit, etc.).
Your role is strictly to analyze and report findings.

Note: You may optionally use parallel read-only Tasks to examine multiple files simultaneously if that would be helpful.
</section>

<section name="output-schema" locked="true">
## Output Format

### CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks. Do not wrap the JSON in \`\`\`json blocks. The response must start with { and end with }.

Output JSON with this structure:
{
  "level": 2,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Detailed explanation mentioning why full file context was needed",
    "suggestion": "How to fix/improve based on file context (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title describing file-level concern",
    "description": "Explanation of the file-level observation (architecture, organization, naming, etc.)",
    "suggestion": "How to address the file-level concern (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of file context findings"
}
</section>

<section name="diff-instructions" required="true">
## Line Number Reference (old_or_new field)
The "old_or_new" field indicates which line number column to use:
- **"NEW"** (default): Use the NEW column number. This is correct for:
  - ADDED lines marked with [+]
  - CONTEXT lines (unchanged lines that appear in both versions)
- **"OLD"**: Use the OLD column number. ONLY use this for DELETED lines marked with [-].

**IMPORTANT**: Context lines exist in BOTH the old and new file - always use "NEW" for context lines.
Only use "OLD" when the line is prefixed with [-] indicating it was deleted.

If you are unsure, use "NEW" - it is correct for the vast majority of suggestions.
</section>

<section name="file-level-guidance" optional="true" tier="balanced,thorough">
## File-Level Suggestions
In addition to line-specific suggestions, you may include file-level observations in the "fileLevelSuggestions" array. These are observations about an entire file that are not tied to specific lines, such as:
- Overall file architecture or organization issues
- Naming convention concerns for the file/module
- Missing tests for the file
- File structure improvements
- Module-level design patterns
- Overall code organization within the file

File-level suggestions should NOT have a line number. They apply to the entire file.
</section>

<section name="guidelines" required="true">
## Important Guidelines
- You may attach line-specific suggestions to any line within modified files, including context lines when they reveal file-level issues.
- Focus on issues that require understanding the full file context
- Focus on file-level patterns and consistency
- For "praise" type: Omit the suggestion field entirely to save tokens
- For other types: Include specific, actionable suggestions
</section>`;

/**
 * Section definitions with metadata
 * Used for parsing and validation
 */
const sections = [
  { name: 'role', required: true },
  { name: 'pr-context', locked: true },
  { name: 'custom-instructions', optional: true },
  { name: 'level-header', required: true },
  { name: 'line-number-guidance', required: true },
  { name: 'generated-files', optional: true },
  { name: 'valid-files', locked: true },
  { name: 'analysis-process', required: true },
  { name: 'focus-areas', required: true },
  { name: 'available-commands', required: true },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true },
  { name: 'file-level-guidance', optional: true, tier: ['balanced', 'thorough'] },
  { name: 'guidelines', required: true }
];

/**
 * Default section order for Level 2 Balanced
 */
const defaultOrder = [
  'role',
  'pr-context',
  'custom-instructions',
  'level-header',
  'line-number-guidance',
  'generated-files',
  'valid-files',
  'analysis-process',
  'focus-areas',
  'available-commands',
  'output-schema',
  'diff-instructions',
  'file-level-guidance',
  'guidelines'
];

/**
 * Parse the tagged prompt into section objects
 * @returns {Array<Object>} Array of section objects with name, attributes, and content
 */
function parseSections() {
  const sectionRegex = /<section\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/section>/g;
  const parsed = [];
  let match;

  while ((match = sectionRegex.exec(taggedPrompt)) !== null) {
    const [, name, attrs, content] = match;
    const section = {
      name,
      content: content.trim(),
      locked: attrs.includes('locked="true"'),
      required: attrs.includes('required="true"'),
      optional: attrs.includes('optional="true"')
    };

    // Extract tier attribute if present
    const tierMatch = attrs.match(/tier="([^"]+)"/);
    if (tierMatch) {
      section.tier = tierMatch[1].split(',');
    }

    parsed.push(section);
  }

  return parsed;
}

module.exports = {
  taggedPrompt,
  sections,
  defaultOrder,
  parseSections,
  // Re-export shared sections for convenience
  sharedSections: {
    validFilesSection,
    outputSchemaSection,
    diffInstructionsSection,
    fileLevelGuidanceSection
  }
};
