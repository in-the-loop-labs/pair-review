// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * The comment panel's filter menu (issue #610): a funnel button with labeled
 * "Show dismissed" / "Show posted" options, a dot when an option differs from
 * its default, and a notice at the end of the user comment list counting the
 * comments the filters hide.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const PostedComment = require('../../public/js/utils/posted-comment.js');
const { AIPanel } = require('../../public/js/components/AIPanel.js');
const { PRManager } = require('../../public/js/pr.js');

const PR_KEY = 'acme/widget#7';
const DISMISSED_KEY = `pair-review-show-dismissed_${PR_KEY}`;
const POSTED_KEY = `pair-review-show-posted_${PR_KEY}`;

let filterEvents;
function onFilterEvent(e) { filterEvents.push(e.detail); }

beforeEach(() => {
  localStorage.clear();
  PostedComment.setShowPostedOverride(null);
  window.PostedComment = PostedComment;
  window.escapeHtmlAttribute = (text) => String(text ?? '').replace(/"/g, '&quot;');
  delete window.PAIR_REVIEW_LOCAL_MODE;
  // jsdom has no layout; the panel scrolls its selected item into view
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = `
    <div id="ai-panel">
      <div class="segment-control" id="segment-control">
        <div class="segment-control-scroll" id="segment-control-scroll">
          <div class="segment-control-inner">
            <button class="segment-btn" data-segment="ai">AI <span class="segment-count">(0)</span></button>
            <button class="segment-btn" data-segment="comments">User <span class="segment-count">(0)</span></button>
            <button class="segment-btn" data-segment="all">All <span class="segment-count">(0)</span></button>
          </div>
        </div>
      </div>
      <div id="findings-list"></div>
    </div>`;
  filterEvents = [];
  document.addEventListener('commentFilterChanged', onFilterEvent);
});

afterEach(() => {
  document.removeEventListener('commentFilterChanged', onFilterEvent);
  delete window.PAIR_REVIEW_LOCAL_MODE;
  delete window.aiPanel;
  vi.restoreAllMocks();
});

function makePanel() {
  const panel = new AIPanel();
  panel.setPR('acme', 'widget', 7);
  return panel;
}

const funnel = () => document.querySelector('.comment-filter-btn');
const menu = () => document.querySelector('.comment-filter-menu');
const option = (name) => document.querySelector(`input[data-filter="${name}"]`);

function check(name, checked) {
  const input = option(name);
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('comment filter menu', () => {
  it('replaces the eye toggle with a funnel that opens labeled options', () => {
    makePanel();
    expect(document.querySelector('.filter-toggle-btn')).toBeNull();
    expect(funnel().getAttribute('aria-expanded')).toBe('false');
    expect(menu().hidden).toBe(true);

    funnel().click();
    expect(menu().hidden).toBe(false);
    expect(funnel().getAttribute('aria-expanded')).toBe('true');
    const labels = [...menu().querySelectorAll('label')].map(l => l.textContent.trim());
    expect(labels).toEqual(['Show dismissed', 'Show posted']);
    expect(document.activeElement).toBe(option('showDismissed'));
  });

  it('closes on Escape (returning focus to the funnel) and on an outside click', () => {
    makePanel();
    funnel().click();
    option('showDismissed').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu().hidden).toBe(true);
    expect(funnel().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(funnel());

    funnel().click();
    menu().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu().hidden).toBe(false);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu().hidden).toBe(true);
  });

  it('local mode has no "Show posted" option', () => {
    window.PAIR_REVIEW_LOCAL_MODE = true;
    makePanel();
    expect(option('showDismissed')).not.toBeNull();
    expect(option('showPosted')).toBeNull();
  });

  it('persists "Show dismissed" per review and dispatches one change event', () => {
    const panel = makePanel();
    check('showDismissed', true);

    expect(localStorage.getItem(DISMISSED_KEY)).toBe('true');
    expect(panel.getCommentFilterState()).toEqual({ includeDismissed: true, showPosted: true });
    expect(filterEvents).toEqual([{ includeDismissed: true, showPosted: true }]);
  });

  it('"Show posted" overrides the browser-wide setting for this review only', () => {
    PostedComment.setHidePostedEnabled(true);
    const panel = makePanel();
    expect(panel.getCommentFilterState().showPosted).toBe(false);
    expect(option('showPosted').checked).toBe(false);

    check('showPosted', true);
    expect(panel.getCommentFilterState().showPosted).toBe(true);
    expect(PostedComment.shouldHidePostedComment({ status: 'active', publication: { state: 'posted' } })).toBe(false);
    expect(localStorage.getItem(POSTED_KEY)).toBe('true');
    // The browser-wide preference is untouched
    expect(PostedComment.isHidePostedEnabled()).toBe(true);
    expect(filterEvents).toEqual([{ includeDismissed: false, showPosted: true }]);

    // Back to the default drops the override, so the review follows the
    // browser-wide setting again
    check('showPosted', false);
    expect(localStorage.getItem(POSTED_KEY)).toBeNull();
    expect(PostedComment.getShowPostedOverride()).toBeNull();
    expect(PostedComment.isHidePostedEnabled()).toBe(true);
  });

  it('restores both options for the review without dispatching', () => {
    PostedComment.setHidePostedEnabled(true);
    localStorage.setItem(DISMISSED_KEY, 'true');
    localStorage.setItem(POSTED_KEY, 'true');
    const dispatch = vi.spyOn(document, 'dispatchEvent');

    const panel = makePanel();

    expect(panel.getCommentFilterState()).toEqual({ includeDismissed: true, showPosted: true });
    expect(option('showDismissed').checked).toBe(true);
    expect(option('showPosted').checked).toBe(true);
    expect(dispatch.mock.calls.filter(([e]) => e.type === 'commentFilterChanged')).toHaveLength(0);
    expect(filterEvents).toHaveLength(0);
  });

  it('another review without an override follows the browser-wide setting', () => {
    PostedComment.setHidePostedEnabled(true);
    localStorage.setItem(POSTED_KEY, 'true');
    const panel = makePanel();
    panel.setPR('acme', 'widget', 8);
    expect(panel.getCommentFilterState().showPosted).toBe(false);
  });

  it('shows the dot only when an option differs from its default', () => {
    makePanel();
    expect(funnel().classList.contains('has-active-filter')).toBe(false);

    check('showDismissed', true);
    expect(funnel().classList.contains('has-active-filter')).toBe(true);
    expect(funnel().getAttribute('aria-label')).toMatch(/filters on/);
    check('showDismissed', false);
    expect(funnel().classList.contains('has-active-filter')).toBe(false);

    // Browser-wide setting shows posted comments: hiding them here is non-default
    check('showPosted', false);
    expect(funnel().classList.contains('has-active-filter')).toBe(true);
  });

  it('the dot ignores the posted setting in local mode', () => {
    window.PAIR_REVIEW_LOCAL_MODE = true;
    PostedComment.setHidePostedEnabled(true);
    const panel = makePanel();
    expect(panel.isCommentFilterNonDefault()).toBe(false);
  });

  it('the submit dialog clearing the override resets this review to the browser-wide setting', () => {
    const panel = makePanel();
    check('showPosted', false);
    expect(localStorage.getItem(POSTED_KEY)).toBe('false');

    panel.clearShowPostedOverride();
    expect(localStorage.getItem(POSTED_KEY)).toBeNull();
    expect(panel.getCommentFilterState().showPosted).toBe(true);
    expect(funnel().classList.contains('has-active-filter')).toBe(false);
  });
});

