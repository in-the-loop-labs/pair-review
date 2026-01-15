// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Level 2 Thorough Prompt - File Context Analysis (Deep Review)
 *
 * This is the thorough tier variant of Level 2 analysis (file context).
 * It is optimized for careful, detailed reviews with extended reasoning
 * and comprehensive guidance for file-level pattern analysis.
 *
 * Tier-specific optimizations applied:
 * - EXTENDED: Focus areas with more detailed analysis considerations
 * - ADDED: Confidence calibration guidance section
 * - ADDED: Reasoning encouragement section
 * - EXPANDED: Category definitions with examples
 * - EXPANDED: Guidelines with additional considerations
 * - INCLUDED: All optional sections including file-level-guidance
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

/**
 * Tagged prompt template for Level 2 Thorough analysis
 *
 * Placeholders:
 * - {{reviewIntro}} - Review introduction line
 * - {{prContext}} - PR context section
 * - {{customInstructions}} - Custom instructions section (optional)
 * - {{lineNumberGuidance}} - Line number guidance section
 * - {{generatedFiles}} - Generated files exclusion section (optional)
 * - {{validFiles}} - List of valid files for suggestions
 */
const taggedPrompt = `<section name="role" required="true" tier="thorough">
{{reviewIntro}}
</section>

<section name="pr-context" locked="true">
{{prContext}}
</section>

<section name="custom-instructions" optional="true" tier="balanced,thorough">
{{customInstructions}}
</section>

<section name="level-header" required="true" tier="thorough">
# Level 2 Review - Deep File Context Analysis
</section>

<section name="line-number-guidance" required="true" tier="thorough">
{{lineNumberGuidance}}
</section>

<section name="reasoning-encouragement" required="true" tier="thorough">
## Reasoning Approach
Take your time to analyze each file thoroughly. For each potential issue you identify:
1. Consider the full context of the file - its purpose, patterns, and conventions
2. Evaluate how the changes integrate with existing code in the file
3. Think through edge cases and failure modes within the file's scope
4. Consider whether the issue is a genuine problem or a stylistic preference
5. Assess the impact on file maintainability, readability, and coherence
6. Formulate clear, actionable suggestions grounded in file context

Quality matters more than speed for this review level. It's better to surface fewer, high-confidence issues that require file context understanding than many observations that could be made from the diff alone.
</section>

<section name="generated-files" optional="true" tier="balanced,thorough">
{{generatedFiles}}
</section>

<section name="valid-files" locked="true">
## Valid Files for Suggestions
You should ONLY create suggestions for files in this list:
{{validFiles}}

Do NOT create suggestions for any files not in this list. If you cannot find issues in these files, that's okay - just return fewer suggestions.
</section>

<section name="analysis-process" required="true" tier="thorough">
## Analysis Process
For each file with changes, follow this thorough analysis approach:
   1. **Read the full file content** - Understand the complete context and purpose
   2. **Run the annotated diff tool** (shown above) with the file path to see what changed with line numbers
   3. **Map the file's architecture** - Identify key structures, patterns, and conventions
   4. **Analyze how changes integrate** - Do they follow the file's established patterns?
   5. **Evaluate consistency** - Naming, error handling, code style, documentation
   6. **Consider completeness** - Are there related changes within the file that should accompany these changes?
   7. **Assess file-level implications** - Does the change affect the file's overall coherence?
   8. **Generate line-level suggestions** - After analyzing file context, create suggestions attached to specific lines where issues manifest
   9. **Skip files where no file-level issues are found** - Efficiency focus, don't force findings
</section>

<section name="focus-areas" required="true" tier="thorough">
## Analysis Focus Areas
Carefully identify and analyze the following within file context:

### Consistency
- Naming convention consistency within the file
- Error handling patterns - are they consistent with the rest of the file?
- Logging patterns and conventions
- Comment and documentation style consistency
- Import organization and grouping patterns
- Function/method ordering and organization

### Integration Quality
- How well do changes integrate with existing code patterns?
- Are there related sections that should change together?
- Do changes maintain the file's existing abstraction levels?
- Is the code organization coherent after the changes?

### Security (File Scope)
- Security patterns consistent with the rest of the file
- Input validation matching file's established patterns
- Sensitive data handling consistency
- Access control patterns within the file

### Performance (File Scope)
- Performance patterns consistent with file conventions
- Resource management following file patterns
- Caching and memoization consistency
- Algorithm choices consistent with similar functions in file

### Code Quality
- Design pattern consistency within the file
- Complexity appropriate for the file's style
- Duplication with other code in the same file
- Magic numbers or hardcoded values that should use file constants
- Type usage consistent with file patterns

### Documentation
- Documentation style matching file conventions
- Missing documentation for changes that file's style would require
- Outdated comments that no longer match the changed code
- JSDoc/docstring consistency with other functions in file

### Good Practices
- Good practices worth praising in the context of file conventions
- Clean integration with existing code
- Thoughtful handling of file-specific patterns
- Improvements to overall file quality
</section>

<section name="available-commands" required="true" tier="thorough">
## Available Commands (READ-ONLY)
You have READ-ONLY access to the codebase. You may run commands like:
- The annotated diff tool shown above with file path (preferred for viewing changes with line numbers)
- \`cat -n <file>\` to view files with line numbers
- grep, find, ls commands as needed

IMPORTANT: Do NOT modify any files. Do NOT run write commands (rm, mv, git commit, etc.).
Your role is strictly to analyze and report findings.

Note: You may optionally use parallel read-only Tasks to examine multiple files simultaneously if that would be helpful for a thorough analysis.
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

<section name="diff-instructions" required="true" tier="thorough">
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

<section name="confidence-guidance" required="true" tier="thorough">
## Confidence Calibration
**Confidence** reflects your certainty that something IS an issue:
- High (0.8-1.0): You're certain this is a real problem
- Medium (0.5-0.79): Likely an issue, but context might justify it
- Low (0.3-0.49): Possibly an issue, requires human judgment
- Very low (<0.3): Observation only - flag for human awareness

Note: Confidence is about certainty, not severity. A minor style issue can have high confidence. A potential security issue might have low confidence if you're unsure it's exploitable.
</section>

<section name="category-definitions" required="true" tier="thorough">
## Category Definitions

### Issue Types
- **bug**: Errors visible when considering file context. Code that will fail or behave incorrectly in the context of how the file works.
  - Example: New function doesn't follow file's error handling pattern, causing uncaught exceptions
- **improvement**: Enhancements to better integrate with file patterns. The code works but could be more consistent.
  - Example: New function uses different naming convention than rest of file
- **praise**: Good practices that follow file conventions. Positive feedback for well-integrated code.
  - Example: New code follows the file's established patterns perfectly
- **suggestion**: General recommendations based on file context. Ideas that may improve file coherence.
  - Example: Consider grouping this function with similar ones in the file
- **design**: Architecture and structural concerns within the file.
  - Example: New class breaks single responsibility pattern established in file
- **performance**: Efficiency issues that deviate from file's performance patterns.
  - Example: New code doesn't use the caching pattern used elsewhere in the file
- **security**: Security issues visible in file context.
  - Example: New endpoint doesn't follow file's authentication pattern
- **code-style**: Formatting, naming, and style inconsistencies within the file.
  - Example: Indentation differs from rest of file, variable naming doesn't match convention
</section>

<section name="file-level-guidance" required="true" tier="thorough">
## File-Level Suggestions
In addition to line-specific suggestions, you MAY include file-level observations in the "fileLevelSuggestions" array. These are observations about an entire file that are not tied to specific lines, such as:
- Overall file architecture or organization issues introduced by the changes
- Naming convention concerns that affect the file/module as a whole
- Missing tests for the file (if test patterns are visible in the codebase)
- File structure improvements suggested by the changes
- Module-level design patterns that the changes should follow
- Overall code organization improvements within the file
- Opportunities to refactor the file based on the new changes
- File-level documentation that should be updated

File-level suggestions should NOT have a line number. They apply to the entire file.

**When to use file-level suggestions:**
- Line-level suggestions are preferred when they relate to a specific line or range of lines
- The observation requires understanding the whole file, not just one line
- The suggestion would improve overall file coherence
- The issue cannot be addressed by changing a single line
- The praise applies to how well changes integrate with the file overall
</section>

<section name="guidelines" required="true" tier="thorough">
## Important Guidelines

### What to Review
- You may attach line-specific suggestions to any line within modified files, including context lines when they reveal file-level issues
- Focus on issues that REQUIRE understanding the full file context - don't duplicate Level 1 findings
- Look for patterns, conventions, and consistency issues that aren't visible from the diff alone
- Include file-level suggestions for observations about overall file organization and architecture

### Output Quality
- For "praise" type suggestions: Omit the suggestion field entirely (no action needed)
- For other types always include specific, actionable suggestions grounded in file context
- Explain WHY file context was needed to identify the issue
- Provide enough context that a developer understands what file patterns they should follow
- Avoid vague suggestions - be specific about what patterns exist and how to match them

### Review Philosophy
- Be constructive, not critical - the goal is to help maintain file consistency
- Consider the file's history and established conventions as authoritative
- Distinguish between "must fix for consistency" and "nice to have improvements"
- When in doubt about file conventions, lower your confidence score
- Praise good integration with file patterns to reinforce positive practices
- Remember: This review is about changes in the context of the entire file. If an issue could be found from the diff alone, skip it.

### Prioritization
- High priority: Breaking file conventions that could cause bugs or security issues
- Medium priority: Consistency issues that affect maintainability
- Low priority: Stylistic suggestions that would improve file coherence
- Maybe include praise for excellent integration with file patterns
</section>`;

