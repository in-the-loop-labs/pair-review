// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Diff corpora for the E2E suite.
 *
 * Every corpus is a `git diff`-shaped patch together with the full old and new
 * contents of each file in it. The patch is emitted from a known edit script
 * (tests/contract/fixtures/workload.js), so it applies to the old contents and
 * gives the new contents by construction. That matters because the frontend
 * fetches a file's contents after rendering its patch and upgrades the diff
 * with them: contents that do not belong to the patch re-layout the file a
 * second or so after load and make the vendor log a mismatch (ledger H37).
 *
 * Deterministic: no git, no disk, no clock, no Math.random.
 *
 * Paths are unique across corpora, so tests/e2e/test-server.js can answer
 * `GET /api/reviews/:id/file-contents/<path>` for any of them from one static
 * registry (`fileContentsFor`), whichever corpus a test routed.
 *
 * Corpora:
 *   defaultFixture()   the two-file diff the test database is seeded with
 *   evictionDiff()     a target file, then a 4,000-line file, then a tail file:
 *                      from either end the file at the other end is tens of
 *                      thousands of pixels away
 *   manyFilesDiff()    60 medium modified files
 *   edgeFilesDiff()    one file per unusual shape (rename, binary, CRLF, ...)
 *
 * `routeDiff(page, corpus)` serves a corpus on both modes' diff endpoints.
 */

const W = require('../../contract/fixtures/workload.js');
const { mergeChangedFilesWithDiff, parseUnifiedDiffPatches, buildChangedFileEntries } = require('../../../src/utils/diff-file-list');
const { parseHunks } = require('../../../src/utils/diff-hunks');
const { hashHunk } = require('../../../src/ai/hunk-hashing');

const joinLines = W.joinLines;

/**
 * @typedef {Object} CorpusFile
 * @property {string|null} old - full old contents, null for an added file
 * @property {string|null} new - full new contents, null for a deleted file
 * @property {string} [oldName] - previous path of a renamed file
 * @property {boolean} [binary]
 * @property {number} hunks
 * @property {number} additions
 * @property {number} deletions
 *
 * @typedef {Object} Corpus
 * @property {string} name
 * @property {string} diff - the whole patch
 * @property {string[]} order - paths in patch order (git's path order)
 * @property {Object<string, CorpusFile>} files
 * @property {Object<string, string>} roles - names for the files tests use
 * @property {string[]} generated - paths the server would mark generated
 * @property {Object<string, string>} plain - contents of files NOT in the
 *   diff (context files), by path
 */

function finish(name, builder, extra = {}) {
  const sections = builder.sections.slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    name,
    diff: sections.map((s) => s.text).join(''),
    order: sections.map((s) => s.path),
    files: builder.files,
    roles: extra.roles || {},
    generated: extra.generated || [],
    plain: extra.plain || {},
  };
}

// ---------------------------------------------------------------------------
// The default fixture: what the test database is seeded with.
// ---------------------------------------------------------------------------

/**
 * The shared two-file fixture (`src/main.js`, `src/utils.js`).
 *
 * - utils.js: a first hunk at lines 1-4 (old) / 1-7 (new) with a net change
 *   of +3, and a second hunk at old line 50 / new line 53. The 45 old lines
 *   between them are hidden context; the second hunk header carries the
 *   function context "function exportSection()".
 * - main.js: one hunk at line 10 adding five lines.
 *
 * The hunk headers declare exactly the lines the hunks contain. Until phase 2
 * of the CodeView migration they did not (ledger H36): the headers declared
 * 5/8 and 6/10 lines for bodies of 4/7 and 4/9, and blank lines stood in for
 * context lines without their leading space. The vendor parser dropped those
 * lines and rendered the rest, so the rows on screen are the same as before;
 * only the headers and the stray blank lines changed.
 */
