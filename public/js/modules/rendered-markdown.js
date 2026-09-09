// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * RenderedMarkdown - pure parsing/outline/target-resolution helpers for the
 * first-class "Rendered" Markdown view.
 *
 * This module deliberately contains NO DOM code so it can be unit tested in
 * plain Node. DOM assembly (creating wrapper elements, wiring click
 * handlers) lives in `rendered-document-view.js`, which consumes the data
 * shapes produced here.
 *
 * Design notes (see plans/rendered-markdown-review.md for the full writeup):
 *  - Top-level markdown-it blocks (levels === 0) are the unit of comment
 *    anchoring. Each block carries a 1-indexed, inclusive source line range
 *    derived from markdown-it's `token.map`.
 *  - Comment targets are resolved from trusted, in-memory data (the active
 *    file's `patch` string) — never from attributes read back off the
 *    rendered DOM — so repository-controlled markdown content can never
 *    redirect a comment to a different file or an attacker-chosen line.
 *  - Diff-position resolution mirrors the "both endpoints must be inside the
 *    diff" rule already used at PR-submission time (src/routes/pr.js
 *    `isExpandedContext`): if either endpoint of the block's line range
 *    falls outside every hunk, the comment is submitted WITHOUT a
 *    diff_position (the existing "honest fallback" — GitHub review
 *    submission already knows how to format such comments as file-level
 *    "(Ref Lines X-Y)" comments). We never fabricate a diff_position, which
 *    is what would risk silently attaching a comment to an unrelated line.
 */

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

/**
 * Version stamped into every persisted rendered-anchor descriptor. Bump ONLY
 * with a matching reader change: `normalizeRenderedAnchor` rejects any other
 * version outright, which is the intended "old client, new data" (and vice
 * versa) behavior — an unrecognised descriptor must degrade to the honest
 * line-based fallback, never to a guessed nested element.
 */
const RENDERED_ANCHOR_VERSION = 1;

/**
 * The complete set of nested comment-target kinds. A descriptor naming
 * anything else is rejected (fail closed) — both in the browser and at the
 * API boundary, which shares this module (see src/utils/rendered-anchor.js).
 */
const RENDERED_TARGET_KINDS = Object.freeze([
  'list-item',
  'nested-list-item',
  'table-row',
  'table-header-cell',
  'table-cell'
]);
const RENDERED_TARGET_KIND_SET = new Set(RENDERED_TARGET_KINDS);

/** Keys a descriptor may carry. Any extra key rejects the whole descriptor. */
const RENDERED_ANCHOR_KEYS = new Set(['v', 'kind', 'startLine', 'endLine', 'ordinal']);

/**
 * Hard ceilings for descriptor fields. These are deliberately generous
 * relative to anything the UI can produce (Rendered mode itself refuses
 * files over 5,000 lines) and exist so a hand-crafted API payload can't
 * store an absurd value that later formats into the UI.
 */
const RENDERED_ANCHOR_MAX_LINE = 10000000;
const RENDERED_ANCHOR_MAX_ORDINAL = 4096;
/** Serialized size ceiling, checked before any JSON.parse of stored text. */
const RENDERED_ANCHOR_MAX_JSON_CHARS = 512;

/**
 * markdown-it token types that open/close a structural element we can map
 * onto a rendered DOM node. Keyed by token TYPE (not `.tag`) so an inline
 * `html_inline` token that happens to carry a `<td>` string can never be
 * mistaken for a real table cell.
 */
const STRUCTURAL_OPEN_TOKENS = {
  // `blockquote` carries no target of its own, but it MUST take part in the
  // structural pairing: markdown-it renders `> - item` as
  // `blockquote > ul > li`, and a tree that skipped the blockquote would
  // disagree with the DOM and fail the whole block closed.
  blockquote_open: 'blockquote',
  bullet_list_open: 'ul',
  ordered_list_open: 'ol',
  list_item_open: 'li',
  table_open: 'table',
  thead_open: 'thead',
  tbody_open: 'tbody',
  tr_open: 'tr',
  th_open: 'th',
  td_open: 'td'
};

const STRUCTURAL_CLOSE_TOKENS = {
  blockquote_close: 'blockquote',
  bullet_list_close: 'ul',
  ordered_list_close: 'ol',
  list_item_close: 'li',
  table_close: 'table',
  thead_close: 'thead',
  tbody_close: 'tbody',
  tr_close: 'tr',
  th_close: 'th',
  td_close: 'td'
};