/**
 * Section definitions with metadata
 * Used for parsing and validation
 */
const sections = [
  { name: 'role', required: true, tier: ['thorough'] },
  { name: 'pr-context', locked: true },
  { name: 'custom-instructions', optional: true, tier: ['balanced', 'thorough'] },
  { name: 'level-header', required: true, tier: ['thorough'] },
  { name: 'line-number-guidance', required: true, tier: ['thorough'] },
  { name: 'reasoning-encouragement', required: true, tier: ['thorough'] },
  { name: 'generated-files', optional: true, tier: ['balanced', 'thorough'] },
  { name: 'valid-files', locked: true },
  { name: 'analysis-process', required: true, tier: ['thorough'] },
  { name: 'focus-areas', required: true, tier: ['thorough'] },
  { name: 'available-commands', required: true, tier: ['thorough'] },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true, tier: ['thorough'] },
  { name: 'confidence-guidance', required: true, tier: ['thorough'] },
  { name: 'category-definitions', required: true, tier: ['thorough'] },
  { name: 'file-level-guidance', required: true, tier: ['thorough'] },
  { name: 'guidelines', required: true, tier: ['thorough'] }
];

/**
 * Default section order for Level 2 Thorough
 * Note: Added reasoning-encouragement, confidence-guidance, and category-definitions sections
 */
const defaultOrder = [
  'role',
  'pr-context',
  'custom-instructions',
  'level-header',
  'line-number-guidance',
  'reasoning-encouragement',
  'generated-files',
  'valid-files',
  'analysis-process',
  'focus-areas',
  'available-commands',
  'output-schema',
  'diff-instructions',
  'confidence-guidance',
  'category-definitions',
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
