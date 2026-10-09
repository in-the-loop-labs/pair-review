// @vitest-environment jsdom

import { describe, it, expect, afterAll } from 'vitest';

// Loads window.SmartTruncate and the global window.smartTruncate instance
require('../../public/js/components/SmartTruncate.js');
const { DiffRenderer } = require('../../public/js/modules/diff-renderer.js');

describe('DiffRenderer.createFileHeader file name', () => {
  afterAll(() => {
    window.smartTruncate.destroy();
  });

  it('front-truncates the path with the full path as tooltip text', () => {
    const path = 'src/components/very/deep/folder/MyComponent.test.js';
    const header = DiffRenderer.createFileHeader(path);
    const fileName = header.querySelector('.d2h-file-name');

    expect(fileName.classList.contains('smart-truncate')).toBe(true);
    expect(fileName.classList.contains('smart-truncate--start')).toBe(true);
    expect(fileName.querySelector(':scope > .smart-truncate__text').textContent).toBe(path);
    expect(fileName.dataset.fullText).toBe(path);
    expect(fileName.textContent).toBe(path);
  });

  it('keeps rename markup inside the truncating wrapper and uses "old → new" as tooltip text', () => {
    const header = DiffRenderer.createFileHeader('src/new/place/file.js', {
      renamed: true,
      renamedFrom: 'src/old/place/file.js'
    });
    const fileName = header.querySelector('.d2h-file-name');
    const inner = fileName.querySelector(':scope > .smart-truncate__text');

    expect(inner.querySelector('.file-rename-old-path').textContent).toBe('src/old/place/file.js');
    expect(inner.querySelector('.file-rename-arrow').textContent).toBe('\u2192');
    expect(fileName.dataset.fullText).toBe('src/old/place/file.js \u2192 src/new/place/file.js');
  });

  it('degrades to plain text when SmartTruncate is not loaded', () => {
    const saved = window.SmartTruncate;
    delete window.SmartTruncate;
    try {
      const header = DiffRenderer.createFileHeader('a/b.js');
      const fileName = header.querySelector('.d2h-file-name');
      expect(fileName.textContent).toBe('a/b.js');
      expect(fileName.classList.contains('smart-truncate')).toBe(false);
    } finally {
      window.SmartTruncate = saved;
    }
  });
});
