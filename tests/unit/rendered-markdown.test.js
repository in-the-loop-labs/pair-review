// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';

const markdownit = require('markdown-it');
const RenderedMarkdown = require('../../public/js/modules/rendered-markdown.js');

const {
  isMarkdownPath,
  splitTopLevelBlocks,
  slugifyHeading,
  fileIdSlug,
  buildOutline,
  computeDiffPositions,
  resolveCommentTarget,
  resolveInternalLink,
  buildNestedTargets,
  normalizeRenderedAnchor,
  renderedAnchorKey,
  describeRenderedTarget,
  RENDERED_ANCHOR_MAX_JSON_CHARS,
  RENDERED_ANCHOR_MAX_ORDINAL
} = RenderedMarkdown;

function md() {
  return markdownit({ html: false, breaks: true, linkify: true, typographer: true });
}

describe('isMarkdownPath', () => {
  it('accepts .md and .markdown (case-insensitive)', () => {
    expect(isMarkdownPath('docs/guide.md')).toBe(true);
    expect(isMarkdownPath('docs/GUIDE.MD')).toBe(true);
    expect(isMarkdownPath('README.markdown')).toBe(true);
  });

  it('rejects non-markdown paths, missing extensions, and falsy input', () => {
    expect(isMarkdownPath('src/utils.js')).toBe(false);
    expect(isMarkdownPath('Makefile')).toBe(false);
    expect(isMarkdownPath('docs/')).toBe(false);
    expect(isMarkdownPath('')).toBe(false);
    expect(isMarkdownPath(null)).toBe(false);
    expect(isMarkdownPath(undefined)).toBe(false);
  });

  it('ignores query/fragment suffixes', () => {
    expect(isMarkdownPath('docs/guide.md#section')).toBe(true);
  });
});

describe('splitTopLevelBlocks', () => {
  it('returns an empty array for empty source', () => {
    expect(splitTopLevelBlocks(md(), '')).toEqual([]);
  });

  it('maps a heading + paragraph to correct 1-indexed inclusive line ranges', () => {
    const source = '# Title\n\nHello world.\n';
    const blocks = splitTopLevelBlocks(md(), source);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'heading', startLine: 1, endLine: 1 });
    expect(blocks[0].heading).toEqual({ level: 1, text: 'Title' });
    expect(blocks[1]).toMatchObject({ type: 'paragraph', startLine: 3, endLine: 3, source: 'Hello world.' });
  });

  it('keeps a multi-line paragraph as a single block spanning all its lines', () => {
    const source = 'Line one\nLine two\nLine three\n';
    const blocks = splitTopLevelBlocks(md(), source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startLine: 1, endLine: 3 });
  });

  it('keeps a whole list (all items) as a single top-level block', () => {
    const source = '- one\n- two\n- three\n';
    const blocks = splitTopLevelBlocks(md(), source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'bullet_list', startLine: 1, endLine: 3 });
  });

  it('keeps a fenced code block as one block including the fence lines', () => {
    const source = 'Intro\n\n```js\nconst x = 1;\n```\n\nOutro\n';
    const blocks = splitTopLevelBlocks(md(), source);
    // Intro, fence, Outro
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'fence', 'paragraph']);
    const fenceBlock = blocks[1];
    expect(fenceBlock.startLine).toBe(3);
    expect(fenceBlock.endLine).toBe(5);
    expect(fenceBlock.source).toBe('```js\nconst x = 1;\n```');
  });

  it('keeps a blockquote as one block', () => {
    const source = '> quoted line one\n> quoted line two\n';
    const blocks = splitTopLevelBlocks(md(), source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'blockquote', startLine: 1, endLine: 2 });
  });

  it('keeps a table as one block', () => {
    const source = '| a | b |\n| - | - |\n| 1 | 2 |\n';
    const blocks = splitTopLevelBlocks(md(), source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'table', startLine: 1, endLine: 3 });
  });

  it('assigns sequential zero-based indices matching document order', () => {
    const source = '# A\n\npara\n\n## B\n';
    const blocks = splitTopLevelBlocks(md(), source);
    expect(blocks.map((b) => b.index)).toEqual([0, 1, 2]);
  });

  it('does not emit a block for a link-reference definition (no tokens produced)', () => {
    const source = '[ref]: https://example.com "Example"\n';
    const blocks = splitTopLevelBlocks(md(), source);
    expect(blocks).toEqual([]);
  });
});

