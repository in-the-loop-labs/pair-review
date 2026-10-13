// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Git path decoding, shared by the server and the browser.
 *
 * pair-review runs every path-producing git command with core.quotePath=false,
 * so non-ASCII names come out verbatim. Git still C-quotes a path that contains
 * a control character, `"` or `\`: `tab<TAB>name.js` appears in a `diff --git`
 * header as `"a/tab\tname.js"`. Diff text cached by older versions (written
 * with git's default core.quotePath=true) also carries octal-escaped UTF-8
 * (`"a/caf\303\251.js"`) until the review is refreshed.
 *
 * The browser reads paths straight out of the diff text (parseUnifiedDiff keys
 * patches by them, Local mode builds its file list from them, Pierre names
 * files from them), so it decodes headers exactly like the server. This file
 * is the ONE implementation: src/utils/git-paths.js re-exports it for the
 * server, and pr.html / local.html load it for the browser.
 */
(function () {
  const QUOTED_PATH = '"(?:[^"\\\\]|\\\\.)*"';
  const DIFF_GIT_PATHS_RE = new RegExp(`^(${QUOTED_PATH}|a\\/.+?) (${QUOTED_PATH}|b\\/.+)$`);
  const DECODE_ESCAPES = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' };

  /**
   * Decode a git C-quoted path (including octal-escaped UTF-8 bytes). An
   * unquoted value is returned unchanged: git always quotes a path that
   * begins with `"`, so a leading quote is unambiguous.
   * @param {string} value - Path as printed by git
   * @returns {string} Real path
   */
  function decodeGitPath(value) {
    if (typeof value !== 'string' || value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
      return value;
    }
    const encoder = new TextEncoder();
    const bytes = [];
    for (const match of value.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/gs)) {
      if (match[2] !== undefined) {
        bytes.push(...encoder.encode(match[2]));
      } else if (/^[0-7]/.test(match[1])) {
        bytes.push(parseInt(match[1], 8) & 0xff);
      } else {
        bytes.push(...encoder.encode(DECODE_ESCAPES[match[1]] ?? match[1]));
      }
    }
    // ignoreBOM: a name that begins with U+FEFF keeps it (the default decoder
    // would strip a leading EF BB BF as a byte order mark).
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(bytes));
  }

  /**
   * Parse the old and new paths from a `diff --git` header line. Either side
   * may be C-quoted independently.
   *
   * An unquoted header for an unrenamed file is `a/<p> b/<p>`, split at its
   * midpoint, so a name containing ` b/` (`x b/y.js`) still parses. Other
   * unquoted headers split at the first ` b/`; parsePatchPaths corrects a
   * rename or copy from its `rename from` / `rename to` lines.
   *
   * @param {string} headerLine - First line of a per-file patch
   * @returns {{ oldPath: string, newPath: string }|null} Decoded paths without
   *   their `a/` / `b/` prefixes, or null when the line is not a git header
   */
  function parseDiffGitPaths(headerLine) {
    if (typeof headerLine !== 'string' || !headerLine.startsWith('diff --git ')) return null;
    const rest = headerLine.slice('diff --git '.length);

    const half = (rest.length - 1) / 2;
    if (Number.isInteger(half) && rest.startsWith('a/') && rest.startsWith(' b/', half)) {
      const oldPath = rest.slice(2, half);
      if (oldPath === rest.slice(half + 3)) {
        return { oldPath, newPath: oldPath };
      }
    }

    const match = rest.match(DIFF_GIT_PATHS_RE);
    if (!match) return null;
    const oldPath = decodeGitPath(match[1]);
    const newPath = decodeGitPath(match[2]);
    if (!oldPath.startsWith('a/') || !newPath.startsWith('b/')) return null;
    return { oldPath: oldPath.slice(2), newPath: newPath.slice(2) };
  }

  // Extended header lines git prints between `diff --git` and the first hunk
  // can name the old and new paths explicitly. Copies use `copy from/to`.
  const PATCH_PATH_LINE_RE = /^(?:rename|copy) (from|to) (.+)$/;
  // Lines that end the extended header: nothing after them names a path.
  const PATCH_HEADER_END_RE = /^(?:@@|--- |\+\+\+ |Binary files |GIT binary patch$|diff --git )/;
  // Longest git extended header: old mode, new mode, similarity index,
  // rename from, rename to, index. Lines past this never name a path.
  const MAX_EXTENDED_HEADER_LINES = 8;

  /**
   * Resolve the old and new paths of one per-file patch.
   *
   * A renamed or copied file's unquoted `diff --git` header is ambiguous when
   * a path contains ` b/` (`git mv 'x b/y.js' z.js` prints
   * `diff --git a/x b/y.js b/z.js`). Git also prints `rename from` /
   * `rename to` (or `copy from` / `copy to`) lines that each hold exactly one
   * path, so those win over the header split. Every other patch has the same
   * path on both sides, which parseDiffGitPaths splits unambiguously.
   *
   * @param {string|string[]} patch - Per-file patch text, or the diff's lines
   * @param {number} [start=0] - Index of the `diff --git` line when `patch` is
   *   an array of lines
   * @returns {{ oldPath: string, newPath: string }|null} Decoded paths, or null
   *   when the first line is not a git header
   */
  function parsePatchPaths(patch, start = 0) {
    const lines = typeof patch === 'string'
      ? patch.split('\n', MAX_EXTENDED_HEADER_LINES + 1)
      : patch;
    if (!Array.isArray(lines)) return null;
    const paths = parseDiffGitPaths(lines[start]);
    if (!paths) return null;

    const end = Math.min(lines.length, start + 1 + MAX_EXTENDED_HEADER_LINES);
    for (let i = start + 1; i < end; i++) {
      const line = lines[i];
      if (PATCH_HEADER_END_RE.test(line)) break;
      const match = line.match(PATCH_PATH_LINE_RE);
      if (!match) continue;
      if (match[1] === 'from') {
        paths.oldPath = decodeGitPath(match[2]);
      } else {
        paths.newPath = decodeGitPath(match[2]);
      }
    }
    return paths;
  }

  const GitPaths = { decodeGitPath, parseDiffGitPaths, parsePatchPaths };

  if (typeof window !== 'undefined') {
    window.GitPaths = GitPaths;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GitPaths;
  }
})();
