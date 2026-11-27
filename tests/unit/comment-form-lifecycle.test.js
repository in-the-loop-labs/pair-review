// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * The line comment form of the diff pane, from the gutter's + to Save: the
 * page's own handlers (PRManager._bridgeInteractionOptions) wired to the
 * production bridge by PRManager._createBridge, over the recording stand-in
 * of the viewer (tests/utils/page-bridge.js). The forms are the ones the
 * bridge builds for its annotations (PierreAnnotations.renderForm). Nothing
 * is drawn: a form that is not attached to the document is the form of a
 * file the viewer has not mounted, or has unmounted after the reader
 * scrolled it away, and comes back attached when the file is mounted again.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const { makePageWithBridge, restorePageBridges } = require('../utils/page-bridge.js');
const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');

let vendor;
beforeAll(async () => {
  vendor = await import('@pierre/diffs');
});

const FILE = 'src/a.js';

/** A patch whose one hunk shows lines 1 to 20 of FILE, line 12 changed. */
function patch() {
  const lines = ['@@ -1,20 +1,20 @@'];
  for (let n = 1; n <= 20; n++) {
    if (n === 12) lines.push('-old 12', '+new 12');
    else lines.push(` line ${n}`);
  }
  return [`diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`, ...lines, ''].join('\n');
}

/** A promise and the functions that settle it. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let a chain of microtasks run (an `await` of something already settled). */
const settle = () => new Promise((resolve) => setImmediate(resolve));

let page;
beforeEach(() => {
  page = makePageWithBridge(vendor, {
    files: [{ name: FILE, patch: patch() }],
    overrides: { currentPR: { id: 7, head_sha: 'abc' }, _clientId: 'client-1' },
  });
});

afterEach(() => {
  restorePageBridges();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** The gutter's + on one line, or on a selected range, as the viewer reports it. */
function clickPlus(start, end = start, side = 'RIGHT') {
  page.bridge.options.onCommentClick(FILE, end, side, { start, end, side, isRange: end !== start });
}

/** The comment forms of FILE, as annotations. */
const formAnnotations = () => page.bridge.getAnnotations(FILE, 'comment-form');

/** The element the viewer is given for a form annotation (built as its render callback builds it). */
const formElementOf = (annotation) => page.bridge.getAnnotationElement(FILE, annotation.metadata.id, { create: true });

/** Type into a form as the reader does. */
function type(form, text) {
  const textarea = form.querySelector('textarea');
  textarea.value = text;
  textarea.dispatchEvent(new window.Event('input'));
  return textarea;
}

/** The bodies of the comment POSTs a fetch stub received. */
function postedComments(fetchStub) {
  return fetchStub.mock.calls
    .filter(([url, init]) => String(url).endsWith('/comments') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body));
}

describe('Save of a line comment form', () => {
  it('a second Save while the first POST is in flight posts nothing more', async () => {
    // A save that answers late, from a fetch that is not an async function.
    const response = deferred();
    const fetchStub = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetchStub);

    clickPlus(3);
    const form = formElementOf(formAnnotations()[0]);
    document.body.appendChild(form);
    type(form, 'one comment');
    const save = form.querySelector('.save-comment-btn');

    save.click();
    await settle();
    // Double-click, or Cmd/Ctrl+Enter pressed twice: the POST has not answered.
    save.click();
    await settle();
    expect(postedComments(fetchStub)).toHaveLength(1);

    response.resolve({ ok: true, json: async () => ({ commentId: 41 }) });
    await vi.waitFor(() => expect(formAnnotations()).toHaveLength(0));
    expect(postedComments(fetchStub)).toHaveLength(1);
  });

  it('a failed save of a form whose file was scrolled away leaves Save usable when the form comes back', async () => {
    const response = deferred();
    const fetchStub = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetchStub);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    clickPlus(3);
    const form = formElementOf(formAnnotations()[0]);
    document.body.appendChild(form);
    type(form, 'kept text');
    const save = form.querySelector('.save-comment-btn');
    save.click();
    await settle();
    expect(save.dataset.saving).toBe('true');

    // The reader scrolls the file away: the viewer unmounts it, and the
    // bridge keeps the form (and what was typed) for its return.
    form.remove();
    response.resolve({ ok: false, status: 500, json: async () => ({}) });
    await vi.waitFor(() => expect(save.dataset.saving).toBe('false'));

    // The file is mounted again with its form.
    document.body.appendChild(formElementOf(formAnnotations()[0]));
    expect(formElementOf(formAnnotations()[0])).toBe(form);
    expect(save.disabled).toBe(false);
    expect(form.querySelector('textarea').value).toBe('kept text');

    const second = deferred();
    fetchStub.mockImplementation(() => second.promise);
    save.click();
    await settle();
    expect(postedComments(fetchStub)).toHaveLength(2);
    second.resolve({ ok: true, json: async () => ({ commentId: 42 }) });
    await vi.waitFor(() => expect(formAnnotations()).toHaveLength(0));
  });
});

