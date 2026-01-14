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

/**
 * Tagged prompt template for Orchestration Fast analysis
 *
 * Placeholders:
 * - {{reviewIntro}} - Review introduction line
 * - {{prContext}} - PR context section (optional, may be empty)
 * - {{customInstructions}} - Custom instructions section (optional)
 * - {{lineNumberGuidance}} - Line number guidance section
 * - {{level1Suggestions}} - Formatted Level 1 suggestions
 * - {{level2Suggestions}} - Formatted Level 2 suggestions
 * - {{level3Suggestions}} - Formatted Level 3 suggestions
 * - {{fileLineCounts}} - File line count validation data (optional)
 */
const taggedPrompt = `<section name="role" required="true" tier="fast">
{{reviewIntro}}
</section>

<section name="task-header" required="true" tier="fast">
# Quick AI Suggestion Orchestration
</section>

<section name="line-number-guidance" required="true" tier="fast">
{{lineNumberGuidance}}
</section>

<section name="critical-output" locked="true">
## CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks. Do not wrap the JSON in \`\`\`json blocks. The response must start with { and end with }.
</section>

<section name="role-description" required="true" tier="fast">
## Your Role
Curate and merge suggestions from 3-level analysis into high-value, non-redundant guidance for the human reviewer.
</section>

<section name="custom-instructions" optional="true" tier="fast,balanced,thorough">
{{customInstructions}}
</section>

<section name="input-suggestions" locked="true">
## Input: Multi-Level Analysis Results

**Level 1 - Diff Analysis:**
{{level1Suggestions}}

**Level 2 - File Context:**
{{level2Suggestions}}

**Level 3 - Codebase Context:**
{{level3Suggestions}}
</section>

<section name="file-line-counts" optional="true" tier="fast,balanced,thorough">
{{fileLineCounts}}
</section>

<section name="intelligent-merging" required="true" tier="fast">
## Orchestration Guidelines

### 1. Merging
- Combine related suggestions across levels
- Merge overlapping concerns
- Preserve unique insights
- Do NOT mention which level found issues
</section>

<section name="priority-curation" required="true" tier="fast">
### 2. Priority Order
1. Security vulnerabilities
2. Bugs and errors
3. Architecture concerns
4. Performance
5. Code style
</section>

<section name="balanced-output" required="true" tier="fast">
### 3. Output Constraints
- Limit praise to 2-3 items
- Focus on actionable items
- Quality over quantity
</section>

<section name="human-centric-framing" required="true" tier="fast">
### 4. Framing
- Frame as guidance, not mandates
- Use "Consider...", "Worth noting..."
- Preserve reviewer autonomy
</section>

<section name="output-schema" locked="true">
## Output Format

### CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks. Do not wrap the JSON in \`\`\`json blocks. The response must start with { and end with }.

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
  "summary": "Brief summary of orchestration results and key patterns found"
}
</section>

<section name="diff-instructions" required="true" tier="fast">
## Line Numbers (old_or_new)
- **"NEW"** (default): For added lines [+] and context lines
- **"OLD"**: Only for deleted lines [-]

Preserve old_or_new from input suggestions when merging.
</section>

<section name="guidelines" required="true" tier="fast">
## Guidelines
- Quality over quantity - 8 excellent suggestions > 20 mediocre ones
- Higher confidence for issues found in multiple levels
- Only include modified files - discard suggestions for unmodified files
- Preserve file-level insights in fileLevelSuggestions array
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
  { name: 'file-line-counts', optional: true, tier: ['fast', 'balanced', 'thorough'] },
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
  'file-line-counts',
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
