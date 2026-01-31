// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Orchestration Thorough Prompt - Comprehensive Multi-Level Suggestion Curation
 *
 * This is the thorough tier variant of Orchestration analysis. It is optimized for
 * careful, detailed orchestration with extended reasoning and comprehensive guidance
 * for merging and prioritizing multi-level suggestions.
 *
 * Tier-specific optimizations applied:
 * - EXTENDED: Reasoning encouragement section for thoughtful synthesis
 * - COMPREHENSIVE: Intelligent merging with conflict resolution and confidence combining
 * - COMPREHENSIVE: Priority-based curation with sub-tier reasoning and contextual adjustment
 * - ADDED: Confidence calibration guidance for orchestration decisions
 * - ADDED: Reasoning-encouragement section
 * - ADDED: Summary synthesis guidance (forest vs trees)
 * - EXPANDED: Human-centric framing with additional context
 * - EXPANDED: Guidelines with additional considerations and review philosophy
 * - INCLUDED: All optional sections including file-level-guidance
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

const { ORCHESTRATION_INPUT_SCHEMA_DOCS } = require('../../shared/output-schema');

/**
 * Tagged prompt template for Orchestration Thorough analysis
 *
 * Placeholders:
 * - {{reviewIntro}} - Review introduction line
 * - {{prContext}} - PR context section (optional, may be empty)
 * - {{customInstructions}} - Custom instructions section (optional)
 * - {{lineNumberGuidance}} - Line number guidance section
 * - {{level1Count}} - Number of Level 1 suggestions
 * - {{level2Count}} - Number of Level 2 suggestions
 * - {{level3Count}} - Number of Level 3 suggestions
 * - {{level1Suggestions}} - Level 1 suggestions as JSON array
 * - {{level2Suggestions}} - Level 2 suggestions as JSON array
 * - {{level3Suggestions}} - Level 3 suggestions as JSON array
 */
