// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Consolidation Fast Prompt - Quick Cross-Reviewer Suggestion Merging
 *
 * This is the fast tier variant of Consolidation analysis. It is optimized
 * for speed with shorter, more directive prompts.
 *
 * Tier-specific optimizations applied:
 * - Simplified: consolidation-rules to essential directives
 * - Removed: consensus-handling section (folded into rules)
 * - Shortened: guidelines to essentials
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

/**
 * Tagged prompt template for Consolidation Fast analysis
 *
 * Placeholders:
 * - {{reviewIntro}} - Review introduction line
 * - {{lineNumberGuidance}} - Line number guidance section
 * - {{customInstructions}} - Custom instructions section (optional)
 * - {{reviewerSuggestions}} - Formatted reviewer suggestions input
 * - {{suggestionCount}} - Total number of input suggestions
 * - {{reviewerCount}} - Number of reviewers being consolidated
 */
const taggedPrompt = `<section name="role" required="true" tier="fast">
{{reviewIntro}}
</section>

<section name="task-header" required="true" tier="fast">
# Cross-Reviewer Consolidation
</section>

<section name="line-number-guidance" required="true">
{{lineNumberGuidance}}
</section>

<section name="critical-output" locked="true">
**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**
</section>

<section name="role-description" required="true" tier="fast">
## Task
Merge suggestions from multiple AI reviewers. Deduplicate. Resolve conflicts. Keep high-value items only.
</section>

<section name="custom-instructions" optional="true" tier="fast,balanced,thorough">
{{customInstructions}}
</section>

<section name="input-suggestions" locked="true">
## Input: {{reviewerCount}} Reviewer(s), {{suggestionCount}} Total Suggestions

{{reviewerSuggestions}}
</section>

<section name="consolidation-rules" required="true" tier="fast">
## Rules
- Merge duplicate suggestions (same file/line/issue). Boost confidence for consensus.
- When reviewers disagree, keep the more specific analysis.
- Preserve unique insights from individual reviewers.
- Drop very low confidence (< 0.3) items unless multiple reviewers agree.
</section>

<section name="output-schema" locked="true">
## JSON Schema
{
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Detailed explanation",
    "suggestion": "How to fix/improve (omit for praise)",
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
  "summary": "Key findings as if from single reviewer (no mention of consolidation/merging)"
}

### GitHub Suggestion Syntax
When suggesting a specific change, **embed** a GitHub suggestion block within the "suggestion" field:

\`\`\`suggestion
replacement content here
\`\`\`

The content inside the block is the complete replacement for the commented line(s). Do not include explanation inside the block — any explanation should appear as plain text outside it. For non-specific suggestions, use plain text only.
</section>

<section name="diff-instructions" required="true" tier="fast">
## old_or_new
"NEW" (default): added [+] and context lines. "OLD": deleted [-] only. Preserve from input.
</section>

<section name="guidelines" required="true" tier="fast">
## Notes
Quality over quantity. Higher confidence for multi-reviewer agreement. Only modified files. Omit uncertain suggestions.
</section>`;

/**
 * Section definitions with metadata
 * Used for parsing and validation
 */
const sections = [
  { name: 'role', required: true, tier: ['fast'] },
  { name: 'task-header', required: true, tier: ['fast'] },
  { name: 'line-number-guidance', required: true },
  { name: 'critical-output', locked: true },
  { name: 'role-description', required: true, tier: ['fast'] },
  { name: 'custom-instructions', optional: true, tier: ['fast', 'balanced', 'thorough'] },
  { name: 'input-suggestions', locked: true },
  { name: 'consolidation-rules', required: true, tier: ['fast'] },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true, tier: ['fast'] },
  { name: 'guidelines', required: true, tier: ['fast'] }
];

/**
 * Default section order for Consolidation Fast
 * Note: Removed consensus-handling section
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
