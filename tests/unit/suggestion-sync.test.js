// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

/**
 * SuggestionManager.syncSuggestionElement brings a suggestion card in line
 * with its suggestion's status. The diff runs it every time it draws the
 * card. A card whose status has not changed since it was built, or since a
 * flow updated it and said so (markSuggestionSynced), is not touched; that
 * keeps what the reader did to it, such as showing an adopted suggestion
 * again. A card that missed a status change is given the new state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');

function makeManager(userComments = []) {
  const sm = Object.create(SuggestionManager.prototype);
  sm.prManager = { userComments };
  return sm;
}

function card({ collapsed = false } = {}) {
  const element = document.createElement('div');
  element.className = `ai-suggestion${collapsed ? ' collapsed' : ''}`;
  element.innerHTML = '<button class="btn-restore" title="Hide suggestion"><span class="btn-text">Hide</span></button>';
  return element;
}

const label = element => element.querySelector('.btn-text').textContent;

beforeEach(() => {
  window.SuggestionUI = { setCollapsedStateTooltip: vi.fn(), clearDismissalReasonUI: vi.fn() };
});

afterEach(() => {
  delete window.SuggestionUI;
  vi.restoreAllMocks();
});

describe('SuggestionManager.effectiveSuggestionStatus', () => {
  it('is adopted when its own status says so or a live comment was adopted from it', () => {
    expect(makeManager().effectiveSuggestionStatus({ id: 1, status: 'adopted' })).toBe('adopted');
    expect(makeManager([{ id: 9, parent_id: 1, status: 'active' }])
      .effectiveSuggestionStatus({ id: '1', status: 'active' })).toBe('adopted');
    // A dismissed comment no longer adopts its suggestion.
    expect(makeManager([{ id: 9, parent_id: 1, status: 'inactive' }])
      .effectiveSuggestionStatus({ id: 1, status: 'dismissed' })).toBe('dismissed');
  });

  it('is dismissed or active otherwise, and active without a suggestion or comments', () => {
    const sm = makeManager();
    expect(sm.effectiveSuggestionStatus({ id: 1, status: 'dismissed' })).toBe('dismissed');
    expect(sm.effectiveSuggestionStatus({ id: 1, status: 'active' })).toBe('active');
    expect(sm.effectiveSuggestionStatus({ id: 1 })).toBe('active');
    expect(sm.effectiveSuggestionStatus(null)).toBe('active');
    sm.prManager = null;
    expect(sm.effectiveSuggestionStatus({ id: 1, status: 'dismissed' })).toBe('dismissed');
  });
});

describe('SuggestionManager.syncSuggestionElement', () => {
  it('leaves a card that was just built alone, and one whose status did not change', () => {
    const sm = makeManager();
    const element = card();
    const suggestion = { id: 1, status: 'active' };

    sm.syncSuggestionElement(element, suggestion);
    sm.syncSuggestionElement(element, suggestion);

    expect(element.className).toBe('ai-suggestion');
    expect(label(element)).toBe('Hide');
    expect(window.SuggestionUI.setCollapsedStateTooltip).not.toHaveBeenCalled();
  });

  it('collapses a card that missed its dismissal, and reopens one that missed its restore', () => {
    const sm = makeManager();
    const element = card();
    const suggestion = { id: 1, status: 'active' };
    sm.syncSuggestionElement(element, suggestion);

    suggestion.status = 'dismissed';
    sm.syncSuggestionElement(element, suggestion);
    expect(element.classList.contains('collapsed')).toBe(true);
    expect(element.dataset.hiddenForAdoption).toBe('false');
    expect(label(element)).toBe('Show');
    expect(window.SuggestionUI.setCollapsedStateTooltip).toHaveBeenLastCalledWith(element, 'Dismissed');

    suggestion.status = 'active';
    sm.syncSuggestionElement(element, suggestion);
    expect(element.classList.contains('collapsed')).toBe(false);
    expect(element.dataset.hiddenForAdoption).toBeUndefined();
    expect(window.SuggestionUI.setCollapsedStateTooltip).toHaveBeenLastCalledWith(element, '');
    expect(window.SuggestionUI.clearDismissalReasonUI).toHaveBeenCalledWith(element);
  });

  it('collapses a card that missed its adoption and marks it hidden for adoption', () => {
    const comments = [];
    const sm = makeManager(comments);
    const element = card();
    const suggestion = { id: 1, status: 'active' };
    sm.syncSuggestionElement(element, suggestion);

    comments.push({ id: 9, parent_id: 1, status: 'active' });
    sm.syncSuggestionElement(element, suggestion);

    expect(element.classList.contains('collapsed')).toBe(true);
    expect(element.dataset.hiddenForAdoption).toBe('true');
    expect(label(element)).toBe('Show');
    expect(window.SuggestionUI.setCollapsedStateTooltip).toHaveBeenLastCalledWith(element, 'Adopted');
  });

  it('keeps what a flow did to a card it marked as up to date', () => {
    const sm = makeManager();
    const element = card();
    const suggestion = { id: 1, status: 'active' };
    sm.syncSuggestionElement(element, suggestion);

    // The adopt flow collapsed the card; the reader then chose to show it.
    suggestion.status = 'adopted';
    element.classList.add('collapsed');
    sm.markSuggestionSynced(element, suggestion);
    element.classList.remove('collapsed');

    sm.syncSuggestionElement(element, suggestion);
    expect(element.classList.contains('collapsed')).toBe(false);
  });

  it('finds the card inside a wrapper, and does nothing without a card or a suggestion', () => {
    const sm = makeManager();
    const wrapper = document.createElement('div');
    const element = card();
    wrapper.appendChild(element);
    const suggestion = { id: 1, status: 'active' };
    sm.syncSuggestionElement(wrapper, suggestion);
    suggestion.status = 'dismissed';
    sm.syncSuggestionElement(wrapper, suggestion);
    expect(element.classList.contains('collapsed')).toBe(true);

    expect(() => sm.syncSuggestionElement(null, suggestion)).not.toThrow();
    expect(() => sm.syncSuggestionElement(document.createElement('div'), suggestion)).not.toThrow();
    expect(() => sm.syncSuggestionElement(element, null)).not.toThrow();
    expect(() => sm.markSuggestionSynced(null, suggestion)).not.toThrow();
    expect(() => sm.markSuggestionSynced(element, null)).not.toThrow();
  });

  it('works without SuggestionUI and without a restore button', () => {
    delete window.SuggestionUI;
    const sm = makeManager();
    const element = document.createElement('div');
    element.className = 'ai-suggestion';
    const suggestion = { id: 1, status: 'active' };
    sm.syncSuggestionElement(element, suggestion);
    suggestion.status = 'dismissed';
    expect(() => sm.syncSuggestionElement(element, suggestion)).not.toThrow();
    expect(element.classList.contains('collapsed')).toBe(true);
  });
});
