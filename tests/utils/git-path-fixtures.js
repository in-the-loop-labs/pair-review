// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Shared git path spelling fixtures.
 *
 * The server and the browser share one decoder (public/js/utils/git-paths.js,
 * re-exported by src/utils/git-paths.js). The server tests, the browser tests
 * (parseUnifiedDiff, PierreBridge.parsePatch) and the changed_files builder
 * all run these cases, so every consumer spells a path the same way.
 *
 * Header strings are verbatim `git diff` output (git 2.47) captured from a
 * real repository, with core.quotePath=false (what pair-review runs) and with
 * git's default core.quotePath=true (diffs cached by older versions).
 */

/** [git spelling, decoded path] */
const DECODE_CASES = [
  ['src/plain.js', 'src/plain.js'],
  ['dir with space/a b.js', 'dir with space/a b.js'],
  ['café.js', 'café.js'],
  [String.raw`"caf\303\251.js"`, 'café.js'],
  [String.raw`"dir/m\303\266v\303\251d.js"`, 'dir/mövéd.js'],
  [String.raw`"\346\227\245\346\234\254\350\252\236.txt"`, '日本語.txt'],
  [String.raw`"emoji-\360\237\230\200.md"`, 'emoji-😀.md'],
  [String.raw`"src/tab\tname.js"`, 'src/tab\tname.js'],
  [String.raw`"nl\nname"`, 'nl\nname'],
  [String.raw`"quo\"te.js"`, 'quo"te.js'],
  [String.raw`"back\\slash.js"`, 'back\\slash.js'],
  [String.raw`"del\177.js"`, 'del\x7f.js'],
  [String.raw`"ctl\001.js"`, 'ctl\x01.js'],
  // A byte sequence that is not valid UTF-8 decodes to U+FFFD.
  [String.raw`"bad\377.js"`, 'bad�.js'],
  // A leading U+FEFF is part of the name, not a byte order mark.
  [String.raw`"\357\273\277name.js"`, '﻿name.js'],
  [String.raw`"dir/\357\273\277name.js"`, 'dir/﻿name.js'],
  // Not a complete quoted string: left alone.
  ['"half.js', '"half.js'],
  ['a => b.md', 'a => b.md']
];

/** [diff --git header, decoded old path, decoded new path] */
const DIFF_HEADER_CASES = [
  ['diff --git a/src/file.js b/src/file.js', 'src/file.js', 'src/file.js'],
  // core.quotePath=false
  ['diff --git a/café.js b/café.js', 'café.js', 'café.js'],
  ['diff --git a/lib/moved.js b/ñew dir/moved é.js', 'lib/moved.js', 'ñew dir/moved é.js'],
  [String.raw`diff --git "a/quo\"te.js" "b/quo\"te.js"`, 'quo"te.js', 'quo"te.js'],
  [String.raw`diff --git "a/back\\slash.js" "b/back\\slash.js"`, 'back\\slash.js', 'back\\slash.js'],
  [String.raw`diff --git "a/tab\tname.js" "b/tab\tname.js"`, 'tab\tname.js', 'tab\tname.js'],
  // Literal names that look like renames or contain " b/"
  ['diff --git a/a => b.md b/a => b.md', 'a => b.md', 'a => b.md'],
  ['diff --git a/src/{a => b}.md b/src/{a => b}.md', 'src/{a => b}.md', 'src/{a => b}.md'],
  ['diff --git a/x b/y.js b/x b/y.js', 'x b/y.js', 'x b/y.js'],
  // A rename whose paths share nothing
  ['diff --git a/old/thing.js b/totally/different.txt', 'old/thing.js', 'totally/different.txt'],
  ['diff --git a/a b.js b/c d.js', 'a b.js', 'c d.js'],
  // core.quotePath=true (diffs cached by older versions)
  [String.raw`diff --git "a/caf\303\251.js" "b/caf\303\251.js"`, 'café.js', 'café.js'],
  [String.raw`diff --git a/lib/moved.js "b/\303\261ew dir/moved \303\251.js"`, 'lib/moved.js', 'ñew dir/moved é.js'],
  [String.raw`diff --git "a/caf\303\251.js" b/cafe.js`, 'café.js', 'cafe.js'],
  [String.raw`diff --git "a/a\"b\\c.js" "b/a\"b\\c.js"`, 'a"b\\c.js', 'a"b\\c.js']
];