describe('hidden-comments notice', () => {
  const notice = () => document.querySelector('.hidden-comments-notice');

  function showUserSegment(panel) {
    panel.selectedSegment = 'comments';
    panel.renderFindings();
  }

  it('is not rendered when nothing is hidden', () => {
    const panel = makePanel();
    showUserSegment(panel);
    panel.setHiddenCommentCounts({ posted: 0, dismissed: 0 });
    expect(notice()).toBeNull();
  });

  it('counts hidden posted and dismissed comments at the end of the user list', () => {
    const panel = makePanel();
    showUserSegment(panel);
    panel.setComments([{ id: 1, status: 'active', file: 'a.js', line_start: 1, body: 'Visible' }]);
    panel.setHiddenCommentCounts({ posted: 3, dismissed: 2 });

    expect(notice().textContent.replace(/\s+/g, ' ').trim()).toBe('3 posted · 2 dismissed hidden — Show');
    expect(document.querySelector('#findings-list').lastElementChild).toBe(notice());
  });

  it('is not shown in the AI segment', () => {
    const panel = makePanel();
    panel.selectedSegment = 'ai';
    panel.setHiddenCommentCounts({ posted: 1, dismissed: 1 });
    expect(notice()).toBeNull();
  });

  it('shows with the empty state when every user comment is hidden', () => {
    const panel = makePanel();
    showUserSegment(panel);
    panel.setHiddenCommentCounts({ dismissed: 2 });
    expect(notice().textContent).toContain('2 dismissed hidden');
    expect(document.querySelector('.empty-state-title').textContent).toBe('No comments shown');
  });

  it('"Show" turns on the matching options, in one change', () => {
    PostedComment.setHidePostedEnabled(true);
    const panel = makePanel();
    showUserSegment(panel);
    panel.setHiddenCommentCounts({ posted: 1, dismissed: 0 });

    document.querySelector('.hidden-comments-show').click();

    expect(panel.getCommentFilterState()).toEqual({ includeDismissed: false, showPosted: true });
    expect(filterEvents).toEqual([{ includeDismissed: false, showPosted: true }]);

    panel.setHiddenCommentCounts({ posted: 0, dismissed: 4 });
    document.querySelector('.hidden-comments-show').click();
    expect(panel.getCommentFilterState()).toEqual({ includeDismissed: true, showPosted: true });
    expect(filterEvents).toHaveLength(2);
  });
});

