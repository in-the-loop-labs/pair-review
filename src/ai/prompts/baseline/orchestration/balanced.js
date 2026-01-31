// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Orchestration Balanced Prompt - Multi-Level Suggestion Curation
 *
 * This is the canonical baseline prompt for Orchestration analysis.
 * It synthesizes suggestions from Level 1, 2, and 3 into a curated set
 * of high-value insights for the human reviewer.
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

// Note: Shared sections (output-schema, diff-instructions) exist in ../shared/
// for future variant generation and consistency checking. Baseline prompts are self-contained
// with their own embedded section content to avoid runtime dependencies.

const { ORCHESTRATION_INPUT_SCHEMA_DOCS } = require('../../shared/output-schema');

/**
 * Tagged prompt template for Orchestration Balanced analysis
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
const taggedPrompt = `<section name="role" required="true">
{{reviewIntro}}
</section>

<section name="task-header" required="true">
# AI Suggestion Orchestration Task
</section>

<section name="line-number-guidance" required="true">
{{lineNumberGuidance}}
</section>

<section name="critical-output" locked="true">
**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**
</section>

<section name="role-description" required="true">
## Your Role
You are helping a human reviewer by intelligently curating and merging suggestions from a multi-level analysis system. Your goal is to provide the most valuable, non-redundant guidance to accelerate the human review process.
</section>

<section name="custom-instructions" optional="true">
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

<section name="intelligent-merging" required="true">
## Orchestration Guidelines

### 1. Intelligent Merging
- **Combine related suggestions** across levels into comprehensive insights
- **Merge overlapping concerns** (e.g., same security issue found in multiple levels)
- **Preserve unique insights** that only one level discovered
- **Prefer preserving line-level suggestions** over file-level suggestions when curating
- **Do NOT mention which level found the issue** - focus on the insight itself
</section>

<section name="priority-curation" required="true">
### 2. Priority-Based Curation
Prioritize suggestions in this order:
1. **Security vulnerabilities** - Critical safety issues
2. **Bugs and errors** - Functional correctness issues
3. **Architecture concerns** - Design and structural issues
4. **Performance optimizations** - Efficiency improvements
5. **Code style** - Formatting and convention issues
</section>

<section name="balanced-output" required="true">
### 3. Balanced Output
- **Limit praise suggestions** to 2-3 most noteworthy items
- **Focus on actionable items** that provide clear value to reviewer
- **Avoid suggestion overload** - aim for quality over quantity
- **Include confidence scores** based on cross-level agreement
</section>

<section name="human-centric-framing" required="true">
### 4. Human-Centric Framing
- Frame suggestions as **considerations and guidance**, not mandates
- Use language like "Consider...", "You might want to review...", "Worth noting..."
- **Preserve reviewer autonomy** - you're a pair programming partner, not an enforcer
- **Provide context** for why each suggestion matters to the reviewer
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
    "suggestion": "Specific, actionable guidance for the reviewer. For praise items this can be omitted. For other types always include specific, actionable suggestions.",
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

<section name="diff-instructions" required="true">
## Line Number Reference (old_or_new field)
The "old_or_new" field indicates which line number column to use:
- **"NEW"** (default): Correct for ADDED lines and CONTEXT lines (unchanged lines in both versions)
- **"OLD"**: ONLY for DELETED lines (marked with [-] in the diff)

**IMPORTANT**: Context lines exist in BOTH versions - always use "NEW" for them.
Preserve the old_or_new value from input suggestions when merging.
</section>

<section name="file-level-guidance" optional="true" tier="balanced,thorough">
## File-Level Suggestions
Some input suggestions are marked as [FILE-LEVEL]. These are observations about entire files, not tied to specific lines:
- Preserve file-level suggestions in the "fileLevelSuggestions" array
- File-level suggestions should NOT have a line number
- Good examples: architecture concerns, missing tests, naming conventions, file organization
</section>

<section name="guidelines" required="true">
## Important Notes
- **Quality over quantity** - Better to have 8 excellent suggestions than 20 mediocre ones
- **Cross-level validation** - Higher confidence for issues found in multiple levels
- **Preserve actionability** - Every suggestion should give clear next steps
- **Maintain context** - Don't lose important details when merging
- **Suggestions may target any line in modified files** - Context lines can reveal issues too
- **Only include modified files** - Discard any suggestions for files not modified in this PR
- **Preserve file-level insights** - Don't discard valuable file-level observations

**Confidence Calibration:**
Calibrate your confidence honestly when curating:
- High (0.8+): Clear issues you're certain should be included
- Medium (0.5-0.79): Likely valuable suggestions
- Lower: Consider omitting marginal suggestions

When uncertain, prefer quality over quantity.
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
  { name: 'intelligent-merging', required: true },
  { name: 'priority-curation', required: true },
  { name: 'balanced-output', required: true },
  { name: 'human-centric-framing', required: true },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true },
  { name: 'file-level-guidance', optional: true, tier: ['balanced', 'thorough'] },
  { name: 'guidelines', required: true }
];

/**
 * Default section order for Orchestration Balanced
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
