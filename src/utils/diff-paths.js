// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Canonical parsing of file paths out of git's textual output.
 *
 * Every diff parser in this codebase MUST derive paths through this module.
 * The reason is not tidiness: `hasFile()` in `src/utils/diff-annotator.js`
 * decides whether a review comment is refused outright (local mode's
 * `refuseCommentsOutsideDiff` turns one unrecognised path into a 409 for the
 * WHOLE submission), while `parseUnifiedDiffPatches` in
 * `src/utils/diff-file-list.js` decides which patch text the UI renders that
 * same comment against. If the two disagree by a single byte — a trailing TAB,
 * a surviving pair of quotes, an octal escape left undecoded — a file the user
 * can plainly see in the diff becomes a file the submitter says is not in it.
 *
 * The three representations git actually emits, verified against real
 * `git diff` output (see the fixtures in tests/unit/diff-paths.test.js):
 *
 *   1. Plain:   `diff --git a/plain.txt b/plain.txt`
 *               `--- a/plain.txt`
 *   2. Spaces:  `diff --git a/my file.txt b/my file.txt`   <- ambiguous split
 *               `--- a/my file.txt\t`                      <- TAB terminator
 *      Git appends a bare TAB to the `---`/`+++` name when the name contains a
 *      space, for `patch(1)` compatibility; other diff producers append
 *      TAB + timestamp. Everything from the first TAB on is metadata.
 *   3. Quoted:  `diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"`
 *               `--- "a/caf\303\251.txt"`
 *      Anything git considers unprintable — non-ASCII bytes, `"`, `\`, TAB,
 *      control characters — forces C-style quoting of the WHOLE token,
 *      `a/` prefix included, with non-ASCII bytes written as octal escapes.
 *      The same quoting governs `git diff --name-only` and `git ls-files`,
 *      which is why `unquoteGitPath` is exported on its own.
 */

/**
 * C escape sequences git's `quote_c_style()` emits (besides `\ooo` octals).
 * Kept as a literal map rather than a regex so an unknown escape falls through
 * to "the escaped character itself", which is what git's unquote does.
 */
const C_ESCAPES = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  '"': '"'
};

/**
 * Append a character's UTF-8 bytes to a byte array.
 *
 * Decoding is done at the BYTE level because git's octal escapes are bytes of
 * a UTF-8 sequence (`\303\251` is two bytes of "é", not two characters).
 * Assembling the string per-character would produce U+00C3 U+00A9 instead.
 */
function pushUtf8Bytes(bytes, ch) {
  const buf = Buffer.from(ch, 'utf8');
  for (const byte of buf) bytes.push(byte);
}

/**
 * Locate the closing quote of a C-quoted token that starts at `start`.
 *
 * @param {string} str - String containing the token
 * @param {number} start - Index of the opening `"`
 * @returns {number} Index of the closing `"`, or -1 when unterminated
 */
function findQuoteEnd(str, start) {
  for (let i = start + 1; i < str.length; i++) {
    const ch = str[i];
    // A backslash escapes the next character, `\"` very much included; skipping
    // it is the whole reason this is a scan and not an `indexOf('"')`.
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') return i;
  }
  return -1;
}

/**
 * Decode one C-quoted token (surrounding quotes included) into a real path.
 *
 * @param {string} token - Token beginning and ending with `"`
 * @returns {string} Decoded path
 */
function decodeCQuoted(token) {
  const body = token.slice(1, -1);
  const bytes = [];

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      pushUtf8Bytes(bytes, ch);
      continue;
    }

    const next = body[++i];
    if (next === undefined) break; // trailing backslash: nothing left to escape

    if (next >= '0' && next <= '7') {
      // Octal escape: up to three digits, one raw byte.
      let octal = next;
      while (octal.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') {
        octal += body[++i];
      }
      bytes.push(parseInt(octal, 8) & 0xff);
      continue;
    }

    const mapped = C_ESCAPES[next];
    pushUtf8Bytes(bytes, mapped !== undefined ? mapped : next);
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * Decode a git path token that MAY be C-quoted.
 *
 * Safe to call on any single-path line git prints — `git diff --name-only`,
 * `git ls-files`, `git status --porcelain` — because git only quotes when it
 * has to, and an unquoted token is returned untouched.
 *
 * @param {string} token - One path token, quoted or not
 * @returns {string} Decoded path ('' for non-string input)
 */
function unquoteGitPath(token) {
  if (typeof token !== 'string') return '';
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return decodeCQuoted(token);
  }
  return token;
}

/**
 * Remove the diff prefix (`a/` or `b/`) from a decoded path.
 *
 * Only the prefix belonging to `side` is stripped, and only once: a file
 * genuinely named `b/thing` shows up as `--- a/b/thing` and must come back as
 * `b/thing`, not `thing`.
 *
 * @param {string} filePath - Decoded path, possibly prefixed
 * @param {'a'|'b'} side - Which prefix is legal here
 * @returns {string} Path without the prefix
 */
