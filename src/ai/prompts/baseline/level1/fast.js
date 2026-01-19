// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Level 1 Fast Prompt - Changes in Isolation Analysis (Quick Review)
 *
 * This is the fast tier variant of Level 1 analysis. It is optimized for speed
 * with shorter, more directive prompts and simplified instructions.
 *
 * Tier-specific optimizations applied:
 * - Removed: speed-expectations section (redundant for fast tier)
 * - Removed: category-definitions section (model should know these)
 * - Simplified: focus-areas to essential checks only
 * - Simplified: guidelines to core requirements
 * - Shortened: available-commands to essentials
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

/**
 * Tagged prompt template for Level 1 Fast analysis
 *
 * Placeholders:
 * - {{reviewIntro}} - Review introduction line
 * - {{prContext}} - PR context section
 * - {{customInstructions}} - Custom instructions section (optional)
 * - {{lineNumberGuidance}} - Line number guidance section
 * - {{generatedFiles}} - Generated files exclusion section (optional)
 * - {{validFiles}} - List of valid files for suggestions
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
# Level 1 Review - Quick Diff Analysis
</section>

<section name="line-number-guidance" required="true" tier="fast">
{{lineNumberGuidance}}
</section>

<section name="generated-files" optional="true" tier="fast,balanced,thorough">
{{generatedFiles}}
</section>

<section name="valid-files" locked="true">
## Valid Files
ONLY suggest for files in this list:
{{validFiles}}
</section>

<section name="initial-setup" required="true" tier="fast">
## Steps
1. Run git-diff-lines
2. Focus ONLY on changed lines
</section>

<section name="focus-areas" required="true" tier="fast">
## What to Find
- Bugs and errors
- Logic issues
- Security vulnerabilities
- Performance problems
- Good practices (praise)
</section>

<section name="available-commands" required="true" tier="fast">
## Commands (READ-ONLY)
git-diff-lines, \`cat -n\`, ls, find, grep. Do NOT modify files.
</section>

<section name="output-schema" locked="true">
## Output Format

**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**

{
  "level": 1,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Explanation",
    "suggestion": "How to fix (omit for praise)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary"
}
</section>

<section name="diff-instructions" required="true" tier="fast">
## Line Numbers (old_or_new)
- "NEW" (default): added [+] and context lines
- "OLD": deleted [-] lines only
Default to NEW if unclear.
</section>

<section name="guidelines" required="true" tier="fast">
## Guidelines
- High confidence only, skip uncertain issues
- Prefer line-level over file-level comments
- Prioritize changed lines
- Praise: omit suggestion field; Others: include actionable fix
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
  { name: 'valid-files', locked: true },
  { name: 'initial-setup', required: true, tier: ['fast'] },
  { name: 'focus-areas', required: true, tier: ['fast'] },
  { name: 'available-commands', required: true, tier: ['fast'] },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true, tier: ['fast'] },
  { name: 'guidelines', required: true, tier: ['fast'] }
];

/**
 * Default section order for Level 1 Fast
 * Note: Removed speed-expectations and category-definitions sections
 */
const defaultOrder = [
  'role',
  'pr-context',
  'custom-instructions',
  'level-header',
  'line-number-guidance',
  'generated-files',
  'valid-files',
  'initial-setup',
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