/** Lines that are not parseable `diff --git` headers. */
const MALFORMED_DIFF_HEADERS = [
  'invalid',
  '--- a/file.js',
  'diff --git "a/bad.js b/bad.js',
  'diff --git x/file.js b/file.js',
  String.raw`diff --git "x/caf\303\251.js" "b/caf\303\251.js"`
];

/**
 * Verbatim `git -c core.quotePath=false diff` of a commit that renames two
 * files (one into a non-ASCII path, one into a path sharing nothing with the
 * old one) and edits files whose names are non-ASCII, contain `"`, contain
 * ` b/`, or look like a rename. Plus a binary file and a deleted SQL comment
 * line (`-- note` prints as `--- note`), counted the way --numstat counts them.
 */
const QUOTEPATH_FALSE_DIFF = [
  'diff --git a/a => b.md b/a => b.md',
  'index df967b9..2ecd216 100644',
  '--- a/a => b.md\t',
  '+++ b/a => b.md\t',
  '@@ -1 +1,2 @@',
  ' base',
  '+changed',
  'diff --git a/café.js b/café.js',
  'index df967b9..2ecd216 100644',
  '--- a/café.js',
  '+++ b/café.js',
  '@@ -1 +1,2 @@',
  ' base',
  '+changed',
  String.raw`diff --git "a/quo\"te.js" "b/quo\"te.js"`,
  'index df967b9..2ecd216 100644',
  String.raw`--- "a/quo\"te.js"`,
  String.raw`+++ "b/quo\"te.js"`,
  '@@ -1 +1,2 @@',
  ' base',
  '+changed',
  'diff --git a/old/thing.js b/totally/different.txt',
  'similarity index 100%',
  'rename from old/thing.js',
  'rename to totally/different.txt',
  'diff --git a/x b/y.js b/x b/y.js',
  'index df967b9..2ecd216 100644',
  '--- a/x b/y.js\t',
  '+++ b/x b/y.js\t',
  '@@ -1 +1,2 @@',
  ' base',
  '+changed',
  'diff --git a/lib/moved.js b/ñew dir/moved é.js',
  'similarity index 55%',
  'rename from lib/moved.js',
  'rename to ñew dir/moved é.js',
  'index d498ffc..a484ea0 100644',
  '--- a/lib/moved.js',
  '+++ b/ñew dir/moved é.js\t',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  'diff --git a/logo.png b/logo.png',
  'index 1111111..2222222 100644',
  'Binary files a/logo.png and b/logo.png differ',
  'diff --git a/schema.sql b/schema.sql',
  'index 3333333..4444444 100644',
  '--- a/schema.sql',
  '+++ b/schema.sql',
  '@@ -1,3 +1,3 @@',
  ' create table t;',
  '--- note',
  '+++ note',
  ' drop table t;',
  ''
].join('\n');

/** changed_files that QUOTEPATH_FALSE_DIFF must produce (generated: false). */
const QUOTEPATH_FALSE_CHANGED_FILES = [
  { file: 'a => b.md', insertions: 1, deletions: 0, changes: 1, binary: false },
  { file: 'café.js', insertions: 1, deletions: 0, changes: 1, binary: false },
  { file: 'quo"te.js', insertions: 1, deletions: 0, changes: 1, binary: false },
  { file: 'totally/different.txt', insertions: 0, deletions: 0, changes: 0, binary: false, renamed: true, renamedFrom: 'old/thing.js' },
  { file: 'x b/y.js', insertions: 1, deletions: 0, changes: 1, binary: false },
  { file: 'ñew dir/moved é.js', insertions: 1, deletions: 1, changes: 2, binary: false, renamed: true, renamedFrom: 'lib/moved.js' },
  { file: 'logo.png', insertions: 0, deletions: 0, changes: 0, binary: true },
  { file: 'schema.sql', insertions: 1, deletions: 1, changes: 2, binary: false }
];

/**
 * The same kind of diff as cached by an older version (git's default
 * core.quotePath=true): a quoted modification and a rename into a quoted
 * destination.
 */