describe('slugifyHeading', () => {
  it('lowercases, strips punctuation, and hyphenates spaces', () => {
    const seen = new Set();
    expect(slugifyHeading('Hello, World!', seen)).toBe('hello-world');
  });

  it('de-duplicates repeated headings with -1, -2, ...', () => {
    const seen = new Set();
    expect(slugifyHeading('Usage', seen)).toBe('usage');
    expect(slugifyHeading('Usage', seen)).toBe('usage-1');
    expect(slugifyHeading('Usage', seen)).toBe('usage-2');
  });

  it('falls back to "section" for a heading with no word characters', () => {
    const seen = new Set();
    expect(slugifyHeading('!!!', seen)).toBe('section');
  });

  it('is Unicode-aware: CJK, Cyrillic, and accented headings produce a real slug instead of falling back to "section"', () => {
    // Plain `\w` is ASCII-only, so a naive regex strips every character of
    // these headings and every one collapses to the same generic
    // "section"/"section-1"/... fallback, making Outline navigation
    // useless for non-Latin documents.
    expect(slugifyHeading('概述', new Set())).toBe('概述');
    expect(slugifyHeading('Обзор проекта', new Set())).toBe('обзор-проекта');
    expect(slugifyHeading('Café Menu', new Set())).toBe('café-menu');
  });

  it('de-duplicates non-ASCII headings the same way as ASCII ones', () => {
    const seen = new Set();
    expect(slugifyHeading('概述', seen)).toBe('概述');
    expect(slugifyHeading('概述', seen)).toBe('概述-1');
  });
});

describe('fileIdSlug', () => {
  it('produces distinct, DOM-id-safe slugs for distinct file paths', () => {
    expect(fileIdSlug('docs/guide.md')).toBe('docs-guide-md');
    expect(fileIdSlug('docs/setup.md')).toBe('docs-setup-md');
    expect(fileIdSlug('docs/guide.md')).not.toBe(fileIdSlug('docs/setup.md'));
  });

  it('falls back to "doc" for empty/falsy input', () => {
    expect(fileIdSlug('')).toBe('doc');
    expect(fileIdSlug(null)).toBe('doc');
  });

  it('is Unicode-aware, matching slugifyHeading', () => {
    expect(fileIdSlug('docs/概述.md')).toBe('docs-概述-md');
  });
});

describe('buildOutline', () => {
  it('lists only heading blocks, with slugs de-duplicated in document order', () => {
    const source = '# Guide\n\ntext\n\n## Usage\n\nmore text\n\n## Usage\n';
    const blocks = splitTopLevelBlocks(md(), source);
    const outline = buildOutline(blocks);
    expect(outline).toEqual([
      { level: 1, text: 'Guide', slug: 'guide', startLine: 1, blockIndex: 0 },
      { level: 2, text: 'Usage', slug: 'usage', startLine: 5, blockIndex: 2 },
      { level: 2, text: 'Usage', slug: 'usage-1', startLine: 9, blockIndex: 4 }
    ]);
  });

  it('returns an empty array for a document with no headings', () => {
    const blocks = splitTopLevelBlocks(md(), 'just a paragraph\n');
    expect(buildOutline(blocks)).toEqual([]);
  });
});

describe('computeDiffPositions', () => {
  // header=1, ' context1'=2, '-old'=3, '+new'=4, ' context2'=5
  const PATCH = '@@ -5,3 +5,3 @@\n context1\n-old\n+new\n context2\n';

  it('assigns positions to context (both sides), removed (LEFT), and added (RIGHT) lines', () => {
    const positions = computeDiffPositions(PATCH);
    expect(positions.get('RIGHT:5')).toBe(2);
    expect(positions.get('LEFT:5')).toBe(2);
    expect(positions.get('LEFT:6')).toBe(3);
    expect(positions.get('RIGHT:6')).toBe(4);
    expect(positions.get('RIGHT:7')).toBe(5);
    expect(positions.get('LEFT:7')).toBe(5);
  });

  it('returns an empty map for a null/empty patch', () => {
    expect(computeDiffPositions(null).size).toBe(0);
    expect(computeDiffPositions('').size).toBe(0);
  });

  it('accepts an injected HunkParser (for isolation from the real module)', () => {
    const fakeHunkParser = {
      parseDiffIntoBlocks: () => [{ oldStart: 1, newStart: 1, lines: [' a', '+b'] }]
    };
    const positions = computeDiffPositions('anything', fakeHunkParser);
    // header=1, ' a'=2, '+b'=3
    expect(positions.get('RIGHT:1')).toBe(2);
    expect(positions.get('LEFT:1')).toBe(2);
    expect(positions.get('RIGHT:2')).toBe(3);
  });
});

