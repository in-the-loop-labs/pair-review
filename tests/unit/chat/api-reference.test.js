// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

const { renderApiDocs, buildApiCheatSheet } = require('../../../src/chat/api-reference');

describe('renderApiDocs', () => {
  it('should substitute all {{PORT}} placeholders with the real port', () => {
    const md = renderApiDocs({ port: 7247, reviewId: 1 });
    expect(md).not.toContain('{{PORT}}');
    expect(md).toContain('localhost:7247');
  });

  it('should substitute all {{REVIEW_ID}} placeholders with the real reviewId', () => {
    const md = renderApiDocs({ port: 7247, reviewId: 42 });
    expect(md).not.toContain('{{REVIEW_ID}}');
    expect(md).toContain('/reviews/42/');
  });

  it('should contain no remaining template placeholders', () => {
    const md = renderApiDocs({ port: 3000, reviewId: 99 });
    expect(md).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('should throw when reviewId is null', () => {
    expect(() => renderApiDocs({ port: 7247, reviewId: null })).toThrow();
  });

  it('should throw when reviewId is undefined', () => {
    expect(() => renderApiDocs({ port: 7247 })).toThrow();
  });

  it('should include all major API sections', () => {
    const md = renderApiDocs({ port: 7247, reviewId: 1 });
    expect(md).toContain('## Comments');
    expect(md).toContain('## Suggestions');
    expect(md).toContain('## Analysis Launch');
    expect(md).toContain('## Analysis Management');
    expect(md).toContain('## Comment Types');
    expect(md).toContain('## Context Files');
    expect(md).toContain('## Diff Hunk Expansion');
  });

  it('should not include the behavioral preamble from SKILL.md', () => {
    const md = renderApiDocs({ port: 7247, reviewId: 1 });
    expect(md).not.toContain('read-only access to the filesystem');
    expect(md).not.toContain('pair-review-api');
  });

  it('should not include the Notes section from SKILL.md', () => {
    const md = renderApiDocs({ port: 7247, reviewId: 1 });
    expect(md).not.toContain('Replace `PORT`');
  });
});

describe('buildApiCheatSheet', () => {
  it('should be under 2.5KB', () => {
    const sheet = buildApiCheatSheet({ port: 7247, reviewId: 1 });
    expect(Buffer.byteLength(sheet, 'utf8')).toBeLessThan(2560);
  });

  it('should stay under 2.5KB with worst-case port and reviewId values', () => {
    const sheet = buildApiCheatSheet({ port: 65535, reviewId: 99999 });
    expect(Buffer.byteLength(sheet, 'utf8')).toBeLessThan(2560);
  });

  it('should contain all major endpoint categories', () => {
    const sheet = buildApiCheatSheet({ port: 7247, reviewId: 1 });
    expect(sheet).toMatch(/comment/i);
    expect(sheet).toMatch(/suggest/i);
    expect(sheet).toMatch(/analy/i);
    expect(sheet).toMatch(/context.?file/i);
  });

  it('should use real port and reviewId values (no template placeholders)', () => {
    const sheet = buildApiCheatSheet({ port: 9999, reviewId: 55 });
    expect(sheet).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(sheet).toContain('9999');
    expect(sheet).toContain('55');
  });

  it('should include the full docs URL', () => {
    const sheet = buildApiCheatSheet({ port: 7247, reviewId: 10 });
    expect(sheet).toContain('http://localhost:7247/api.md?reviewId=10');
  });

  it('should throw when reviewId is null', () => {
    expect(() => buildApiCheatSheet({ port: 7247, reviewId: null })).toThrow();
  });

  it('should throw when port is null', () => {
    expect(() => buildApiCheatSheet({ port: null, reviewId: 1 })).toThrow();
  });
});