function defaultFixture() {
  const diff = [
    'diff --git a/src/utils.js b/src/utils.js',
    '--- a/src/utils.js',
    '+++ b/src/utils.js',
    '@@ -1,4 +1,7 @@',
    ' // Utility functions',
    '+',
    ' function helper() {',
    '-  return null;',
    '+  // Improved implementation',
    '+  const result = computeValue();',
    '+  return result;',
    ' }',
    '@@ -50,4 +53,4 @@ function exportSection()',
    ' // Another section of code',
    ' function exportData() {',
    '-  return data;',
    '+  return JSON.stringify(data);',
    ' }',
    'diff --git a/src/main.js b/src/main.js',
    '--- a/src/main.js',
    '+++ b/src/main.js',
    '@@ -10,4 +10,9 @@',
    ' const config = loadConfig();',
    '+// New feature: logging',
    '+function log(message) {',
    "+  console.log('[App]', message);",
    '+}',
    '+',
    ' function initialize() {',
    "   console.log('Starting app');",
    ' }',
  ].join('\n');

  // utils.js: old lines 1-4 are hunk 1, line 5 is blank, 6-49 the gap (line
  // 49 is the function-context line), 50-53 hunk 2, 54-60 a tail.
  const utilsGap = [];
  for (let i = 6; i <= 49; i++) utilsGap.push(i === 49 ? 'function exportSection()' : `// gap line ${i}`);
  const utilsTail = [];
  for (let i = 54; i <= 60; i++) utilsTail.push(`// trailer line ${i}`);
  const utilsOld = [
    '// Utility functions', 'function helper() {', '  return null;', '}', '',
    ...utilsGap,
    '// Another section of code', 'function exportData() {', '  return data;', '}',
    ...utilsTail,
  ];
  const utilsNew = [
    '// Utility functions', '', 'function helper() {', '  // Improved implementation',
    '  const result = computeValue();', '  return result;', '}', '',
    ...utilsGap,
    '// Another section of code', 'function exportData() {', '  return JSON.stringify(data);', '}',
    ...utilsTail,
  ];

  // main.js: 9 lines above the hunk, the hunk at 10-13 (old), 27 lines below.
  const mainHead = [];
  for (let i = 1; i <= 9; i++) mainHead.push(`// main.js preamble line ${i}`);
  const mainTail = [];
  for (let i = 14; i <= 40; i++) mainTail.push(`// main.js body line ${i}`);
  const mainOld = [
    ...mainHead,
    'const config = loadConfig();', 'function initialize() {', "  console.log('Starting app');", '}',
    ...mainTail,
  ];
  const mainNew = [
    ...mainHead,
    'const config = loadConfig();',
    '// New feature: logging', 'function log(message) {', "  console.log('[App]', message);", '}', '',
    'function initialize() {', "  console.log('Starting app');", '}',
    ...mainTail,
  ];

  return {
    name: 'default',
    diff,
    order: ['src/utils.js', 'src/main.js'],
    files: {
      'src/utils.js': { old: joinLines(utilsOld), new: joinLines(utilsNew), hunks: 2, additions: 5, deletions: 2 },
      'src/main.js': { old: joinLines(mainOld), new: joinLines(mainNew), hunks: 1, additions: 5, deletions: 0 },
    },
    roles: { first: 'src/main.js', second: 'src/utils.js', twoHunks: 'src/utils.js' },
    generated: [],
    plain: {},
  };
}

// ---------------------------------------------------------------------------
// Eviction: a file far enough from another that a virtualized viewer unmounts
// one while the other is on screen.
// ---------------------------------------------------------------------------

/**
 * Three files in path order:
 *   corpus-evict/a-target.js  modified, 300 lines, three hunks with hidden gaps
 *   corpus-evict/m-big.js     added, 4,000 lines (about 70,000 px of rows)
 *   corpus-evict/z-tail.js    modified, 120 lines, one hunk
 *
 * The big file is 4,000 lines and not the 20,100 of the previous attempt's
 * helper: the application defers a patch over 20,000 lines behind a "Load
 * diff" placeholder (PRManager.PIERRE_AUTO_RENDER_MAX_PATCH_LINES), and a
 * placeholder pushes nothing out of reach. 4,000 lines also sits above the
 * per-file highlight cap (3,000 lines), so the file exercises the plain-text
 * path.
 */
