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
 * @property {string} [cwd] - Optional working directory the agent is running in.
 *   When provided, the prompt invites bounded read-only file access; the path
 *   itself is NOT embedded in the prompt. Used purely as a signal flag — when
 *   omitted, the prompt does not promise read-only access at all.
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
function buildHunkSummaryPrompt({ filePath, hunks, prTitle, prDescription, changedFiles, cwd } = {}) {
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
    'You are summarizing changed hunks from a code review. Treat the diff text provided below as the primary source. Do NOT modify files. Do NOT run write commands (rm, mv, git commit, etc.). Produce concise natural-language summaries.'
  );

  if (hasText(cwd)) {
    sections.push(
      [
        'You have read-only access to the current working directory. The diff is',
        'your primary source. You MAY consult adjacent code ONLY when it materially',
        'improves the description of WHAT changed:',
        '- A symbol introduced/modified in the diff has callers or a definition',
        '  elsewhere whose existence changes the summary (e.g. "extracts a helper',
        '  now used by 4 sites" vs "adds a helper").',
        '- The diff is locally ambiguous about what changed (e.g. a one-line',
        '  signature change whose meaning depends on the function body not in',
        '  the hunk).',
        '',
        'Budget per file: at most ~5 file reads, ~3 grep calls. Do not browse',
        'broadly. Do not read tests, fixtures, or generated files unless directly',
        'relevant. Do not modify any file.',
        '',
        'The summary still describes what the DIFF changes, not what the',
        'surrounding code does. Context informs phrasing; it does not become',
        'the subject.'
      ].join('\n')
    );
  }

  sections.push(
    [
      'Style:',
      '- 1–3 sentences. Aim for one; use two only when a second sentence adds',
      '  information the first cannot. Three is rare.',
      '- Target ~200 characters; hard ceiling 400.',
      '- State WHAT changed in the diff. Context informs phrasing; it does not',
      '  become the subject. Do not speculate beyond what code you can see makes',
      '  unambiguous.',
      '- For mechanical changes (formatting, trivial rename), say so in one short',
      '  sentence and stop.',
      '- Lead with a verb (Adds, Removes, Renames, Refactors, Fixes, Moves,',
      '  Inlines, Extracts).'
    ].join('\n')
  );

  sections.push(
    [
      'You MAY return summary: null for a hunk only when ALL of these hold:',
      '- The change is purely mechanical (whitespace, import reorder, lint fix,',
      '  trivial rename) AND',
      '- A reader scanning the diff would learn nothing from a summary.',
      '',
      'Default is to summarize. When in doubt, write the summary.'
    ].join('\n')
  );

  if (hasText(prTitle) || hasText(prDescription)) {
    const contextLines = ["Author's stated intent (hint only — verify against the diff):"];
    if (hasText(prTitle)) {
      contextLines.push(`  Title: ${prTitle.trim()}`);
    }
    if (hasText(prDescription)) {
      contextLines.push(`  Description: ${prDescription.trim()}`);
    }
    sections.push(contextLines.join('\n'));

    sections.push(
      [
        "The author's stated intent above is a HINT — useful for orientation and",
        'vocabulary. It is NOT verified ground truth. The diff is ground truth.',
        '- Use the description to orient your reading and to choose vocabulary that',
        '  matches the project (e.g. domain terms).',
        '- Do NOT repeat or paraphrase the description as the summary.',
        '- If the diff and the description disagree, describe the diff. Do not',
        '  paper over the disagreement, and do not editorialize about it — just',
        '  state what the diff does.',
        '- If the description is vague, templated, or empty, ignore it entirely.'
      ].join('\n')
    );
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
        '    { "index": 2, "summary": null }',
        '] }',
        '',
        'Rules:',
        '- One entry per hunk above; index matches the [N] label.',
        '- `summary` is `string | null` (null only per the opt-out clause above).',
        '- Do not include any extra fields, explanation, or prose outside the JSON.'
      ].join('\n')
    );
  }

  return sections.join('\n\n');
}

module.exports = { buildHunkSummaryPrompt };
