// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * The range a comment is posted for, from a drag on the line numbers to
 * Save: the selection the drag leaves, the gutter's + (PierreGutter, as the
 * bridge builds it for the viewer's gutter slot), the page's handler
 * (PRManager._bridgeInteractionOptions onCommentClick -> showCommentForm),
 * the form and its POST. A drag across hidden lines must never post them:
 * the selection is cut back at the hidden lines (PierreBridge), and the
 * form, its id and the posted `line_start` / `line_end` are the cut range.
 *
 * The page manager with the production bridge over the recording stand-in
 * of the viewer (tests/utils/page-bridge.js). The drag is sent as the
 * viewer sends it (selectionGesture of tests/utils/pierre-bridge-harness.js).
 * Local mode posts through the same handler (public/js/local.js overrides
 * none of the code on this path); its reviews are reviews of this API.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const { makePageWithBridge, restorePageBridges } = require('../utils/page-bridge.js');
const { changedFileFixture, selectionGesture } = require('../utils/pierre-bridge-harness.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

// Patch only: new lines 117-123 and 247-253, a separator between them.
const A = changedFileFixture('src/a.js');

let page;
let fetchStub;
beforeEach(() => {
  page = makePageWithBridge(vendor, {
    files: [{ name: A.name, patch: A.patch }],
    overrides: { currentPR: { id: 7, head_sha: 'abc' }, _clientId: 'client-1' },
  });
  fetchStub = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 1 }) }));
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  restorePageBridges();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const viewer = () => page.bridge.codeView;

/** A pointer event as the gutter's buttons read it. */
function pointer(type) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  event.pointerId = 1;
  return event;
}

/**
 * The gutter's + clicked where the viewer shows it: the viewer asks the
 * bridge for the gutter element with its hovered-line getter, which answers
 * the selection's last row while a selection is held (H130).
 */
function clickPlus(lineNumber, side = 'additions') {
  const gutter = viewer().options.renderGutterUtility(() => ({ lineNumber, side }), { item: viewer().getItem(A.name) });
  const plus = gutter.querySelector('.pierre-comment-btn');
  plus.dispatchEvent(pointer('pointerdown'));
  document.dispatchEvent(pointer('pointerup'));
  plus.click();
}

/** The one comment form of the file, typed into and saved; the body of its POST. */
async function saveTheForm() {
  const forms = page.bridge.getAnnotations(A.name, 'comment-form');
  expect(forms).toHaveLength(1);
  const form = page.bridge.getAnnotationElement(A.name, forms[0].metadata.id, { create: true });
  document.body.appendChild(form);
  const textarea = form.querySelector('textarea');
  textarea.value = 'a comment';
  textarea.dispatchEvent(new window.Event('input'));
  form.querySelector('.save-comment-btn').click();
  await vi.waitFor(() => expect(posted()).toHaveLength(1));
  return { id: forms[0].metadata.id, body: posted()[0] };
}

function posted() {
  return fetchStub.mock.calls
    .filter(([url, init]) => String(url).endsWith('/comments') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body));
}

describe('a drag across the hidden lines, then +, then Save', () => {
  it('down: the form and the comment are for the lines above the separator', async () => {
    selectionGesture(viewer(), A.name, [121, 122, 123, 247, 250]);
    clickPlus(123);
    const { id, body } = await saveTheForm();
    expect(id).toBe('form-src/a.js-121-123-RIGHT');
    expect(body).toMatchObject({ file: A.name, line_start: 121, line_end: 123, side: 'RIGHT' });
    expect(body.diff_position).toBe(page.bridge.getDiffPosition(A.name, 121, 'RIGHT'));
  });

  it('up: the form and the comment are for the lines below the separator', async () => {
    selectionGesture(viewer(), A.name, [250, 248, 247, 123, 121]);
    clickPlus(250);
    const { id, body } = await saveTheForm();
    expect(id).toBe('form-src/a.js-247-250-RIGHT');
    expect(body).toMatchObject({ line_start: 247, line_end: 250 });
  });

  it('from the line next to the separator to the line on its other side: a one-line comment on the first', async () => {
    selectionGesture(viewer(), A.name, [123, 247]);
    clickPlus(123);
    const { id, body } = await saveTheForm();
    expect(id).toBe('form-src/a.js-123-123-RIGHT');
    expect(body).toMatchObject({ line_start: 123, line_end: 123 });
    expect(body.diff_position).toBe(page.bridge.getDiffPosition(A.name, 123, 'RIGHT'));
    expect(body.diff_position).not.toBeNull();
  });

  it('a drag inside one hunk posts the range as dragged', async () => {
    selectionGesture(viewer(), A.name, [118, 119, 121]);
    clickPlus(121);
    const { id, body } = await saveTheForm();
    expect(id).toBe('form-src/a.js-118-121-RIGHT');
    expect(body).toMatchObject({ line_start: 118, line_end: 121 });
  });
});
