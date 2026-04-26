// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from 'vitest';

global.window = global.window || {};

const { FileCommentManager } = require('../../public/js/modules/file-comment-manager.js');

function createTestFileCommentManager() {
  const fileCommentManager = Object.create(FileCommentManager.prototype);
  fileCommentManager.prManager = {
    currentPR: { id: 'test-review-1' }
  };
  return fileCommentManager;
}

describe('FileCommentManager.loadFileComments()', () => {
  afterEach(() => {
    delete global.document;
    delete global.window.DiffRenderer;
  });

  it('resolves file-level items through findZoneForFile before rendering', () => {
    const fileCommentManager = createTestFileCommentManager();
    const container = {
      querySelectorAll: vi.fn().mockReturnValue([])
    };
    const zone = {
      dataset: { fileName: 'src/file.js' },
      querySelector: vi.fn(selector => selector === '.file-comments-container' ? container : null)
    };

    global.document = {
      querySelectorAll: vi.fn().mockReturnValue([zone])
    };

    fileCommentManager.findZoneForFile = vi.fn(file => file === './src/file.js' ? zone : null);
    fileCommentManager.displayAISuggestion = vi.fn();
    fileCommentManager.displayUserComment = vi.fn();
    fileCommentManager.updateCommentCount = vi.fn();

    const comment = { file: './src/file.js', is_file_level: 1, body: 'User comment' };
    const suggestion = { file: './src/file.js', is_file_level: 1, body: 'AI suggestion' };

    fileCommentManager.loadFileComments([comment], [suggestion]);

    expect(fileCommentManager.findZoneForFile).toHaveBeenCalledWith('./src/file.js');
    expect(fileCommentManager.displayAISuggestion).toHaveBeenCalledWith(zone, suggestion);
    expect(fileCommentManager.displayUserComment).toHaveBeenCalledWith(zone, comment);
    expect(fileCommentManager.updateCommentCount).toHaveBeenCalledWith(zone);
  });
});

describe('FileCommentManager.findZoneForFile()', () => {
  afterEach(() => {
    delete global.document;
    delete global.CSS;
    delete global.window.DiffRenderer;
  });

  it('escapes CSS special characters in the fallback selector lookup', () => {
    const fileCommentManager = createTestFileCommentManager();
    const zone = { dataset: { fileName: 'src/routes/repos/"quoted"/route.tsx' } };
    const file = 'src/routes/repos/"quoted"/route.tsx';

    global.window.DiffRenderer = undefined;
    global.CSS = {
      escape: vi.fn(value => value.replace(/"/g, '\\"'))
    };
    global.document = {
      querySelector: vi.fn().mockReturnValue(zone)
    };

    const result = fileCommentManager.findZoneForFile(file);

    expect(global.CSS.escape).toHaveBeenCalledWith(file);
    expect(global.document.querySelector).toHaveBeenCalledWith(
      '.file-comments-zone[data-file-name="src/routes/repos/\\"quoted\\"/route.tsx"]'
    );
    expect(result).toBe(zone);
  });
});
