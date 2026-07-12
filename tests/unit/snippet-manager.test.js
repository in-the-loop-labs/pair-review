// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the shared SnippetManager component
 * (public/js/components/SnippetManager.js). Imports the real class via its
 * CommonJS export and drives it against a routed fetch mock backed by an
 * in-memory store, so re-fetch-after-mutation behaves like the real API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { SnippetManager } = require('../../public/js/components/SnippetManager.js');

/** Minimal fetch Response stand-in with an async json() body. */
function makeResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

/**
 * Install a routed fetch mock backed by `store` ({ list, nextId }). Mutations
 * update the store so the component's re-fetch returns fresh data.
 */
function installFetch(store) {
  global.fetch = vi.fn(async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();

    if (url === '/api/snippets' && method === 'GET') {
      return makeResponse({ snippets: store.list.slice() });
    }
    if (url === '/api/snippets' && method === 'POST') {
      const body = JSON.parse(opts.body).body;
      const snippet = { id: store.nextId++, body };
      store.list.unshift(snippet); // newest first (MRU-ish)
      return makeResponse({ snippet }, { status: 201 });
    }

    const m = url.match(/^\/api\/snippets\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const found = store.list.find(s => s.id === id);
      if (method === 'PUT') {
        if (!found) return makeResponse({ error: 'not found' }, { ok: false, status: 404 });
        found.body = JSON.parse(opts.body).body;
        return makeResponse({ snippet: found });
      }
      if (method === 'DELETE') {
        if (!found) return makeResponse({ error: 'not found' }, { ok: false, status: 404 });
        store.list = store.list.filter(s => s.id !== id);
        return makeResponse({ success: true });
      }
    }
    return makeResponse({ error: 'unexpected' }, { ok: false, status: 500 });
  });
  return global.fetch;
}

function mount() {
  document.body.innerHTML = '<div id="host"></div>';
  return document.getElementById('host');
}

beforeEach(() => {
  // Delete is gated behind a confirmation. Default to "no styled dialog present,
  // native confirm accepts" so happy-path delete tests proceed; individual tests
  // override window.confirm / window.confirmDialog as needed.
  delete window.confirmDialog;
  window.confirm = vi.fn(() => true);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  delete global.fetch;
  delete window.confirmDialog;
});

describe('SnippetManager inline mount', () => {
  it('renders the snippet list with truncated previews', async () => {
    installFetch({ list: [{ id: 1, body: 'First snippet' }, { id: 2, body: 'Second' }], nextId: 3 });
    const host = mount();
    new SnippetManager(host);

    await vi.waitFor(() => {
      expect(host.querySelectorAll('.snippet-manager__row')).toHaveLength(2);
    });
    const previews = [...host.querySelectorAll('.snippet-manager__preview')].map(p => p.textContent);
    expect(previews).toEqual(['First snippet', 'Second']);
    // Each row exposes sibling Edit/Delete buttons (never nested in the row).
    const firstRow = host.querySelector('.snippet-manager__row');
    expect(firstRow.tagName).toBe('DIV');
    expect(firstRow.querySelector('.snippet-manager__edit-btn')).toBeTruthy();
    expect(firstRow.querySelector('.snippet-manager__delete-btn')).toBeTruthy();
  });

  it('renders an empty state when there are no snippets', async () => {
    installFetch({ list: [], nextId: 1 });
    const host = mount();
    new SnippetManager(host);

    await vi.waitFor(() => {
      expect(host.querySelector('.snippet-manager__empty')).toBeTruthy();
    });
    expect(host.querySelector('.snippet-manager__empty').textContent).toContain('No snippets yet');
    expect(host.querySelector('.snippet-manager__add-btn')).toBeTruthy();
  });

  it('renders an error state when the list fetch fails', async () => {
    global.fetch = vi.fn(async () => makeResponse({ error: 'boom' }, { ok: false, status: 500 }));
    const host = mount();
    new SnippetManager(host);

    await vi.waitFor(() => {
      expect(host.querySelector('.snippet-manager__error')).toBeTruthy();
    });
  });

  it('escapes snippet bodies (no HTML injection)', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    installFetch({ list: [{ id: 1, body: evil }], nextId: 2 });
    const host = mount();
    new SnippetManager(host);

    await vi.waitFor(() => {
      expect(host.querySelector('.snippet-manager__preview')).toBeTruthy();
    });
    // Rendered as text, not parsed into an <img> element.
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.snippet-manager__preview').textContent).toBe(evil);
  });
});