function evictionDiff() {
  const rng = W.createRng(20260001);
  const b = W.createPatchBuilder(rng);
  const targetOld = W.makeLines(rng, 'js', 300);
  b.modified('corpus-evict/a-target.js', 'js', targetOld, 3, {
    edits: [
      { at: 20, del: 1, ins: ['  const evictTargetFirst = 1; /* changed */'] },
      { at: 150, del: 2, ins: ['  const evictTargetSecond = 2; /* changed */', '  const evictTargetThird = 3; /* added */'] },
      { at: 270, del: 0, ins: ['  const evictTargetLast = 4; /* added */'] },
    ],
  });
  b.added('corpus-evict/m-big.js', W.makeLines(rng, 'js', 4000));
  const tailOld = W.makeLines(rng, 'js', 120);
  b.modified('corpus-evict/z-tail.js', 'js', tailOld, 1, {
    edits: [{ at: 60, del: 1, ins: ['  const evictTail = true; /* changed */'] }],
  });
  return finish('eviction', b, {
    roles: {
      target: 'corpus-evict/a-target.js',
      big: 'corpus-evict/m-big.js',
      tail: 'corpus-evict/z-tail.js',
    },
    plain: {
      'corpus-evict/context-long.js': joinLines(W.makeLines(rng, 'js', 240)),
    },
  });
}

// ---------------------------------------------------------------------------
// Many files.
// ---------------------------------------------------------------------------

/** 60 modified files, 60 to 320 lines, 1 to 4 hunks each. */
function manyFilesDiff() {
  const rng = W.createRng(20260002);
  const b = W.createPatchBuilder(rng);
  const exts = ['js', 'ts', 'py', 'css', 'md', 'json'];
  const sizes = [60, 90, 140, 200, 260, 320];
  const paths = [];
  for (let i = 0; i < 60; i++) {
    const ext = exts[i % exts.length];
    const nn = String(i).padStart(2, '0');
    const path = `corpus-many/d${nn}/file${nn}.${ext}`;
    paths.push(path);
    b.modified(path, ext, W.makeLines(rng, ext, sizes[(i * 5) % sizes.length]), 1 + (i % 4));
  }
  return finish('many', b, {
    roles: { first: paths[0], middle: paths[30], last: paths[59] },
  });
}

// ---------------------------------------------------------------------------
// Edge shapes.
// ---------------------------------------------------------------------------

/**
 * One file per unusual shape. Roles name them; paths sort in the order shown.
 *
 *   added           corpus-edge/added.js            new file, 40 lines
 *   binary          corpus-edge/binary.bin          "Binary files differ"
 *   crlf            corpus-edge/crlf.txt            CRLF line endings, one change
 *   deleted         corpus-edge/deleted.js          deleted file, 30 lines
 *   emptyAdded      corpus-edge/empty-added.txt     new empty file (no hunk)
 *   generated       corpus-edge/generated.lock      modified; marked generated
 *   longLine        corpus-edge/long-line.js        one 2,400-character line changed
 *   modeOnly        corpus-edge/mode-only.sh        old mode / new mode only
 *   noNewline       corpus-edge/no-newline.js       new side has no newline at EOF
 *   quoted          corpus-edge/quo"te d.js         git C-quotes the header path
 *   renameChanged   corpus-edge/renamed-changed.js  rename with a change
 *   renamePure      corpus-edge/renamed-pure.py     100% similarity rename
 *   unicode         corpus-edge/unicode-ünï.js      non-ASCII path and content
 */