function stripDiffPrefix(filePath, side) {
  const prefix = `${side}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

const DIFF_GIT_PREFIX = 'diff --git ';

/**
 * Read one token — quoted or "everything that is left" — from a header tail.
 *
 * @param {string} rest - Remainder of the header line
 * @param {'a'|'b'} side - Which prefix the token may carry
 * @returns {string|null} Decoded, prefix-stripped path, or null when the token
 *   is a quoted string with no closing quote
 */
function readTrailingToken(rest, side) {
  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest, 0);
    if (end === -1) return null;
    return stripDiffPrefix(unquoteGitPath(rest.slice(0, end + 1)), side);
  }
  return stripDiffPrefix(rest, side);
}

/**
 * Parse the two paths out of a `diff --git` header line.
 *
 * The unquoted form is genuinely ambiguous — `diff --git a/my file.txt b/my
 * file.txt` has no delimiter — so the split candidates are ranked: a split
 * that yields two IDENTICAL names wins, because a same-name pair is what every
 * non-rename entry produces and it is the only evidence available for a name
 * that itself contains " b/". Otherwise the first candidate wins, which is the
 * lazy behaviour `parseUnifiedDiffPatches` has always had. (The old greedy
 * regex in `parseFileHeader` took the LAST candidate instead — the two parsers
 * disagreed on exactly the pathological names this ranking now settles.)
 *
 * @param {string} line - A line starting with `diff --git `
 * @returns {{ oldPath: string, newPath: string }|null} Decoded, prefix-stripped
 *   paths, or null when the line is not a parseable `diff --git` header
 */
function parseDiffGitPaths(line) {
  if (typeof line !== 'string' || !line.startsWith(DIFF_GIT_PREFIX)) return null;

  const rest = line.slice(DIFF_GIT_PREFIX.length);
  if (!rest) return null;

  // Quoted a-side: the closing quote ends the token, no ambiguity at all.
  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest, 0);
    if (end === -1) return null;
    const oldPath = stripDiffPrefix(unquoteGitPath(rest.slice(0, end + 1)), 'a');
    const second = rest.slice(end + 1).replace(/^\s+/, '');
    if (!second) return null;
    const newPath = readTrailingToken(second, 'b');
    return newPath === null ? null : { oldPath, newPath };
  }

  // Unquoted a-side, quoted b-side — a rename where only the new name is
  // exotic. An unquoted token can never contain a `"` (a quote is one of the
  // characters that FORCES quoting), so the first ` "` is the b token's start.
  const quotedB = rest.indexOf(' "');
  if (quotedB !== -1) {
    const newPath = readTrailingToken(rest.slice(quotedB + 1), 'b');
    if (newPath === null) return null;
    return { oldPath: stripDiffPrefix(rest.slice(0, quotedB), 'a'), newPath };
  }

  // Both unquoted: require the `a/` … ` b/` shape, then rank the splits.
  if (!rest.startsWith('a/')) return null;
  const candidates = [];
  for (let idx = rest.indexOf(' b/'); idx !== -1; idx = rest.indexOf(' b/', idx + 1)) {
    candidates.push(idx);
  }
  if (candidates.length === 0) return null;

  let cut = candidates[0];
  for (const candidate of candidates) {
    if (rest.slice(2, candidate) === rest.slice(candidate + 3)) {
      cut = candidate;
      break;
    }
  }

  return { oldPath: rest.slice(2, cut), newPath: rest.slice(cut + 3) };
}

/**
 * Parse the path out of a `---` (old side) or `+++` (new side) header line.
 *
 * @param {string} line - The header line
 * @param {'a'|'b'} side - 'a' for `---`, 'b' for `+++`
 * @returns {string|null} Decoded, prefix-stripped path; null for `/dev/null`
 *   and for a marker with no path after it
 */
function parseDiffSidePath(line, side) {
  const marker = side === 'a' ? '---' : '+++';
  if (typeof line !== 'string' || !line.startsWith(marker)) return null;

  const afterMarker = line.slice(marker.length);
  const gap = afterMarker.match(/^\s+/);
  if (!gap) return null;

  const rest = afterMarker.slice(gap[0].length);
  if (!rest) return null;

  let token;
  if (rest.startsWith('"')) {
    const end = findQuoteEnd(rest, 0);
    if (end === -1) return null;
    token = unquoteGitPath(rest.slice(0, end + 1));
  } else {
    // TAB terminates the name: a bare TAB from git when the name has a space,
    // TAB + timestamp from other diff producers. Never part of the path — a
    // path that really contains a TAB is quoted instead, handled above.
    const tab = rest.indexOf('\t');
    token = tab === -1 ? rest : rest.slice(0, tab);
  }

  if (token === '/dev/null') return null;
  return stripDiffPrefix(token, side);
}

module.exports = {
  unquoteGitPath,
  stripDiffPrefix,
  parseDiffGitPaths,
  parseDiffSidePath
};
