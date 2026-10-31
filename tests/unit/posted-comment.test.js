// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

const PostedComment = require('../../public/js/utils/posted-comment.js');
const {
  HIDE_POSTED_STORAGE_KEY,
  isPostedComment,
  isHidePostedEnabled,
  setHidePostedEnabled,
  shouldHidePostedComment,
  getPostedCommentIcon,
  stampCommentStatus
} = PostedComment;

beforeEach(() => localStorage.clear());

describe('posted-comment helpers', () => {
  it.each([
    ['active', false],
    [undefined, false],
    ['submitted', true],
    ['draft', true],
    ['inactive', false]
  ])('status %s: posted=%s', (status, posted) => {
    expect(isPostedComment({ status })).toBe(posted);
  });

  it('reads and writes the hide-posted preference under one key', () => {
    expect(isHidePostedEnabled()).toBe(false);
    setHidePostedEnabled(true);
    expect(localStorage.getItem(HIDE_POSTED_STORAGE_KEY)).toBe('true');
    expect(isHidePostedEnabled()).toBe(true);
    setHidePostedEnabled(false);
    expect(isHidePostedEnabled()).toBe(false);
  });

  it('hides only submitted comments, and only when the preference is on', () => {
    expect(shouldHidePostedComment({ status: 'submitted' })).toBe(false);
    setHidePostedEnabled(true);
    expect(shouldHidePostedComment({ status: 'submitted' })).toBe(true);
    expect(shouldHidePostedComment({ status: 'draft' })).toBe(false);
    expect(shouldHidePostedComment({ status: 'active' })).toBe(false);
    // An explicit setting wins over the stored one
    expect(shouldHidePostedComment({ status: 'submitted' }, false)).toBe(false);
  });

  it('shows the posted icon for posted comments only', () => {
    expect(getPostedCommentIcon({ status: 'active' })).toBe('');
    expect(getPostedCommentIcon({ status: 'submitted' })).toContain('posted-comment-icon');
    expect(getPostedCommentIcon({ status: 'draft' })).toContain('posted-comment-icon');
  });

  it('stamps status and the hidden class onto an element', () => {
    const el = document.createElement('div');
    stampCommentStatus(el, { id: 1 });
    expect(el.dataset.commentStatus).toBe('active');
    expect(el.classList.contains('posted-comment-hidden')).toBe(false);

    setHidePostedEnabled(true);
    stampCommentStatus(el, { status: 'submitted' });
    expect(el.dataset.commentStatus).toBe('submitted');
    expect(el.classList.contains('posted-comment-hidden')).toBe(true);

    stampCommentStatus(el, { status: 'draft' });
    expect(el.classList.contains('posted-comment-hidden')).toBe(false);
  });

  it('publishes itself on window for browser scripts', () => {
    expect(window.PostedComment).toBe(PostedComment);
  });
});
