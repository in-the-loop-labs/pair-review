// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tour prompt builder.
 *
 * Pure function that produces the prompt body sent to the background provider
 * for generating a guided "tour" of a code review. The agent is expected to
 * actively explore the worktree (read files, run the annotated diff tool,
 * grep) and choose stops grounded in real code — summaries are hints, not
 * gospel.
 */

const { buildAnalysisLineNumberGuidance } = require('./line-number-guidance');

// What the prompt asks the model for. Trivial diffs may legitimately yield
// only one or two stops; we don't want to coerce padding.
const PROMPT_MIN_STOPS = 1;
// Persistence gate: fewer than this and the result is treated as
// "not tour-worthy" rather than published.
const PERSIST_MIN_STOPS = 2;
const MAX_STOPS = 12;
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 280;

/**
 * @typedef {Object} TourSummaryItem
 * @property {string} summary
 */

/**
 * @typedef {Object} TourSummariesByFile
 * @property {string} filePath
 * @property {TourSummaryItem[]} summaries
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
 * Build the prompt body sent to the background provider for generating a tour.
 *
 * The agent is expected to explore the worktree directly (Read, grep, the
 * annotated diff tool) and ground every stop in real file content. The
 * `summariesByFile` data is provided as orientation only.
 *
 * @param {Object}   context
 * @param {string}   [context.prTitle]            Optional PR title or local-review name.
 * @param {string}   [context.prDescription]      Optional PR description.
 * @param {TourSummariesByFile[]} [context.summariesByFile=[]]  Optional non-trivial per-hunk summaries.
 * @param {string}   context.scriptCommand        Annotated-diff command (e.g. `git-diff-lines --cwd "/abs"`).
 * @param {string[]} context.changedFiles         Repo-relative paths of files in the diff.
 * @param {string}   [context.worktreePath]       Informational; the agent's cwd.
 * @returns {string} The full prompt.
 */