const QUOTEPATH_TRUE_DIFF = [
  String.raw`diff --git "a/src/caf\303\251.js" "b/src/caf\303\251.js"`,
  'index 1111111..2222222 100644',
  String.raw`--- "a/src/caf\303\251.js"`,
  String.raw`+++ "b/src/caf\303\251.js"`,
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  String.raw`diff --git a/lib/moved.js "b/\303\261ew dir/moved \303\251.js"`,
  'similarity index 55%',
  'rename from lib/moved.js',
  String.raw`rename to "\303\261ew dir/moved \303\251.js"`,
  'index d498ffc..a484ea0 100644',
  '--- a/lib/moved.js',
  String.raw`+++ "b/\303\261ew dir/moved \303\251.js"` + '\t',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  ''
].join('\n');

/**
 * Verbatim `git -c core.quotePath=false diff -M` of renames out of paths that
 * contain ` b/`. The unquoted `diff --git` header is ambiguous for these
 * (`a/x b/y.js b/z.js` splits as `x` -> `y.js b/z.js` at the first ` b/`);
 * the `rename from` / `rename to` lines are not. One is a pure rename with no
 * hunks, the other edits the file too.
 */
const B_SLASH_RENAME_DIFF = [
  'diff --git a/p b/q.js b/r b/s.js',
  'similarity index 100%',
  'rename from p b/q.js',
  'rename to r b/s.js',
  'diff --git a/x b/y.js b/z.js',
  'similarity index 77%',
  'rename from x b/y.js',
  'rename to z.js',
  'index c5f8446..ae2a63a 100644',
  '--- a/x b/y.js\t',
  '+++ b/z.js',
  '@@ -2,3 +2,4 @@ base',
  ' more',
  ' lines',
  ' here',
  '+extra',
  ''
].join('\n');

/** changed_files that B_SLASH_RENAME_DIFF must produce (generated: false). */
const B_SLASH_RENAME_CHANGED_FILES = [
  { file: 'r b/s.js', insertions: 0, deletions: 0, changes: 0, binary: false, renamed: true, renamedFrom: 'p b/q.js' },
  { file: 'z.js', insertions: 1, deletions: 0, changes: 1, binary: false, renamed: true, renamedFrom: 'x b/y.js' }
];

/**
 * [per-file patch, decoded old path, decoded new path] for parsePatchPaths:
 * the explicit rename / copy lines win over the header split.
 */
const PATCH_PATH_CASES = [
  ['diff --git a/x b/y.js b/z.js\nsimilarity index 77%\nrename from x b/y.js\nrename to z.js\nindex c5f8446..ae2a63a 100644\n--- a/x b/y.js\t\n+++ b/z.js\n@@ -2,3 +2,4 @@\n+extra\n', 'x b/y.js', 'z.js'],
  ['diff --git a/p b/q.js b/r b/s.js\nsimilarity index 100%\nrename from p b/q.js\nrename to r b/s.js\n', 'p b/q.js', 'r b/s.js'],
  // Mode change plus rename: the longest extended header git prints
  ['diff --git a/m b/n.sh b/o.sh\nold mode 100644\nnew mode 100755\nsimilarity index 90%\nrename from m b/n.sh\nrename to o.sh\nindex 1111111..2222222\n--- a/m b/n.sh\t\n+++ b/o.sh\n@@ -1 +1 @@\n-a\n+b\n', 'm b/n.sh', 'o.sh'],
  ['diff --git a/c b/d.js b/e.js\nsimilarity index 90%\ncopy from c b/d.js\ncopy to e.js\n', 'c b/d.js', 'e.js'],
  // Cached with octal escapes: rename lines are quoted like the header
  [String.raw`diff --git a/lib/moved.js "b/\303\261ew dir/moved \303\251.js"` + '\nsimilarity index 55%\nrename from lib/moved.js\n' + String.raw`rename to "\303\261ew dir/moved \303\251.js"` + '\n', 'lib/moved.js', 'ñew dir/moved é.js'],
  // A content line that looks like an extended header is not one
  ['diff --git a/a.js b/a.js\nindex 1111111..2222222 100644\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-rename to evil.js\n+rename to evil.js\n', 'a.js', 'a.js']
];

module.exports = {
  B_SLASH_RENAME_DIFF,
  B_SLASH_RENAME_CHANGED_FILES,
  PATCH_PATH_CASES,
  DECODE_CASES,
  DIFF_HEADER_CASES,
  MALFORMED_DIFF_HEADERS,
  QUOTEPATH_FALSE_DIFF,
  QUOTEPATH_FALSE_CHANGED_FILES,
  QUOTEPATH_TRUE_DIFF
};