describe('resolveCommentTarget', () => {
  const PATCH = '@@ -5,3 +5,3 @@\n context1\n-old\n+new\n context2\n';

  it('sets diff_position when both endpoints of a single-line range are in the diff', () => {
    const target = resolveCommentTarget({ patch: PATCH, startLine: 6, endLine: 6 });
    expect(target).toEqual({ side: 'RIGHT', line_start: 6, line_end: 6, diff_position: 4, inDiff: true });
  });

  it('defaults endLine to startLine when omitted', () => {
    const target = resolveCommentTarget({ patch: PATCH, startLine: 6 });
    expect(target.line_end).toBe(6);
    expect(target.diff_position).toBe(4);
  });

  it('uses the END line position for a multi-line in-diff range', () => {
    const target = resolveCommentTarget({ patch: PATCH, startLine: 5, endLine: 6 });
    expect(target).toMatchObject({ diff_position: 4, inDiff: true });
  });

  it('leaves diff_position null (honest fallback) when a line is outside every hunk', () => {
    const target = resolveCommentTarget({ patch: PATCH, startLine: 100, endLine: 100 });
    expect(target).toEqual({ side: 'RIGHT', line_start: 100, line_end: 100, diff_position: null, inDiff: false });
  });

  it('leaves diff_position null when only ONE endpoint of a range is in the diff', () => {
    // line 5 is in the diff (context1, RIGHT position 2), line 200 is not.
    const target = resolveCommentTarget({ patch: PATCH, startLine: 5, endLine: 200 });
    expect(target.diff_position).toBeNull();
    expect(target.inDiff).toBe(false);
  });

  it('leaves diff_position null when there is no patch at all', () => {
    const target = resolveCommentTarget({ patch: null, startLine: 6, endLine: 6 });
    expect(target.diff_position).toBeNull();
    expect(target.inDiff).toBe(false);
  });
});

describe('resolveInternalLink', () => {
  const changed = new Set(['docs/guide.md', 'docs/setup.md']);

  it('resolves a same-directory relative link to another changed markdown file', () => {
    expect(resolveInternalLink('./setup.md', 'docs/guide.md', changed))
      .toEqual({ targetPath: 'docs/setup.md', fragment: null, samePage: false });
  });

  it('resolves a bare relative filename (no leading ./)', () => {
    expect(resolveInternalLink('setup.md', 'docs/guide.md', changed))
      .toEqual({ targetPath: 'docs/setup.md', fragment: null, samePage: false });
  });

  it('resolves a parent-directory relative link', () => {
    const set = new Set(['README.md']);
    expect(resolveInternalLink('../README.md', 'docs/guide.md', set))
      .toEqual({ targetPath: 'README.md', fragment: null, samePage: false });
  });

  it('carries a #fragment through to the resolved target', () => {
    expect(resolveInternalLink('./setup.md#install', 'docs/guide.md', changed))
      .toEqual({ targetPath: 'docs/setup.md', fragment: 'install', samePage: false });
  });

  it('treats a bare #fragment as same-page navigation', () => {
    expect(resolveInternalLink('#usage', 'docs/guide.md', changed))
      .toEqual({ targetPath: 'docs/guide.md', fragment: 'usage', samePage: true });
  });

  it('returns null for a relative link to a file NOT in the changed set', () => {
    expect(resolveInternalLink('./not-in-diff.md', 'docs/guide.md', changed)).toBeNull();
  });

  it('returns null for external http(s) links', () => {
    expect(resolveInternalLink('https://github.com', 'docs/guide.md', changed)).toBeNull();
    expect(resolveInternalLink('http://example.com/x.md', 'docs/guide.md', changed)).toBeNull();
  });

  it('returns null for mailto: and other scheme links', () => {
    expect(resolveInternalLink('mailto:a@b.com', 'docs/guide.md', changed)).toBeNull();
  });

  it('returns null for protocol-relative and root-relative links', () => {
    expect(resolveInternalLink('//example.com/x.md', 'docs/guide.md', changed)).toBeNull();
    expect(resolveInternalLink('/docs/setup.md', 'docs/guide.md', changed)).toBeNull();
  });

  it('returns null for a relative link that would escape the repository root', () => {
    const set = new Set(['setup.md']);
    expect(resolveInternalLink('../../setup.md', 'guide.md', set)).toBeNull();
  });

  it('returns null for empty/falsy hrefs', () => {
    expect(resolveInternalLink('', 'docs/guide.md', changed)).toBeNull();
    expect(resolveInternalLink(null, 'docs/guide.md', changed)).toBeNull();
  });

  it('accepts an Array for changedMarkdownPaths as well as a Set', () => {
    expect(resolveInternalLink('./setup.md', 'docs/guide.md', ['docs/guide.md', 'docs/setup.md']))
      .toMatchObject({ targetPath: 'docs/setup.md' });
  });
});

