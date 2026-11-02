// @vitest-environment jsdom
// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * The help modal greets first-time users who have no PR reviews yet, on the
 * initial page load only. Emptying the list later (deleting the last review,
 * singly or in bulk) must show the empty-state message without popping the
 * help modal (issue #367).
 *
 * Drives the real public/js/index.js against a jsdom document: the initial
 * load runs the module's DOMContentLoaded handler, and the delete path clicks
 * the real delete and confirm buttons.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const INDEX_MARKUP = `
  <button id="help-btn"></button>
  <div id="help-modal-overlay"><button id="help-modal-close"></button></div>
  <div id="recent-reviews-section">
    <div id="recent-reviews-container" class="recent-reviews-loading"></div>
  </div>
`;

const path = require('path');
const INDEX_JS = path.resolve(__dirname, '../../public/js/index.js');

const REVIEW = {
  id: 42,
  repository: 'owner/repo',
  pr_number: 7,
  pr_title: 'A change',
  author: 'someone',
  last_accessed_at: '2026-10-31T12:00:00Z'
};

let documentListeners;
let recentReviews;

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
}

function mockFetch(url, init = {}) {
  if (url.startsWith('/api/worktrees/recent')) {
    return jsonResponse({ success: true, reviews: recentReviews, hasMore: false });
  }
  if (url.startsWith('/api/worktrees/') && init.method === 'DELETE') {
    const id = Number(url.split('/').pop());
    recentReviews = recentReviews.filter(r => r.id !== id);
    return jsonResponse({ success: true });
  }
  if (url === '/api/config') return jsonResponse({});
  // Anything else (active analyses, etc.) is irrelevant here.
  return jsonResponse({ success: true });
}

async function settle() {
  // Let the chained fetch/json promises inside the handlers resolve.
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

async function initialPageLoad() {
  for (const handler of documentListeners.DOMContentLoaded || []) handler();
  await settle();
}

function click(el) {
  // index.js uses document-level delegation; call the captured handlers
  // with an event whose target is the real element.
  const event = { target: el, preventDefault() {}, stopPropagation() {} };
  for (const handler of documentListeners.click || []) handler(event);
}

const helpModalVisible = () =>
  document.getElementById('help-modal-overlay').classList.contains('visible');
const container = () => document.getElementById('recent-reviews-container');

beforeEach(() => {
  document.body.innerHTML = INDEX_MARKUP;
  document.body.style.overflow = '';
  localStorage.clear();
  window.PairReviewTheme = { setup: () => {} };
  global.fetch = vi.fn(mockFetch);

  // Capture document listeners instead of attaching them, so reloading the
  // module per test doesn't stack handlers from earlier tests.
  documentListeners = {};
  vi.spyOn(document, 'addEventListener').mockImplementation((type, handler) => {
    (documentListeners[type] = documentListeners[type] || []).push(handler);
  });

  delete require.cache[INDEX_JS];
  require(INDEX_JS);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
});

describe('help modal on an empty PR review list', () => {
  it('opens on initial page load when the user has no reviews', async () => {
    recentReviews = [];

    await initialPageLoad();

    expect(container().textContent).toContain('No PR reviews yet');
    expect(helpModalVisible()).toBe(true);
  });

  it('does not open on initial page load when reviews exist', async () => {
    recentReviews = [REVIEW];

    await initialPageLoad();

    expect(container().querySelector('.btn-delete-review')).not.toBeNull();
    expect(helpModalVisible()).toBe(false);
  });

  it('does not open after the user deletes the last review', async () => {
    recentReviews = [REVIEW];
    await initialPageLoad();

    click(container().querySelector('.btn-delete-review'));
    container().querySelector('.btn-confirm-yes').click();
    await settle();

    expect(global.fetch).toHaveBeenCalledWith('/api/worktrees/42', { method: 'DELETE' });
    expect(container().textContent).toContain('No PR reviews yet');
    expect(helpModalVisible()).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });
});
