// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';

// The icons module writes to window.Icons, then re-exports via module.exports
global.window = global.window || {};
const { icon, DEFS } = require('../../public/js/utils/icons.js');

describe('Icons module', () => {
  describe('basic icon rendering', () => {
    it('returns an SVG string with default 16x16 dimensions and fill="currentColor"', () => {
      const svg = icon('discussion');
      expect(svg).toContain('viewBox="0 0 16 16"');
      expect(svg).toContain('width="16"');
      expect(svg).toContain('height="16"');
      expect(svg).toContain('fill="currentColor"');
    });
  });

  describe('custom dimensions', () => {
    it('accepts a single number for width and defaults height to match', () => {
      const svg = icon('discussion', 12);
      expect(svg).toContain('width="12"');
      expect(svg).toContain('height="12"');
    });
  });

  describe('width + height', () => {
    it('accepts separate width and height arguments', () => {
      const svg = icon('discussion', 12, 14);
      expect(svg).toContain('width="12"');
      expect(svg).toContain('height="14"');
    });
  });

  describe('object options', () => {
    it('accepts { width, height, className } and emits class attribute', () => {
      const svg = icon('discussion', { width: 10, height: 10, className: 'foo' });
      expect(svg).toContain('width="10"');
      expect(svg).toContain('height="10"');
      expect(svg).toContain('class="foo"');
    });

    it('defaults height to width when only width is provided', () => {
      const svg = icon('discussion', { width: 10 });
      expect(svg).toContain('width="10"');
      expect(svg).toContain('height="10"');
    });

    it('defaults both dimensions to 16 when only className is provided', () => {
      const svg = icon('discussion', { className: 'bar' });
      expect(svg).toContain('width="16"');
      expect(svg).toContain('height="16"');
      expect(svg).toContain('class="bar"');
    });

    it('accepts a style option and emits style attribute', () => {
      const svg = icon('commentFilled', { width: 16, height: 16, style: 'display:none' });
      expect(svg).toContain('style="display:none"');
      expect(svg).toContain('width="16"');
    });

    it('omits style attribute when style is not provided', () => {
      const svg = icon('discussion', { width: 16 });
      expect(svg).not.toContain('style=');
    });
  });

  describe('unknown icon', () => {
    it('returns empty string for an unrecognised name', () => {
      expect(icon('nonexistent')).toBe('');
    });
  });

  describe('non-standard viewBox', () => {
    it('preserves the 24-unit viewBox defined on brain', () => {
      const svg = icon('brain', 14, 14);
      expect(svg).toContain('viewBox="0 0 24 24"');
    });
  });

  describe('stroke-based icons', () => {
    it('logo renders with fill="none" and stroke="currentColor"', () => {
      const svg = icon('logo', 24, 24);
      expect(svg).toContain('fill="none"');
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).not.toContain('fill="currentColor"');
    });
  });

  describe('stroke-based sparkle', () => {
    it('sparkle renders with stroke="currentColor" and 24-unit viewBox', () => {
      const svg = icon('sparkle', 32, 32);
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).toContain('viewBox="0 0 24 24"');
    });
  });

  describe('alias', () => {
    it('speechBubble produces the same SVG content as comment', () => {
      const speechBubble = icon('speechBubble');
      const comment = icon('comment');
      // Both should produce identical SVG (same ICON_DEFS entry)
      expect(speechBubble).toBe(comment);
    });
  });

  describe('path content', () => {
    const cases = [
      ['discussion', 'M1.75 1h8.5c.966 0 1.75.784'],
      ['close', 'M3.72 3.72a.75.75 0 0 1 1.06'],
      ['check', 'M13.78 4.22a.75.75 0 0 1 0 1'],
      ['pencil', 'M11.013 1.427a1.75 1.75 0 0'],
      ['star', 'M8 .25a.75.75 0 01.673.418l1']
    ];

    it.each(cases)(
      '%s output contains the first 30 chars of its path d attribute',
      (name, pathPrefix) => {
        const svg = icon(name);
        expect(svg).toContain(pathPrefix);
      }
    );
  });

  describe('DEFS export', () => {
    it('contains at least 25 entries', () => {
      expect(Object.keys(DEFS).length).toBeGreaterThanOrEqual(25);
    });
  });

  describe('default height', () => {
    it('when only width is specified, height matches width', () => {
      const svg = icon('close', 20);
      expect(svg).toContain('width="20"');
      expect(svg).toContain('height="20"');
    });
  });

  describe('no className by default', () => {
    it('omits the class attribute when no className is given', () => {
      const svg = icon('close');
      expect(svg).not.toContain('class=');
    });
  });
});
