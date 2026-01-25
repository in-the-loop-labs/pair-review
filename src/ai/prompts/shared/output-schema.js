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
 * Input schema documentation for orchestration prompts
 * Documents the JSON structure of suggestions passed to the orchestration layer
 */
const ORCHESTRATION_INPUT_SCHEMA_DOCS = `Each level provides suggestions as a JSON array with the following schema per item:
- file: path to the file
- line_start: starting line number
- line_end: ending line number
- old_or_new: "NEW" for added/context lines, "OLD" for deleted lines
- type: suggestion type (bug, improvement, praise, etc.)
- title: brief title
- description: full explanation
- suggestion: remediation advice
- confidence: 0.0-1.0 score
- is_file_level: true if this is a file-level suggestion (no line numbers)`;

/**
 * Level 1 output schema (diff analysis - changes in isolation)
 */
const LEVEL1_OUTPUT_SCHEMA = {
  level: 1,
  suggestions: [{
    file: 'path/to/file',
    line: 42,
    old_or_new: 'NEW',
    type: 'bug|improvement|praise|suggestion|design|performance|security|code-style',
    title: 'Brief title',
    description: 'Detailed explanation',
    suggestion: 'How to fix/improve (omit this field for praise items - no action needed)',
    confidence: '0.0-1.0'
  }],
  summary: 'Brief summary of findings'
};

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
 * Level 3 output schema (codebase context analysis)
 */
const LEVEL3_OUTPUT_SCHEMA = {
  level: 3,
  suggestions: [{
    file: 'path/to/file',
    line: 42,
    old_or_new: 'NEW',
    type: 'bug|improvement|praise|suggestion|design|performance|security|code-style',
    title: 'Brief title',
    description: 'Detailed explanation mentioning why codebase context was needed',
    suggestion: 'How to fix/improve based on codebase context (omit for praise items)',
    confidence: '0.0-1.0'
  }],
  fileLevelSuggestions: [{
    file: 'path/to/file',
    type: 'bug|improvement|praise|suggestion|design|performance|security|code-style',
    title: 'Brief title describing file-level concern',
    description: 'Explanation of the file-level observation from codebase perspective',
    suggestion: 'How to address the file-level concern (omit for praise items)',
    confidence: '0.0-1.0'
  }],
  summary: 'Brief summary of how these changes connect to and impact the codebase'
};

/**
 * Orchestration output schema (curated multi-level analysis)
 */
const ORCHESTRATION_OUTPUT_SCHEMA = {
  level: 'orchestrated',
  suggestions: [{
    file: 'path/to/file',
    line: 42,
    old_or_new: 'NEW',
    type: 'bug|improvement|praise|suggestion|design|performance|security|code-style',
    title: 'Brief title describing the curated insight',
    description: 'Clear explanation of the issue and why this guidance matters to the human reviewer',
    suggestion: 'Specific, actionable guidance for the reviewer (omit for praise items)',
    confidence: '0.0-1.0'
  }],
  fileLevelSuggestions: [{
    file: 'path/to/file',
    type: 'bug|improvement|praise|suggestion|design|performance|security|code-style',
    title: 'Brief title describing file-level concern',
    description: 'Explanation of the file-level observation',
    suggestion: 'How to address the file-level concern (omit for praise items)',
    confidence: '0.0-1.0'
  }],
  summary: 'Brief summary of orchestration results and key patterns found'
};

/**
 * Helper to build a locked output schema section
 * @param {Object} schema - The output schema object
 * @returns {Object} Section definition
 */
function buildOutputSchemaSection(schema) {
  return {
    name: 'output-schema',
    locked: true,
    content: `## Output Format

### CRITICAL OUTPUT REQUIREMENT
Output ONLY valid JSON with no additional text, explanations, or markdown code blocks. Do not wrap the JSON in \`\`\`json blocks. The response must start with { and end with }.

Output JSON with this structure:
${JSON.stringify(schema, null, 2)}`
  };
}

/**
 * Section definition for output schema (Level 1)
 */
const level1OutputSchemaSection = buildOutputSchemaSection(LEVEL1_OUTPUT_SCHEMA);

/**
 * Section definition for output schema (Level 2)
 * @deprecated Use getOutputSchemaSection(2) instead
 */
const outputSchemaSection = buildOutputSchemaSection(LEVEL2_OUTPUT_SCHEMA);

/**
 * Section definition for output schema (Level 3)
 */
const level3OutputSchemaSection = buildOutputSchemaSection(LEVEL3_OUTPUT_SCHEMA);

/**
 * Section definition for output schema (Orchestration)
 */
const orchestrationOutputSchemaSection = buildOutputSchemaSection(ORCHESTRATION_OUTPUT_SCHEMA);

/**
 * Get the output schema section for a specific level
 * @param {number|string} level - Analysis level (1, 2, 3, or 'orchestration')
 * @returns {Object} Section definition
 */
function getOutputSchemaSection(level) {
  if (level === 1) {
    return level1OutputSchemaSection;
  }
  if (level === 2) {
    return outputSchemaSection;
  }
  if (level === 3) {
    return level3OutputSchemaSection;
  }
  if (level === 'orchestration') {
    return orchestrationOutputSchemaSection;
  }
  throw new Error(`Output schema for level ${level} not yet implemented`);
}

module.exports = {
  LEVEL1_OUTPUT_SCHEMA,
  LEVEL2_OUTPUT_SCHEMA,
  LEVEL3_OUTPUT_SCHEMA,
  ORCHESTRATION_OUTPUT_SCHEMA,
  ORCHESTRATION_INPUT_SCHEMA_DOCS,
  outputSchemaSection,
  level1OutputSchemaSection,
  level3OutputSchemaSection,
  orchestrationOutputSchemaSection,
  getOutputSchemaSection
};
