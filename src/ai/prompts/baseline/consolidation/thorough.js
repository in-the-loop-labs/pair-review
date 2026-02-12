// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Consolidation Thorough Prompt - Comprehensive Cross-Reviewer Suggestion Merging
 *
 * This is the thorough tier variant of Consolidation analysis. It is optimized for
 * careful, detailed merging with extended reasoning and comprehensive guidance
 * for resolving conflicts and synthesizing multi-reviewer findings.
 *
 * Tier-specific optimizations applied:
 * - ADDED: Reasoning encouragement section for thoughtful synthesis
 * - COMPREHENSIVE: Consolidation rules with detailed conflict resolution
 * - COMPREHENSIVE: Consensus handling with confidence calibration
 * - ADDED: Summary synthesis guidance
 * - EXPANDED: Guidelines with review philosophy
 * - INCLUDED: All optional sections
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

/**
 * Tagged prompt template for Consolidation Thorough analysis
 *
 * Placeholders:
 * - {{reviewIntro}} - Review introduction line
 * - {{lineNumberGuidance}} - Line number guidance section
 * - {{customInstructions}} - Custom instructions section (optional)
 * - {{reviewerSuggestions}} - Formatted reviewer suggestions input
 * - {{suggestionCount}} - Total number of input suggestions
 * - {{reviewerCount}} - Number of reviewers being consolidated
 */
