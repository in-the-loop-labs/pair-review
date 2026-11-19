// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Output schema documentation shared across prompt types.
 *
 * Each baseline prompt defines its own locked `output-schema` section inline
 * (see src/ai/prompts/baseline/). This module holds only the input schema docs
 * that the orchestration prompts embed to describe the suggestions they receive.
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
- severity: "critical", "medium", or "minor" (omit for praise items)
- confidence: 0.0-1.0 score
- reasoning: (optional) array of strings with concise code evidence and impact
- is_file_level: true if this is a file-level suggestion (no line numbers)`;

module.exports = {
  ORCHESTRATION_INPUT_SCHEMA_DOCS
};
