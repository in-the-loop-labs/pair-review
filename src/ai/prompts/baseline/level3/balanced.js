// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Level 3 Balanced Prompt - Codebase Context Analysis
 *
 * This is the canonical baseline prompt for Level 3 analysis (codebase context).
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
 * Tagged prompt template for Level 3 Balanced analysis
 *
 * Placeholders:
 * - {{reviewIntro}} - Review introduction line
 * - {{prContext}} - PR context section
 * - {{customInstructions}} - Custom instructions section (optional)
 * - {{lineNumberGuidance}} - Line number guidance section
 * - {{generatedFiles}} - Generated files exclusion section (optional)
 * - {{changedFiles}} - List of changed files in this PR
 * - {{testingGuidance}} - Testing-specific guidance based on context
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
# Level 3 Review - Analyze Change Impact on Codebase
</section>

<section name="line-number-guidance" required="true">
{{lineNumberGuidance}}
</section>

<section name="generated-files" optional="true">
{{generatedFiles}}
</section>

<section name="changed-files" locked="true">
{{changedFiles}}
</section>

<section name="purpose" required="true">
## Purpose
Level 3 analyzes how the changes connect to and impact the broader codebase.

**IMPORTANT**: This is NOT a general codebase review or architectural audit.
Focus exclusively on relationships between these specific changes and existing code.
</section>

<section name="analysis-process" required="true">
## Analysis Process
Start from the changed files and explore outward to understand connections:

1. Identify files that reference or are referenced by changed files
2. Check how changes relate to tests, configurations, and documentation
3. Evaluate whether changes follow, improve, or violate established patterns
4. Assess impact on other parts of the system

Explore deeply as needed, but stay focused on relationships to the changes.
Skip general codebase review - evaluate these specific changes in their broader context.
</section>

<section name="focus-areas" required="true">
## Focus Areas
Analyze how these changes affect or relate to:

**Architecture & Patterns** (high priority)
- Existing architecture: do changes fit with, improve, or disrupt architectural patterns?
- Established patterns: do changes follow or violate patterns used elsewhere?
- Cross-file dependencies: how do changes impact files that depend on them?

**Contracts & Compatibility** (high priority)
- Breaking changes: do changes break existing functionality or contracts?
- API contracts: do changes maintain consistency with existing API patterns?
- Backward compatibility: do changes maintain compatibility with prior versions?

**Testing & Documentation**
- {{testingGuidance}}
- Documentation: do changes require doc updates? Are they consistent with documented APIs?
- Configuration: do changes necessitate configuration updates?

**Performance & Security**
- Performance of connected components: how do changes affect performance elsewhere?
- System scalability: how do changes impact the system's ability to scale?
- Security of connected systems: do changes introduce security risks in other parts?
- Data flow security: how do changes affect security across data flows?
</section>

<section name="available-commands" required="true">
## Available Commands (READ-ONLY)
You have READ-ONLY access to the codebase:
- find . -name "*.test.js" to locate test files
- grep -r "pattern" to search for patterns
- \`cat -n <file>\` to view files with line numbers
- ls, tree commands to explore structure
- Any other read-only commands as needed

**>>> CRITICAL: Do NOT modify any files. Do NOT run write commands (rm, mv, git commit, etc.). <<<**

You may use parallel read-only Tasks to explore different areas of the codebase if helpful.
</section>

<section name="output-schema" locked="true">
## Output Format

**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**

Output JSON with this structure:
{
  "level": 3,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Detailed explanation mentioning why codebase context was needed",
    "suggestion": "How to fix/improve based on codebase context (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title describing file-level concern",
    "description": "Explanation of the file-level observation from codebase perspective",
    "suggestion": "How to address the file-level concern (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of how these changes connect to and impact the codebase"
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

<section name="file-level-guidance" optional="true">
## Line-Level vs File-Level Suggestions
Prefer line-level comments (in the "suggestions" array) when the issue can be anchored to specific lines. Use file-level suggestions (in the "fileLevelSuggestions" array) only for observations that truly apply to the entire file and cannot be tied to specific lines.

File-level suggestions are appropriate for:
- Architectural concerns about the file's role in the codebase
- Missing tests for the file's functionality
- Integration issues with other parts of the codebase
- File-level design pattern inconsistencies with the rest of the codebase
- Documentation gaps for the file
- Organizational issues (file location, module structure)

File-level suggestions should NOT have a line number. They apply to the entire file.
</section>

<section name="guidelines" required="true">
## Important Guidelines

**Line vs File-Level Suggestions**
- Prefer line-level comments when the issue can be anchored to specific lines
- Use fileLevelSuggestions only for observations that truly apply to the entire file
- You may attach suggestions to context lines when they reveal codebase-level issues

**Focus & Quality**
- Focus on how changes interact with the broader codebase
- Look especially for missing tests, documentation, and integration issues
- When uncertain, prefer to omit rather than include marginal suggestions

**Confidence Calibration**
- High (0.8+): Clear issues you're certain about
- Medium (0.5-0.79): Likely issues with some uncertainty
- Lower: Observations you're less sure about

**Output Requirements**
- For "praise" type: Omit the suggestion field entirely
- For other types: Always include specific, actionable suggestions
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
  { name: 'changed-files', locked: true },
  { name: 'purpose', required: true },
  { name: 'analysis-process', required: true },
  { name: 'focus-areas', required: true },
  { name: 'available-commands', required: true },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true },
  { name: 'file-level-guidance', optional: true },
  { name: 'guidelines', required: true }
];

/**
 * Default section order for Level 3 Balanced
 */
const defaultOrder = [
  'role',
  'pr-context',
  'custom-instructions',
  'level-header',
  'line-number-guidance',
  'generated-files',
  'changed-files',
  'purpose',
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