const taggedPrompt = `<section name="role" required="true" tier="thorough">
{{reviewIntro}}
</section>

<section name="task-header" required="true" tier="thorough">
# Deep AI Suggestion Orchestration Task
</section>

<section name="line-number-guidance" required="true" tier="thorough">
{{lineNumberGuidance}}
</section>

<section name="critical-output" locked="true">
**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**
</section>

<section name="role-description" required="true" tier="thorough">
## Your Role
You are helping a human reviewer by intelligently curating and merging suggestions from a 3-level analysis system. Your goal is to provide the most valuable, non-redundant guidance to accelerate the human review process while maintaining the highest quality standards.

This is the orchestration layer - you are synthesizing insights from:
- **Level 1**: Diff-only analysis (issues visible in changed lines)
- **Level 2**: File context analysis (issues requiring understanding of the whole file)
- **Level 3**: Codebase context analysis (issues requiring understanding of the broader system)

Your task is to produce a curated, thoughtful set of suggestions that represents the best insights from all three levels, merged intelligently and prioritized for maximum human reviewer value.
</section>

<section name="reasoning-encouragement" required="true" tier="thorough">
## Reasoning Approach
Take your time to analyze and synthesize the suggestions thoroughly. For each potential issue across all levels:
1. Consider whether multiple levels identified the same or related concerns
2. Evaluate which level's framing best captures the essence of the issue
3. Think through whether combining insights adds value or creates confusion
4. Assess the confidence based on cross-level agreement and evidence strength
5. Consider how this insight will help the human reviewer make better decisions
6. Formulate clear, actionable guidance that respects reviewer autonomy

Quality matters more than speed for this orchestration level. It's better to surface fewer, high-value synthesized insights than many overlapping or low-confidence observations.
</section>

<section name="custom-instructions" optional="true" tier="balanced,thorough">
{{customInstructions}}
</section>

<section name="input-suggestions" locked="true">
## Input: Multi-Level Analysis Results

${ORCHESTRATION_INPUT_SCHEMA_DOCS}

**Level 1 - Diff Analysis ({{level1Count}} suggestions):**
{{level1Suggestions}}

**Level 2 - File Context ({{level2Count}} suggestions):**
{{level2Suggestions}}

**Level 3 - Codebase Context ({{level3Count}} suggestions):**
{{level3Suggestions}}
</section>

<section name="intelligent-merging" required="true" tier="thorough">
## Orchestration Guidelines

### 1. Intelligent Merging
Apply careful analysis when combining suggestions across levels:

**When to Merge:**
- Same issue identified at multiple levels (e.g., security concern found in diff AND flagged for codebase patterns)
- Overlapping concerns that are better presented as a unified insight
- Complementary details from different levels that enrich understanding

**When NOT to Merge:**
- Issues that are genuinely distinct despite affecting similar code
- Level-specific context that would be lost in merging
- Situations where separate action items are clearer than combined ones

**Handling Level Contradictions:**
When levels disagree (e.g., Level 1 flags an issue that Level 3 says follows codebase patterns):
- **Evaluate evidence quality**: Concrete code analysis > pattern matching > heuristics
- **Consider scope**: Broader context (Level 3) may invalidate narrow concerns (Level 1)
- **Weight intentionality**: If higher levels show the pattern is intentional, downgrade the concern
- **When truly uncertain**: Include the suggestion with reduced confidence and note the tension in the description

**Combining Confidence Scores:**
- **Cross-level agreement**: If 2+ levels flag the same issue, boost confidence by 0.1-0.2
- **Contradictory signals**: If levels disagree, use the lower confidence minus 0.1
- **Single-level unique insight**: Preserve original confidence; don't penalize valuable unique findings
- **Evidence-based adjustment**: Strong code evidence (specific line, concrete bug) > general observations

**Merging Best Practices:**
- Preserve the most actionable and specific details from each level
- Use the clearest framing, regardless of which level provided it
- Do NOT mention which level found the issue - focus on the insight itself
- When merging would lose important nuance, keep suggestions distinct
</section>

<section name="priority-curation" required="true" tier="thorough">
### 2. Priority-Based Curation
Prioritize suggestions carefully based on impact and urgency:

**Critical Priority (Address First):**
1. **Security vulnerabilities** - Authentication bypasses, injection flaws, data exposure
2. **Bugs and errors** - Runtime errors, logic flaws, data corruption risks

**High Priority (Important to Address):**
3. **Architecture concerns** - Design violations, structural issues, maintainability risks
4. **API contract violations** - Breaking changes, interface inconsistencies

**Medium Priority (Should Consider):**
5. **Performance optimizations** - Efficiency improvements, resource usage
6. **Testing gaps** - Missing coverage for critical paths

**Lower Priority (Nice to Have):**
7. **Code style** - Formatting, naming conventions
8. **Documentation** - Comments, README updates

**Sub-tier Reasoning Within Priority Levels:**
Within each priority tier, further rank by:
- **Certainty of impact**: Definite bug > potential bug > possible edge case
- **Blast radius**: Affects many users/codepaths > affects edge cases
- **Reversibility**: Hard to fix later > easy to fix later
- **Cross-level validation**: Found by multiple levels > single level finding

**Contextual Priority Adjustment:**
Adjust the base priority based on PR context:
- **Hot path code**: Elevate performance and correctness concerns
- **Public API changes**: Elevate contract and compatibility concerns
- **Security-sensitive areas**: Elevate all security-adjacent observations
- **Refactoring PRs**: Deprioritize behavior changes (likely intentional); elevate consistency concerns
- **New feature PRs**: Elevate design and architecture concerns; slight deprioritization of style nits
</section>

<section name="balanced-output" required="true" tier="thorough">
### 3. Balanced Output
Maintain appropriate balance in your curated suggestions:

**Quantity Guidelines:**
- **Limit praise suggestions** to 2-3 most noteworthy items that reinforce good practices
- **Focus on actionable items** that provide clear value and specific next steps
- **Avoid suggestion overload** - aim for 8-15 total suggestions for most PRs
- **Include confidence scores** based on evidence strength and cross-level agreement

**Quality Guidelines:**
- Each suggestion should provide clear value to the reviewer
- Avoid redundancy - if you've addressed an issue, don't repeat it
- Be specific - vague suggestions waste reviewer time
- Include context - explain why this matters, not just what to do

**Balance Considerations:**
- Balance between critical issues and improvement suggestions
- Balance between different categories (don't focus only on style OR only on bugs)
- Balance between files if multiple files are modified
- Balance between being thorough and being respectful of reviewer time
</section>

<section name="human-centric-framing" required="true" tier="thorough">
### 4. Human-Centric Framing
Frame all suggestions as guidance for a human reviewer, not automated mandates:

**Language Principles:**
- Use language like "Consider...", "You might want to review...", "Worth noting..."
- Frame issues as observations, not demands
- Acknowledge uncertainty where it exists
- Provide reasoning, not just conclusions

**Preserve Reviewer Autonomy:**
- You're a pair programming partner, not an enforcer
- The human reviewer has context you don't have
- Some suggestions may not apply given business context
- Trust the reviewer to make final decisions

**Provide Helpful Context:**
- Explain WHY each suggestion matters (impact, risk, etc.)
- Give enough information for the reviewer to evaluate independently
- Suggest specific actions when appropriate
- Link related suggestions to help reviewer see patterns

**Tone and Style:**
- Be helpful and constructive, never critical or condescending
- Acknowledge good work alongside areas for improvement
- Focus on the code, not the developer
- Be concise but complete
</section>

<section name="confidence-guidance" required="true" tier="thorough">
## Confidence Calibration
**Confidence** when curating reflects certainty the suggestion is valuable:
- High (0.8-1.0): Clearly valuable insight for the reviewer
- Medium (0.5-0.79): Likely helpful, worth including
- Low (0.3-0.49): Marginal value, consider context
- Very low (<0.3): May not add value - consider omitting

Note: Confidence is about certainty of value, not severity. A minor improvement suggestion can have high confidence if you're sure it's helpful.
</section>

<section name="summary-synthesis" required="true" tier="thorough">
## Summary Synthesis Guidance
The summary field is not a list of findings - it's a synthesis that helps the reviewer see the forest, not just the trees.

**Effective Summary Approach:**
- **Synthesize, don't summarize**: Identify the overarching narrative of this PR's quality and concerns
- **Lead with the most important insight**: What single thing should the reviewer understand first?
- **Connect the dots**: How do individual findings relate to each other or to a common theme?
- **Calibrate severity**: Is this PR fundamentally sound with minor issues, or does it have structural problems?
- **Respect reviewer time**: A good summary lets the reviewer decide where to focus attention

**Summary Anti-patterns to Avoid:**
- Listing findings ("Found 3 bugs, 2 improvements, 1 praise...")
- Implementation details ("Merged Level 1 and Level 2 suggestions...")
- Vague platitudes ("This PR has some issues to consider...")
- Excessive length (2-3 sentences is ideal)
</section>

<section name="output-schema" locked="true">
## Output Format

**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**

Output JSON with this structure:
{
  "level": "orchestrated",
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title describing the curated insight",
    "description": "Clear explanation of the issue and why this guidance matters to the human reviewer",
    "suggestion": "Specific, actionable guidance for the reviewer (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title describing file-level concern",
    "description": "Explanation of the file-level observation",
    "suggestion": "How to address the file-level concern (omit for praise items)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary of the key findings and their significance to the reviewer. Focus on WHAT was found, not HOW it was found. Do NOT mention 'orchestration', 'levels', 'merged from Level 1/2/3' etc. Write as if a single reviewer produced this analysis."
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

When merging suggestions from multiple levels, preserve the old_or_new value from the input suggestions. If multiple levels reference the same line, verify they agree on the old_or_new value.
</section>

<section name="file-level-guidance" required="true" tier="thorough">
## File-Level Suggestions
Some input suggestions are marked as [FILE-LEVEL]. These are observations about entire files, not tied to specific lines. Handle them with special care:

**Preserving File-Level Insights:**
- Keep file-level suggestions in the "fileLevelSuggestions" array
- File-level suggestions should NOT have a line number
- Merge file-level suggestions if multiple levels identified the same file-level concern

**Good Examples of File-Level Suggestions:**
- Architecture concerns affecting the whole file
- Missing tests for the file
- Naming conventions across the file
- File organization improvements
- Module-level design pattern suggestions
- File-wide documentation needs

**When to Create File-Level Suggestions:**
- The observation requires understanding the whole file
- The suggestion would improve overall file coherence
- The issue cannot be addressed by changing a single line
- The praise applies to how well changes integrate with the file overall

**Merging File-Level Suggestions:**
- Combine related file-level observations from different levels
- Preserve the most comprehensive and actionable framing
- Use higher confidence when multiple levels agree on file-level issues
</section>

<section name="guidelines" required="true" tier="thorough">
## Important Guidelines

### Output Quality
- **Quality over quantity** - Better to have 8-12 excellent suggestions than 20 mediocre ones
- **Cross-level validation** - Higher confidence for issues found in multiple levels
- **Preserve actionability** - Every suggestion should give clear next steps
- **Maintain context** - Don't lose important details when merging
- **Be specific** - Avoid vague observations; provide concrete guidance

### Coverage and Scope
- **Suggestions may target any line in modified files** - Context lines can reveal issues too
- **Only include modified files** - Discard any suggestions for files not modified in this PR
- **Preserve file-level insights** - Don't discard valuable file-level observations
- **Balance across files** - Ensure important issues in all modified files are represented

### Review Philosophy
- **Be constructive, not critical** - The goal is to help, not to find fault
- **Consider the full picture** - Individual issues may be less important than overall patterns
- **Respect the developer's intent** - Understand why choices were made before suggesting changes
- **Acknowledge good work** - Praise reinforces positive patterns and balances criticism
- **Think like a pair programmer** - You're a helpful colleague, not an automated gate

### Synthesis Strategy
- Start by identifying themes across the three levels
- Look for issues that appear in multiple levels (high priority)
- Identify unique insights from each level that add value
- Discard redundant or low-value suggestions
- Ensure the final set tells a coherent story about the PR's quality
</section>`;

