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
 * Two patches joined with no `diff --git` between them. Exercises the counters'
 * line-count bound only: the lookalikes inside the first hunk are counted, and
 * the second patch's `---`/`+++` pair, which arrives after that hunk has
 * delivered every line it declared, is not.
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

/**
 * A hunk header whose function context carries a lone carriage return.
 *
 * git trims trailing whitespace from the context line but keeps a `\r` in the
 * middle of it, so the header is `@@ -3,5 +3,5 @@ function foo() {\r  // x`.
 * A header regex ending in `(.*)$` without the dotAll flag rejects that line,
 * and a counter that relies on it then counts the hunk as +0/-0.
 *
 * Verbatim `git diff` output (git 2.x) for a file whose line 1 is
 * `function foo() {\r  // x`.
 */
const CR_CONTEXT_DIFF = [
  'diff --git a/f.js b/f.js',
  'index 38895eb..9755c24 100644',
  '--- a/f.js',
  '+++ b/f.js',
  '@@ -3,5 +3,5 @@ function foo() {\r  // x',
  '   b',
  '   c',
  '   d',
  '-  e',
  '+  E',
  ' }',
  ''
].join('\n');

const CR_CONTEXT_STATS = { 'f.js': { additions: 1, deletions: 1 } };

module.exports = {
  LOOKALIKE_DIFF,
  LOOKALIKE_STATS,
  EXHAUSTED_HUNK_PATCH,
  EXHAUSTED_HUNK_STATS,
  CR_CONTEXT_DIFF,
  CR_CONTEXT_STATS
};
