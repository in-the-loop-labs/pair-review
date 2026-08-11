// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createPierreEnv } = require('../utils/fake-code-view');

// Coverage for the batch annotation path (addAnnotations): applying K
// annotations to a file must publish the item EXACTLY ONCE (one version-bumped
// updateItem), not K times. Loop callers (loadUserComments, SuggestionManager)
// rely on this to avoid K full re-renders per file.

describe('PierreBridge batch annotations', () => {
  let env;
  let bridge;
  let codeView;

  beforeEach(() => {
    env = createPierreEnv({ worker: false });
    bridge = new env.PierreBridge({});
    const root = env.document.createElement('div');
    bridge.renderAll(root, [
      { id: 'a.js', type: 'diff', fileName: 'a.js', patch: '@@ -1 +1 @@\n-old\n+new\n' },
    ]);
    codeView = env.codeViews[0];
  });

  afterEach(() => {
    env.cleanup();
  });

  function makeAnnotations(n) {
    return Array.from({ length: n }, (_, i) => ({
      lineNumber: i + 1,
      side: 'RIGHT',
      type: 'comment',
      id: `comment-${i + 1}`,
      data: { id: i + 1 },
    }));
  }

  it('applies a batch of N annotations with exactly one publish', () => {
    const before = codeView.calls.updateItem.length;
    bridge.addAnnotations('a.js', makeAnnotations(5));

    expect(bridge.files.get('a.js').annotations).toHaveLength(5);
    expect(codeView.calls.updateItem.length).toBe(before + 1);
    // The single published item carries all five annotations.
    expect(codeView.getItem('a.js').annotations).toHaveLength(5);
  });

  it('bumps the version once for the whole batch', () => {
    const before = codeView.getItem('a.js').version;
    bridge.addAnnotations('a.js', makeAnnotations(3));
    expect(codeView.getItem('a.js').version).toBe(before + 1);
  });

  it('applies the same shape/ids a per-item loop would produce', () => {
    bridge.addAnnotations('a.js', makeAnnotations(3));

    const annotations = bridge.files.get('a.js').annotations;
    expect(annotations.map(a => a.metadata.id)).toEqual([
      'comment-1', 'comment-2', 'comment-3',
    ]);
    expect(annotations[0]).toMatchObject({
      side: 'additions',
      lineNumber: 1,
      metadata: { type: 'comment', id: 'comment-1' },
    });
  });

  it('single addAnnotation publishes exactly once', () => {
    const before = codeView.calls.updateItem.length;
    bridge.addAnnotation('a.js', {
      lineNumber: 2, side: 'RIGHT', type: 'comment', id: 'c-1', data: {},
    });

    expect(bridge.files.get('a.js').annotations).toHaveLength(1);
    expect(codeView.calls.updateItem.length).toBe(before + 1);
  });

  it('N single addAnnotation calls publish N times (demonstrates the batch win)', () => {
    const before = codeView.calls.updateItem.length;
    for (const ann of makeAnnotations(4)) bridge.addAnnotation('a.js', ann);
    expect(codeView.calls.updateItem.length).toBe(before + 4);
  });

  it('is a no-op (no crash, no publish) for a missing / not-yet-rendered file', () => {
    const before = codeView.calls.updateItem.length;
    expect(() => bridge.addAnnotations('missing.js', makeAnnotations(3))).not.toThrow();
    expect(codeView.calls.updateItem.length).toBe(before);
  });

  it('does not publish for an empty or non-array batch', () => {
    const before = codeView.calls.updateItem.length;
    bridge.addAnnotations('a.js', []);
    bridge.addAnnotations('a.js', undefined);
    expect(bridge.files.get('a.js').annotations).toHaveLength(0);
    expect(codeView.calls.updateItem.length).toBe(before);
  });

  it('generates fallback ids when a batch item omits one', () => {
    bridge.addAnnotations('a.js', [
      { lineNumber: 9, side: 'LEFT', type: 'suggestion', data: {} },
    ]);
    const { id, type } = bridge.files.get('a.js').annotations[0].metadata;
    expect(type).toBe('suggestion');
    expect(id).toMatch(/^suggestion-9-LEFT-\d+$/);
  });

  it('drops a stale publish to an id CodeView no longer holds', () => {
    // A newer setItems replaced the list (e.g. a re-render): a late annotation
    // add must not resurrect the wiped record.
    codeView.setItems([]);
    const before = codeView.calls.updateItem.length;
    bridge.addAnnotation('a.js', {
      lineNumber: 1, side: 'RIGHT', type: 'comment', id: 'late', data: {},
    });
    // updateItem is attempted but returns false (id gone); nothing is stored.
    expect(codeView.getItem('a.js')).toBeUndefined();
    // The publish guard bails before calling updateItem when getItem is empty.
    expect(codeView.calls.updateItem.length).toBe(before);
  });
});
