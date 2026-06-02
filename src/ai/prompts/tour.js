// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Tour prompt builder.
 *
 * Pure function that produces the prompt body sent to the background provider
 * for generating a guided "tour" of a code review. The agent is expected to
 * actively explore the worktree (read files, run the annotated diff tool,
 * grep) and choose stops grounded in real code it has read directly.
 */

const { buildAnalysisLineNumberGuidance } = require('./line-number-guidance');

// What the prompt asks the model for. Trivial diffs may legitimately yield
// only one or two stops; we don't want to coerce padding.
const PROMPT_MIN_STOPS = 1;
// Persistence gate: fewer than this and the result is treated as
// "not tour-worthy" rather than published.
const PERSIST_MIN_STOPS = 2;
const MAX_STOPS = 12;
const TITLE_MAX = 120;
// Storage cap. The UI clamps the visible description to ~3 lines and
// reveals the rest behind a "Show more" toggle, so we can afford to give
// the model more room than the old 280-char hard cap (which produced
// visibly mid-sentence truncations the user hated).
const DESCRIPTION_MAX = 800;

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
 * annotated diff tool) and ground every stop in real file content.
 *
 * @param {Object}   context
 * @param {string}   [context.prTitle]            Optional PR title or local-review name.
 * @param {string}   [context.prDescription]      Optional PR description.
 * @param {string}   context.scriptCommand        Annotated-diff command (e.g. `git-diff-lines --cwd "/abs"`).
 * @param {string[]} context.changedFiles         Repo-relative paths of files in the diff.
 * @param {string}   [context.worktreePath]       Informational; the agent's cwd.
 * @returns {string} The full prompt.
 */
function buildTourPrompt({
  prTitle,
  prDescription,
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
      `      "description": "1-3 sentences; aim for ~200-300 chars, up to ${DESCRIPTION_MAX}"`,
      '    }',
      '  ]',
      '}',
      '',
      '`side` is "LEFT" or "RIGHT".'
    ].join('\n')
  );

  sections.push(
    [
      'Style:',
      `- title: a short noun phrase, <= ${TITLE_MAX} characters.`,
      `- description: 1–3 sentences. Aim for ~200–300 characters; up to ${DESCRIPTION_MAX}`,
      '  if more context is genuinely needed. Explain WHY this stop matters and',
      '  what to look for. Do NOT restate what the code does; say why it is load-bearing.',
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
      'Every stop MUST point at lines that actually changed in the diff:',
      '- The chosen `[line_start, line_end]` range MUST intersect changed',
      '  lines for the chosen `side` in the chosen file.',
      '- Stops on unchanged code or on files outside the diff will be rejected.',
      '- If you want to call out unchanged code that the change interacts with,',
      '  pick a stop on a changed line nearby and reference the unchanged code',
      '  in the description text.'
    ].join('\n')
  );

  sections.push(
    [
      'Side semantics:',
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
      '  (full function, full block) before committing to a stop.'
    ].join('\n')
  );

  sections.push(buildAnalysisLineNumberGuidance({ scriptCommand }).trim());

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
    'Stops MUST be in one of the files above. Stops on other files will be rejected.'
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
