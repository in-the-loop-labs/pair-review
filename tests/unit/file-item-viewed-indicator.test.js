// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for the sidebar file row's "viewed" indicator.
 *
 * When a file is marked as viewed, the sidebar row should:
 *   - Gain the `.viewed` class (drives gray file-name color via CSS)
 *   - Get an eye-slash icon prepended inside `.file-viewed-icon-wrapper`
 *
 * Covers both the initial render (`renderFileItem`) and in-place updates
 * after a viewed toggle (`updateFileItemViewedState`).
 */

import { describe, it, expect, beforeEach } from 'vitest';

const { PRManager } = require('../../public/js/pr.js');

function createManager(viewedPaths = []) {
  const manager = Object.create(PRManager.prototype);
  manager.viewedFiles = new Set(viewedPaths);
  return manager;
}

function makeFile(overrides = {}) {
  return {
    name: 'app.js',
    fullPath: 'src/app.js',
    status: 'modified',
    additions: 5,
    deletions: 2,
    binary: false,
    generated: false,
    renamed: false,
    renamedFrom: null,
    contextFile: false,
    ...overrides,
  };
}

describe('file-item viewed indicator', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('renderFileItem', () => {
    it('adds .viewed class and eye-slash icon when file is in viewedFiles', () => {
      const manager = createManager(['src/app.js']);
      const item = manager.renderFileItem(makeFile());

      expect(item.classList.contains('viewed')).toBe(true);

      const icon = item.querySelector('.file-viewed-icon-wrapper');
      expect(icon).not.toBeNull();
      expect(icon.getAttribute('title')).toBe('Marked as viewed');
      expect(icon.querySelector('svg.file-viewed-icon')).not.toBeNull();
    });

    it('prepends the viewed icon before other content (first child)', () => {
      const manager = createManager(['src/app.js']);
      const item = manager.renderFileItem(makeFile());

      expect(item.firstChild.classList.contains('file-viewed-icon-wrapper')).toBe(true);
    });

    it('does not add .viewed class or icon when file is not in viewedFiles', () => {
      const manager = createManager([]);
      const item = manager.renderFileItem(makeFile());

      expect(item.classList.contains('viewed')).toBe(false);
      expect(item.querySelector('.file-viewed-icon-wrapper')).toBeNull();
    });

    it('marks context files as viewed when their path is in viewedFiles', () => {
      const manager = createManager(['src/app.js']);
      const item = manager.renderFileItem(makeFile({ contextFile: true }));

      expect(item.classList.contains('viewed')).toBe(true);
      expect(item.querySelector('.file-viewed-icon-wrapper')).not.toBeNull();
    });

    it('handles missing viewedFiles set without throwing', () => {
      const manager = Object.create(PRManager.prototype);
      manager.viewedFiles = undefined;

      expect(() => manager.renderFileItem(makeFile())).not.toThrow();
      const item = manager.renderFileItem(makeFile());
      expect(item.classList.contains('viewed')).toBe(false);
    });

    it('coexists with rename icon — both icons are appended', () => {
      const manager = createManager(['src/app.js']);
      const item = manager.renderFileItem(makeFile({
        renamed: true,
        renamedFrom: 'src/old.js',
      }));

      expect(item.querySelector('.file-viewed-icon-wrapper')).not.toBeNull();
      expect(item.querySelector('.file-rename-icon-wrapper')).not.toBeNull();
      // Viewed icon should come first
      expect(item.firstChild.classList.contains('file-viewed-icon-wrapper')).toBe(true);
    });
  });

  describe('updateFileItemViewedState', () => {
    it('adds class and icon when toggled to viewed', () => {
      const manager = createManager([]);
      const item = manager.renderFileItem(makeFile());
      document.body.appendChild(item);

      manager.updateFileItemViewedState('src/app.js', true);

      expect(item.classList.contains('viewed')).toBe(true);
      expect(item.querySelector('.file-viewed-icon-wrapper')).not.toBeNull();
    });

    it('removes class and icon when toggled to unviewed', () => {
      const manager = createManager(['src/app.js']);
      const item = manager.renderFileItem(makeFile());
      document.body.appendChild(item);

      manager.updateFileItemViewedState('src/app.js', false);

      expect(item.classList.contains('viewed')).toBe(false);
      expect(item.querySelector('.file-viewed-icon-wrapper')).toBeNull();
    });

    it('does not duplicate the icon if called twice with isViewed=true', () => {
      const manager = createManager([]);
      const item = manager.renderFileItem(makeFile());
      document.body.appendChild(item);

      manager.updateFileItemViewedState('src/app.js', true);
      manager.updateFileItemViewedState('src/app.js', true);

      const icons = item.querySelectorAll('.file-viewed-icon-wrapper');
      expect(icons.length).toBe(1);
    });

    it('is a no-op when no matching sidebar row exists', () => {
      const manager = createManager([]);
      // No DOM element rendered — should not throw
      expect(() =>
        manager.updateFileItemViewedState('src/missing.js', true)
      ).not.toThrow();
    });

    it('handles paths containing characters that need CSS-escape', () => {
      const manager = createManager([]);
      const trickyPath = 'src/weird[brackets].js';
      const item = manager.renderFileItem(makeFile({ fullPath: trickyPath }));
      document.body.appendChild(item);

      manager.updateFileItemViewedState(trickyPath, true);

      expect(item.classList.contains('viewed')).toBe(true);
      expect(item.querySelector('.file-viewed-icon-wrapper')).not.toBeNull();
    });

    it('places viewed icon before rename icon when toggled on a renamed file', () => {
      const manager = createManager([]);
      const item = manager.renderFileItem(makeFile({
        renamed: true,
        renamedFrom: 'src/old.js',
      }));
      document.body.appendChild(item);

      manager.updateFileItemViewedState('src/app.js', true);

      const viewedIcon = item.querySelector('.file-viewed-icon-wrapper');
      const renameIcon = item.querySelector('.file-rename-icon-wrapper');
      const children = [...item.children];
      expect(children.indexOf(viewedIcon)).toBeLessThan(children.indexOf(renameIcon));
    });
  });
});
