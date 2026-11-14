// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic workload for the vendor contract suite.
 *
 * Builds, in pure JavaScript, a unified diff shaped like `git diff -M` output
 * together with the full old and new contents of every file in it. No git, no
 * disk, no clock, no Math.random: the same seed always yields the same bytes,
 * in Node and in the browser. The harness page loads this file with a
 * <script> tag and calls `ContractWorkload.build()`.
 *
 * What it contains (59 files in the patch, in path order like git):
 *
 *  - 50 modified files, 20 to 3,000 lines, 1 to 7 hunks, in js/ts/py/css/md/
 *    json flavours. About 6% of js/ts lines are long enough to wrap.
 *  - a 20,000-line added file and a 20,000-line modified file with 30 hunks
 *  - a small added file, a deleted file, a pure rename, a rename with changes,
 *    a binary change, a mode-only change, a file whose new side has no
 *    newline at end of file, an empty added file
 *  - two plain files (not in the patch) for `type: 'file'` items
 *
 * The diff is emitted from a known edit script rather than computed, so the
 * hunks are consistent with the contents by construction: applying the patch
 * to `files[path].old` gives `files[path].new` exactly. That is the property
 * `hydratePartialDiff` and context expansion depend on.
 *
 * `roles` names the files tests use, so a spec never hard-codes a path.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.ContractWorkload = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONTEXT = 3;
  const WORDS = [
    'alpha', 'beta', 'gamma', 'delta', 'review', 'comment', 'render', 'virtual', 'anchor', 'scroll',
    'height', 'worker', 'token', 'cache', 'result', 'value', 'index', 'buffer', 'state', 'option',
  ];

  /** Linear congruential generator (Numerical Recipes constants). */
  function createRng(seed) {
    let state = seed >>> 0;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
    const word = () => WORDS[int(0, WORDS.length - 1)];
    return { next, int, word };
  }

  /** One line of plausible source text for a file extension. */
  function makeLine(rng, ext, i) {
    const r = rng.next();
    const w = rng.word;
    if (ext === 'md') {
      if (r < 0.15) return '';
      if (r < 0.25) return `## ${w()} ${w()} ${i}`;
      return `${w()} ${w()} ${w()} ${w()} ${w()} ${w()} ${w()} (${i}).`;
    }
    if (ext === 'json') {
      return `  "${w()}_${i}": ${r < 0.5 ? rng.int(0, 9999) : `"${w()} ${w()}"`},`;
    }
    if (ext === 'css') {
      if (r < 0.3) return `.${w()}-${i} {`;
      if (r < 0.6) return `  ${w()}: ${rng.int(0, 99)}px;`;
      if (r < 0.75) return '}';
      return `  color: var(--${w()}-${w()});`;
    }
    if (ext === 'py') {
      if (r < 0.1) return '';
      if (r < 0.25) return `def ${w()}_${i}(${w()}, ${w()}=None):`;
      if (r < 0.9) return `    ${w()} = ${w()}(${w()}, "${w()}", ${rng.int(0, 99)})  # ${w()}`;
      return `    return ${w()}.${w()}[${rng.int(0, 9)}]`;
    }
    // js / ts
    if (r < 0.08) return '';
    if (r < 0.2) return `function ${w()}${i}(${w()}, ${w()}) {`;
    if (r < 0.3) return '}';
    if (r < 0.36) {
      const parts = [];
      for (let k = 0; k < 26; k++) parts.push(w());
      return `  // ${parts.join(' ')} long line ${i}`;
    }
    if (r < 0.7) return `  const ${w()}${i} = ${w()}.${w()}(${w()}, '${w()}', ${rng.int(0, 999)});`;
    return `  if (${w()} !== ${w()}) { return ${w()}(${w()} + ${rng.int(1, 50)}); }`;
  }

  function makeLines(rng, ext, count) {
    const out = [];
    for (let i = 1; i <= count; i++) out.push(makeLine(rng, ext, i));
    return out;
  }

  /**
   * A deterministic edit script: `hunks` edits spread evenly through the file.
   * Edits are sorted by position and never overlap.
   * @returns {Array<{at: number, del: number, ins: string[]}>} `at` is a
   *   0-based index into the old lines.
   */
  function makeEdits(rng, oldLines, ext, hunks) {
    const n = oldLines.length;
    const edits = [];
    for (let h = 0; h < hunks; h++) {
      const at = Math.floor(((h + 0.5) / hunks) * n);
      const kind = rng.next();
      const len = rng.int(1, 8);
      const edit = { at, del: 0, ins: [] };
      if (kind < 0.35) {
        edit.del = len;
        const count = rng.int(1, 8);
        for (let i = 0; i < count; i++) edit.ins.push(`${makeLine(rng, ext, 90000 + i)} /* changed */`);
      } else if (kind < 0.7) {
        const count = rng.int(1, 12);
        for (let i = 0; i < count; i++) edit.ins.push(`${makeLine(rng, ext, 80000 + i)} /* added */`);
      } else {
        edit.del = len;
      }
      edits.push(edit);
    }
    // Clamp deletions so an edit never runs into the next one or past the end.
    for (let i = 0; i < edits.length; i++) {
      const limit = i + 1 < edits.length ? edits[i + 1].at : n;
      edits[i].del = Math.max(0, Math.min(edits[i].del, limit - edits[i].at));
    }
    return edits.filter((e) => e.del > 0 || e.ins.length > 0);
  }

  function applyEdits(oldLines, edits) {
    const out = [];
    let cursor = 0;
    for (const e of edits) {
      for (let i = cursor; i < e.at; i++) out.push(oldLines[i]);
      for (const line of e.ins) out.push(line);
      cursor = e.at + e.del;
    }
    for (let i = cursor; i < oldLines.length; i++) out.push(oldLines[i]);
    return out;
  }

  const range = (start, count) => (count === 1 ? `${start}` : `${start},${count}`);

  /**
   * Unified-diff hunks for an edit script, with CONTEXT lines of context and
   * git's merging rule (edits whose context would touch share a hunk).
   * @param {Object} [options]
   * @param {boolean} [options.newNoEofNewline] - the new file's last line has
   *   no trailing newline; the marker follows it when a hunk reaches it.
   * @returns {{text: string, hunkCount: number, additions: number, deletions: number}}
   */
  function hunksFromEdits(oldLines, edits, options = {}) {
    const groups = [];
    for (const e of edits) {
      const last = groups[groups.length - 1];
      const prev = last && last[last.length - 1];
      if (prev && e.at - (prev.at + prev.del) <= 2 * CONTEXT) last.push(e);
      else groups.push([e]);
    }
    const out = [];
    let shift = 0; // new index minus old index, before the current group
    let additions = 0;
    let deletions = 0;
    for (const group of groups) {
      const first = group[0];
      const last = group[group.length - 1];
      const ctxStart = Math.max(0, first.at - CONTEXT);
      const ctxEnd = Math.min(oldLines.length, last.at + last.del + CONTEXT);
      const body = [];
      let cursor = ctxStart;
      let oldCount = 0;
      let newCount = 0;
      let lastNewLineIndex = -1;
      for (const e of group) {
        for (let i = cursor; i < e.at; i++) {
          body.push(` ${oldLines[i]}`);
          oldCount++;
          newCount++;
          lastNewLineIndex = body.length - 1;
        }
        for (let i = e.at; i < e.at + e.del; i++) {
          body.push(`-${oldLines[i]}`);
          oldCount++;
          deletions++;
        }
        for (const line of e.ins) {
          body.push(`+${line}`);
          newCount++;
          additions++;
          lastNewLineIndex = body.length - 1;
        }
        cursor = e.at + e.del;
      }
      for (let i = cursor; i < ctxEnd; i++) {
        body.push(` ${oldLines[i]}`);
        oldCount++;
        newCount++;
        lastNewLineIndex = body.length - 1;
      }
      if (options.newNoEofNewline && ctxEnd === oldLines.length && lastNewLineIndex >= 0) {
        body.splice(lastNewLineIndex + 1, 0, '\\ No newline at end of file');
      }
      const oldStart = oldCount === 0 ? ctxStart : ctxStart + 1;
      const newStart = newCount === 0 ? ctxStart + shift : ctxStart + shift + 1;
      out.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`);
      out.push(...body);
      for (const e of group) shift += e.ins.length - e.del;
    }
    return { text: out.join('\n'), hunkCount: groups.length, additions, deletions };
  }

  /** Short stable hex digest, standing in for a git blob id. */
  function fakeBlobId(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0').slice(0, 7);
  }

  const joinLines = (lines) => (lines.length ? `${lines.join('\n')}\n` : '');

  /**
   * The section writers `build` uses, exposed so other deterministic corpora
   * (tests/e2e/fixtures/diffs.js) emit `git diff`-shaped sections the same way
   * and keep the same guarantee: the patch applied to `files[path].old` gives
   * `files[path].new`.
   * @param {{next: Function, int: Function, word: Function}} rng
   * @returns {{sections: Array<{path: string, text: string}>, files: Object,
   *   modified: Function, added: Function, deleted: Function}}
   */
  function createPatchBuilder(rng) {
    const sections = []; // { path, text }
    const files = {};

    const modified = (path, ext, oldLines, hunks, extra = {}) => {
      const edits = extra.edits || makeEdits(rng, oldLines, ext, hunks);
      const newLines = applyEdits(oldLines, edits);
      const oldText = joinLines(oldLines);
      let newText = joinLines(newLines);
      if (extra.newNoEofNewline) newText = newText.replace(/\n$/, '');
      const diff = hunksFromEdits(oldLines, edits, { newNoEofNewline: extra.newNoEofNewline });
      const oldPath = extra.oldName || path;
      const header = [`diff --git a/${oldPath} b/${path}`];
      if (extra.oldName) {
        header.push(`similarity index ${extra.similarity || 97}%`, `rename from ${oldPath}`, `rename to ${path}`);
      }
      header.push(`index ${fakeBlobId(oldText)}..${fakeBlobId(newText)} 100644`, `--- a/${oldPath}`, `+++ b/${path}`);
      sections.push({ path, text: `${header.join('\n')}\n${diff.text}\n` });
      files[path] = {
        old: oldText,
        new: newText,
        hunks: diff.hunkCount,
        additions: diff.additions,
        deletions: diff.deletions,
      };
      if (extra.oldName) files[path].oldName = extra.oldName;
    };

    const added = (path, lines) => {
      const text = joinLines(lines);
      const header = [`diff --git a/${path} b/${path}`, 'new file mode 100644'];
      if (lines.length === 0) {
        // git prints no ---/+++ lines and no hunk for an empty added file.
        header.push('index 0000000..e69de29');
        sections.push({ path, text: `${header.join('\n')}\n` });
      } else {
        header.push(`index 0000000..${fakeBlobId(text)}`, '--- /dev/null', `+++ b/${path}`);
        const body = lines.map((line) => `+${line}`).join('\n');
        sections.push({ path, text: `${header.join('\n')}\n@@ -0,0 +${range(1, lines.length)} @@\n${body}\n` });
      }
      files[path] = { old: null, new: text, hunks: lines.length ? 1 : 0, additions: lines.length, deletions: 0 };
    };

    const deleted = (path, lines) => {
      const text = joinLines(lines);
      const header = [
        `diff --git a/${path} b/${path}`,
        'deleted file mode 100644',
        `index ${fakeBlobId(text)}..0000000`,
        `--- a/${path}`,
        '+++ /dev/null',
      ];
      const body = lines.map((line) => `-${line}`).join('\n');
      sections.push({ path, text: `${header.join('\n')}\n@@ -${range(1, lines.length)} +0,0 @@\n${body}\n` });
      files[path] = { old: text, new: null, hunks: 1, additions: 0, deletions: lines.length };
    };

    return { sections, files, modified, added, deleted };
  }

  /**
   * @param {Object} [options]
   * @param {number} [options.seed]
   * @returns {{
   *   patch: string,
   *   order: string[],
   *   files: Object<string, {old: string|null, new: string|null, oldName?: string, hunks: number, additions: number, deletions: number}>,
   *   plain: Array<{name: string, contents: string}>,
   *   roles: Object<string, string>,
   * }}
   */
  function build(options = {}) {
    const rng = createRng(options.seed === undefined ? 1234567 : options.seed);
    const { sections, files, modified, added, deleted } = createPatchBuilder(rng);


    // ---- 50 modified files ----
    const exts = ['js', 'ts', 'py', 'css', 'md', 'json', 'js', 'ts'];
    const sizes = [20, 45, 80, 120, 200, 350, 500, 800, 1200, 3000];
    const modifiedPaths = [];
    for (let i = 0; i < 50; i++) {
      const ext = exts[i % exts.length];
      const path = `src/mod${String(i).padStart(2, '0')}/file${i}.${ext}`;
      const oldLines = makeLines(rng, ext, sizes[i % sizes.length]);
      modifiedPaths.push(path);
      if (i === 0) {
        // New side has no newline at end of file: the last line is rewritten.
        const lastIndex = oldLines.length - 1;
        modified(path, ext, oldLines, 1, {
          edits: [
            { at: 6, del: 2, ins: ['  const firstChange = true; /* changed */'] },
            { at: lastIndex, del: 1, ins: [`${oldLines[lastIndex]} // no newline follows`] },
          ],
          newNoEofNewline: true,
        });
      } else {
        modified(path, ext, oldLines, 1 + (i % 7));
      }
    }

    // ---- special files ----
    modified('big/huge.ts', 'ts', makeLines(rng, 'ts', 20000), 30);
    added('big/generated-added.ts', makeLines(rng, 'ts', 20000));
    added('fresh/added.js', makeLines(rng, 'js', 140));
    added('fresh/empty.txt', []);
    deleted('gone/deleted.js', makeLines(rng, 'js', 180));

    const renamedLines = makeLines(rng, 'py', 90);
    sections.push({
      path: 'new-name/renamed.py',
      text: [
        'diff --git a/old-name/renamed.py b/new-name/renamed.py',
        'similarity index 100%',
        'rename from old-name/renamed.py',
        'rename to new-name/renamed.py',
      ].join('\n') + '\n',
    });
    files['new-name/renamed.py'] = {
      old: joinLines(renamedLines),
      new: joinLines(renamedLines),
      oldName: 'old-name/renamed.py',
      hunks: 0,
      additions: 0,
      deletions: 0,
    };

    modified('new-name/renamed-changed.js', 'js', makeLines(rng, 'js', 150), 1, {
      oldName: 'old-name/renamed-changed.js',
      similarity: 98,
      edits: [{ at: 70, del: 2, ins: ['  const renamedAndChanged = true;'] }],
    });

    sections.push({
      path: 'assets/logo.bin',
      text: [
        'diff --git a/assets/logo.bin b/assets/logo.bin',
        'index 3b18e51..9f2c0aa 100644',
        'Binary files a/assets/logo.bin and b/assets/logo.bin differ',
      ].join('\n') + '\n',
    });
    files['assets/logo.bin'] = { old: null, new: null, hunks: 0, additions: 0, deletions: 0 };

    sections.push({
      path: 'scripts/run.sh',
      text: ['diff --git a/scripts/run.sh b/scripts/run.sh', 'old mode 100644', 'new mode 100755'].join('\n') + '\n',
    });
    files['scripts/run.sh'] = {
      old: '#!/bin/sh\necho run\n',
      new: '#!/bin/sh\necho run\n',
      hunks: 0,
      additions: 0,
      deletions: 0,
    };

    // git orders a diff by path.
    sections.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const plain = [
      { name: 'README.md', contents: joinLines(makeLines(rng, 'md', 400)) },
      { name: 'config/settings.json', contents: joinLines(['{', ...makeLines(rng, 'json', 250), '  "end": true', '}']) },
    ];

    return {
      patch: sections.map((s) => s.text).join(''),
      // The same text per file, for code that takes one file's patch at a time.
      patches: Object.fromEntries(sections.map((s) => [s.path, s.text])),
      order: sections.map((s) => s.path),
      files,
      plain,
      roles: {
        // 20 lines, 2 hunks; the new side has no newline at end of file.
        noNewline: 'src/mod00/file0.js',
        // Small modified files that sit next to each other in the list.
        small: 'src/mod01/file1.ts',
        medium: 'src/mod04/file4.md',
        // 3,000 lines: old plus new contents are about 300,000 characters,
        // the size at which a worker-pool diff swap takes most of a second.
        large: 'src/mod09/file9.ts',
        hugeModified: 'big/huge.ts',
        hugeAdded: 'big/generated-added.ts',
        added: 'fresh/added.js',
        emptyAdded: 'fresh/empty.txt',
        deleted: 'gone/deleted.js',
        renamePure: 'new-name/renamed.py',
        renameChanged: 'new-name/renamed-changed.js',
        binary: 'assets/logo.bin',
        modeOnly: 'scripts/run.sh',
      },
      modifiedPaths,
    };
  }

  return { build, createRng, makeLines, makeEdits, applyEdits, hunksFromEdits, createPatchBuilder, joinLines, CONTEXT };
});
