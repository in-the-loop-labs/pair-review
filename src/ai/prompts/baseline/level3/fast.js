// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Level 3 Fast Prompt - Codebase Context Analysis (Quick Review)
 *
 * This is the fast tier variant of Level 3 analysis. It is optimized for speed
 * with shorter, more directive prompts and simplified instructions.
 *
 * Tier-specific optimizations applied:
 * - Removed: file-level-guidance section (tier="balanced,thorough")
 * - Simplified: focus-areas to essential architectural checks only
 * - Simplified: guidelines to core requirements
 * - Shortened: available-commands to essentials
 * - Shortened: analysis-process to key steps only
 * - Shortened: purpose to minimal context
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

/**
 * Tagged prompt template for Level 3 Fast analysis
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
const taggedPrompt = `<section name="role" required="true" tier="fast">
{{reviewIntro}}
</section>

<section name="pr-context" locked="true">
{{prContext}}
</section>

<section name="custom-instructions" optional="true" tier="fast,balanced,thorough">
{{customInstructions}}
</section>

<section name="level-header" required="true" tier="fast">
# Level 3 Review - Quick Codebase Impact Analysis
</section>

<section name="line-number-guidance" required="true" tier="fast">
{{lineNumberGuidance}}
</section>

<section name="generated-files" optional="true" tier="fast,balanced,thorough">
{{generatedFiles}}
</section>

<section name="changed-files" locked="true">
{{changedFiles}}
</section>

<section name="purpose" required="true" tier="fast">
## Purpose
Level 3 checks how changes connect to and impact the broader codebase.
Focus on relationships between changed code and existing patterns.
</section>

<section name="analysis-process" required="true" tier="fast">
## Steps
1. Explore outward from changed files to understand connections
2. Check how changes interact with referencing/referenced files
3. Verify changes follow established patterns
4. Skip areas without cross-cutting concerns
</section>

<section name="focus-areas" required="true" tier="fast">
## What to Find
- Architectural inconsistencies with existing patterns
- Cross-file dependency issues
- {{testingGuidance}}
- Breaking changes or API contract violations
- Security issues in connected systems
- Good architectural decisions worth praising
</section>

<section name="available-commands" required="true" tier="fast">
## Commands (READ-ONLY)
- find, grep to search patterns
- \`cat -n <file>\` for file content
- ls, tree to explore structure

Do NOT modify files.
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

<section name="diff-instructions" required="true" tier="fast">
## Line Numbers (old_or_new)
- **"NEW"** (default): For added lines [+] and context lines
- **"OLD"**: Only for deleted lines [-]

When unsure, use "NEW".
</section>

<section name="guidelines" required="true" tier="fast">
## Guidelines
- Focus on codebase-level issues requiring broader context
- Only include suggestions you're confident about. If you're uncertain whether something is actually an issue, skip it.
- Prefer line-level comments over file-level comments when the suggestion applies to a specific line or range of lines
- For "praise" type: omit the suggestion field
- For other types always include specific, actionable suggestions
</section>`;

/**
 * Section definitions with metadata
 * Used for parsing and validation
 */
const sections = [
  { name: 'role', required: true, tier: ['fast'] },
  { name: 'pr-context', locked: true },
  { name: 'custom-instructions', optional: true, tier: ['fast', 'balanced', 'thorough'] },
  { name: 'level-header', required: true, tier: ['fast'] },
  { name: 'line-number-guidance', required: true, tier: ['fast'] },
  { name: 'generated-files', optional: true, tier: ['fast', 'balanced', 'thorough'] },
  { name: 'changed-files', locked: true },
  { name: 'purpose', required: true, tier: ['fast'] },
  { name: 'analysis-process', required: true, tier: ['fast'] },
  { name: 'focus-areas', required: true, tier: ['fast'] },
  { name: 'available-commands', required: true, tier: ['fast'] },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true, tier: ['fast'] },
  { name: 'guidelines', required: true, tier: ['fast'] }
];

/**
 * Default section order for Level 3 Fast
 * Note: Removed file-level-guidance section (tier="balanced,thorough")
 */
const defaultOrder = [
  'role',
  'pr-context',
  'custom-instructions',
  'level-header',
  'line-number-guidance',
  'generated-files',
  'changed-files',
  'purpose',
  'analysis-process',
  'focus-areas',
  'available-commands',
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