const taggedPrompt = `<section name="role" required="true" tier="thorough">
{{reviewIntro}}
</section>

<section name="task-header" required="true" tier="thorough">
# Deep Cross-Reviewer Consolidation Task
</section>

<section name="line-number-guidance" required="true">
{{lineNumberGuidance}}
</section>

<section name="critical-output" locked="true">
**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**
</section>

<section name="role-description" required="true" tier="thorough">
## Your Role
Multiple independent AI reviewers have analyzed the same code changes. Your task is to carefully merge their findings into a single, high-quality set of suggestions. This requires thoughtful deduplication, nuanced conflict resolution, and preservation of the most valuable unique insights from each reviewer.

Each reviewer may have used a different AI model, perspective, or focus area. Your consolidation should produce output that is stronger than any individual review.
</section>

<section name="reasoning-encouragement" required="true" tier="thorough">
## Reasoning Approach
Take your time to analyze the reviewer findings thoroughly. For each cluster of related suggestions:
1. Identify which reviewers flagged the same or overlapping issues
2. Evaluate the strength of evidence from each reviewer
3. Determine the best framing that captures the full insight
4. Calibrate confidence based on reviewer agreement and evidence quality
5. Consider whether merging would lose important nuance
6. Formulate clear, actionable guidance that respects reviewer autonomy
</section>

<section name="custom-instructions" optional="true" tier="balanced,thorough">
{{customInstructions}}
</section>

<section name="input-suggestions" locked="true">
## Input: {{reviewerCount}} Reviewer(s), {{suggestionCount}} Total Suggestions

{{reviewerSuggestions}}
</section>

<section name="consolidation-rules" required="true" tier="thorough">
## Consolidation Guidelines

### 1. Deduplication
Apply careful analysis when identifying duplicates:

**When to Merge:**
- Same issue identified at the same file and line by multiple reviewers
- Overlapping concerns that are better presented as a unified insight
- Complementary details from different reviewers that enrich understanding

**When NOT to Merge:**
- Issues that are genuinely distinct despite affecting similar code
- Reviewer-specific context that would be lost in merging
- Situations where separate action items are clearer than combined ones

**Merging Best Practices:**
- Preserve the most actionable and specific details from each reviewer
- Use the clearest framing, regardless of which reviewer provided it
- Do NOT mention which reviewer found the issue — focus on the insight itself

### 2. Conflict Resolution
When reviewers disagree about an issue:
- **Evaluate evidence quality**: Concrete code analysis > pattern matching > heuristics
- **Consider specificity**: More specific analysis usually wins
- **Weight actionability**: Prefer the suggestion that gives clearer next steps
- **When truly uncertain**: Include the suggestion with reduced confidence and note the tension in the description

### 3. Unique Insights
- **Preserve suggestions** that only one reviewer noticed — these are often the most valuable
- A unique finding from one reviewer may represent a perspective the others missed
- Don't penalize unique findings with lower confidence just because they lack consensus

### 4. Quality Filter
- Drop suggestions with very low confidence (< 0.3) unless multiple reviewers agree
- Elevate suggestions where reviewers independently converge
</section>

<section name="consensus-handling" required="true" tier="thorough">
### 5. Consensus Handling and Confidence Calibration

**Cross-Reviewer Agreement:**
- **Strong consensus** (3+ reviewers): Boost confidence by 0.2 (cap at 1.0)
- **Moderate consensus** (2 reviewers): Boost confidence by 0.1
- **Single reviewer**: Preserve original confidence — don't penalize valuable unique findings
- **Contradiction**: Use the lower confidence minus 0.1

**Confidence Calibration:**
- High (0.8+): Clear issues with strong evidence or multi-reviewer consensus
- Medium (0.5-0.79): Likely valuable suggestions with reasonable evidence
- Lower (0.3-0.49): Marginal suggestions — include only if unique and actionable
- Very low (<0.3): Consider omitting unless multi-reviewer consensus

Note: Confidence is about certainty of value, not severity.
</section>

<section name="summary-synthesis" required="true" tier="thorough">
## Summary Synthesis Guidance
The summary field should synthesize the findings, not list them.

**Effective Summary Approach:**
- **Lead with the most important insight**: What should the reviewer focus on first?
- **Connect the dots**: How do individual findings relate to each other?
- **Calibrate severity**: Is this code fundamentally sound with minor issues, or are there structural problems?
- **Write as a single reviewer**: Do NOT mention consolidation, merging, or multiple reviewers
</section>

<section name="output-schema" locked="true">
## Output Format

**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**

Output JSON with this structure:
{
  "suggestions": [
    {
      "file": "path/to/file",
      "line": 42,
      "old_or_new": "NEW",
      "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
      "title": "Brief title",
      "description": "Detailed explanation",
      "suggestion": "How to fix/improve (omit for praise)",
      "confidence": 0.0-1.0,
      "reasoning": ["Step-by-step reasoning explaining why this issue was flagged"]
    }
  ],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title describing file-level concern",
    "description": "Explanation of the file-level observation",
    "suggestion": "How to address the file-level concern (omit for praise items)",
    "confidence": 0.0-1.0,
    "reasoning": ["Step-by-step reasoning explaining why this issue was flagged"]
  }],
  "summary": "Brief summary of the key findings and their significance. Write as if a single reviewer produced this analysis — do NOT mention 'consolidation', 'merging', or 'multiple reviewers'."
}
</section>

<section name="diff-instructions" required="true" tier="thorough">
## Line Number Reference (old_or_new field)
The "old_or_new" field indicates which line number column to use:
- **"NEW"** (default): Use the NEW column number. Correct for added [+] and context lines.
- **"OLD"**: Use the OLD column number. ONLY for deleted [-] lines.

**IMPORTANT**: Context lines exist in BOTH versions — always use "NEW" for them.
Preserve the old_or_new value from input suggestions when merging.
</section>

<section name="guidelines" required="true" tier="thorough">
## Important Guidelines

### Output Quality
- **Quality over quantity** — better to have fewer excellent suggestions than many mediocre ones
- **Cross-reviewer agreement** is strong evidence — boost confidence accordingly
- **Preserve actionability** — every suggestion should give clear next steps
- **Maintain context** — don't lose important details when merging

### Coverage and Scope
- **Only include modified files** — discard suggestions for files not in this changeset
- **Balance across files** — ensure important issues in all modified files are represented
- **Preserve unique perspectives** — different reviewer models may catch different things

### Review Philosophy
- Frame suggestions as considerations, not mandates
- The human reviewer has context you don't have
- Focus on the code, not the reviewers
- When uncertain, prefer quality over quantity
</section>`;

/**
 * Section definitions with metadata
 * Used for parsing and validation
 */
const sections = [
  { name: 'role', required: true, tier: ['thorough'] },
  { name: 'task-header', required: true, tier: ['thorough'] },
  { name: 'line-number-guidance', required: true },
  { name: 'critical-output', locked: true },
  { name: 'role-description', required: true, tier: ['thorough'] },
  { name: 'reasoning-encouragement', required: true, tier: ['thorough'] },
  { name: 'custom-instructions', optional: true, tier: ['balanced', 'thorough'] },
  { name: 'input-suggestions', locked: true },
  { name: 'consolidation-rules', required: true, tier: ['thorough'] },
  { name: 'consensus-handling', required: true, tier: ['thorough'] },
  { name: 'summary-synthesis', required: true, tier: ['thorough'] },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true, tier: ['thorough'] },
  { name: 'guidelines', required: true, tier: ['thorough'] }
];

/**
 * Default section order for Consolidation Thorough
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
  'consolidation-rules',
  'consensus-handling',
  'summary-synthesis',
  'output-schema',
  'diff-instructions',
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
