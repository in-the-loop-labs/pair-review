// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared fixtures for the diff line counters.
 *
 * Inside a hunk, a deleted `-- x` line (a SQL/Lua comment) is emitted as
 * `--- x` and an added `++ x` line as `+++ x`: content that looks like a file
 * header. The server (`countPatchStats` in src/utils/diff-file-list.js,
 * `countAddedLines` in src/ai/summary-generator.js) and the browser
 * (`HunkParser.countPatchStats` in public/js/modules/hunk-parser.js) each count
 * these, so all three suites run the same cases.
 *
 * LOOKALIKE_DIFF is verbatim `git diff` output (git 2.x).
 */

const LOOKALIKE_DIFF = [
  'diff --git a/a.js b/a.js',
  'index 489ce0f..3e5126c 100644',
  '--- a/a.js',
  '+++ b/a.js',
  '@@ -1 +1 @@',
  '-old',
  '\\ No newline at end of file',
  '+new',
  '\\ No newline at end of file',
  'diff --git a/img.bin b/img.bin',
  'index bdc955b..8835708 100644',
  'Binary files a/img.bin and b/img.bin differ',
  'diff --git a/q.sql b/q.sql',
  'index 9ef5139..7d58919 100644',
  '--- a/q.sql',
  '+++ b/q.sql',
  '@@ -1,4 +1,4 @@',
  ' select 1;',
  '--- legacy comment',
  '-drop table t;',
  '+++ new comment',
  '+++x',
  ' select 2;',
  ''
].join('\n');

/** Per-file counts for LOOKALIKE_DIFF, keyed by path. */
const LOOKALIKE_STATS = {
  'a.js': { additions: 1, deletions: 1 },
  'img.bin': { additions: 0, deletions: 0 },
  'q.sql': { additions: 2, deletions: 2 }
};

/**
 * A bare concatenation of two patches (no `diff --git`). The second file's
 * `---`/`+++` pair follows a hunk that has delivered every line it declared,
 * so it is a header; the lookalikes inside the first hunk are content.
 */
const EXHAUSTED_HUNK_PATCH = [
  '--- a/one.sql',
  '+++ b/one.sql',
  '@@ -1,2 +1,2 @@',
  '--- gone',
  '+++ here',
  ' same',
  '--- a/two.sql',
  '+++ b/two.sql',
  '@@ -1 +1 @@',
  '-x',
  '+y'
].join('\n');

const EXHAUSTED_HUNK_STATS = { additions: 2, deletions: 2 };

module.exports = { LOOKALIKE_DIFF, LOOKALIKE_STATS, EXHAUSTED_HUNK_PATCH, EXHAUSTED_HUNK_STATS };