describe('SnippetManager add', () => {
  it('POSTs a new snippet, re-fetches, and fires onChange', async () => {
    const store = { list: [], nextId: 1 };
    const fetchMock = installFetch(store);
    const onChange = vi.fn();
    const host = mount();
    new SnippetManager(host, { onChange });

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__add-btn')).toBeTruthy());
    host.querySelector('.snippet-manager__add-btn').click();

    const textarea = host.querySelector('.snippet-manager__textarea');
    expect(textarea).toBeTruthy();
    textarea.value = 'Brand new snippet';
    textarea.dispatchEvent(new window.Event('input'));
    host.querySelector('.snippet-manager__form').dispatchEvent(new window.Event('submit'));

    await vi.waitFor(() => {
      expect(host.querySelectorAll('.snippet-manager__row')).toHaveLength(1);
    });
    const postCall = fetchMock.mock.calls.find(([u, o]) => u === '/api/snippets' && o && o.method === 'POST');
    expect(postCall).toBeTruthy();
    expect(JSON.parse(postCall[1].body)).toEqual({ body: 'Brand new snippet' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.snippet-manager__preview').textContent).toBe('Brand new snippet');
  });

  it('does not POST an empty/whitespace body (Save stays disabled)', async () => {
    const fetchMock = installFetch({ list: [], nextId: 1 });
    const host = mount();
    new SnippetManager(host);

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__add-btn')).toBeTruthy());
    host.querySelector('.snippet-manager__add-btn').click();

    const saveBtn = host.querySelector('.snippet-manager__save-btn');
    expect(saveBtn.disabled).toBe(true);
    const textarea = host.querySelector('.snippet-manager__textarea');
    textarea.value = '   ';
    textarea.dispatchEvent(new window.Event('input'));
    expect(saveBtn.disabled).toBe(true);

    const posted = fetchMock.mock.calls.some(([u, o]) => u === '/api/snippets' && o && o.method === 'POST');
    expect(posted).toBe(false);
  });

  it('persists the body verbatim (leading/trailing whitespace preserved)', async () => {
    const fetchMock = installFetch({ list: [], nextId: 1 });
    const host = mount();
    new SnippetManager(host);

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__add-btn')).toBeTruthy());
    host.querySelector('.snippet-manager__add-btn').click();

    const verbatim = '  Leading and trailing kept\n\n';
    const textarea = host.querySelector('.snippet-manager__textarea');
    textarea.value = verbatim;
    textarea.dispatchEvent(new window.Event('input'));
    host.querySelector('.snippet-manager__form').dispatchEvent(new window.Event('submit'));

    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/snippets' && o && o.method === 'POST')).toBe(true);
    });
    const postCall = fetchMock.mock.calls.find(([u, o]) => u === '/api/snippets' && o && o.method === 'POST');
    // Sent unmodified — NOT trimmed.
    expect(JSON.parse(postCall[1].body)).toEqual({ body: verbatim });
  });

  it('preserves in-progress text and resets _busy after a failed save', async () => {
    // GET succeeds (empty), POST fails.
    global.fetch = vi.fn(async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      if (method === 'GET') return makeResponse({ snippets: [] });
      return makeResponse({ error: 'server down' }, { ok: false, status: 500 });
    });
    const host = mount();
    const mgr = new SnippetManager(host);

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__add-btn')).toBeTruthy());
    host.querySelector('.snippet-manager__add-btn').click();

    const typed = 'A carefully written snippet I do not want to lose';
    let textarea = host.querySelector('.snippet-manager__textarea');
    textarea.value = typed;
    textarea.dispatchEvent(new window.Event('input'));
    host.querySelector('.snippet-manager__form').dispatchEvent(new window.Event('submit'));

    // After the failed save re-render: error banner shown, still on the form,
    // and the textarea retains the user's text.
    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__error')).toBeTruthy());
    textarea = host.querySelector('.snippet-manager__textarea');
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe(typed);
    expect(mgr._busy).toBe(false);
  });
});