describe('PRManager filter wiring', () => {
  const comments = [
    { id: 1, status: 'active', file: 'src/a.js', line_start: 10, body: 'Pending' },
    { id: 2, status: 'active', publication: { state: 'posted' }, file: 'src/a.js', line_start: 11, body: 'Posted' },
    { id: 3, status: 'active', publication: { state: 'posted' }, file: 'src/a.js', line_start: 12, body: 'Posted too' },
    { id: 4, status: 'active', publication: { state: 'draft' }, file: 'src/a.js', line_start: 13, body: 'In draft review' },
    { id: 5, status: 'inactive', publication: { state: 'posted' }, file: 'src/a.js', line_start: 14, body: 'Dismissed' }
  ];

  function makeManager() {
    const manager = Object.create(PRManager.prototype);
    manager.currentPR = { id: 42, owner: 'acme', repo: 'widget', number: 7 };
    manager.ensureLinesVisible = vi.fn();
    manager.findFileElement = () => null;
    manager.updateCommentCount = vi.fn();
    return manager;
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ comments }) })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('counts hidden comments from the comment data and feeds the notice', async () => {
    PostedComment.setHidePostedEnabled(true);
    window.aiPanel = makePanel();
    window.aiPanel.selectedSegment = 'comments';
    const manager = makeManager();

    await manager.loadUserComments();

    // Drafts stay visible; submitted ones are hidden; the dismissed one is hidden
    expect(manager.getHiddenCommentCounts()).toEqual({ posted: 2, dismissed: 1 });
    expect(window.aiPanel.comments.map(c => c.id)).toEqual([1, 4]);
    expect(document.querySelector('.hidden-comments-notice').textContent).toContain('2 posted · 1 dismissed hidden');
  });

  it('a filter change reloads and shows the comments it turns on', async () => {
    PostedComment.setHidePostedEnabled(true);
    window.aiPanel = makePanel();
    window.aiPanel.selectedSegment = 'comments';
    const manager = makeManager();
    // Stands in for setupEventHandlers' listener (the E2E specs cover the real one)
    document.addEventListener('commentFilterChanged', function reload() {
      document.removeEventListener('commentFilterChanged', reload);
      manager.loadUserComments();
    });
    await manager.loadUserComments();

    document.querySelector('.hidden-comments-show').click();
    await manager._latestUserCommentsLoad;

    expect(window.aiPanel.comments.map(c => c.id)).toEqual([1, 2, 3, 4, 5]);
    expect(manager.getHiddenCommentCounts()).toEqual({ posted: 0, dismissed: 0 });
    expect(document.querySelector('.hidden-comments-notice')).toBeNull();
  });

  it.each([false, true].flatMap(showPosted => [false, true].map(includeDismissed => ({ showPosted, includeDismissed }))))('dismissed posted visibility follows only Show dismissed: %j', async filter => {
    window.aiPanel = makePanel();
    const manager = makeManager();
    manager.getCommentFilterState = () => filter;
    await manager.loadUserComments();
    const row = document.createElement('div');
    row.dataset.commentStatus = 'inactive';
    row.dataset.commentPublication = 'posted';
    document.body.appendChild(row);
    manager.applyPostedCommentVisibility();
    expect(window.aiPanel.comments.map(c => c.id).includes(5)).toBe(filter.includeDismissed);
    expect(manager.getHiddenCommentCounts()).toEqual({
      posted: filter.showPosted ? 0 : 2, dismissed: filter.includeDismissed ? 0 : 1
    });
    expect(row.classList.contains('posted-comment-hidden')).toBe(false);
  });

  it('dismissing a comment counts it as hidden without a reload', async () => {
    window.aiPanel = makePanel();
    window.aiPanel.selectedSegment = 'comments';
    const manager = makeManager();
    await manager.loadUserComments();
    expect(manager.getHiddenCommentCounts()).toEqual({ posted: 0, dismissed: 1 });

    manager.patchUserComment(1, { status: 'inactive' });

    expect(window.aiPanel.hiddenCommentCounts).toEqual({ posted: 0, dismissed: 2 });
    expect(window.aiPanel.comments.map(c => c.id)).not.toContain(1);
  });
});
