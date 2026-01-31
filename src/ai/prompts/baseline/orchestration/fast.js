// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Orchestration Fast Prompt - Quick Multi-Level Suggestion Curation
 *
 * This is the fast tier variant of Orchestration analysis. It is optimized for speed
 * with shorter, more directive prompts and simplified instructions.
 *
 * Tier-specific optimizations applied:
 * - Removed: file-level-guidance section (tier="balanced,thorough")
 * - Simplified: intelligent-merging to essential rules only
 * - Simplified: priority-curation to brief priority list
 * - Simplified: balanced-output to core constraints
 * - Simplified: human-centric-framing to key principles
 * - Shortened: guidelines to essential requirements
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

const { ORCHESTRATION_INPUT_SCHEMA_DOCS } = require('../../shared/output-schema');

/**
 * Tagged prompt template for Orchestration Fast analysis
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
const taggedPrompt = `<section name="role" required="true" tier="fast">
{{reviewIntro}}
</section>

<section name="task-header" required="true" tier="fast">
# Suggestion Orchestration
</section>

<section name="line-number-guidance" required="true" tier="fast">
{{lineNumberGuidance}}
</section>

<section name="critical-output" locked="true">
**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**
</section>

<section name="role-description" required="true" tier="fast">
## Task
Curate and merge 3-level suggestions. Remove duplicates. Keep high-value items only.
</section>

<section name="custom-instructions" optional="true" tier="fast,balanced,thorough">
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

<section name="intelligent-merging" required="true" tier="fast">
## Rules
Combine related suggestions. Merge overlaps. Preserve unique insights. Never mention levels.
</section>

<section name="priority-curation" required="true" tier="fast">
### Priority
Security > Bugs > Architecture > Performance > Style
</section>

<section name="balanced-output" required="true" tier="fast">
### Output
Max 2-3 praise items. Prefer line-level over file-level. Include actionable suggestions.
</section>

<section name="human-centric-framing" required="true" tier="fast">
### Framing
Use "Consider...", "Worth noting..." - guidance not mandates.
</section>

<section name="output-schema" locked="true">
## JSON Schema
{
  "level": "orchestrated",
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Why it matters",
    "suggestion": "What to do (omit for praise)",
    "confidence": 0.0-1.0
  }],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "...",
    "title": "Brief title",
    "description": "File-level observation",
    "suggestion": "How to fix (omit for praise)",
    "confidence": 0.0-1.0
  }],
  "summary": "Key findings as if from single reviewer (no mention of levels/orchestration)"
}
</section>

<section name="diff-instructions" required="true" tier="fast">
## old_or_new
"NEW" (default): added [+] and context lines. "OLD": deleted [-] only. Preserve from input.
</section>

<section name="guidelines" required="true" tier="fast">
## Notes
Quality over quantity. Higher confidence for multi-level findings. Only modified files. Omit uncertain suggestions. Preserve file-level insights.
</section>`;

/**
 * Section definitions with metadata
 * Used for parsing and validation
 */
const sections = [
  { name: 'role', required: true, tier: ['fast'] },
  { name: 'task-header', required: true, tier: ['fast'] },
  { name: 'line-number-guidance', required: true, tier: ['fast'] },
  { name: 'critical-output', locked: true },
  { name: 'role-description', required: true, tier: ['fast'] },
  { name: 'custom-instructions', optional: true, tier: ['fast', 'balanced', 'thorough'] },
  { name: 'input-suggestions', locked: true },
  { name: 'intelligent-merging', required: true, tier: ['fast'] },
  { name: 'priority-curation', required: true, tier: ['fast'] },
  { name: 'balanced-output', required: true, tier: ['fast'] },
  { name: 'human-centric-framing', required: true, tier: ['fast'] },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true, tier: ['fast'] },
  { name: 'guidelines', required: true, tier: ['fast'] }
];

/**
 * Default section order for Orchestration Fast
 * Note: Removed file-level-guidance section (tier="balanced,thorough")
 */
const defaultOrder = [
  'role',
  'task-header',
  'line-number-guidance',
  'critical-output',
  'role-description',
  'custom-instructions',
  'input-suggestions',
  'intelligent-merging',
  'priority-curation',
  'balanced-output',
  'human-centric-framing',
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