function edgeFilesDiff() {
  const rng = W.createRng(20260003);
  const b = W.createPatchBuilder(rng);
  const raw = (path, lines, info) => {
    b.sections.push({ path, text: `${lines.join('\n')}\n` });
    b.files[path] = info;
  };

  b.added('corpus-edge/added.js', W.makeLines(rng, 'js', 40));

  raw('corpus-edge/binary.bin', [
    'diff --git a/corpus-edge/binary.bin b/corpus-edge/binary.bin',
    'index 3b18e51..9f2c0aa 100644',
    'Binary files a/corpus-edge/binary.bin and b/corpus-edge/binary.bin differ',
  ], { old: null, new: null, binary: true, hunks: 0, additions: 0, deletions: 0 });

  // CRLF: every line of both sides ends in \r\n; the patch carries the \r.
  {
    const oldLines = W.makeLines(rng, 'md', 30).map((l) => `${l}\r`);
    b.modified('corpus-edge/crlf.txt', 'md', oldLines, 1, {
      edits: [{ at: 14, del: 1, ins: ['crlf changed line\r'] }],
    });
  }

  b.deleted('corpus-edge/deleted.js', W.makeLines(rng, 'js', 30));
  b.added('corpus-edge/empty-added.txt', []);

  b.modified('corpus-edge/generated.lock', 'json', W.makeLines(rng, 'json', 80), 2);

  {
    const oldLines = W.makeLines(rng, 'js', 40);
    const long = (tag) => `const ${tag} = '${'lorem ipsum dolor sit amet '.repeat(88)}';`;
    oldLines[19] = long('before');
    b.modified('corpus-edge/long-line.js', 'js', oldLines, 1, {
      edits: [{ at: 19, del: 1, ins: [long('after')] }],
    });
  }

  raw('corpus-edge/mode-only.sh', [
    'diff --git a/corpus-edge/mode-only.sh b/corpus-edge/mode-only.sh',
    'old mode 100644',
    'new mode 100755',
  ], { old: '#!/bin/sh\necho run\n', new: '#!/bin/sh\necho run\n', hunks: 0, additions: 0, deletions: 0 });

  {
    const oldLines = W.makeLines(rng, 'js', 20);
    const last = oldLines.length - 1;
    b.modified('corpus-edge/no-newline.js', 'js', oldLines, 1, {
      edits: [
        { at: 6, del: 2, ins: ['  const firstChange = true; /* changed */'] },
        { at: last, del: 1, ins: [`${oldLines[last]} // no newline follows`] },
      ],
      newNoEofNewline: true,
    });
  }

  // A path git C-quotes even with core.quotePath=false (it contains `"`).
  {
    const path = 'corpus-edge/quo"te d.js';
    const quoted = (prefix) => `"${prefix}/corpus-edge/quo\\"te d.js"`;
    const oldLines = W.makeLines(rng, 'js', 24);
    const edits = [{ at: 10, del: 1, ins: ['  const quotedPathChange = true; /* changed */'] }];
    const newLines = W.applyEdits(oldLines, edits);
    const hunks = W.hunksFromEdits(oldLines, edits);
    raw(path, [
      `diff --git ${quoted('a')} ${quoted('b')}`,
      'index 1111111..2222222 100644',
      `--- ${quoted('a')}`,
      `+++ ${quoted('b')}`,
      hunks.text,
    ], { old: joinLines(oldLines), new: joinLines(newLines), hunks: hunks.hunkCount, additions: hunks.additions, deletions: hunks.deletions });
  }

  b.modified('corpus-edge/renamed-changed.js', 'js', W.makeLines(rng, 'js', 90), 1, {
    oldName: 'corpus-edge/old/renamed-changed.js',
    similarity: 97,
    edits: [{ at: 40, del: 2, ins: ['  const renamedAndChanged = true;'] }],
  });

  {
    const lines = W.makeLines(rng, 'py', 50);
    raw('corpus-edge/renamed-pure.py', [
      'diff --git a/corpus-edge/old/renamed-pure.py b/corpus-edge/renamed-pure.py',
      'similarity index 100%',
      'rename from corpus-edge/old/renamed-pure.py',
      'rename to corpus-edge/renamed-pure.py',
    ], { old: joinLines(lines), new: joinLines(lines), oldName: 'corpus-edge/old/renamed-pure.py', hunks: 0, additions: 0, deletions: 0 });
  }

  {
    const oldLines = W.makeLines(rng, 'js', 30);
    oldLines[9] = "const greeting = 'héllo wörld — 日本語 ✓';";
    b.modified('corpus-edge/unicode-ünï.js', 'js', oldLines, 1, {
      edits: [{ at: 9, del: 1, ins: ["const greeting = 'grüße, мир — 日本語 ✓✓';"] }],
    });
  }

  return finish('edge', b, {
    roles: {
      added: 'corpus-edge/added.js',
      binary: 'corpus-edge/binary.bin',
      crlf: 'corpus-edge/crlf.txt',
      deleted: 'corpus-edge/deleted.js',
      emptyAdded: 'corpus-edge/empty-added.txt',
      generated: 'corpus-edge/generated.lock',
      longLine: 'corpus-edge/long-line.js',
      modeOnly: 'corpus-edge/mode-only.sh',
      noNewline: 'corpus-edge/no-newline.js',
      quoted: 'corpus-edge/quo"te d.js',
      renameChanged: 'corpus-edge/renamed-changed.js',
      renamePure: 'corpus-edge/renamed-pure.py',
      unicode: 'corpus-edge/unicode-ünï.js',
    },
    generated: ['corpus-edge/generated.lock'],
  });
}

