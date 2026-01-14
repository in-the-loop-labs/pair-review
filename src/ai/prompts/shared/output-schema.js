// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Output schema section - shared across prompt types
 *
 * This section defines the JSON structure for AI responses.
 * It is LOCKED and cannot be modified by variants.
 *
 * CRITICAL: Output schemas are sacred - they must be identical across
 * all providers to ensure consistent parsing.
 */

/**
 * Level 2 output schema (file context analysis)
 */
const LEVEL2_OUTPUT_SCHEMA = {
  level: 2,
  suggestions: [{
    file: 'path/to/file',
    line: 42,
    old_or_new: 'NEW',
    type: 'bug|improvement|praise|suggestion|design|performance|security|code-style',
    title: 'Brief title',
    description: 'Detailed explanation mentioning why full file context was needed',
    suggestion: 'How to fix/improve based on file context (omit for praise items)',
    confidence: 0.8
  }],
  fileLevelSuggestions: [{
    file: 'path/to/file',
    type: 'bug|improvement|praise|suggestion|design|performance|security|code-style',
    title: 'Brief title describing file-level concern',
    description: 'Explanation of the file-level observation (architecture, organization, naming, etc.)',
    suggestion: 'How to address the file-level concern (omit for praise items)',
    confidence: 0.8
  }],
  summary: 'Brief summary of file context findings'
};

/**
 * Section definition for output schema (Level 2)
 */
const outputSchemaSection = {
  name: 'output-schema',
  locked: true,
  content: `## Output Format

### CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks. Do not wrap the JSON in \`\`\`json blocks. The response must start with { and end with }.

Output JSON with this structure:
${JSON.stringify(LEVEL2_OUTPUT_SCHEMA, null, 2)}`
};

/**
 * Get the output schema section for a specific level
 * @param {number} level - Analysis level (1, 2, or 3)
 * @returns {Object} Section definition
 */
function getOutputSchemaSection(level) {
  // For now, only Level 2 is implemented
  if (level === 2) {
    return outputSchemaSection;
  }
  throw new Error(`Output schema for level ${level} not yet implemented`);
}

module.exports = {
  LEVEL2_OUTPUT_SCHEMA,
  outputSchemaSection,
  getOutputSchemaSection
};