/**
 * Nested (hierarchical) comment targets. These are what let a reviewer
 * select an individual list item, a table row, or one exact cell instead of
 * only the whole block. The descriptors produced here are what get
 * persisted, so their identity rules — especially `ordinal` — are the
 * contract that makes two comments on two cells of ONE source line
 * distinguishable after a reload.
 */
describe('buildNestedTargets', () => {
  const descriptors = (source, startLine = 1) =>
    buildNestedTargets(md(), source, startLine).targets.map((t) => t.descriptor);

  it('returns no targets for a block with no list or table', () => {
    expect(descriptors('Just a paragraph.\n')).toEqual([]);
    expect(descriptors('# A heading\n')).toEqual([]);
    expect(descriptors('```js\nconst x = 1;\n```\n')).toEqual([]);
  });

  it('derives a target per list item, distinguishing nested items from top-level ones', () => {
    // 10: - Alpha
    // 11:   - Nested one
    // 12:   - Nested two
    // 13: - Beta
    const source = '- Alpha\n  - Nested one\n  - Nested two\n- Beta\n';
    expect(descriptors(source, 10)).toEqual([
      { v: 1, kind: 'list-item', startLine: 10, endLine: 12, ordinal: 0 },
      { v: 1, kind: 'nested-list-item', startLine: 11, endLine: 11, ordinal: 0 },
      { v: 1, kind: 'nested-list-item', startLine: 12, endLine: 12, ordinal: 0 },
      { v: 1, kind: 'list-item', startLine: 13, endLine: 13, ordinal: 0 }
    ]);
  });

  it('treats a third-level item as nested too (depth is "not the outer list", not "exactly two")', () => {
    const kinds = descriptors('- a\n  - b\n    - c\n').map((d) => d.kind);
    expect(kinds).toEqual(['list-item', 'nested-list-item', 'nested-list-item']);
  });

  it('handles ordered lists the same way as bullet lists', () => {
    expect(descriptors('1. one\n2. two\n', 4)).toEqual([
      { v: 1, kind: 'list-item', startLine: 4, endLine: 4, ordinal: 0 },
      { v: 1, kind: 'list-item', startLine: 5, endLine: 5, ordinal: 0 }
    ]);
  });

  it('gives every cell of a table row the row\'s source line, disambiguated by a column ordinal', () => {
    // 7: | A | B |
    // 8: | --- | --- |
    // 9: | a1 | b1 |
    const source = '| A | B |\n| --- | --- |\n| a1 | b1 |\n';
    expect(descriptors(source, 7)).toEqual([
      { v: 1, kind: 'table-row', startLine: 7, endLine: 7, ordinal: 0 },
      { v: 1, kind: 'table-header-cell', startLine: 7, endLine: 7, ordinal: 0 },
      { v: 1, kind: 'table-header-cell', startLine: 7, endLine: 7, ordinal: 1 },
      { v: 1, kind: 'table-row', startLine: 9, endLine: 9, ordinal: 0 },
      { v: 1, kind: 'table-cell', startLine: 9, endLine: 9, ordinal: 0 },
      { v: 1, kind: 'table-cell', startLine: 9, endLine: 9, ordinal: 1 }
    ]);
  });

  it('produces a unique key for every target, including ones sharing a kind and a line', () => {
    const source = '| A | B | C |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |\n';
    const keys = descriptors(source, 1).map(renderedAnchorKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('disambiguates a list item and its nested child that start on the SAME line', () => {
    // `- - a` renders an item whose only content is another list, both
    // starting on line 1: line numbers alone cannot tell them apart.
    const found = descriptors('- - a\n');
    expect(found).toEqual([
      { v: 1, kind: 'list-item', startLine: 1, endLine: 1, ordinal: 0 },
      { v: 1, kind: 'nested-list-item', startLine: 1, endLine: 1, ordinal: 0 }
    ]);
    expect(new Set(found.map(renderedAnchorKey)).size).toBe(2);
  });

  it('trims the trailing blank line markdown-it includes in a loose list item\'s map', () => {
    // Item "one" spans line 1 only; markdown-it's map runs to the blank
    // line 2 that makes the list loose.
    const [first] = descriptors('- one\n\n- two\n');
    expect(first).toMatchObject({ startLine: 1, endLine: 1 });
  });

  it('maps targets inside a table cell and inside a nested block correctly', () => {
    const found = descriptors('| A |\n| --- |\n| <br> |\n', 1);
    expect(found.map((d) => d.kind)).toEqual([
      'table-row', 'table-header-cell', 'table-row', 'table-cell'
    ]);
  });

  it('returns null (fail closed) when no usable markdown-it instance is supplied', () => {
    expect(buildNestedTargets(null, '- a\n', 1)).toBeNull();
    expect(buildNestedTargets({}, '- a\n', 1)).toBeNull();
  });

  it('tolerates empty/missing source without throwing', () => {
    expect(buildNestedTargets(md(), '', 1).targets).toEqual([]);
    expect(buildNestedTargets(md(), null, 1).targets).toEqual([]);
  });

  it('defaults a nonsensical block start line to 1 rather than emitting bogus coordinates', () => {
    expect(descriptors('- a\n', 0)).toEqual([
      { v: 1, kind: 'list-item', startLine: 1, endLine: 1, ordinal: 0 }
    ]);
  });

  it('does NOT create targets from raw HTML list/table markup (markdown-it emits it opaquely)', () => {
    // The DOM will contain a <ul><li>, but no token describes it — so no
    // descriptor exists for it, and the consumer's structural pairing will
    // additionally refuse to map anything in this block.
    const html = '<ul><li>injected</li></ul>\n';
    expect(descriptors(html)).toEqual([]);
  });
});

describe('normalizeRenderedAnchor', () => {
  const VALID = { v: 1, kind: 'table-cell', startLine: 4, endLine: 4, ordinal: 1 };

  it('accepts a well-formed descriptor object and returns a fresh canonical copy', () => {
    const out = normalizeRenderedAnchor(VALID);
    expect(out).toEqual(VALID);
    expect(out).not.toBe(VALID);
  });

  it('accepts the JSON string form (as persisted in the database)', () => {
    expect(normalizeRenderedAnchor(JSON.stringify(VALID))).toEqual(VALID);
  });

  it('accepts every supported kind', () => {
    for (const kind of RenderedMarkdown.RENDERED_TARGET_KINDS) {
      expect(normalizeRenderedAnchor({ ...VALID, kind })).toMatchObject({ kind });
    }
  });

  it('rejects an unknown version — an unreadable anchor must fall back, not be guessed at', () => {
    expect(normalizeRenderedAnchor({ ...VALID, v: 2 })).toBeNull();
    expect(normalizeRenderedAnchor({ ...VALID, v: '1' })).toBeNull();
  });

  it('rejects an unknown kind', () => {
    expect(normalizeRenderedAnchor({ ...VALID, kind: 'table-column' })).toBeNull();
    expect(normalizeRenderedAnchor({ ...VALID, kind: 42 })).toBeNull();
  });

  it('rejects any extra key (no silent passthrough of unvetted fields)', () => {
    expect(normalizeRenderedAnchor({ ...VALID, file: '../../etc/passwd' })).toBeNull();
    expect(normalizeRenderedAnchor({ ...VALID, extra: 1 })).toBeNull();
  });

  it('rejects out-of-range, non-integer or inverted line numbers', () => {
    expect(normalizeRenderedAnchor({ ...VALID, startLine: 0 })).toBeNull();
    expect(normalizeRenderedAnchor({ ...VALID, startLine: -3, endLine: -1 })).toBeNull();
    expect(normalizeRenderedAnchor({ ...VALID, startLine: 1.5, endLine: 2 })).toBeNull();
    expect(normalizeRenderedAnchor({ ...VALID, startLine: 9, endLine: 4 })).toBeNull();
    expect(normalizeRenderedAnchor({ ...VALID, startLine: 1, endLine: 1e12 })).toBeNull();
    expect(normalizeRenderedAnchor({ ...VALID, startLine: '4' })).toBeNull();
  });

  it('rejects an out-of-range or non-integer ordinal', () => {
    expect(normalizeRenderedAnchor({ ...VALID, ordinal: -1 })).toBeNull();
    expect(normalizeRenderedAnchor({ ...VALID, ordinal: 1.5 })).toBeNull();
    expect(normalizeRenderedAnchor({ ...VALID, ordinal: RENDERED_ANCHOR_MAX_ORDINAL + 1 })).toBeNull();
    expect(normalizeRenderedAnchor({ ...VALID, ordinal: RENDERED_ANCHOR_MAX_ORDINAL })).toBeTruthy();
  });

  it('rejects an oversized string before attempting to parse it', () => {
    const huge = `${JSON.stringify(VALID).slice(0, -1)},"pad":"${'x'.repeat(RENDERED_ANCHOR_MAX_JSON_CHARS)}"}`;
    expect(huge.length).toBeGreaterThan(RENDERED_ANCHOR_MAX_JSON_CHARS);
    expect(normalizeRenderedAnchor(huge)).toBeNull();
  });

  it('rejects malformed JSON, arrays, primitives and null', () => {
    expect(normalizeRenderedAnchor('{not json')).toBeNull();
    expect(normalizeRenderedAnchor('[1,2,3]')).toBeNull();
    expect(normalizeRenderedAnchor([VALID])).toBeNull();
    expect(normalizeRenderedAnchor(7)).toBeNull();
    expect(normalizeRenderedAnchor(null)).toBeNull();
    expect(normalizeRenderedAnchor(undefined)).toBeNull();
    expect(normalizeRenderedAnchor('')).toBeNull();
  });
});

describe('renderedAnchorKey / describeRenderedTarget', () => {
  it('keys on all four identity fields, so a changed end line is a MISS not a near-match', () => {
    const a = { v: 1, kind: 'list-item', startLine: 3, endLine: 4, ordinal: 0 };
    const b = { v: 1, kind: 'list-item', startLine: 3, endLine: 5, ordinal: 0 };
    expect(renderedAnchorKey(a)).not.toBe(renderedAnchorKey(b));
  });

  it('describes each kind with its real source line range', () => {
    expect(describeRenderedTarget({ v: 1, kind: 'list-item', startLine: 3, endLine: 3, ordinal: 0 }))
      .toBe('List item, line 3');
    expect(describeRenderedTarget({ v: 1, kind: 'list-item', startLine: 3, endLine: 5, ordinal: 0 }))
      .toBe('List item, lines 3–5');
    expect(describeRenderedTarget({ v: 1, kind: 'nested-list-item', startLine: 4, endLine: 4, ordinal: 0 }))
      .toBe('Nested list item, line 4');
    expect(describeRenderedTarget({ v: 1, kind: 'table-row', startLine: 9, endLine: 9, ordinal: 0 }))
      .toBe('Table row, line 9');
  });

  it('names the column for cells, since every cell of a row shares one line', () => {
    expect(describeRenderedTarget({ v: 1, kind: 'table-cell', startLine: 9, endLine: 9, ordinal: 1 }))
      .toBe('Table cell, line 9, column 2');
    expect(describeRenderedTarget({ v: 1, kind: 'table-header-cell', startLine: 7, endLine: 7, ordinal: 0 }))
      .toBe('Table header cell, line 7, column 1');
  });

  it('distinguishes same-line list items by position', () => {
    expect(describeRenderedTarget({ v: 1, kind: 'nested-list-item', startLine: 1, endLine: 1, ordinal: 1 }))
      .toBe('Nested list item 2, line 1');
  });
});