// ---------------------------------------------------------------------------
// Registry and routing
// ---------------------------------------------------------------------------

let cache = null;
/** Every corpus, built once per process. */
function allCorpora() {
  if (!cache) {
    cache = {
      default: defaultFixture(),
      eviction: evictionDiff(),
      many: manyFilesDiff(),
      edge: edgeFilesDiff(),
    };
  }
  return cache;
}

let registry = null;
function contentsRegistry() {
  if (!registry) {
    registry = new Map();
    for (const corpus of Object.values(allCorpora())) {
      for (const [path, file] of Object.entries(corpus.files)) {
        if (registry.has(path)) throw new Error(`corpus path registered twice: ${path}`);
        registry.set(path, file);
      }
      for (const [path, contents] of Object.entries(corpus.plain)) {
        if (registry.has(path)) throw new Error(`corpus path registered twice: ${path}`);
        registry.set(path, { old: contents, new: contents, plain: true, hunks: 0, additions: 0, deletions: 0 });
      }
    }
  }
  return registry;
}

/**
 * The truthful contents of a corpus path, or null when the path belongs to no
 * corpus. The shape mirrors the real route's answer
 * (`GET /api/reviews/:id/file-contents/*` in src/routes/reviews.js).
 * @param {string} path
 * @returns {{fileName: string, oldContents: string|null, newContents: string|null, oldPath?: string, binary?: boolean}|null}
 */
function fileContentsFor(path) {
  const file = contentsRegistry().get(path);
  if (!file) return null;
  if (file.binary) return { fileName: path, binary: true };
  const out = { fileName: path, oldContents: file.old, newContents: file.new };
  if (file.oldName) out.oldPath = file.oldName;
  return out;
}

/**
 * The lines of a corpus path's current (new-side) contents, or null. For the
 * context-file content endpoint (`GET /api/reviews/:id/file-content/*`).
 * @param {string} path
 * @returns {string[]|null}
 */
function fileLinesFor(path) {
  const file = contentsRegistry().get(path);
  if (!file || file.binary || file.new == null) return null;
  const lines = file.new.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Hunk hashes per file, computed the way both diff routes compute them
 * (`computeHunkHashesFromDiff` in src/routes/pr.js, the loop in
 * src/routes/local.js): the same two helpers over the same per-file patches.
 * @returns {Map<string, string[]>}
 */
function hunkHashes(diff) {
  const result = new Map();
  for (const [filePath, filePatch] of parseUnifiedDiffPatches(diff).entries()) {
    result.set(filePath, parseHunks(filePatch).map((h) => hashHunk(filePath, `${h.header}\n${h.lines.join('\n')}`)));
  }
  return result;
}

/**
 * The PR-mode diff response for a corpus, built with the server's own helpers
 * so `changed_files` has the production shape (stats, rename and binary
 * flags, hunk hashes).
 */
function prDiffResponse(corpus) {
  const generated = new Set(corpus.generated);
  const hashes = hunkHashes(corpus.diff);
  const changedFiles = mergeChangedFilesWithDiff(
    buildChangedFileEntries(corpus.diff, { isGenerated: (p) => generated.has(p) }),
    corpus.diff
  ).map((file) => {
    const out = { ...file, generated: generated.has(file.file) };
    if (hashes.has(file.file)) out.hunk_hashes = hashes.get(file.file);
    return out;
  });
  return {
    diff: corpus.diff,
    changed_files: changedFiles,
    stats: {
      additions: changedFiles.reduce((sum, f) => sum + (f.insertions || 0), 0),
      deletions: changedFiles.reduce((sum, f) => sum + (f.deletions || 0), 0),
      changed_files: changedFiles.length,
    },
  };
}

/** The Local-mode diff response for a corpus (src/routes/local.js). */
function localDiffResponse(corpus) {
  const hunkHashesByFile = {};
  for (const [filePath, fileHashes] of hunkHashes(corpus.diff)) {
    if (fileHashes.length > 0) hunkHashesByFile[filePath] = fileHashes;
  }
  return {
    diff: corpus.diff,
    generated_files: corpus.generated.slice(),
    hunk_hashes_by_file: hunkHashesByFile,
    stats: { trackedChanges: corpus.order.length, untrackedFiles: 0, stagedChanges: 0, unstagedChanges: 0 },
  };
}

/**
 * Where a corpus file's changes are, read from its patch: the new-side line
 * numbers of its added lines, the old-side numbers of its deleted lines, and
 * its hunk ranges. Lets a scenario put a comment or a suggestion on a line
 * that is certainly on screen, or certainly hidden between two hunks.
 * @param {Corpus} corpus
 * @param {string} path
 * @returns {{additions: number[], deletions: number[], hunks: Array<{oldStart: number, oldCount: number, newStart: number, newCount: number}>}}
 */
function changedLines(corpus, path) {
  const patch = parseUnifiedDiffPatches(corpus.diff).get(path);
  if (!patch) throw new Error(`changedLines: ${path} is not in corpus "${corpus.name}"`);
  const out = { additions: [], deletions: [], hunks: [] };
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      const hunk = {
        oldStart: Number(header[1]), oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]), newCount: header[4] === undefined ? 1 : Number(header[4]),
      };
      out.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) out.additions.push(newLine++);
    else if (line.startsWith('-')) out.deletions.push(oldLine++);
    else if (line.startsWith(' ')) { oldLine++; newLine++; }
  }
  return out;
}

