// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
const PostedComment = require('../../public/js/utils/posted-comment.js');
const { publicationState, isPendingComment, isPostedComment, shouldHidePostedComment,
  getPostedCommentIcon, stampCommentStatus, setHidePostedEnabled } = PostedComment;
const posted = { status: 'active', publication: { state: 'posted' } };
const draft = { status: 'active', publication: { state: 'draft' } };
beforeEach(() => { localStorage.clear(); PostedComment.setShowPostedOverride(null); });

describe('posted-comment helpers', () => {
  it.each([
    [{ status: 'active' }, 'none', true],
    [{ status: 'inactive' }, 'none', false],
    [posted, 'posted', false], [draft, 'draft', false],
    [{ ...posted, status: 'inactive' }, 'posted', false],
    [null, 'none', false]
  ])('derives publication and pending independently of lifecycle: %j', (comment, state, pending) => {
    expect(publicationState(comment)).toBe(state);
    expect(isPostedComment(comment)).toBe(state !== 'none');
    expect(isPendingComment(comment)).toBe(pending);
  });

  it('stores the preference and lets the review override it without changing storage', () => {
    expect(shouldHidePostedComment(posted)).toBe(false);
    setHidePostedEnabled(true);
    expect(localStorage.getItem(PostedComment.HIDE_POSTED_STORAGE_KEY)).toBe('true');
    expect(shouldHidePostedComment(posted)).toBe(true);
    expect(shouldHidePostedComment(draft)).toBe(false);
    PostedComment.setShowPostedOverride(true);
    expect(shouldHidePostedComment(posted)).toBe(false);
    expect(PostedComment.isHidePostedEnabled()).toBe(true);
    PostedComment.setShowPostedOverride(null);
    expect(shouldHidePostedComment(posted)).toBe(true);
    expect(shouldHidePostedComment(posted, false)).toBe(false);
    expect(PostedComment.countHiddenPostedComments([posted, posted, draft], true)).toBe(2);
    expect(PostedComment.countHiddenPostedComments(undefined, true)).toBe(0);
  });

  it('links to the precise comment or review, escapes attributes, and keeps panel icons noninteractive', () => {
    const comment = { ...posted, publication: { state: 'posted', comment_url: 'https://example.test/c?x="&y=1', review_url: 'https://example.test/r' } };
    expect(getPostedCommentIcon(comment)).toMatch(/^<span/);
    const html = getPostedCommentIcon(comment, { link: true });
    expect(html).toContain('href="https://example.test/c?x=&quot;&amp;y=1"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('Posted comment');
    expect(getPostedCommentIcon({ ...draft, publication: { state: 'draft', review_url: 'https://example.test/r' } }, { link: true })).toContain('In pending draft review');
    expect(getPostedCommentIcon({ ...posted, publication: { state: 'posted', review_url: 'https://example.test/r' } }, { link: true })).toContain('Posted review');
    expect(getPostedCommentIcon(posted, { link: true })).toMatch(/^<span/);
    expect(getPostedCommentIcon({ ...posted, publication: { state: 'posted', comment_url: 'javascript:alert(1)' } }, { link: true })).toMatch(/^<span/);
    expect(getPostedCommentIcon({ status: 'active' })).toBe('');
  });

  it('stamps both lifecycle and publication', () => {
    const el = document.createElement('div');
    setHidePostedEnabled(true);
    stampCommentStatus(el, posted);
    expect(el.dataset.commentStatus).toBe('active');
    expect(el.dataset.commentPublication).toBe('posted');
    expect(el.classList.contains('posted-comment-hidden')).toBe(true);
    stampCommentStatus(el, draft);
    expect(el.classList.contains('posted-comment-hidden')).toBe(false);
    expect(window.PostedComment).toBe(PostedComment);
  });
});
