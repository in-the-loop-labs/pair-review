// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Hunk summary prompt builder.
 *
 * Pure function that produces the prompt body sent to the background provider
 * for summarizing one file's worth of diff hunks. Output schema and length
 * constraints are defined in plans/semantic-hunk-summaries-and-tours.md
 * ("Prompt Design Notes" -> "Summary prompt contract").
 */

const MAX_CHANGED_FILES_LISTED = 100;

/**
 * @typedef {Object} HunkInput
 * @property {string} header - "@@ -10,5 +10,7 @@" line
 * @property {string[]} lines - Diff body lines with leading +/-/space markers
 */

/**
 * @typedef {Object} SummaryContext
 * @property {string} filePath - Path of the file being summarized
 * @property {HunkInput[]} hunks - Hunks to summarize, in file order
 * @property {string} [prTitle] - Optional PR title or local-review name
 * @property {string} [prDescription] - Optional PR description
 * @property {string[]} [changedFiles] - Optional list of all changed-file paths in this review (light context)
 */

/**
 * Returns true if the value is a non-empty, non-whitespace-only string.
 * @param {unknown} value
 * @returns {boolean}
 */
function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Build the prompt body sent to the background provider for summarizing one
 * file's worth of hunks. Returns a single string (the full prompt).
 * @param {SummaryContext} context
 * @returns {string}
 */
function buildHunkSummaryPrompt({ filePath, hunks, prTitle, prDescription, changedFiles } = {}) {
  if (!hasText(filePath)) {
    throw new TypeError('filePath is required');
  }
  if (hunks === undefined || hunks === null) {
    throw new TypeError('hunks is required');
  }
  if (!Array.isArray(hunks)) {
    throw new TypeError('hunks is required');
  }

  const sections = [];

  sections.push(
    'You are summarizing changed hunks from a code review. Use only the diff text provided. Do NOT modify files. Do NOT run write commands (rm, mv, git commit, etc.). Produce concise natural-language summaries.'
  );

  sections.push(
    [
      'Style rules:',
      '- Each summary <= 140 characters.',
      '- Single sentence, present-tense imperative ("Adds...", "Removes...", "Renames...", "Refactors...", "Fixes...").',
      '- Focus on WHAT changed (and WHY only if it is plainly visible). Do NOT speculate.',
      '- If the change is mechanical (formatting-adjacent, trivial rename), say so plainly.'
    ].join('\n')
  );

  if (hasText(prTitle) || hasText(prDescription)) {
    const contextLines = ['Review context:'];
    if (hasText(prTitle)) {
      contextLines.push(`  Title: ${prTitle.trim()}`);
    }
    if (hasText(prDescription)) {
      contextLines.push(`  Description: ${prDescription.trim()}`);
    }
    sections.push(contextLines.join('\n'));
  }

  if (Array.isArray(changedFiles) && changedFiles.length > 0) {
    if (changedFiles.length > MAX_CHANGED_FILES_LISTED) {
      sections.push(
        `Changed files in this review: ${changedFiles.length} total (list omitted for length)`
      );
    } else {
      const fileLines = ['Changed files in this review:'];
      for (const path of changedFiles) {
        fileLines.push(`  - ${path}`);
      }
      sections.push(fileLines.join('\n'));
    }
  }

  const hunkBlockLines = [`File: ${filePath}`, 'Hunks (numbered):'];
  if (hunks.length === 0) {
    hunkBlockLines.push('(no hunks)');
  } else {
    hunks.forEach((hunk, idx) => {
      const header = hunk && typeof hunk.header === 'string' ? hunk.header : '';
      const lines = hunk && Array.isArray(hunk.lines) ? hunk.lines : [];
      hunkBlockLines.push(`[${idx + 1}] ${header}`);
      if (lines.length > 0) {
        hunkBlockLines.push(lines.join('\n'));
      }
    });
  }
  sections.push(hunkBlockLines.join('\n'));

  if (hunks.length === 0) {
    sections.push(
      [
        'There are no hunks to summarize.',
        'Return ONLY this JSON object:',
        '{ "summaries": [] }',
        '',
        'Do not include any extra fields, explanation, or prose outside the JSON.'
      ].join('\n')
    );
  } else {
    sections.push(
      [
        'Return ONLY a JSON object with this shape:',
        '{ "summaries": [',
        '    { "index": 1, "summary": "Adds X to do Y." },',
        '    { "index": 2, "summary": "Removes Z." }',
        '] }',
        '',
        'Rules:',
        '- One entry per hunk above; index matches the [N] label.',
        '- Each summary is <= 140 characters and a single sentence.',
        '- Do not include any extra fields, explanation, or prose outside the JSON.'
      ].join('\n')
    );
  }

  return sections.join('\n\n');
}

module.exports = { buildHunkSummaryPrompt };
