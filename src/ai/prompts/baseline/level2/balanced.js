// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Level 2 Balanced Prompt - File Context Analysis
 *
 * This is the canonical baseline prompt for Level 2 analysis (file context).
 * It uses tagged XML format to enable machine-readable optimization.
 *
 * Optimizations applied:
 * - Added emphasis markers (**>>> CRITICAL: ... <<<**) for output requirements
 * - Added explicit skip guidance for files without issues
 * - Consolidated redundant focus areas
 * - Restructured guidelines with clear priority ordering
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

// Note: Shared sections (valid-files, output-schema, diff-instructions) exist in ../shared/
// for future variant generation and consistency checking. Baseline prompts are self-contained
// with their own embedded section content to avoid runtime dependencies.

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
ONLY create suggestions for files in this list:
{{validFiles}}

Do NOT create suggestions for files not in this list. If no issues are found, return fewer suggestions - that's perfectly acceptable.
</section>

<section name="analysis-process" required="true">
## Analysis Process
For each file with changes:
1. Run git-diff-lines to see changes with line numbers
2. Read the full file content when context is needed
3. Analyze how changes fit within the file's structure
4. Focus on file-level patterns and consistency
5. **Skip files where no file-level issues are found** - efficiency matters
</section>

<section name="focus-areas" required="true">
## Focus Areas
Look for:
- Inconsistencies within files (naming, patterns, error handling)
- Missing related changes (if one part changed, what else should?)
- Security vulnerabilities in file context
- Style violations or pattern deviations
- Design pattern consistency
- Documentation completeness for file-level changes
- Good practices worth praising
</section>

<section name="available-commands" required="true">
## Available Commands (READ-ONLY)
- git-diff-lines (preferred for viewing changes with line numbers)
- \`cat -n <file>\` to view files with line numbers
- grep, find, ls commands as needed

Do NOT modify files. Your role is strictly to analyze and report findings.

Note: You may use parallel read-only Tasks to examine multiple files simultaneously.
</section>

<section name="output-schema" locked="true">
## Output Format

**>>> CRITICAL: Output ONLY valid JSON <<<**
No markdown blocks, no explanations, no extra text. Response must start with { and end with }.

{
  "level": 2,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Explanation mentioning why full file context was needed",
    "suggestion": "How to fix/improve (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "File-level concern",
    "description": "File-level observation (architecture, organization, naming, etc.)",
    "suggestion": "How to address (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of file context findings"
}
</section>

<section name="diff-instructions" required="true">
## Line Number Reference (old_or_new field)
- **"NEW"** (default): For ADDED [+] lines and CONTEXT lines
- **"OLD"**: ONLY for DELETED [-] lines

Context lines exist in both old and new files - always use "NEW" for them.
When unsure, use "NEW" - it's correct for the vast majority of cases.
</section>

<section name="file-level-guidance" optional="true">
## Line-Level vs File-Level Suggestions
Prefer line-level comments when issues can be anchored to specific lines. Use file-level suggestions only for observations that truly apply to the entire file.

File-level suggestions are appropriate for:
- Overall file architecture or organization
- Module naming conventions
- Missing tests for the file
- File structure improvements
- Module-level design patterns

File-level suggestions should NOT have a line number.
</section>

<section name="guidelines" required="true">
## Guidelines

**Priority rules:**
1. Skip files with no issues when considering full file context
2. Anchor suggestions to specific lines when possible
3. Use fileLevelSuggestions only for true file-wide concerns
4. Focus on issues that require understanding full file context

**Output rules:**
- For "praise": omit the suggestion field
- For other types: include specific, actionable suggestions

**Confidence calibration:**
- High (0.8+): Clear issues you're certain about
- Medium (0.5-0.79): Likely issues with some uncertainty
- Lower: Prefer to omit marginal suggestions
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
  { name: 'file-level-guidance', optional: true },
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
      section.tier = tierMatch[1].split(',').map(t => t.trim());
    }

    parsed.push(section);
  }

  return parsed;
}

module.exports = {
  taggedPrompt,
  sections,
  defaultOrder,
  parseSections
};
