// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Level 1 Balanced Prompt - Changes in Isolation Analysis
 *
 * This is the balanced tier variant of Level 1 analysis, optimized for
 * Claude Sonnet. It balances thoroughness with clarity.
 *
 * Optimizations applied:
 * - ADDED: Emphasis markers (**>>> CRITICAL: ... <<<**) for output requirements
 * - ADDED: "Default to NEW if unclear" fallback guidance in diff-instructions
 * - TRIMMED: Verbose phrasing in valid-files, focus-areas, guidelines
 * - STRUCTURED: Clear numbered steps in initial-setup
 * - RETAINED: Category definitions (unlike fast tier) for precision
 * - RETAINED: Speed expectations section for scope clarity
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
 * Tagged prompt template for Level 1 Balanced analysis
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
# Level 1 Review - Analyze Changes in Isolation
</section>

<section name="line-number-guidance" required="true">
{{lineNumberGuidance}}
</section>

<section name="speed-expectations" required="true">
## Speed and Scope Expectations
**This analysis should be fast** - focus only on the diff itself without exploring file context or surrounding unchanged code.
</section>

<section name="generated-files" optional="true">
{{generatedFiles}}
</section>

<section name="valid-files" locked="true">
## Valid Files for Suggestions
ONLY create suggestions for files in this list:
{{validFiles}}

Do NOT create suggestions for any files not in this list. If you cannot find issues in these files, that's okay - just return fewer suggestions.
</section>

<section name="initial-setup" required="true">
## Initial Setup
1. Run the annotated diff tool (shown above) to see changes with line numbers
2. Focus on changed lines only - do not analyze surrounding context
</section>

<section name="focus-areas" required="true">
## Analysis Focus Areas
Identify the following in changed code:
- Bugs or errors in the modified code
- Logic issues in the changes
- Security vulnerabilities in the changed lines
- Performance issues visible in the diff
- Code style and naming convention violations
- Design pattern violations visible in isolation
- Documentation issues in changed lines
- Good practices worth praising
</section>

<section name="available-commands" required="true">
## Available Commands (READ-ONLY)
- The annotated diff tool shown above (required)
- \`cat -n <file>\` to view files with line numbers
- ls, find, grep as needed

Do NOT modify files or run write commands. Analyze and report only.
</section>

<section name="output-schema" locked="true">
## Output Format

**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**

{
  "level": 1,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Detailed explanation",
    "suggestion": "How to fix/improve (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of findings"
}
</section>

<section name="diff-instructions" required="true">
## Line Number Reference (old_or_new field)
The "old_or_new" field indicates which line number column to use:
- **"NEW"** (default): Use the NEW column number for:
  - ADDED lines marked with [+]
  - CONTEXT lines (unchanged lines in both versions)
- **"OLD"**: Use the OLD column number ONLY for DELETED lines marked with [-]

**IMPORTANT:** Context lines exist in BOTH old and new file - always use "NEW" for context lines.
**Default to NEW if unclear** - it is correct for the vast majority of suggestions.
</section>

<section name="category-definitions" required="true">
## Category Definitions
- bug: Errors, crashes, or incorrect behavior
- improvement: Enhancements to make existing code better
- praise: Good practices worth highlighting
- suggestion: General recommendations to consider
- design: Architecture and structural concerns
- performance: Speed and efficiency optimizations
- security: Vulnerabilities or safety issues
- code-style: Formatting, naming conventions, and code style
</section>

<section name="guidelines" required="true">
## Guidelines
- Prioritize changed lines; include unchanged lines only when they reveal issues
- Prefer line-level over file-level comments when applicable
- **Praise:** omit the suggestion field (no action needed)
- **Other types:** include specific, actionable suggestions

Confidence calibration:
- High (0.8+): Clear issues you're certain about
- Medium (0.5-0.79): Likely issues with some uncertainty
- Lower (<0.5): Prefer to omit marginal suggestions
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
  { name: 'speed-expectations', required: true },
  { name: 'generated-files', optional: true },
  { name: 'valid-files', locked: true },
  { name: 'initial-setup', required: true },
  { name: 'focus-areas', required: true },
  { name: 'available-commands', required: true },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true },
  { name: 'category-definitions', required: true },
  { name: 'guidelines', required: true }
];

/**
 * Default section order for Level 1 Balanced
 */
const defaultOrder = [
  'role',
  'pr-context',
  'custom-instructions',
  'level-header',
  'line-number-guidance',
  'speed-expectations',
  'generated-files',
  'valid-files',
  'initial-setup',
  'focus-areas',
  'available-commands',
  'output-schema',
  'diff-instructions',
  'category-definitions',
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