function buildTourPrompt({
  prTitle,
  prDescription,
  summariesByFile = [],
  scriptCommand,
  changedFiles,
  worktreePath
} = {}) {
  if (!hasText(scriptCommand)) {
    throw new TypeError('scriptCommand is required');
  }
  if (!Array.isArray(changedFiles)) {
    throw new TypeError('changedFiles is required');
  }
  if (summariesByFile !== undefined && summariesByFile !== null && !Array.isArray(summariesByFile)) {
    throw new TypeError('summariesByFile must be an array when provided');
  }

  const sections = [];

  sections.push(
    [
      'You are building a guided tour of a pull request or local code change.',
      'The tour exists for ONE reason: accelerated understanding of the change',
      'for the reader.',
      '',
      'Audience: a reviewer who needs to build an accurate mental model of',
      'the change fast and know where to focus scrutiny before deciding',
      'whether to approve, push back, or dig deeper.',
      '',
      'Success looks like: after reading the tour in order, the reviewer',
      '(a) understands what changed and why, and (b) knows which parts',
      'deserve careful attention.',
      '',
      'This is NOT a changelog or a hunk-by-hunk summary. Skip anything a',
      'competent reviewer absorbs at a glance. Privilege load-bearing logic,',
      'contract changes, and subtle risk over breadth of coverage.',
      '',
      'You have shell tools (Read, the annotated diff tool, cat, grep).',
      'EXPLORE the worktree directly. Ground every stop in real file content',
      'you have read. Do NOT modify files. Do NOT run write commands.'
    ].join('\n')
  );

  sections.push(
    [
      'Return ONLY a JSON object with this shape:',
      '{',
      '  "stops": [',
      '    {',
      '      "file_path": "src/foo.ts",',
      '      "side": "RIGHT",',
      '      "line_start": 42,',
      '      "line_end": 58,',
      `      "title": "<= ${TITLE_MAX} chars",`,
      `      "description": "<= ${DESCRIPTION_MAX} chars",`,
      '      "is_context": false',
      '    }',
      '  ]',
      '}',
      '',
      '`side` is "LEFT" or "RIGHT". `is_context` is described below.'
    ].join('\n')
  );

  sections.push(
    [
      'Style:',
      `- title: a short noun phrase, <= ${TITLE_MAX} characters.`,
      `- description: 1–3 sentences, <= ${DESCRIPTION_MAX} characters. Explain WHY`,
      '  this stop matters and what to look for. Do NOT restate what the code does;',
      '  say why it is load-bearing.',
      '- Be concrete. No fluff like "this is important code".'
    ].join('\n')
  );

  sections.push(
    [
      'Stop selection:',
      '- Order stops as a coherent reading path — start with the most load-bearing',
      '  change, then dependents, then supporting changes. Order does NOT have to',
      '  follow file order.',
      '- Skip mechanical/uninteresting code (formatting, imports, whitespace).',
      '  Include only stops a reviewer benefits from reading explicitly.',
      '- `[line_start, line_end]` should be tight — a function, a block, a few',
      '  related lines — not an entire file.',
      `- Return as many stops as the diff genuinely warrants, up to ${MAX_STOPS}.`,
      '  Trivial diffs may legitimately yield only 1-2 stops; do not pad. Fewer',
      '  well-chosen stops beat a long laundry list.',
      '- Stops must not overlap. Pick the single most informative range per',
      '  region; do not return multiple stops covering the same function or',
      '  block under different framings.'
    ].join('\n')
  );

  sections.push(
    [
      'is_context semantics (a property of the LINE RANGE, not the file):',
      '- `is_context: false` — the chosen range intersects changed lines on the',
      '  chosen side. Use for stops that point at the change itself.',
      '- `is_context: true` — the chosen range is entirely unchanged code (in',
      '  any file, whether the file is in the diff or not).',
      '',
      'A stop pointing at unchanged code is high-value when it shows the change',
      'is inconsistent with existing code, or will break something elsewhere.',
      'Use sparingly.',
      '- For context stops, `side` MUST be "RIGHT" (current code on disk).',
      '- The file must exist in the worktree; the line range must be within',
      '  file bounds. Verify with Read before returning.',
      '- Good examples: "this changed handler is inconsistent with the existing',
      '  pattern in src/x.js:120-140"; "this function\'s new contract will break',
      '  callers in src/y.js:45".'
    ].join('\n')
  );

  sections.push(
    [
      'Side semantics for changed-file stops:',
      '- `RIGHT` = post-change content (added or context lines, by NEW line numbers).',
      '- `LEFT` = pre-change content (deleted lines, by OLD line numbers). Use only',
      '  when calling out something that was removed.',
      '- The range must intersect a changed-line region on the chosen side. Use the',
      '  annotated diff tool to confirm.'
    ].join('\n')
  );

  sections.push(
    [
      'Exploration discipline:',
      '- Use the annotated diff tool to ground every line number. Treat it as the',
      '  authoritative source for which lines changed and on which side.',
      '- Read the relevant files to verify ranges sit on meaningful boundaries',
      '  (full function, full block) before committing to a stop.',
      '- The hints below are a planning aid — verify against the actual code.'
    ].join('\n')
  );

  sections.push(buildAnalysisLineNumberGuidance({ scriptCommand }).trim());

  if (Array.isArray(summariesByFile) && summariesByFile.length > 0) {
    const hintLines = [];
    for (const entry of summariesByFile) {
      const filePath = entry && entry.filePath;
      const summaries = entry && Array.isArray(entry.summaries) ? entry.summaries : [];
      if (!hasText(filePath) || summaries.length === 0) continue;
      const fileBlock = [`  File: ${filePath}`];
      for (const s of summaries) {
        if (!s || !hasText(s.summary)) continue;
        fileBlock.push(`    - ${s.summary.trim()}`);
      }
      if (fileBlock.length > 1) {
        hintLines.push(fileBlock.join('\n'));
      }
    }
    if (hintLines.length > 0) {
      sections.push(
        [
          'Per-hunk hints (use to plan exploration; not gospel — verify against the code):',
          ...hintLines
        ].join('\n')
      );
    }
  }

  if (hasText(prTitle) || hasText(prDescription)) {
    const intentLines = ["Author's stated intent (HINT only — verify against the code):"];
    if (hasText(prTitle)) {
      intentLines.push(`  Title: ${prTitle.trim()}`);
    }
    if (hasText(prDescription)) {
      intentLines.push(`  Description: ${prDescription.trim()}`);
    }
    sections.push(intentLines.join('\n'));

    sections.push(
      [
        "The author's stated intent above is a HINT for orientation and vocabulary.",
        'It is NOT verified ground truth. The code and diff are ground truth.',
        '- If the description and the code disagree, follow the code.',
        '- If the description is vague, templated, or empty, ignore it entirely.'
      ].join('\n')
    );
  }

  const changedFilesBlock = ['Changed files in this diff:'];
  if (changedFiles.length === 0) {
    changedFilesBlock.push('  (none)');
  } else {
    for (const path of changedFiles) {
      changedFilesBlock.push(`  - ${path}`);
    }
  }
  changedFilesBlock.push('');
  changedFilesBlock.push(
    'Stops on files OUTSIDE this list MUST use `is_context: true`.'
  );
  sections.push(changedFilesBlock.join('\n'));

  if (hasText(worktreePath)) {
    sections.push(`Your working directory is: ${worktreePath}`);
  }

  sections.push(
    [
      'Final output rules:',
      '- JSON only. No prose, no markdown fences.',
      '- Validate every range against file bounds and (for changed-file stops)',
      '  against the annotated diff before returning.'
    ].join('\n')
  );

  return sections.join('\n\n');
}

module.exports = {
  buildTourPrompt,
  TOUR_PROMPT_MIN_STOPS: PROMPT_MIN_STOPS,
  TOUR_PERSIST_MIN_STOPS: PERSIST_MIN_STOPS,
  TOUR_MAX_STOPS: MAX_STOPS,
  TOUR_TITLE_MAX: TITLE_MAX,
  TOUR_DESCRIPTION_MAX: DESCRIPTION_MAX
};
