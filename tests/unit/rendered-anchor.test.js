// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

/**
 * API-boundary validation for the optional `rendered_anchor` descriptor a
 * comment may carry. Everything here is about failing CLOSED: the value
 * arrives over HTTP, is persisted, and is later formatted back into the UI,
 * so anything that isn't exactly a known-version, known-kind, in-range
 * descriptor must be rejected rather than stored.
 */

import { describe, it, expect } from 'vitest';

const { validateRenderedAnchor } = require('../../src/utils/rendered-anchor.js');
const {
  RENDERED_ANCHOR_MAX_JSON_CHARS,
  RENDERED_TARGET_KINDS
} = require('../../public/js/modules/rendered-markdown.js');

const VALID = { v: 1, kind: 'table-cell', startLine: 9, endLine: 9, ordinal: 1 };
const LINES = { lineStart: 9, lineEnd: 9 };

describe('validateRenderedAnchor', () => {
  it('treats absent/null/empty as "no nested target" — the case for every non-Rendered comment', () => {
    expect(validateRenderedAnchor(undefined, LINES)).toEqual({ ok: true, value: null });
    expect(validateRenderedAnchor(null, LINES)).toEqual({ ok: true, value: null });
    expect(validateRenderedAnchor('', LINES)).toEqual({ ok: true, value: null });
  });

  it('accepts a valid descriptor and returns the canonical JSON string to persist', () => {
    const result = validateRenderedAnchor(VALID, LINES);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.value)).toEqual(VALID);
  });

  it('accepts every supported kind', () => {
    for (const kind of RENDERED_TARGET_KINDS) {
      expect(validateRenderedAnchor({ ...VALID, kind }, LINES).ok).toBe(true);
    }
  });

  it('drops unknown keys by rejecting the whole descriptor (no partial acceptance)', () => {
    const result = validateRenderedAnchor({ ...VALID, file: '../../etc/passwd' }, LINES);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/supported/);
  });

  it('rejects an unknown version', () => {
    expect(validateRenderedAnchor({ ...VALID, v: 2 }, LINES).ok).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(validateRenderedAnchor({ ...VALID, kind: 'table-column' }, LINES).ok).toBe(false);
  });

  it('rejects bad line ranges and ordinals', () => {
    expect(validateRenderedAnchor({ ...VALID, startLine: 0, endLine: 0 }, { lineStart: 0 }).ok).toBe(false);
    expect(validateRenderedAnchor({ ...VALID, startLine: 12, endLine: 9 }, LINES).ok).toBe(false);
    expect(validateRenderedAnchor({ ...VALID, ordinal: -1 }, LINES).ok).toBe(false);
    expect(validateRenderedAnchor({ ...VALID, ordinal: 1.5 }, LINES).ok).toBe(false);
  });

  it('rejects an oversized payload before parsing it', () => {
    const huge = JSON.stringify({ ...VALID, pad: 'x'.repeat(RENDERED_ANCHOR_MAX_JSON_CHARS) });
    const result = validateRenderedAnchor(huge, LINES);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too large/);
  });

  it('rejects non-object payloads', () => {
    expect(validateRenderedAnchor('{not json', LINES).ok).toBe(false);
    expect(validateRenderedAnchor([VALID], LINES).ok).toBe(false);
    expect(validateRenderedAnchor(7, LINES).ok).toBe(false);
    expect(validateRenderedAnchor(true, LINES).ok).toBe(false);
  });

  it('rejects a descriptor that points outside the comment\'s own line range', () => {
    const result = validateRenderedAnchor({ ...VALID, startLine: 40, endLine: 40 }, LINES);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/within the comment line range/);
  });

  it('accepts a descriptor contained within a multi-line comment range', () => {
    expect(validateRenderedAnchor(
      { v: 1, kind: 'list-item', startLine: 4, endLine: 5, ordinal: 0 },
      { lineStart: 3, lineEnd: 6 }
    ).ok).toBe(true);
  });

  it('accepts the JSON string form (round-tripping a stored value)', () => {
    const result = validateRenderedAnchor(JSON.stringify(VALID), LINES);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.value)).toEqual(VALID);
  });

  it('still validates shape when no comment line range is supplied', () => {
    expect(validateRenderedAnchor(VALID, {}).ok).toBe(true);
    expect(validateRenderedAnchor({ ...VALID, kind: 'nope' }, {}).ok).toBe(false);
  });
});