describe('SnippetManager edit', () => {
  it('prefills the form and PUTs the update to the right id', async () => {
    const store = { list: [{ id: 7, body: 'Original body' }], nextId: 8 };
    const fetchMock = installFetch(store);
    const onChange = vi.fn();
    const host = mount();
    new SnippetManager(host, { onChange });

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__edit-btn')).toBeTruthy());
    host.querySelector('.snippet-manager__edit-btn').click();

    const textarea = host.querySelector('.snippet-manager__textarea');
    expect(textarea.value).toBe('Original body');
    textarea.value = 'Updated body';
    textarea.dispatchEvent(new window.Event('input'));
    host.querySelector('.snippet-manager__form').dispatchEvent(new window.Event('submit'));

    await vi.waitFor(() => {
      expect(host.querySelector('.snippet-manager__preview').textContent).toBe('Updated body');
    });
    const putCall = fetchMock.mock.calls.find(([u, o]) => u === '/api/snippets/7' && o && o.method === 'PUT');
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall[1].body)).toEqual({ body: 'Updated body' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('Cancel returns to the list without a request', async () => {
    const fetchMock = installFetch({ list: [{ id: 1, body: 'A' }], nextId: 2 });
    const host = mount();
    new SnippetManager(host);

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__edit-btn')).toBeTruthy());
    const callsBefore = fetchMock.mock.calls.length;
    host.querySelector('.snippet-manager__edit-btn').click();
    host.querySelector('.snippet-manager__cancel-btn').click();

    expect(host.querySelector('.snippet-manager__list-wrap')).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBe(callsBefore); // no PUT/GET beyond initial
  });
});

describe('SnippetManager delete', () => {
  it('DELETEs the snippet, re-fetches, and fires onChange', async () => {
    const store = { list: [{ id: 3, body: 'Doomed' }, { id: 4, body: 'Survivor' }], nextId: 5 };
    const fetchMock = installFetch(store);
    const onChange = vi.fn();
    const host = mount();
    new SnippetManager(host, { onChange });

    await vi.waitFor(() => expect(host.querySelectorAll('.snippet-manager__row')).toHaveLength(2));
    host.querySelector('.snippet-manager__row').querySelector('.snippet-manager__delete-btn').click();

    await vi.waitFor(() => {
      expect(host.querySelectorAll('.snippet-manager__row')).toHaveLength(1);
    });
    const delCall = fetchMock.mock.calls.find(([u, o]) => u === '/api/snippets/3' && o && o.method === 'DELETE');
    expect(delCall).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.snippet-manager__preview').textContent).toBe('Survivor');
  });

  it('uses the styled confirmDialog when present and deletes on confirm', async () => {
    window.confirmDialog = { show: vi.fn().mockResolvedValue('confirm') };
    const fetchMock = installFetch({ list: [{ id: 9, body: 'Doomed' }], nextId: 10 });
    const host = mount();
    new SnippetManager(host);

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__delete-btn')).toBeTruthy());
    host.querySelector('.snippet-manager__delete-btn').click();

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__empty')).toBeTruthy());
    expect(window.confirmDialog.show).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/snippets/9' && o && o.method === 'DELETE')).toBe(true);
  });

  it('does NOT delete when the confirmation is declined', async () => {
    window.confirmDialog = { show: vi.fn().mockResolvedValue('cancel') };
    const fetchMock = installFetch({ list: [{ id: 5, body: 'Kept' }], nextId: 6 });
    const host = mount();
    new SnippetManager(host);

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__delete-btn')).toBeTruthy());
    host.querySelector('.snippet-manager__delete-btn').click();

    // Give the declined promise a chance to settle, then assert nothing changed.
    await Promise.resolve();
    await Promise.resolve();
    expect(window.confirmDialog.show).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/snippets/5' && o && o.method === 'DELETE')).toBe(false);
    expect(host.querySelectorAll('.snippet-manager__row')).toHaveLength(1);
  });

  it('falls back to native confirm(false) and does not delete', async () => {
    window.confirm = vi.fn(() => false); // no styled dialog on this page
    const fetchMock = installFetch({ list: [{ id: 2, body: 'Kept' }], nextId: 3 });
    const host = mount();
    new SnippetManager(host);

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__delete-btn')).toBeTruthy());
    host.querySelector('.snippet-manager__delete-btn').click();

    await Promise.resolve();
    await Promise.resolve();
    expect(window.confirm).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([u, o]) => o && o.method === 'DELETE')).toBe(false);
    expect(host.querySelectorAll('.snippet-manager__row')).toHaveLength(1);
  });

  it('shows an error banner and resets _busy=false after a failed delete', async () => {
    global.fetch = vi.fn(async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      if (method === 'GET') return makeResponse({ snippets: [{ id: 1, body: 'X' }] });
      return makeResponse({ error: 'nope' }, { ok: false, status: 500 });
    });
    const host = mount();
    const mgr = new SnippetManager(host);

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__delete-btn')).toBeTruthy());
    host.querySelector('.snippet-manager__delete-btn').click();

    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__error')).toBeTruthy());
    expect(mgr._busy).toBe(false);
  });
});

