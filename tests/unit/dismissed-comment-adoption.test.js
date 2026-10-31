// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * PRManager.userComments keeps dismissed comments (loadUserComments fetches
 * them so the comment panel can count what its filters hide). Dismissing an
 * adopted comment dismisses its suggestion, so a dismissed comment must not
 * mark its suggestion as adopted.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const { SuggestionManager } = require('../../public/js/modules/suggestion-manager.js');
const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');

const suggestion = { id: 7, status: 'dismissed', type: 'bug', title: 'T', body: 'B', file: 'src/a.js', line_start: 3 };

function prManagerWith(status) {
  return {
    userComments: [{ id: 1, parent_id: 7, status, file: 'src/a.js', line_start: 3 }],
    escapeHtml: (s) => String(s ?? '')
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a dismissed comment does not adopt its suggestion', () => {
  it.each([
    ['active', 'true'],
    ['inactive', undefined]
  ])('line-level suggestion, comment %s: hiddenForAdoption=%s', (status, expected) => {
    const manager = new SuggestionManager(prManagerWith(status));
    const row = manager.createSuggestionRow([suggestion], { fileName: 'src/a.js', lineNumber: 3, side: 'RIGHT' });
    const div = row.querySelector('[data-suggestion-id="7"]');
    expect(div.dataset.hiddenForAdoption).toBe(expected);
    expect(div.classList.contains('collapsed')).toBe(true);
  });

  it.each([
    ['active', 'Adopted'],
    ['inactive', 'Dismissed']
  ])('file-level suggestion, comment %s: shown as %s', (status, label) => {
    const manager = Object.create(FileCommentManager.prototype);
    manager.prManager = prManagerWith(status);
    const zone = document.createElement('div');
    zone.innerHTML = '<div class="file-comments-container"></div>';
    document.body.appendChild(zone);
    manager.displayAISuggestion(zone, { ...suggestion, is_file_level: 1 });
    const card = zone.querySelector('[data-suggestion-id="7"]');
    expect(card.querySelector('.ai-suggestion-collapsed-content').title).toBe(label);
  });
});
