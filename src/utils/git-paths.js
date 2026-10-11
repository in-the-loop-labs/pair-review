// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Git path spelling helpers for the server.
 *
 * Every git command that prints paths runs with core.quotePath=false (see
 * GIT_PATH_CONFIG in src/git/diff-flags.js), and path lists are read with -z,
 * so names arrive verbatim. What is left to decode is the diff text itself:
 * git still C-quotes a header path containing a control character, `"` or
 * `\`, and diffs cached by older versions quote non-ASCII names too.
 *
 * The decoder is shared with the browser (public/js/utils/git-paths.js) so
 * both sides spell every path the same way.
 */
const { decodeGitPath, parseDiffGitPaths, parsePatchPaths } = require('../../public/js/utils/git-paths');

const QUOTE_ESCAPES = { 0x07: 'a', 0x08: 'b', 0x09: 't', 0x0a: 'n', 0x0b: 'v', 0x0c: 'f', 0x0d: 'r', 0x22: '"', 0x5c: '\\' };

/**
 * Quote a path the way git does with core.quotePath=false, so a header we
 * synthesize is spelled like one git would print. Only control characters,
 * DEL, `"` and `\` force quoting; non-ASCII stays verbatim. Paths that need no
 * quoting are returned unchanged.
 * @param {string} value - Real path (may include an `a/` or `b/` prefix)
 * @returns {string} Git-spelled path
 */
function quoteGitPath(value) {
  let needsQuote = false;
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (QUOTE_ESCAPES[code] !== undefined) {
      out += `\\${QUOTE_ESCAPES[code]}`;
      needsQuote = true;
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\${code.toString(8).padStart(3, '0')}`;
      needsQuote = true;
    } else {
      out += char;
    }
  }
  return needsQuote ? `"${out}"` : value;
}

/**
 * Decode the path in a `--- ` / `+++ ` file line or a `rename from` /
 * `rename to` extended header. Git ends a `---`/`+++` path that contains a
 * space with a tab; a tab inside a real name is always C-quoted, so one
 * trailing raw tab is never part of the path.
 * @param {string} value - Text after `--- `, `+++ `, `rename from ` or `rename to `
 * @param {string} [prefix] - Prefix to strip from the decoded path (`a/` or `b/`)
 * @returns {string|null} Decoded path, or null for `/dev/null`
 */
function decodeDiffLinePath(value, prefix = '') {
  const raw = value.endsWith('\t') ? value.slice(0, -1) : value;
  if (raw === '/dev/null') return null;
  const decoded = decodeGitPath(raw);
  return prefix && decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded;
}

/**
 * Split NUL-terminated git output (`--name-only -z`, `ls-files -z`) into
 * paths. Paths are verbatim: no trimming, no unquoting.
 * @param {string} stdout - Raw command output
 * @returns {string[]} Non-empty paths
 */
function splitNulPaths(stdout) {
  return (stdout || '').split('\0').filter(path => path.length > 0);
}

module.exports = {
  decodeGitPath,
  parseDiffGitPaths,
  parsePatchPaths,
  quoteGitPath,
  decodeDiffLinePath,
  splitNulPaths
};