/**
 * Section definitions with metadata
 * Used for parsing and validation
 */
const sections = [
  { name: 'role', required: true, tier: ['thorough'] },
  { name: 'task-header', required: true, tier: ['thorough'] },
  { name: 'line-number-guidance', required: true, tier: ['thorough'] },
  { name: 'critical-output', locked: true },
  { name: 'role-description', required: true, tier: ['thorough'] },
  { name: 'reasoning-encouragement', required: true, tier: ['thorough'] },
  { name: 'custom-instructions', optional: true, tier: ['balanced', 'thorough'] },
  { name: 'input-suggestions', locked: true },
  { name: 'intelligent-merging', required: true, tier: ['thorough'] },
  { name: 'priority-curation', required: true, tier: ['thorough'] },
  { name: 'balanced-output', required: true, tier: ['thorough'] },
  { name: 'human-centric-framing', required: true, tier: ['thorough'] },
  { name: 'confidence-guidance', required: true, tier: ['thorough'] },
  { name: 'summary-synthesis', required: true, tier: ['thorough'] },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true, tier: ['thorough'] },
  { name: 'file-level-guidance', required: true, tier: ['thorough'] },
  { name: 'guidelines', required: true, tier: ['thorough'] }
];

/**
 * Default section order for Orchestration Thorough
 * Note: Added reasoning-encouragement and confidence-guidance sections
 */
const defaultOrder = [
  'role',
  'task-header',
  'line-number-guidance',
  'critical-output',
  'role-description',
  'reasoning-encouragement',
  'custom-instructions',
  'input-suggestions',
  'intelligent-merging',
  'priority-curation',
  'balanced-output',
  'human-centric-framing',
  'confidence-guidance',
  'summary-synthesis',
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