/** Tag names that participate in the token <-> DOM structural pairing. */
const STRUCTURAL_TAGS = new Set([
  'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td'
]);

const RENDERED_TARGET_LABELS = {
  'list-item': 'List item',
  'nested-list-item': 'Nested list item',
  'table-row': 'Table row',
  'table-header-cell': 'Table header cell',
  'table-cell': 'Table cell'
};

/**
 * Whether a repository path is a Markdown file eligible for Rendered mode.
 * @param {string} filePath
 * @returns {boolean}
 */
function isMarkdownPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const clean = filePath.split(/[?#]/)[0];
  const dot = clean.lastIndexOf('.');
  if (dot === -1 || dot === clean.length - 1) return false;
  const ext = clean.slice(dot + 1).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(ext);
}

/**
 * Resolve the HunkParser implementation, preferring an explicitly injected
 * reference (used by tests), then the browser global, then a Node require.
 * @param {object} [injected]
 * @returns {object|null}
 */
function _getHunkParser(injected) {
  if (injected) return injected;
  if (typeof window !== 'undefined' && window.HunkParser) return window.HunkParser;
  if (typeof module !== 'undefined' && module.exports) {
    try {
      // eslint-disable-next-line global-require
      return require('./hunk-parser.js').HunkParser;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Human-readable block "type" derived from a markdown-it token's `.type`
 * (e.g. `paragraph_open` -> `paragraph`, `fence` -> `fence`).
 * @param {object} token
 * @returns {string}
 */
function _blockType(token) {
  return token.type.endsWith('_open') ? token.type.slice(0, -5) : token.type;
}

/**
 * Split a markdown-it token stream into top-level ("level 0") blocks, each
 * carrying its own 1-indexed inclusive source line range and, for headings,
 * the heading level + text needed to build the outline.
 *
 * Blocks that produce no tokens at all (e.g. link-reference definitions,
 * which markdown-it consumes into `env.references` without emitting a
 * token) are simply absent from the result — there is nothing to anchor a
 * comment to and nothing to render.
 *
 * KNOWN LIMITATION: because each block's source is later re-rendered in
 * isolation (see rendered-document-view.js), link reference definitions
 * and footnote definitions declared in a DIFFERENT top-level block will not
 * resolve. This is an accepted tradeoff for deterministic per-block comment
 * anchoring; most real-world PR markdown (headings, paragraphs, lists, code
 * fences, tables, blockquotes) is unaffected.
 *
 * @param {object} md - a markdown-it instance (only `.parse` is used)
 * @param {string} source - the full markdown document text
 * @returns {Array<{index:number, type:string, startLine:number, endLine:number, source:string, heading:({level:number,text:string}|null)}>}
 */
function splitTopLevelBlocks(md, source) {
  const src = source == null ? '' : String(source);
  const lines = src.split('\n');
  const tokens = md.parse(src, {});
  const blocks = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.level !== 0) {
      i++;
      continue;
    }
    if (token.nesting === -1) {
      // Stray close with no matching open we recorded (shouldn't happen for
      // a well-formed token stream) — skip defensively.
      i++;
      continue;
    }

    let endIndex = i;
    if (token.nesting === 1) {
      let j = i + 1;
      while (j < tokens.length && !(tokens[j].level === 0 && tokens[j].nesting === -1)) {
        j++;
      }
      endIndex = j < tokens.length ? j : tokens.length - 1;
    }

    const map = token.map || tokens[endIndex].map;
    if (map) {
      const startLine = map[0] + 1;
      const endLine = map[1];
      let heading = null;
      if (token.type === 'heading_open') {
        const inlineToken = tokens[i + 1];
        const level = parseInt(String(token.tag || 'h1').slice(1), 10) || 1;
        heading = {
          level,
          text: inlineToken && inlineToken.type === 'inline' ? inlineToken.content : ''
        };
      }
      blocks.push({
        index: blocks.length,
        type: _blockType(token),
        startLine,
        endLine,
        source: lines.slice(startLine - 1, endLine).join('\n'),
        heading
      });
    }

    i = endIndex + 1;
  }

  return blocks;
}

/**
 * GitHub-style heading slug: lowercase, strip punctuation (keep any-script
 * letters/numbers/underscore/spaces/hyphens — a Unicode-aware equivalent of
 * `\w`, since bare `\w` is ASCII-only and would strip CJK/Cyrillic/accented
 * headings down to nothing), collapse whitespace to hyphens, de-duplicate
 * against `seen` by appending `-1`, `-2`, ... Mutates `seen`.
 * @param {string} text
 * @param {Set<string>} seen
 * @returns {string}
 */
function slugifyHeading(text, seen) {
  let slug = String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s+/g, '-');
  if (!slug) slug = 'section';
  if (seen.has(slug)) {
    let n = 1;
    while (seen.has(`${slug}-${n}`)) n++;
    slug = `${slug}-${n}`;
  }
  seen.add(slug);
  return slug;
}

/**
 * Derive a DOM-id-safe slug for a repository file path, used to namespace
 * heading ids (see rendered-document-view.js) so two different Markdown
 * files that happen to share a heading (e.g. two READMEs each with an
 * "Overview" section) don't collide on the same `id` when both are open in
 * Rendered mode simultaneously. Unicode-aware for the same reason as
 * `slugifyHeading`. Not required to be reversible or globally unique beyond
 * "distinct file paths produce distinct ids in practice" — it is purely a
 * DOM-scoping key, never used to resolve a comment target.
 * @param {string} filePath
 * @returns {string}
 */
function fileIdSlug(filePath) {
  const slug = String(filePath || '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'doc';
}

/**
 * Build the outline (heading list) for a document's top-level blocks.
 * @param {Array} blocks - result of splitTopLevelBlocks
 * @returns {Array<{level:number, text:string, slug:string, startLine:number, blockIndex:number}>}
 */
function buildOutline(blocks) {
  const seen = new Set();
  const outline = [];
  for (const block of blocks) {
    if (!block.heading) continue;
    outline.push({
      level: block.heading.level,
      text: block.heading.text,
      slug: slugifyHeading(block.heading.text, seen),
      startLine: block.startLine,
      blockIndex: block.index
    });
  }
  return outline;
}

/**
 * Compute a `SIDE:line -> diffPosition` map from a unified diff patch for a
 * single file, mirroring the walk in PierreBridge._diffPositionsFromPatch /
 * CommentManager.isLineInDiffHunk (three independent, already-existing
 * implementations of this walk — see plan Hazards). Context lines are
 * addressable from both sides.
 * @param {string|null} patch
 * @param {object} [HunkParserRef] - injectable for tests
 * @returns {Map<string, number>}
 */
function computeDiffPositions(patch, HunkParserRef) {
  const positions = new Map();
  if (!patch) return positions;
  const HunkParser = _getHunkParser(HunkParserRef);
  if (!HunkParser) return positions;

  const blocks = HunkParser.parseDiffIntoBlocks(patch);
  let diffPosition = 0;

  blocks.forEach((block) => {
    diffPosition++; // hunk header counts as a position
    let oldLineNum = block.oldStart;
    let newLineNum = block.newStart;

    block.lines.forEach((line) => {
      if (line == null) return;
      if (line.startsWith('\\ No newline')) return;
      diffPosition++;
      if (line.startsWith('+')) {
        positions.set(`RIGHT:${newLineNum}`, diffPosition);
        newLineNum++;
      } else if (line.startsWith('-')) {
        positions.set(`LEFT:${oldLineNum}`, diffPosition);
        oldLineNum++;
      } else {
        positions.set(`RIGHT:${newLineNum}`, diffPosition);
        positions.set(`LEFT:${oldLineNum}`, diffPosition);
        oldLineNum++;
        newLineNum++;
      }
    });
  });

  return positions;
}

/**
 * Resolve a rendered-block comment target. Rendered mode always shows the
 * NEW (post-change) file content, so `side` is always 'RIGHT'.
 *
 * `diff_position` is set ONLY when BOTH endpoints of the range have a known
 * diff position — matching the "both endpoints" rule the review-submission
 * path already applies (src/routes/pr.js). Otherwise it is left `null`
 * (the honest fallback): the comment still stores the real file + real line
 * range, it is just not claimed to sit at a specific diff position. Review
 * submission independently re-derives whether a comment is "in the diff"
 * from line numbers, so this never causes a comment to be mis-submitted —
 * it only affects whether OUR own UI treats it as diff-anchored.
 * @param {object} opts
 * @param {string|null} opts.patch
 * @param {number} opts.startLine
 * @param {number} [opts.endLine]
 * @param {object} [opts.HunkParser] - injectable for tests
 * @returns {{side:string, line_start:number, line_end:number, diff_position:(number|null), inDiff:boolean}}
 */
function resolveCommentTarget({ patch, startLine, endLine, HunkParser } = {}) {
  const side = 'RIGHT';
  const line_start = startLine;
  const line_end = endLine != null ? endLine : startLine;
  const positions = computeDiffPositions(patch, HunkParser);
  const startPos = positions.get(`${side}:${line_start}`);
  const endPos = positions.get(`${side}:${line_end}`);
  const inDiff = startPos != null && endPos != null;
  return {
    side,
    line_start,
    line_end,
    diff_position: inDiff ? endPos : null,
    inDiff
  };
}

/**
 * Normalize a `/`-joined relative path, resolving `.` and `..` segments.
 * Returns null if the path would escape above its root (a `..` with
 * nothing left to pop) — the caller treats that as "not a safe internal
 * link" rather than guessing.
 * @param {string} p
 * @returns {string|null}
 */
function _normalizeRelativePath(p) {
  const stack = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

/**
 * Decide whether a markdown link's `href` is a safe, same-repository
 * relative link, and if so, resolve it against `currentFilePath`.
 *
 * Only a link with NO scheme (no `http:`, `mailto:`, etc.), not starting
 * with `//` or `/`, is considered. This deliberately excludes
 * root-relative links (ambiguous between "repo root" and "site root") —
 * they are left as ordinary links.
 * @param {string} href
 * @param {string} currentFilePath - path of the document containing the link
 * @returns {{targetPath:string, fragment:(string|null)}|{samePage:true, fragment:string}|null}
 */
function _resolveRelativePath(href, currentFilePath) {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#')) {
    return { samePage: true, fragment: trimmed.slice(1) };
  }
  // Any scheme (http:, https:, mailto:, tel:, etc.) — not our concern.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null;
  if (trimmed.startsWith('//')) return null;
  if (trimmed.startsWith('/')) return null;

  const hashIndex = trimmed.indexOf('#');
  const pathPart = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? null : trimmed.slice(hashIndex + 1);
  if (!pathPart) return fragment ? { samePage: true, fragment } : null;

  const currentDir = currentFilePath && currentFilePath.includes('/')
    ? currentFilePath.slice(0, currentFilePath.lastIndexOf('/'))
    : '';
  const combined = currentDir ? `${currentDir}/${pathPart}` : pathPart;
  const normalized = _normalizeRelativePath(combined);
  if (normalized == null) return null;
  return { targetPath: normalized, fragment };
}

/**
 * Resolve an internal-navigation target for a markdown link, or null if the
 * link should be left as an ordinary (possibly external) link.
 *
 * A link is only intercepted when it resolves — after `.`/`..` normalization
 * — to EXACTLY a path present in `changedMarkdownPaths` (the closed set of
 * markdown files changed in this review), or to a `#fragment` within the
 * current document. Anything else (external URLs, links to files not in
 * the diff, links that would escape the repo root) is left alone so it
 * behaves as a normal, safe link.
 * @param {string} href
 * @param {string} currentFilePath
 * @param {Set<string>|Array<string>} changedMarkdownPaths
 * @returns {{targetPath:string, fragment:(string|null), samePage:boolean}|null}
 */
function resolveInternalLink(href, currentFilePath, changedMarkdownPaths) {
  const resolved = _resolveRelativePath(href, currentFilePath);
  if (!resolved) return null;

  if (resolved.samePage) {
    return { targetPath: currentFilePath, fragment: resolved.fragment, samePage: true };
  }

  const set = changedMarkdownPaths instanceof Set
    ? changedMarkdownPaths
    : new Set(changedMarkdownPaths || []);
  if (!set.has(resolved.targetPath)) return null;

  return { targetPath: resolved.targetPath, fragment: resolved.fragment, samePage: false };
}

/**
 * Whether a value is a usable 1-indexed source line number.
 * @param {*} n
 * @returns {boolean}
 */
function _isSourceLine(n) {
  return Number.isInteger(n) && n >= 1 && n <= RENDERED_ANCHOR_MAX_LINE;
}

/**
 * Derive the hierarchical (nested) comment targets inside ONE top-level
 * block, from that block's own markdown-it token stream.
 *
 * WHY the block's own source (and not the whole-document parse): the
 * rendered DOM this maps onto is produced by re-rendering exactly
 * `blockSource` (see rendered-document-view.js `_buildBlockElement`), so
 * parsing the same string is the only way the token tree and the DOM tree
 * are guaranteed to describe the same document. Line numbers are made
 * absolute by adding `blockStartLine`.
 *
 * Returned nodes form a TREE mirroring the structural elements markdown-it
 * will emit (`ul/ol/li/table/thead/tbody/tr/th/td`). The consumer pairs that
 * tree positionally against the sanitized DOM and bails out entirely on the
 * first mismatch — which is what makes repository-authored raw HTML (e.g. a
 * literal `<ul><li>` inside a paragraph, which markdown-it emits as an
 * opaque `html_block`/`html_inline` token) unable to shift a descriptor onto
 * an element it doesn't describe.
 *
 * Descriptors are the persisted identity of a target:
 *   `{ v, kind, startLine, endLine, ordinal }`
 * `ordinal` is the 0-based index among targets in this block that share the
 * SAME kind and SAME start line, in document order. It exists because line
 * numbers alone cannot identify a target: every cell of a Markdown table row
 * is on one source line, and `- - a` puts a list item and its nested child
 * on one line too.
 *
 * @param {object} md - markdown-it instance (only `.parse` is used)
 * @param {string} blockSource - the block's own markdown source
 * @param {number} blockStartLine - 1-indexed absolute line of blockSource[0]
 * @returns {{root:object, targets:Array<object>}|null} null when the token
 *   stream is malformed (fail closed: the caller then offers no nested
 *   targets for this block, leaving the block-level target intact)
 */
function buildNestedTargets(md, blockSource, blockStartLine) {
  if (!md || typeof md.parse !== 'function') return null;
  const base = _isSourceLine(blockStartLine) ? blockStartLine : 1;
  const src = blockSource == null ? '' : String(blockSource);
  const lines = src.split('\n');

  let tokens;
  try {
    tokens = md.parse(src, {});
  } catch {
    return null;
  }

  const root = { tag: null, children: [], descriptor: null };
  const stack = [root];
  for (const token of tokens) {
    const openTag = STRUCTURAL_OPEN_TOKENS[token.type];
    if (openTag) {
      const node = { tag: openTag, map: token.map || null, children: [], descriptor: null };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      continue;
    }
    const closeTag = STRUCTURAL_CLOSE_TOKENS[token.type];
    if (closeTag) {
      // A close with no matching open, or a crossed pair, means our view of
      // the structure is wrong — refuse to map anything rather than map it
      // to the wrong element.
      if (stack.length < 2 || stack[stack.length - 1].tag !== closeTag) return null;
      stack.pop();
    }
  }
  if (stack.length !== 1) return null;

  /**
   * Trim trailing blank source lines off a range. markdown-it's `map` for a
   * list item in a loose list includes the blank separator line that
   * follows it; a comment claiming to cover a blank line it isn't about is
   * both misleading and needlessly likely to fall outside the diff.
   */
  const clampRange = (startLine, endLine) => {
    let end = endLine;
    while (end > startLine && (lines[end - base] || '').trim() === '') end--;
    return { startLine, endLine: end };
  };

  const targets = [];
  const ordinals = new Map();

  const visit = (node, listDepth, rowRange) => {
    let range = null;
    if (node.map && Number.isInteger(node.map[0]) && Number.isInteger(node.map[1])) {
      const startLine = base + node.map[0];
      const endLine = Math.max(startLine, base + node.map[1] - 1);
      range = clampRange(startLine, endLine);
    }
    let currentRow = rowRange;
    if (node.tag === 'tr' && range) currentRow = range;
    // markdown-it emits NO map for `th`/`td` — every cell of a row shares
    // the row's single source line. That is precisely why `ordinal` exists.
    if ((node.tag === 'th' || node.tag === 'td') && !range) range = currentRow;

    let kind = null;
    if (node.tag === 'li') kind = listDepth >= 2 ? 'nested-list-item' : 'list-item';
    else if (node.tag === 'tr') kind = 'table-row';
    else if (node.tag === 'th') kind = 'table-header-cell';
    else if (node.tag === 'td') kind = 'table-cell';

    if (kind && range && _isSourceLine(range.startLine) && _isSourceLine(range.endLine)) {
      const bucket = `${kind}:${range.startLine}`;
      const ordinal = ordinals.get(bucket) || 0;
      ordinals.set(bucket, ordinal + 1);
      if (ordinal <= RENDERED_ANCHOR_MAX_ORDINAL) {
        node.descriptor = {
          v: RENDERED_ANCHOR_VERSION,
          kind,
          startLine: range.startLine,
          endLine: range.endLine,
          ordinal
        };
        targets.push(node);
      }
    }

    const childDepth = (node.tag === 'ul' || node.tag === 'ol') ? listDepth + 1 : listDepth;
    for (const child of node.children) visit(child, childDepth, currentRow);
  };

  for (const child of root.children) visit(child, 0, null);

  return { root, targets };
}

/**
 * Validate and canonicalize a rendered-anchor descriptor.
 *
 * Accepts either the object form or the JSON string form (as persisted in
 * `comments.rendered_anchor`), and returns a NEW object containing only the
 * five known keys — or `null` if anything at all is off. There is no partial
 * acceptance and no coercion: an anchor that cannot be fully trusted must
 * degrade to the line-based fallback, because the alternative (guessing) is
 * exactly the "silently attach a missing anchor to a different nested
 * element" failure this feature must never produce.
 *
 * Shared verbatim by the browser and by the API boundary
 * (src/utils/rendered-anchor.js requires this module) so client and server
 * can never drift into accepting different shapes.
 * @param {*} value
 * @returns {{v:number, kind:string, startLine:number, endLine:number, ordinal:number}|null}
 */
function normalizeRenderedAnchor(value) {
  let raw = value;
  if (typeof raw === 'string') {
    if (raw.length > RENDERED_ANCHOR_MAX_JSON_CHARS) return null;
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  for (const key of Object.keys(raw)) {
    if (!RENDERED_ANCHOR_KEYS.has(key)) return null;
  }
  if (raw.v !== RENDERED_ANCHOR_VERSION) return null;
  if (typeof raw.kind !== 'string' || !RENDERED_TARGET_KIND_SET.has(raw.kind)) return null;
  if (!_isSourceLine(raw.startLine) || !_isSourceLine(raw.endLine)) return null;
  if (raw.endLine < raw.startLine) return null;
  if (!Number.isInteger(raw.ordinal) || raw.ordinal < 0 || raw.ordinal > RENDERED_ANCHOR_MAX_ORDINAL) return null;
  return {
    v: RENDERED_ANCHOR_VERSION,
    kind: raw.kind,
    startLine: raw.startLine,
    endLine: raw.endLine,
    ordinal: raw.ordinal
  };
}

/**
 * Stable lookup key for a descriptor. All four identity fields participate:
 * a stored anchor whose end line no longer matches the current content is a
 * MISS (honest line-based fallback), not a near-match onto a sibling.
 * @param {object} anchor - an already-normalized descriptor
 * @returns {string}
 */
function renderedAnchorKey(anchor) {
  return `${anchor.kind}|${anchor.startLine}|${anchor.endLine}|${anchor.ordinal}`;
}

/**
 * Human-readable description of a target, used for accessible names, the
 * comment form header and the card's target chip. Always includes the real
 * source line range; cells also include their 1-based column, list items
 * their 1-based position when more than one shares a line.
 * @param {object} anchor - an already-normalized descriptor
 * @returns {string}
 */
function describeRenderedTarget(anchor) {
  const label = RENDERED_TARGET_LABELS[anchor.kind] || 'Target';
  const lines = anchor.endLine > anchor.startLine
    ? `lines ${anchor.startLine}–${anchor.endLine}`
    : `line ${anchor.startLine}`;
  if (anchor.kind === 'table-cell' || anchor.kind === 'table-header-cell') {
    return `${label}, ${lines}, column ${anchor.ordinal + 1}`;
  }
  if (anchor.ordinal > 0) {
    return `${label} ${anchor.ordinal + 1}, ${lines}`;
  }
  return `${label}, ${lines}`;
}

const RenderedMarkdown = {
  isMarkdownPath,
  splitTopLevelBlocks,
  buildNestedTargets,
  normalizeRenderedAnchor,
  renderedAnchorKey,
  describeRenderedTarget,
  RENDERED_ANCHOR_VERSION,
  RENDERED_TARGET_KINDS,
  RENDERED_ANCHOR_MAX_JSON_CHARS,
  RENDERED_ANCHOR_MAX_ORDINAL,
  RENDERED_ANCHOR_MAX_LINE,
  STRUCTURAL_TAGS,
  slugifyHeading,
  fileIdSlug,
  buildOutline,
  computeDiffPositions,
  resolveCommentTarget,
  resolveInternalLink
};

// Browser: attach to window
if (typeof window !== 'undefined') {
  window.RenderedMarkdown = RenderedMarkdown;
}

// Node: export for testing / server-side reuse
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RenderedMarkdown;
}