describe('Opening a line comment form', () => {
  it('+ on line 10, then + on the selection 10 to 14: Save of the form under line 14 posts lines 10 to 14', async () => {
    const fetchStub = vi.fn(async () => ({ ok: true, json: async () => ({ commentId: 5 }) }));
    vi.stubGlobal('fetch', fetchStub);

    clickPlus(10);
    clickPlus(10, 14);

    const at14 = formAnnotations().find((annotation) => annotation.lineNumber === 14);
    expect(at14).toBeTruthy();
    const form = formElementOf(at14);
    expect(form.querySelector('.line-range-indicator')?.textContent).toBe('Lines 10-14');
    type(form, 'about the range');
    form.querySelector('.save-comment-btn').click();
    await vi.waitFor(() => expect(postedComments(fetchStub)).toHaveLength(1));

    expect(postedComments(fetchStub)[0]).toMatchObject({ file: FILE, line_start: 10, line_end: 14, side: 'RIGHT', body: 'about the range' });
  });

  it('+ twice on one line leaves one form, with what the reader typed in it', () => {
    clickPlus(10);
    const form = formElementOf(formAnnotations()[0]);
    type(form, 'draft');
    clickPlus(10);

    expect(formAnnotations()).toHaveLength(1);
    expect(formElementOf(formAnnotations()[0])).toBe(form);
    expect(form.querySelector('textarea').value).toBe('draft');
  });

  it('Cancel of the one form on a line removes it and a new + opens an empty form', () => {
    clickPlus(10);
    clickPlus(10);
    const form = formElementOf(formAnnotations()[0]);
    type(form, 'draft');
    form.querySelector('.cancel-comment-btn').click();
    expect(formAnnotations()).toHaveLength(0);

    clickPlus(10);
    expect(formAnnotations()).toHaveLength(1);
    const reopened = formElementOf(formAnnotations()[0]);
    expect(reopened).not.toBe(form);
    expect(reopened.querySelector('textarea').value).toBe('');
  });

  it('forms on two different ranges of a file stay open side by side (as on main for a changed file)', () => {
    clickPlus(3);
    clickPlus(10, 14);
    expect(formAnnotations().map((annotation) => [annotation.lineNumber, annotation.metadata.data.lineStart, annotation.metadata.data.lineEnd]))
      .toEqual([[3, 3, 3], [14, 10, 14]]);
  });
});

describe('Edit of an AI suggestion on a line', () => {
  /** A line suggestion of FILE as the viewer's annotation, with its card built by the page's SuggestionManager. */
  function addSuggestion(id = 99) {
    page.manager.suggestionManager = new SuggestionManager(page.manager);
    page.bridge.addAnnotation(FILE, {
      lineNumber: 12,
      side: 'RIGHT',
      type: 'suggestion',
      id: `suggestion-${id}`,
      data: {
        id, file: FILE, line_start: 12, line_end: 12, side: 'RIGHT', type: 'bug', title: 'A title',
        body: 'Use a constant.', status: 'active', ai_level: 1,
      },
    });
    return id;
  }

  it('Edit twice leaves one edit form, with what the reader typed in it', async () => {
    const id = addSuggestion();
    expect(page.manager.findSuggestionCard(id)).toBeTruthy();

    await page.manager.editAndAdoptSuggestion(id);
    expect(formAnnotations()).toHaveLength(1);
    const form = formElementOf(formAnnotations()[0]);
    type(form, 'edited text');

    await page.manager.editAndAdoptSuggestion(id);
    expect(formAnnotations()).toHaveLength(1);
    expect(formElementOf(formAnnotations()[0])).toBe(form);
    expect(form.querySelector('textarea').value).toBe('edited text');
  });
});
