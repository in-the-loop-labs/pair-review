// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Level 1 Balanced Prompt - Changes in Isolation Analysis
 *
 * This is the canonical baseline prompt for Level 1 analysis (diff-only).
 * It uses tagged XML format to enable machine-readable optimization.
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
**This analysis should be fast** - focusing only on the diff itself without exploring file context or surrounding unchanged code.
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

<section name="initial-setup" required="true">
## Initial Setup
1. Run the annotated diff tool (shown above) to see the changes with line numbers
2. Focus ONLY on the changed lines in the diff
3. Do not analyze file context or surrounding unchanged code
</section>

<section name="focus-areas" required="true">
## Analysis Focus Areas
Identify the following in changed code:
   - Bugs or errors in the modified code
   - Logic issues in the changes
   - Security concerns and vulnerabilities in the changed lines
   - Performance issues and optimizations visible in the diff
   - Code style and formatting issues
   - Naming convention violations
   - Design pattern violations visible in isolation
   - Documentation issues visible in the changed lines
   - Good practices worth praising
</section>

<section name="available-commands" required="true">
## Available Commands (READ-ONLY)
You have READ-ONLY access to the codebase. You may run commands like:
- The annotated diff tool shown above (required for viewing changes with line numbers)
- \`cat -n <file>\` to view files with line numbers
- ls, find, grep commands as needed

IMPORTANT: Do NOT modify any files. Do NOT run write commands (rm, mv, git commit, etc.).
Your role is strictly to analyze and report findings.

Note: You may optionally use parallel read-only Tasks to analyze different files or different parts of the changes if that would be helpful.
</section>

<section name="output-schema" locked="true">
## Output Format

### CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks. Do not wrap the JSON in \`\`\`json blocks. The response must start with { and end with }.

Output JSON with this structure:
{
  "level": 1,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Detailed explanation",
    "suggestion": "How to fix/improve (omit this field for praise items - no action needed)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of findings"
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
## Important Guidelines
- You may comment on any line in modified files. Prioritize changed lines, but include unchanged lines when they reveal issues (missing error handling, inconsistent patterns, etc.)
- Prefer line-level comments over file-level comments when the suggestion applies to a specific line or range of lines
- Focus on issues visible in the diff itself - do not analyze file context
- Do not review unchanged code or missing tests
- Do not analyze file-level patterns or consistency
- For "praise" type suggestions: Omit the suggestion field entirely (no action needed)
- For other types, always include specific, actionable suggestions
- This saves tokens and prevents empty suggestion sections

Calibrate your confidence honestly:
- High (0.8+): Clear issues you're certain about
- Medium (0.5-0.79): Likely issues with some uncertainty
- Lower: Observations you're less sure about

When uncertain, prefer to omit rather than include marginal suggestions.
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
