// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const { z } = require('zod');

const line = z.number().int().positive().nullable();
const suggestion = z.object({
  file: z.string().min(1).refine(p => !p.startsWith('/') && !p.includes('\\') &&
    !p.split('/').some(s => s === '..' || s === '.') && !/[\x00-\x1f]/.test(p)),
  line_start: line, line_end: line,
  old_or_new: z.enum(['NEW', 'OLD']),
  type: z.enum(['bug', 'improvement', 'security', 'performance', 'design', 'suggestion', 'code-style', 'praise']),
  severity: z.enum(['critical', 'medium', 'minor']),
  title: z.string().min(1), description: z.string().min(1), suggestion: z.string(),
  is_file_level: z.boolean(),
}).strict().refine(s => s.is_file_level
  ? s.line_start === null && s.line_end === null
  : s.line_start !== null && (s.line_end === null || s.line_end >= s.line_start));
const schema = z.object({ summary: z.string(), suggestions: z.array(suggestion) }).strict();

function parseNativeResult(raw) {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    // Do not echo a malformed (potentially private) payload into another provider.
    throw new Error('Invalid native result: expected the pair-review suggestion schema');
  }
}

module.exports = { parseNativeResult };
