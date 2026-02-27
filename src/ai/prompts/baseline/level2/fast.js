// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Level 2 Fast Prompt - File Context Analysis (Quick Review)
 *
 * This is the fast tier variant of Level 2 analysis. It is optimized for speed
 * with shorter, more directive prompts and simplified instructions.
 *
 * Tier-specific optimizations applied:
 * - Removed: file-level-guidance section (tier="balanced,thorough")
 * - Simplified: focus-areas to essential checks only
 * - Simplified: guidelines to core requirements
 * - Shortened: available-commands to essentials
 * - Shortened: analysis-process to key steps only
 *
 * Section categories:
 * - locked: Cannot be modified by variants (data integrity)
 * - required: Must be present, content can be rephrased
 * - optional: Can be removed entirely if unhelpful
 */

/**
 * Tagged prompt template for Level 2 Fast analysis
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
# Level 2 Review - Quick File Context Analysis
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

<section name="analysis-process" required="true" tier="fast">
## Steps
1. Run annotated diff tool for changes with line numbers
2. Read full file when context needed
3. Anchor comments to specific lines
</section>

<section name="focus-areas" required="true" tier="fast">
## Find
- File inconsistencies (naming, patterns, error handling)
- Missing related changes
- Security issues
- Style violations
- Good practices (praise)
</section>

<section name="available-commands" required="true" tier="fast">
## Commands (READ-ONLY)
Annotated diff tool (preferred), \`cat -n <file>\`, ls, find, grep. Do NOT modify files.
</section>

<section name="output-schema" locked="true">
## Output Format

**>>> CRITICAL: Output ONLY valid JSON. No markdown, no \`\`\`json blocks. Start with { end with }. <<<**

{
  "level": 2,
  "suggestions": [{
    "file": "path/to/file",
    "line": 42,
    "old_or_new": "NEW",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "Brief title",
    "description": "Why file context was needed",
    "suggestion": "How to fix (omit for praise)",
    "confidence": 0.0-1.0
  }],
  "fileLevelSuggestions": [{
    "file": "path/to/file",
    "type": "bug|improvement|praise|suggestion|design|performance|security|code-style",
    "title": "File-level concern",
    "description": "File-level observation",
    "suggestion": "How to address (omit for praise)",
    "confidence": 0.0-1.0
  }],
  "summary": "Brief summary"
}

### GitHub Suggestion Syntax
When suggesting a specific change, **embed** a GitHub suggestion block within the "suggestion" field:

\`\`\`suggestion
replacement content here
\`\`\`

The content inside the block is the complete replacement for the commented line(s). Do not include explanation inside the block — any explanation should appear as plain text outside it. For non-specific suggestions, use plain text only.
</section>

<section name="diff-instructions" required="true" tier="fast">
## Line Numbers
"NEW" (default): added [+] and context lines. "OLD": only deleted [-] lines.
</section>

<section name="guidelines" required="true" tier="fast">
## Guidelines
- Anchor file-context issues to specific lines when possible
- Omit suggestion field for praise; include for all other types
- Only include confident suggestions
- Skip files with no issues to report
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
  { name: 'analysis-process', required: true, tier: ['fast'] },
  { name: 'focus-areas', required: true, tier: ['fast'] },
  { name: 'available-commands', required: true, tier: ['fast'] },
  { name: 'output-schema', locked: true },
  { name: 'diff-instructions', required: true, tier: ['fast'] },
  { name: 'guidelines', required: true, tier: ['fast'] }
];

/**
 * Default section order for Level 2 Fast
 * Note: Removed file-level-guidance section (tier="balanced,thorough")
 */
const defaultOrder = [
  'role',
  'pr-context',
  'custom-instructions',
  'level-header',
  'line-number-guidance',
  'generated-files',
  'valid-files',
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