/**
 * Check a rendered file (`dumpFile` of tests/e2e/diff-dom.js) against the
 * contents its patch was generated from: every row must show the line its
 * number names. A deletion row, or any row of the old-side column, is that
 * line of the old contents; every other row that line of the new contents.
 * @param {Object} dump - `{columns: [{name, rows: [{type, line, text}]}]}`
 * @param {CorpusFile} corpusFile
 * @returns {{checked: number, mismatches: Array<Object>}} mismatches is empty when the render is truthful
 */
function checkRows(dump, corpusFile) {
  const linesOf = (text) => (text == null || text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const bare = (text) => text.replace(/[\r\n]+$/, '');
  const oldLines = linesOf(corpusFile.old);
  const newLines = linesOf(corpusFile.new);
  const mismatches = [];
  let checked = 0;
  for (const column of dump.columns) {
    for (const row of column.rows) {
      const source = column.name === 'deletions' || row.type === 'change-deletion' ? oldLines : newLines;
      const expected = source[Number(row.line) - 1];
      checked++;
      if (expected === undefined || bare(row.text) !== bare(expected)) {
        mismatches.push({ column: column.name, type: row.type, line: row.line, shown: row.text, expected });
      }
    }
  }
  return { checked, mismatches };
}

/**
 * A corpus for a diff a spec writes by hand (verbatim `git diff` output that
 * a builder cannot produce). The spec supplies the contents that belong to
 * it; `routeDiff` then serves those too, because the paths are not in the
 * static registry.
 *
 * @param {Object} options
 * @param {string} options.name
 * @param {string} options.diff
 * @param {Object<string, {old?: string|null, new?: string|null, oldName?: string, binary?: boolean}>} options.files
 * @param {string[]} [options.generated]
 * @returns {Corpus}
 */
function customCorpus({ name, diff, files, generated = [] }) {
  const order = [...parseUnifiedDiffPatches(diff).keys()];
  for (const path of order) {
    if (!files[path]) throw new Error(`customCorpus "${name}": no contents given for ${path}`);
  }
  return { name, diff, order, files, roles: {}, generated, plain: {}, custom: true };
}

/**
 * Serve a corpus as the diff of whatever review the page opens, in both
 * modes, with or without `?w=1`. File contents of a built corpus need no
 * routing: the test server answers them from the registry. A `customCorpus`
 * has its contents routed here.
 *
 * Local mode also asks whether its diff is stale and refreshes it when it is;
 * the fixture review points at a directory that does not exist, so that is
 * answered here as "not stale".
 *
 * @param {import('@playwright/test').Page} page
 * @param {Corpus} corpus
 */
async function routeDiff(page, corpus) {
  const pr = prDiffResponse(corpus);
  const local = localDiffResponse(corpus);
  await page.route(/\/api\/pr\/[^/]+\/[^/]+\/\d+\/diff(\?.*)?$/, (route) => route.fulfill({ json: pr }));
  await page.route(/\/api\/local\/\d+\/diff(\?.*)?$/, (route) => route.fulfill({ json: local }));
  await page.route(/\/api\/local\/\d+\/check-stale(\?.*)?$/, (route) => route.fulfill({ json: { isStale: false } }));
  if (corpus.custom) {
    await page.route(/\/api\/reviews\/\d+\/file-contents\/[^?]+/, (route) => {
      const match = new URL(route.request().url()).pathname.match(/\/file-contents\/(.+)$/);
      const path = match ? decodeURIComponent(match[1]) : null;
      const file = path && corpus.files[path];
      if (!file) return route.fallback();
      if (file.binary) return route.fulfill({ json: { fileName: path, binary: true } });
      const body = { fileName: path, oldContents: file.old ?? null, newContents: file.new ?? null };
      if (file.oldName) body.oldPath = file.oldName;
      return route.fulfill({ json: body });
    });
  }
}

/**
 * Eight added files of 600 lines, a wrapping line in every ten. Each is drawn
 * whole when the reader gets to it; until then the pane has an estimate of
 * its height, which does not know about the wrapping (ledger H163): the pane
 * grows by about 2,000 px for each file the reader arrives at.
 * @param {string} name - the corpus name (one per spec file)
 * @returns {{corpus: Object, last: string}}
 */
function wrappingFilesCorpus(name) {
  const long = ` // ${'these words make the line long enough to wrap in the pane '.repeat(6)}`;
  const files = {};
  let diff = '';
  for (let f = 1; f <= 8; f++) {
    const path = `wrap/file${f}.js`;
    const lines = Array.from({ length: 600 }, (_, i) => `export const w${f}_${i + 1} = ${i + 1};${(i + 1) % 10 === 0 ? long : ''}`);
    diff += `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..${f}${f}${f}${f}${f}${f}${f}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
    files[path] = { old: null, new: `${lines.join('\n')}\n` };
  }
  return { corpus: customCorpus({ name, diff, files }), last: 'wrap/file8.js' };
}

/**
 * A modified file of `oldLines` with the lines in `changes` (line number ->
 * new text; the file keeps its length) replaced, as git writes it: three
 * lines of context, changes seven lines or fewer apart in one hunk, the
 * deletions of a run before its additions. Truthful contents included.
 * @param {string} path
 * @param {string[]} oldLines
 * @param {Object<number, string>} changes
 * @returns {{text: string, file: {old: string, new: string}}}
 */
function modifiedSection(path, oldLines, changes) {
  const newLines = oldLines.map((line, i) => (changes[i + 1] !== undefined ? changes[i + 1] : line));
  const groups = [];
  for (const line of Object.keys(changes).map(Number).sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last && line - last.end <= 7) last.end = line;
    else groups.push({ start: line, end: line });
  }
  let text = `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n`;
  for (const { start, end } of groups) {
    const from = Math.max(1, start - 3);
    const to = Math.min(oldLines.length, end + 3);
    const body = [];
    for (let n = from; n <= to;) {
      if (changes[n] === undefined) { body.push(` ${oldLines[n - 1]}`); n++; continue; }
      const run = [];
      while (n <= to && changes[n] !== undefined) run.push(n++);
      body.push(...run.map((m) => `-${oldLines[m - 1]}`), ...run.map((m) => `+${newLines[m - 1]}`));
    }
    const count = to - from + 1;
    text += `@@ -${from},${count} +${from},${count} @@\n${body.join('\n')}\n`;
  }
  return { text, file: { old: `${oldLines.join('\n')}\n`, new: `${newLines.join('\n')}\n` } };
}

/**
 * The corpus of the diff-pane fixes made after the owner's review of PR
 * #646 (ledger, section 11, "Review fixes"), served with `routeDiff`. Not
 * registered with the test server: no other spec sees it.
 *
 *   gen/data.lock   modified; marked generated, so it starts collapsed.
 *                   Lines 30 and 31 changed (one hunk, 27-34).
 *   src/alpha.js    modified, 120 lines. Lines 11-13 changed (hunk 8-16)
 *                   and line 81 (hunk 78-84); 17-77 and 85-120 hidden.
 *   src/beta.js     modified, 60 lines. Line 30 changed (hunk 27-33).
 *   src/zeta.js     added, 1,500 lines: while the reader is at its end the
 *                   viewer has not mounted the three files above it.
 */
function reviewFixesCorpus() {
  const numbered = (count, make) => Array.from({ length: count }, (_, i) => make(i + 1));
  const sections = [
    modifiedSection('gen/data.lock', numbered(60, (n) => `"package-${n}": "1.0.${n}",`),
      { 30: '"package-30": "2.0.30",', 31: '"package-31": "2.0.31",' }),
    modifiedSection('src/alpha.js', numbered(120, (n) => `const alpha${n} = ${n};`), {
      11: 'const alpha11 = 11 * 2;', 12: 'const alpha12 = 12 * 2;', 13: 'const alpha13 = 13 * 2;', 81: 'const alpha81 = 81 * 2;'
    }),
    modifiedSection('src/beta.js', numbered(60, (n) => `export const beta${n} = '${n}';`), { 30: "export const beta30 = 'thirty';" }),
  ];
  const paths = ['gen/data.lock', 'src/alpha.js', 'src/beta.js'];
  const zeta = numbered(1500, (n) => `export const zeta${n} = ${n};`);
  const zetaText = 'diff --git a/src/zeta.js b/src/zeta.js\nnew file mode 100644\nindex 0000000..4444444\n'
    + `--- /dev/null\n+++ b/src/zeta.js\n@@ -0,0 +1,${zeta.length} @@\n${zeta.map((l) => `+${l}`).join('\n')}\n`;
  return customCorpus({
    name: 'review-fixes',
    diff: sections.map((s) => s.text).join('') + zetaText,
    files: {
      ...Object.fromEntries(paths.map((path, i) => [path, sections[i].file])),
      'src/zeta.js': { old: null, new: `${zeta.join('\n')}\n` },
    },
    generated: ['gen/data.lock'],
  });
}

/**
 * Two changed files whose paths end alike (`packages/x/src/index.js` and
 * `src/index.js`) with an added file of 1,500 lines between them in path
 * order: while the first is on screen the viewer has not mounted the last.
 * Served with `routeDiff`; not registered with the test server.
 */
function sharedSuffixCorpus() {
  const numbered = (count, make) => Array.from({ length: count }, (_, i) => make(i + 1));
  const nested = modifiedSection('packages/x/src/index.js', numbered(40, (n) => `export const nested${n} = ${n};`),
    { 10: 'export const nested10 = 100;' });
  const top = modifiedSection('src/index.js', numbered(40, (n) => `export const top${n} = ${n};`),
    { 20: 'export const top20 = 200;' });
  const longLines = numbered(1500, (n) => `export const long${n} = ${n};`);
  const longText = 'diff --git a/packages/y/long.js b/packages/y/long.js\nnew file mode 100644\nindex 0000000..3333333\n'
    + `--- /dev/null\n+++ b/packages/y/long.js\n@@ -0,0 +1,${longLines.length} @@\n${longLines.map((l) => `+${l}`).join('\n')}\n`;
  return customCorpus({
    name: 'shared-suffix',
    diff: nested.text + longText + top.text,
    files: {
      'packages/x/src/index.js': nested.file,
      'packages/y/long.js': { old: null, new: `${longLines.join('\n')}\n` },
      'src/index.js': top.file,
    },
  });
}

module.exports = {
  defaultFixture,
  reviewFixesCorpus,
  sharedSuffixCorpus,
  evictionDiff,
  manyFilesDiff,
  edgeFilesDiff,
  allCorpora,
  fileContentsFor,
  fileLinesFor,
  hunkHashes,
  prDiffResponse,
  localDiffResponse,
  changedLines,
  checkRows,
  customCorpus,
  wrappingFilesCorpus,
  routeDiff,
};
