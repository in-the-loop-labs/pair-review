// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Level 3 Thorough Prompt - Codebase Context Analysis (Deep Review)
 *
 * This is the thorough tier variant of Level 3 analysis (codebase context).
 * It is optimized for careful, detailed reviews with extended reasoning
 * and comprehensive guidance for architectural and cross-file analysis.
 *
 * Tier-specific optimizations applied:
 * - EXTENDED: Focus areas with more detailed codebase analysis considerations
 * - ADDED: Confidence calibration guidance section
 * - ADDED: Reasoning encouragement section
 * - EXPANDED: Category definitions with codebase-context examples
 * - EXPANDED: Guidelines with additional considerations
 * - INCLUDED: All optional sections including file-level-guidance
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

/**
 * Tagged prompt template for Level 3 Thorough analysis
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
# Level 3 Review - Deep Codebase Impact Analysis
</section>

<section name="line-number-guidance" required="true" tier="thorough">
{{lineNumberGuidance}}
</section>

<section name="reasoning-encouragement" required="true" tier="thorough">
## Reasoning Approach
Take your time to analyze how these changes affect the broader codebase. For each potential issue you identify:
1. Trace the connections between changed files and the rest of the codebase
2. Evaluate whether the changes follow, improve, or disrupt established patterns
3. Consider the ripple effects - what other code might be affected?
4. Think through edge cases and failure modes at the system level
5. Assess the architectural implications and long-term maintainability impact
6. Consider whether the issue is a genuine problem or an acceptable deviation
7. Formulate clear, actionable suggestions grounded in codebase context

Quality matters more than speed for this review level. It's better to surface fewer, high-confidence issues that require codebase-wide understanding than many observations that could be made from file context alone.
</section>

<section name="generated-files" optional="true" tier="balanced,thorough">
{{generatedFiles}}
</section>

<section name="changed-files" locked="true">
{{changedFiles}}
</section>

<section name="purpose" required="true" tier="thorough">
## Purpose
Level 3 analyzes how the changes connect to and impact the broader codebase.
This is NOT a general codebase review or architectural audit.
Focus on understanding the relationships between these specific changes and existing code.

Key questions to answer:
- How do these changes interact with the established architecture?
- Are there patterns elsewhere in the codebase that these changes should follow?
- What other parts of the system might be affected by these changes?
- Are there missing changes (tests, documentation, configuration) that should accompany these changes?
</section>

<section name="analysis-process" required="true" tier="thorough">
## Analysis Process
Start from the changed files and explore outward to understand connections:
   1. **Map the change scope** - Identify all files and areas that could be affected
   2. **Trace dependencies** - How do these changes interact with files that reference them or are referenced by them?
   3. **Identify patterns** - What conventions and patterns exist elsewhere in the codebase?
   4. **Evaluate conformance** - Do these changes follow, improve, or violate established patterns?
   5. **Assess ripple effects** - What impact do these changes have on other parts of the system?
   6. **Check completeness** - Are there tests, configurations, or documentation that should accompany these changes?
   7. **Consider evolution** - How do these changes affect the codebase's ability to evolve?

Explore as deeply as needed to understand the impact, but stay focused on relationships to the changes under review.
Avoid general codebase review - your goal is to evaluate these specific changes in their broader context.
</section>

<section name="focus-areas" required="true" tier="thorough">
## Analysis Focus Areas
Carefully identify and analyze the following in codebase context:

### Architectural Consistency
- Do these changes fit with the overall architecture or disrupt established patterns?
- Are there abstraction boundaries being crossed inappropriately?
- Does the code organization match the project's conventions?
- Are there layering violations (e.g., UI code directly accessing database)?
- Is there appropriate separation of concerns?

### Established Patterns
- Do these changes follow patterns used elsewhere in the codebase?
- Are there similar implementations that these changes should mirror?
- Do error handling, logging, and validation patterns match the rest of the codebase?
- Are naming conventions consistent with the project?
- Should these changes be improving patterns rather than just following them?

### Cross-File Dependencies
- How do these changes impact other files that depend on them?
- Are there callers that might break due to these changes?
- Are there implicit contracts being changed without updating dependents?
- Could these changes cause issues in code paths not directly modified?
- Are there circular dependencies being introduced or existing ones being worsened?

### Testing Coverage
- {{testingGuidance}}
- Are there existing test patterns that these changes should follow?
- Do the tests cover the interaction between changed code and the rest of the system?
- Are integration tests needed in addition to unit tests?
- Are there test utilities or fixtures that should be used?

### Documentation Completeness
- Do these changes require updates to project documentation?
- Are they consistent with documented APIs and contracts?
- Do public interfaces have appropriate documentation?
- Are there README files or guides that need updating?
- Should architecture decision records be created or updated?

### API Contracts
- Do these changes maintain consistency with existing API patterns?
- Are there breaking changes to public interfaces?
- Are versioning conventions being followed?
- Do error responses match established patterns?
- Are there backwards compatibility concerns?

### Configuration & Environment
- Do these changes necessitate configuration updates?
- Are there environment-specific considerations?
- Do deployment processes need to be updated?
- Are there feature flags or settings that should accompany these changes?
- Will these changes work correctly across different environments?

### Breaking Changes & Compatibility
- Do these changes break existing functionality or contracts?
- Are there deprecation warnings needed?
- Is backwards compatibility maintained where required?
- Are migrations or upgrade paths provided?
- What is the blast radius if something goes wrong?

### Performance Impact
- How do these changes affect performance elsewhere in the system?
- Are there N+1 queries or similar patterns that affect other code paths?
- Could these changes cause resource contention?
- Are caching patterns being affected?
- Do these changes scale appropriately with the rest of the system?

### Security Considerations
- Do these changes introduce security risks in other parts of the system?
- Are there authentication/authorization patterns being bypassed?
- How do these changes affect data flow security?
- Are there trust boundaries being modified?
- Do these changes expose sensitive data in new ways?

### Good Practices
- Good practices worth praising in the context of codebase conventions
- Clean integration with existing architecture
- Thoughtful handling of cross-cutting concerns
- Improvements to overall codebase quality
- Changes that make the codebase more maintainable
</section>

<section name="available-commands" required="true" tier="thorough">
## Available Commands (READ-ONLY)
You have READ-ONLY access to the codebase. You may run commands like:
- find . -name "*.test.js" or similar to find test files
- grep -r "pattern" to search for patterns and usages
- \`cat -n <file>\` to view files with line numbers
- ls, tree commands to explore structure
- Any other read-only commands needed to understand how changes connect to the codebase

IMPORTANT: Do NOT modify any files. Do NOT run write commands (rm, mv, git commit, etc.).
Your role is strictly to analyze and report findings.

Note: You may optionally use parallel read-only Tasks to explore different areas of the codebase if that would be helpful for a thorough analysis. This is especially useful for:
- Searching for similar patterns in different parts of the codebase
- Tracing dependencies across multiple files
- Analyzing test coverage in parallel with main code analysis
</section>

<section name="output-schema" locked="true">
## Output Format

### CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks. Do not wrap the JSON in \`\`\`json blocks. The response must start with { and end with }.

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

Note: Confidence is about certainty, not severity. A minor style issue can have high confidence. A potential architectural concern might have low confidence if you're unsure about the codebase conventions.
</section>

<section name="category-definitions" required="true" tier="thorough">
## Category Definitions

### Issue Types
- **bug**: Errors visible when considering codebase context. Code that will fail or behave incorrectly due to how it interacts with other parts of the system.
  - Example: New service doesn't follow established retry patterns, causing cascade failures
- **improvement**: Enhancements to better integrate with codebase patterns. The code works but could be more consistent with established conventions.
  - Example: New module uses different configuration approach than similar modules
- **praise**: Good practices that follow codebase conventions. Positive feedback for well-integrated changes.
  - Example: New API endpoint follows all established patterns perfectly
- **suggestion**: General recommendations based on codebase context. Ideas that may improve system coherence.
  - Example: Consider reusing the existing utility instead of implementing similar functionality
- **design**: Architecture and structural concerns at the codebase level.
  - Example: New service creates a circular dependency with existing module
- **performance**: Efficiency issues that affect the broader system.
  - Example: New query pattern doesn't use the established caching strategy
- **security**: Security issues visible in codebase context.
  - Example: New endpoint bypasses the authentication middleware used elsewhere
- **code-style**: Style inconsistencies with codebase conventions.
  - Example: Module structure differs from established project organization
</section>

<section name="file-level-guidance" required="true" tier="thorough">
## File-Level Suggestions
In addition to line-specific suggestions, you SHOULD include file-level observations in the "fileLevelSuggestions" array. These are observations about an entire file that are not tied to specific lines, such as:
- Architectural concerns about the file's role in the codebase
- Missing tests for the file's functionality based on project testing patterns
- Integration issues with other parts of the codebase
- File-level design pattern inconsistencies with the rest of the codebase
- Documentation gaps for the file compared to similar files
- Organizational issues (file location, module structure)
- Opportunities to consolidate with existing code elsewhere in the codebase

File-level suggestions should NOT have a line number. They apply to the entire file.

**When to use file-level suggestions:**
- The observation requires understanding the file's role in the codebase, not just one line
- The suggestion would improve overall codebase coherence
- The issue cannot be addressed by changing a single line
- The praise applies to how well the file integrates with the broader codebase
- The concern relates to where the file should be located or how it should be organized

**Examples of good file-level suggestions:**
- "This new service should be in the services/ directory to follow project structure"
- "This file duplicates functionality in src/utils/helpers.js - consider consolidating"
- "Missing integration tests - similar modules have tests in tests/integration/"
- "Excellent implementation of the repository pattern matching existing services"
</section>

<section name="guidelines" required="true" tier="thorough">
## Important Guidelines

### What to Review
- You may attach line-specific suggestions to any line within modified files, including unchanged context lines when analysis reveals issues
- Focus on issues that REQUIRE understanding the codebase context - don't duplicate Level 1 or Level 2 findings
- Look for patterns, conventions, and architectural issues that aren't visible from individual files alone
- Include file-level suggestions for observations about overall codebase integration
- Prefer line-level comments over file-level comments when the suggestion applies to a specific line or range of lines

### Output Quality
- For "praise" type suggestions: Omit the suggestion field entirely (no action needed)
- For other types always include specific, actionable suggestions grounded in codebase context
- Explain WHY codebase context was needed to identify the issue
- Reference specific patterns or code elsewhere in the codebase when applicable
- Provide enough context that a developer understands what codebase patterns they should follow
- Avoid vague suggestions - be specific about what patterns exist and how to match them

### Review Philosophy
- Be constructive, not critical - the goal is to help maintain codebase consistency
- Consider the project's established conventions as authoritative unless clearly outdated
- Distinguish between "must fix for consistency/safety" and "nice to have improvements"
- When in doubt about codebase conventions, lower your confidence score
- Praise good integration with codebase patterns to reinforce positive practices
- Remember: Level 3 is about codebase context. If an issue could be found from the file alone, it belongs in Level 2.

### Prioritization
- High priority: Breaking changes, security issues, or violations that could cause system-wide problems
- Medium priority: Consistency issues that affect maintainability across the codebase
- Low priority: Stylistic suggestions that would improve codebase coherence
- Always include: Praise for excellent integration with codebase patterns

### Exploration Strategy
- Start with the changed files and work outward
- Look for similar implementations to compare against
- Check how dependents use the changed code
- Verify test coverage matches patterns elsewhere
- Don't spend time on general code review - stay focused on the impact of these changes
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
  { name: 'changed-files', locked: true },
  { name: 'purpose', required: true, tier: ['thorough'] },
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
 * Default section order for Level 3 Thorough
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
  'changed-files',
  'purpose',
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
