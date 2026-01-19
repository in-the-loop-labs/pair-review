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
 * - ADDED: Reasoning framework section (multi-phase analysis)
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
## Reasoning Framework

For each file, build a mental model before identifying issues:

**Phase 1: Understand the File's Contract**
- What implicit contracts does this file establish? (error handling conventions, naming patterns, abstraction levels)
- What invariants should be maintained? (ordering, initialization patterns, resource lifecycle)
- What are the file's extension points and how should new code integrate with them?

**Phase 2: Evaluate Change Integration**
- How do the changes interact with existing code paths?
- Are there implicit dependencies that the changes might break?
- Do the changes respect or violate the file's established boundaries?

**Phase 3: Multi-step Impact Analysis**
- Trace through: if this code runs, what downstream effects occur within the file?
- Consider edge cases: what happens at boundaries, with null/empty inputs, under concurrent access?
- Think about maintenance: will a future developer understand why this code exists?

**Output Calibration**
Surface issues that genuinely require file context understanding. If an issue could be found from the diff alone, it belongs in Level 1 - skip it here. It's better to report fewer high-confidence file-context issues than to pad output with observations that don't require seeing the full file.
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

For each file with changes:

1. **Build Context First**
   - Read the full file to understand its purpose and architecture
   - Run git-diff-lines with the file path to see precise line numbers
   - Identify the file's implicit rules: How does it handle errors? What naming conventions does it use? What patterns recur?

2. **Analyze Integration Quality**
   - Do the changes follow or violate the file's established patterns?
   - Are there related code sections that should change together but didn't?
   - Does the change maintain the file's abstraction boundaries?

3. **Generate Contextual Findings**
   - Only report issues that require seeing the full file to understand
   - Attach suggestions to the specific line where the issue manifests
   - Skip files where you find no genuine file-level concerns
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
- git-diff-lines shown above with file path (preferred for viewing changes with line numbers)
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
## old_or_new Field Reference
Use "NEW" (the default) for added lines [+] and context lines. Use "OLD" only for deleted lines [-]. When uncertain, use "NEW".
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
## File-Level vs Line-Level Suggestions

Use **line-level suggestions** (the \`suggestions\` array) when the issue manifests at a specific location, even if understanding it required file context.

Use **file-level suggestions** (the \`fileLevelSuggestions\` array) when:
- The observation concerns overall file organization or architecture
- The issue cannot be pinpointed to a single line (e.g., "this module mixes responsibilities")
- The praise applies to how changes integrate with the file as a whole

File-level suggestions have no line number - they apply to the entire file.
</section>

<section name="guidelines" required="true" tier="thorough">
## Guidelines

### Scope
- You may attach suggestions to any line within modified files, including context lines
- Focus on issues that require full file context - don't duplicate Level 1 diff-only findings
- Look for patterns and consistency issues not visible from the diff alone

### Output Quality
- For "praise" type: Omit the suggestion field (no action needed)
- For other types: Include specific, actionable suggestions grounded in file context
- Explain why file context was needed to identify the issue
- Be specific about what patterns exist and how to match them

### Philosophy
- Be constructive - the goal is to help maintain file consistency
- Treat the file's established conventions as authoritative
- Distinguish between "must fix for consistency" and "nice to have"
- Lower confidence when uncertain about file conventions
- Praise good integration to reinforce positive practices

### Priority Order
1. Breaking file conventions that could cause bugs or security issues
2. Consistency issues affecting maintainability
3. Stylistic suggestions for file coherence
4. Praise for excellent integration
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