describe('SnippetManager.openModal', () => {
  let addSpy;
  let removeSpy;

  beforeEach(() => {
    addSpy = vi.spyOn(document, 'addEventListener');
    removeSpy = vi.spyOn(document, 'removeEventListener');
  });

  it('mounts a modal shell and tears it down on backdrop click', async () => {
    installFetch({ list: [{ id: 1, body: 'X' }], nextId: 2 });
    const onClose = vi.fn();
    SnippetManager.openModal({ onClose });

    const overlay = document.querySelector('.snippet-manager-modal');
    expect(overlay).toBeTruthy();
    expect(overlay.querySelector('.snippet-manager-modal__header h3').textContent).toBe('Manage snippets');
    // A document-level keydown listener is registered in the CAPTURE phase so
    // Escape doesn't bubble to ChatPanel's own handler.
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);

    await vi.waitFor(() => {
      expect(overlay.querySelector('.snippet-manager__row')).toBeTruthy();
    });

    overlay.querySelector('.modal-backdrop').click();

    expect(document.querySelector('.snippet-manager-modal')).toBeNull();
    // Teardown MUST remove the listener with the same capture flag or it leaks.
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('closes via the close button and reports changed=true after a mutation', async () => {
    installFetch({ list: [], nextId: 1 });
    const onClose = vi.fn();
    SnippetManager.openModal({ onClose });

    const overlay = document.querySelector('.snippet-manager-modal');
    await vi.waitFor(() => expect(overlay.querySelector('.snippet-manager__add-btn')).toBeTruthy());

    overlay.querySelector('.snippet-manager__add-btn').click();
    const textarea = overlay.querySelector('.snippet-manager__textarea');
    textarea.value = 'From modal';
    textarea.dispatchEvent(new window.Event('input'));
    overlay.querySelector('.snippet-manager__form').dispatchEvent(new window.Event('submit'));

    await vi.waitFor(() => expect(overlay.querySelector('.snippet-manager__row')).toBeTruthy());

    overlay.querySelector('.snippet-manager-modal__close').click();
    expect(document.querySelector('.snippet-manager-modal')).toBeNull();
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('teardown is idempotent (backdrop then Escape does not double-fire onClose)', async () => {
    installFetch({ list: [], nextId: 1 });
    const onClose = vi.fn();
    SnippetManager.openModal({ onClose });

    const overlay = document.querySelector('.snippet-manager-modal');
    await vi.waitFor(() => expect(overlay.querySelector('.snippet-manager__add-btn')).toBeTruthy());

    overlay.querySelector('.modal-backdrop').click();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape tears down the modal when no confirm dialog is visible', async () => {
    installFetch({ list: [{ id: 1, body: 'X' }], nextId: 2 });
    const onClose = vi.fn();
    SnippetManager.openModal({ onClose });

    const overlay = document.querySelector('.snippet-manager-modal');
    await vi.waitFor(() => expect(overlay.querySelector('.snippet-manager__row')).toBeTruthy());

    // No window.confirmDialog present (deleted in beforeEach).
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.querySelector('.snippet-manager-modal')).toBeNull();
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('Escape yields to a stacked delete confirmation instead of tearing down', async () => {
    installFetch({ list: [{ id: 1, body: 'X' }], nextId: 2 });
    const onClose = vi.fn();
    SnippetManager.openModal({ onClose });

    const overlay = document.querySelector('.snippet-manager-modal');
    await vi.waitFor(() => expect(overlay.querySelector('.snippet-manager__row')).toBeTruthy());

    // Simulate the delete-confirmation dialog stacked above the modal.
    window.confirmDialog = { isVisible: true };
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));

    // Modal is untouched: overlay still present, teardown not run, listener kept.
    expect(document.querySelector('.snippet-manager-modal')).toBe(overlay);
    expect(onClose).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalledWith('keydown', expect.any(Function), true);

    // Once the confirm dialog is dismissed, Escape resumes tearing down.
    window.confirmDialog.isVisible = false;
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.snippet-manager-modal')).toBeNull();
    expect(onClose).toHaveBeenCalledWith(false);
  });
});

describe('SnippetManager.destroy', () => {
  it('clears the container', async () => {
    installFetch({ list: [{ id: 1, body: 'X' }], nextId: 2 });
    const host = mount();
    const mgr = new SnippetManager(host);
    await vi.waitFor(() => expect(host.querySelector('.snippet-manager__row')).toBeTruthy());

    mgr.destroy();
    expect(host.innerHTML).toBe('');
  });
});
