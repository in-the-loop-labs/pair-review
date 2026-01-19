// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Tests for the section parser utility
 *
 * Tests parseSections, computeDelta, and applyDelta functions.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSections,
  getSectionOrder,
  sectionsToMap,
  computeDelta,
  applyDelta,
  rebuildTaggedPrompt
} from '../../src/ai/prompts/section-parser.js';

describe('Section Parser', () => {
  describe('parseSections', () => {
    it('should parse a simple section', () => {
      const tagged = '<section name="intro">Hello world</section>';
      const sections = parseSections(tagged);

      expect(sections).toHaveLength(1);
      expect(sections[0].name).toBe('intro');
      expect(sections[0].content).toBe('Hello world');
      expect(sections[0].locked).toBe(false);
      expect(sections[0].required).toBe(false);
      expect(sections[0].optional).toBe(false);
    });

    it('should parse locked sections', () => {
      const tagged = '<section name="schema" locked="true">{ "type": "object" }</section>';
      const sections = parseSections(tagged);

      expect(sections).toHaveLength(1);
      expect(sections[0].name).toBe('schema');
      expect(sections[0].locked).toBe(true);
    });

    it('should parse required sections', () => {
      const tagged = '<section name="instructions" required="true">Do the thing</section>';
      const sections = parseSections(tagged);

      expect(sections).toHaveLength(1);
      expect(sections[0].required).toBe(true);
    });

    it('should parse optional sections', () => {
      const tagged = '<section name="examples" optional="true">Here are examples</section>';
      const sections = parseSections(tagged);

      expect(sections).toHaveLength(1);
      expect(sections[0].optional).toBe(true);
    });

    it('should parse tier attribute', () => {
      const tagged = '<section name="detailed" tier="balanced,thorough">Extra details</section>';
      const sections = parseSections(tagged);

      expect(sections).toHaveLength(1);
      expect(sections[0].tier).toEqual(['balanced', 'thorough']);
    });

    it('should parse multiple sections in order', () => {
      const tagged = `
<section name="first">First content</section>
<section name="second">Second content</section>
<section name="third">Third content</section>
      `.trim();
      const sections = parseSections(tagged);

      expect(sections).toHaveLength(3);
      expect(sections[0].name).toBe('first');
      expect(sections[1].name).toBe('second');
      expect(sections[2].name).toBe('third');
    });

    it('should parse sections with multiple attributes', () => {
      const tagged = '<section name="critical" locked="true" required="true">Critical section</section>';
      const sections = parseSections(tagged);

      expect(sections).toHaveLength(1);
      expect(sections[0].locked).toBe(true);
      expect(sections[0].required).toBe(true);
    });

    it('should trim content whitespace', () => {
      const tagged = `<section name="spaced">

  Content with leading and trailing whitespace

</section>`;
      const sections = parseSections(tagged);

      expect(sections[0].content).toBe('Content with leading and trailing whitespace');
    });

    it('should preserve internal whitespace in content', () => {
      const tagged = '<section name="formatted">Line 1\n\nLine 2\n  Indented line</section>';
      const sections = parseSections(tagged);

      expect(sections[0].content).toBe('Line 1\n\nLine 2\n  Indented line');
    });

    it('should return empty array for text without sections', () => {
      const tagged = 'Just plain text without any section tags';
      const sections = parseSections(tagged);

      expect(sections).toEqual([]);
    });
  });

  describe('getSectionOrder', () => {
    it('should return section names in order', () => {
      const tagged = `
<section name="alpha">A</section>
<section name="beta">B</section>
<section name="gamma">C</section>
      `;
      const order = getSectionOrder(tagged);

      expect(order).toEqual(['alpha', 'beta', 'gamma']);
    });
  });

  describe('sectionsToMap', () => {
    it('should convert sections array to map', () => {
      const sections = [
        { name: 'a', content: 'A content', locked: false, required: false, optional: false },
        { name: 'b', content: 'B content', locked: true, required: false, optional: false }
      ];
      const map = sectionsToMap(sections);

      expect(map.get('a').content).toBe('A content');
      expect(map.get('b').locked).toBe(true);
    });
  });

  describe('computeDelta', () => {
    it('should detect unchanged sections', () => {
      const baseline = '<section name="intro">Same content</section>';
      const optimized = '<section name="intro">Same content</section>';
      const delta = computeDelta(baseline, optimized);

      expect(delta.sectionOrder).toEqual(['intro']);
      expect(delta.overrides).toEqual({});
      expect(delta.removedSections).toEqual([]);
      expect(delta.addedSections).toEqual([]);
    });

    it('should detect content overrides for non-locked sections', () => {
      const baseline = '<section name="intro">Original</section>';
      const optimized = '<section name="intro">Modified</section>';
      const delta = computeDelta(baseline, optimized);

      expect(delta.overrides).toEqual({ intro: 'Modified' });
    });

    it('should NOT create overrides for locked sections', () => {
      const baseline = '<section name="schema" locked="true">Original schema</section>';
      const optimized = '<section name="schema" locked="true">Modified schema</section>';
      const delta = computeDelta(baseline, optimized);

      // Even if content differs, locked sections should not be overridden
      expect(delta.overrides).toEqual({});
    });

    it('should detect removed sections', () => {
      const baseline = `
<section name="keep">Keep this</section>
<section name="remove">Remove this</section>
      `;
      const optimized = '<section name="keep">Keep this</section>';
      const delta = computeDelta(baseline, optimized);

      expect(delta.removedSections).toEqual(['remove']);
    });

    it('should detect added sections', () => {
      const baseline = '<section name="original">Original</section>';
      const optimized = `
<section name="original">Original</section>
<section name="new" required="true">New section content</section>
      `;
      const delta = computeDelta(baseline, optimized);

      expect(delta.addedSections).toHaveLength(1);
      expect(delta.addedSections[0].name).toBe('new');
      expect(delta.addedSections[0].content).toBe('New section content');
      expect(delta.addedSections[0].required).toBe(true);
    });

    it('should detect reordering', () => {
      const baseline = `
<section name="first">First</section>
<section name="second">Second</section>
      `;
      const optimized = `
<section name="second">Second</section>
<section name="first">First</section>
      `;
      const delta = computeDelta(baseline, optimized);

      expect(delta.sectionOrder).toEqual(['second', 'first']);
    });

    it('should handle complex deltas with multiple changes', () => {
      const baseline = `
<section name="locked" locked="true">Locked content</section>
<section name="modifiable">Original text</section>
<section name="removable" optional="true">To be removed</section>
      `;
      const optimized = `
<section name="new-intro">New introduction</section>
<section name="locked" locked="true">Locked content</section>
<section name="modifiable">Modified text</section>
      `;
      const delta = computeDelta(baseline, optimized);

      expect(delta.sectionOrder).toEqual(['new-intro', 'locked', 'modifiable']);
      expect(delta.overrides).toEqual({ modifiable: 'Modified text' });
      expect(delta.removedSections).toEqual(['removable']);
      expect(delta.addedSections[0].name).toBe('new-intro');
    });
  });

  describe('applyDelta', () => {
    it('should apply empty delta (no changes)', () => {
      const baseline = `
<section name="intro">Hello</section>
<section name="body">World</section>
      `;
      const delta = {
        sectionOrder: ['intro', 'body'],
        overrides: {},
        removedSections: [],
        addedSections: []
      };
      const result = applyDelta(baseline, delta);

      expect(result).toBe('Hello\n\nWorld');
    });

    it('should apply content overrides', () => {
      const baseline = '<section name="intro">Original</section>';
      const delta = {
        sectionOrder: ['intro'],
        overrides: { intro: 'Overridden content' },
        removedSections: [],
        addedSections: []
      };
      const result = applyDelta(baseline, delta);

      expect(result).toBe('Overridden content');
    });

    it('should NOT apply overrides to locked sections', () => {
      const baseline = '<section name="schema" locked="true">Original schema</section>';
      const delta = {
        sectionOrder: ['schema'],
        overrides: { schema: 'Should not appear' },
        removedSections: [],
        addedSections: []
      };
      const result = applyDelta(baseline, delta);

      expect(result).toBe('Original schema');
    });

    it('should remove sections', () => {
      const baseline = `
<section name="keep">Keep this</section>
<section name="remove">Remove this</section>
      `;
      const delta = {
        sectionOrder: ['keep', 'remove'],
        overrides: {},
        removedSections: ['remove'],
        addedSections: []
      };
      const result = applyDelta(baseline, delta);

      expect(result).toBe('Keep this');
      expect(result).not.toContain('Remove this');
    });

    it('should add new sections', () => {
      const baseline = '<section name="existing">Existing</section>';
      const delta = {
        sectionOrder: ['existing', 'new'],
        overrides: {},
        removedSections: [],
        addedSections: [{ name: 'new', content: 'New content' }]
      };
      const result = applyDelta(baseline, delta);

      expect(result).toBe('Existing\n\nNew content');
    });

    it('should reorder sections', () => {
      const baseline = `
<section name="first">First</section>
<section name="second">Second</section>
      `;
      const delta = {
        sectionOrder: ['second', 'first'],
        overrides: {},
        removedSections: [],
        addedSections: []
      };
      const result = applyDelta(baseline, delta);

      expect(result).toBe('Second\n\nFirst');
    });

    it('should handle complex delta with all operations', () => {
      const baseline = `
<section name="locked" locked="true">{{placeholder}}</section>
<section name="modifiable">Original modifiable</section>
<section name="removable">To remove</section>
      `;
      const delta = {
        sectionOrder: ['new-intro', 'locked', 'modifiable'],
        overrides: { modifiable: 'Modified content' },
        removedSections: ['removable'],
        addedSections: [{ name: 'new-intro', content: 'New introduction' }]
      };
      const result = applyDelta(baseline, delta);

      expect(result).toContain('New introduction');
      expect(result).toContain('{{placeholder}}');
      expect(result).toContain('Modified content');
      expect(result).not.toContain('To remove');
      expect(result).not.toContain('Original modifiable');

      // Verify order
      const lines = result.split('\n\n');
      expect(lines[0]).toBe('New introduction');
      expect(lines[1]).toBe('{{placeholder}}');
      expect(lines[2]).toBe('Modified content');
    });

    it('should clean up extra blank lines', () => {
      const baseline = `
<section name="a">A</section>
<section name="b">B</section>
      `;
      const delta = {
        sectionOrder: ['a', 'b'],
        overrides: {},
        removedSections: [],
        addedSections: []
      };
      const result = applyDelta(baseline, delta);

      // Should not have more than double newlines
      expect(result).not.toMatch(/\n{3,}/);
    });
  });

  describe('rebuildTaggedPrompt', () => {
    it('should rebuild simple sections', () => {
      const sections = [
        { name: 'intro', content: 'Hello', locked: false, required: false, optional: false }
      ];
      const result = rebuildTaggedPrompt(sections);

      expect(result).toBe('<section name="intro">\nHello\n</section>');
    });

    it('should include all attributes', () => {
      const sections = [
        { name: 'schema', content: '{}', locked: true, required: true, optional: false, tier: ['fast', 'balanced'] }
      ];
      const result = rebuildTaggedPrompt(sections);

      expect(result).toContain('locked="true"');
      expect(result).toContain('required="true"');
      expect(result).toContain('tier="fast,balanced"');
      expect(result).not.toContain('optional="true"');
    });

    it('should join multiple sections with double newlines', () => {
      const sections = [
        { name: 'a', content: 'A', locked: false, required: false, optional: false },
        { name: 'b', content: 'B', locked: false, required: false, optional: false }
      ];
      const result = rebuildTaggedPrompt(sections);

      expect(result).toContain('</section>\n\n<section');
    });
  });

  describe('Round-trip: parseSections -> rebuildTaggedPrompt', () => {
    it('should preserve section content through round-trip', () => {
      const original = `<section name="intro" required="true">
Introduction text
with multiple lines
</section>

<section name="schema" locked="true">
{ "type": "object" }
</section>`;

      const sections = parseSections(original);
      const rebuilt = rebuildTaggedPrompt(sections);
      const reparsed = parseSections(rebuilt);

      expect(reparsed).toHaveLength(2);
      expect(reparsed[0].name).toBe('intro');
      expect(reparsed[0].content).toBe(sections[0].content);
      expect(reparsed[1].name).toBe('schema');
      expect(reparsed[1].content).toBe(sections[1].content);
    });
  });

  describe('computeDelta -> applyDelta round-trip', () => {
    it('should produce consistent results when computing and applying delta', () => {
      const baseline = `
<section name="role" required="true">You are a code reviewer</section>
<section name="context" locked="true">{{prContext}}</section>
<section name="instructions" required="true">Review the code carefully</section>
<section name="examples" optional="true">Here are some examples</section>
      `;

      const optimized = `
<section name="role" required="true">You are an expert code reviewer</section>
<section name="context" locked="true">{{prContext}}</section>
<section name="new-focus">Focus on security issues</section>
<section name="instructions" required="true">Review with attention to detail</section>
      `;

      // Compute delta
      const delta = computeDelta(baseline, optimized);

      // Apply delta to baseline
      const result = applyDelta(baseline, delta);

      // Verify the result matches the optimized prompt structure
      expect(result).toContain('You are an expert code reviewer');
      expect(result).toContain('{{prContext}}');
      expect(result).toContain('Focus on security issues');
      expect(result).toContain('Review with attention to detail');
      expect(result).not.toContain('Here are some examples');
    });
  });
});
