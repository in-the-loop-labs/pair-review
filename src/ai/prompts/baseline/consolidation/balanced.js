// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Consolidation Balanced Prompt - Cross-Reviewer Suggestion Merging
 *
 * This is the canonical baseline prompt for Consolidation analysis.
 * It merges suggestions from multiple independent AI reviewers who
 * analyzed the same code changes, deduplicating and resolving conflicts.
 *
 * Unlike Orchestration (which merges across analysis levels 1/2/3),
 * Consolidation merges across reviewers within the same scope.
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

/**
 * Tagged prompt template for Consolidation Balanced analysis
 *
 * Placeholders:
 * - {{reviewIntro}} - Review introduction line
 * - {{lineNumberGuidance}} - Line number guidance section
 * - {{customInstructions}} - Custom instructions section (optional)
 * - {{reviewerSuggestions}} - Formatted reviewer suggestions input
 * - {{suggestionCount}} - Total number of input suggestions
 * - {{reviewerCount}} - Number of reviewers being consolidated
 */
const taggedPrompt = `<section name="role" required="true">
{{reviewIntro}}
</section>

<section name="task-header" required="true">
# Cross-Reviewer Consolidation Task
</section>

<section name="line-number-guidance" required="true">
{{lineNumberGuidance}}
</section>

<section name="critical-output" locked="true">
**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**
</section>

<section name="role-description" required="true">
## Your Role
Multiple independent AI reviewers have analyzed the same code changes. Your job is to merge their findings into a single, high-quality set of suggestions by deduplicating, resolving conflicts, and preserving unique insights.
</section>

<section name="custom-instructions" optional="true">
{{customInstructions}}
</section>

<section name="input-suggestions" locked="true">
## Input: {{reviewerCount}} Reviewer(s), {{suggestionCount}} Total Suggestions

{{reviewerSuggestions}}
</section>

<section name="consolidation-rules" required="true">
## Consolidation Guidelines

### 1. Deduplication
- **Merge suggestions** that identify the same issue at the same location
- When merging, combine the best elements from each reviewer's description
- Use the most specific and actionable framing

### 2. Conflict Resolution
- When reviewers **disagree**, prefer the analysis with stronger evidence
- If genuinely uncertain, keep the suggestion with reduced confidence
- Consider whether one reviewer had context the other missed

### 3. Unique Insights
- **Preserve suggestions** that only one reviewer noticed
- A unique finding from one reviewer can be the most valuable insight
- Don't discard something just because only one reviewer flagged it

### 4. Quality Filter
- Drop suggestions with very low confidence (< 0.3) unless multiple reviewers agree
- Boost confidence when multiple reviewers independently identify the same issue
</section>

<section name="consensus-handling" required="true">
### 5. Consensus Handling
- **Agreement**: When multiple reviewers flag the same issue, increase confidence by 0.1-0.2 (cap at 1.0)
- **Partial overlap**: Merge related but distinct observations into a richer suggestion
- **Contradiction**: Use your judgment; prefer the more actionable analysis
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
      "reasoning": ["Step-by-step reasoning explaining why this issue was flagged (optional)"]
    }
  ],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title describing file-level concern",
    "description": "Explanation of the file-level observation",
    "suggestion": "How to address the file-level concern (omit for praise items)",
    "confidence": 0.0-1.0,
    "reasoning": ["Step-by-step reasoning explaining why this issue was flagged (optional)"]
  }],
  "summary": "Brief consolidation summary. Write as if a single reviewer produced this analysis — do NOT mention 'consolidation', 'merging', or 'multiple reviewers'."
}

### GitHub Suggestion Syntax
When suggesting a specific change, **embed** a GitHub suggestion block within the "suggestion" field:

\`\`\`suggestion
replacement content here
\`\`\`

The content inside the block is the complete replacement for the commented line(s). Do not include explanation inside the block — any explanation should appear as plain text outside it. For non-specific suggestions, use plain text only.
</section>

<section name="diff-instructions" required="true">
## Line Number Reference (old_or_new field)
- **"NEW"** (default): For added [+] and context lines
- **"OLD"**: ONLY for deleted [-] lines
Preserve the old_or_new value from input suggestions when merging.
</section>

<section name="guidelines" required="true">
## Important Notes
- **Quality over quantity** — better to have fewer excellent suggestions than many mediocre ones
- **Cross-reviewer agreement** increases confidence significantly
- **Preserve actionability** — every suggestion should give clear next steps
- **Only include modified files** — discard suggestions for unmodified files
</section>`;

/**
 * Section definitions with metadata
 * Used for parsing and validation
 */
const sections = [
  { name: 'role', required: true },
  { name: 'task-header', required: true },
  { name: 'line-number-guidance', required: true },
  { name: 'critical-output', locked: true },
  { name: 'role-description', required: true },
  { name: 'custom-instructions', optional: true },
  { name: 'input-suggestions', locked: true },
  { name: 'consolidation-rules', required: true },
  { name: 'consensus-handling', required: true },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true },
  { name: 'guidelines', required: true }
];

/**
 * Default section order for Consolidation Balanced
 */
const defaultOrder = [
  'role',
  'task-header',
  'line-number-guidance',
  'critical-output',
  'role-description',
  'custom-instructions',
  'input-suggestions',
  'consolidation-rules',
  'consensus-handling',
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
