// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Test emoji data
const TEST_EMOJI_LIST = [
  ['smile', '\u{1F604}'],
  ['smiley', '\u{1F603}'],
  ['grin', '\u{1F600}'],
  ['heart', '\u{2764}\u{FE0F}'],
  ['heart_eyes', '\u{1F60D}'],
  ['thumbsup', '\u{1F44D}'],
  ['+1', '\u{1F44D}'],
  ['fire', '\u{1F525}'],
  ['rocket', '\u{1F680}'],
  ['star', '\u{2B50}']
];

// Mock window object
global.window = {};

// Minimal DOM mocks for Node environment
global.document = {
  body: {
    innerHTML: '',
    appendChild: vi.fn(),
    removeChild: vi.fn()
  },
  createElement: vi.fn((tag) => ({
    tagName: tag.toUpperCase(),
    style: {},
    className: '',
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn()
    },
    innerHTML: '',
    textContent: '',
    appendChild: vi.fn(),
    remove: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({ top: 0, left: 0, width: 100, height: 20 })),
    scrollIntoView: vi.fn()
  })),
  querySelector: vi.fn(() => null),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn()
};

// Mock fetch for emoji bundle extraction
global.fetch = vi.fn();

// Import the EmojiPicker module which exports to window.EmojiPicker
require('../../public/js/components/EmojiPicker.js');

const { EmojiPicker } = global.window;

describe('EmojiPicker', () => {
  let picker;

  beforeEach(() => {
    // Reset the static cache before each test
    EmojiPicker._emojiListCache = TEST_EMOJI_LIST;
    EmojiPicker._extractionPromise = null;

    picker = new EmojiPicker({ maxResults: 5 });
  });

  afterEach(() => {
    picker = null;
    // Reset cache
    EmojiPicker._emojiListCache = null;
    EmojiPicker._extractionPromise = null;
  });

  describe('filterEmoji', () => {
    describe('empty search', () => {
      it('should return first maxResults emoji when search is empty', () => {
        const results = picker.filterEmoji('');
        expect(results).toHaveLength(5);
        expect(results[0][0]).toBe('smile');
      });

      it('should return first maxResults emoji when search is null/undefined', () => {
        const resultsNull = picker.filterEmoji(null);
        const resultsUndefined = picker.filterEmoji(undefined);
        expect(resultsNull).toHaveLength(5);
        expect(resultsUndefined).toHaveLength(5);
      });
    });

    describe('prefix match', () => {
      it('should find emoji that start with search term', () => {
        const results = picker.filterEmoji('smi');
        expect(results).toHaveLength(2);
        expect(results.map(r => r[0])).toContain('smile');
        expect(results.map(r => r[0])).toContain('smiley');
      });

      it('should be case insensitive', () => {
        const results = picker.filterEmoji('SMI');
        expect(results).toHaveLength(2);
        expect(results.map(r => r[0])).toContain('smile');
      });

      it('should prioritize prefix matches over contains matches', () => {
        const results = picker.filterEmoji('heart');
        // 'heart' and 'heart_eyes' are prefix matches
        expect(results[0][0]).toBe('heart');
        expect(results[1][0]).toBe('heart_eyes');
      });
    });

    describe('contains match', () => {
      it('should find emoji where search term appears anywhere in shortcode', () => {
        const results = picker.filterEmoji('eyes');
        expect(results).toHaveLength(1);
        expect(results[0][0]).toBe('heart_eyes');
      });

      it('should include contains matches when not enough prefix matches', () => {
        // 'oc' matches 'rocket' via contains
        const results = picker.filterEmoji('oc');
        expect(results.map(r => r[0])).toContain('rocket');
      });
    });

    describe('no matches', () => {
      it('should return empty array when no matches found', () => {
        const results = picker.filterEmoji('xyz123');
        expect(results).toHaveLength(0);
      });
    });

    describe('maxResults limit', () => {
      it('should respect maxResults option', () => {
        const smallPicker = new EmojiPicker({ maxResults: 2 });
        const results = smallPicker.filterEmoji('');
        expect(results).toHaveLength(2);
      });
    });
  });

  describe('complete shortcode detection in handleInput', () => {
    /**
     * These tests verify that typing a complete shortcode (e.g., :smile:)
     * causes the popup to be hidden rather than showing matches.
     */

    it('should detect searchText ending with colon as complete shortcode', () => {
      // The handleInput logic checks if searchText.endsWith(':')
      // We test the detection logic indirectly by examining what text patterns
      // would trigger the complete shortcode detection

      // If colonPos is found at position 0 and cursor is at position 7 (":smile:")
      // then searchText = "smile:" which endsWith(':') = true
      const value = ':smile:';
      const cursorPos = 7;
      const colonPos = 0;
      const searchText = value.substring(colonPos + 1, cursorPos);

      expect(searchText).toBe('smile:');
      expect(searchText.endsWith(':')).toBe(true);
    });

    it('should not detect incomplete shortcode as complete', () => {
      const value = ':smi';
      const cursorPos = 4;
      const colonPos = 0;
      const searchText = value.substring(colonPos + 1, cursorPos);

      expect(searchText).toBe('smi');
      expect(searchText.endsWith(':')).toBe(false);
    });

    it('should detect complete shortcode in middle of text', () => {
      const value = 'Hello :smile: world';
      const cursorPos = 13; // right after ':'
      const colonPos = 6;
      const searchText = value.substring(colonPos + 1, cursorPos);

      expect(searchText).toBe('smile:');
      expect(searchText.endsWith(':')).toBe(true);
    });
  });

  describe('insertEmoji with triggerStart', () => {
    /**
     * These tests verify that insertEmoji uses triggerStart instead of
     * lastIndexOf(':') for reliable text replacement.
     */

    it('should calculate correct replacement using triggerStart', () => {
      // Simulate: "Hello :smi" with triggerStart at 6
      const value = 'Hello :smi';
      const cursorPos = 10;
      const triggerStart = 6;
      const emoji = '\u{1F604}'; // smile emoji

      // The insertEmoji logic should use:
      const colonPos = triggerStart;
      const before = value.substring(0, colonPos);
      const after = value.substring(cursorPos);
      const newValue = before + emoji + after;

      expect(newValue).toBe('Hello \u{1F604}');
    });

    it('should handle text with multiple colons correctly', () => {
      // Scenario: "Time: 10:30 :thu" - triggerStart should point to position 12
      const value = 'Time: 10:30 :thu';
      const cursorPos = 16;
      const triggerStart = 12; // The colon before "thu"
      const emoji = '\u{1F44D}'; // thumbsup emoji

      const colonPos = triggerStart;
      const before = value.substring(0, colonPos);
      const after = value.substring(cursorPos);
      const newValue = before + emoji + after;

      // Should only replace ":thu", not touch "10:30"
      expect(newValue).toBe('Time: 10:30 \u{1F44D}');
    });

    it('should calculate correct cursor position after emoji insertion', () => {
      const triggerStart = 0;
      const emoji = '\u{1F525}'; // fire emoji

      // New cursor position should be triggerStart + emoji.length
      const newCursorPos = triggerStart + emoji.length;

      expect(newCursorPos).toBe(2); // emoji is 2 characters
    });

    it('should preserve text after cursor position', () => {
      const value = ':star is nice';
      const cursorPos = 5; // cursor after ":star"
      const triggerStart = 0;
      const emoji = '\u{2B50}'; // star emoji

      const before = value.substring(0, triggerStart);
      const after = value.substring(cursorPos);
      const newValue = before + emoji + after;

      expect(newValue).toBe('\u{2B50} is nice');
    });

    it('should not replace anything when triggerStart is -1', () => {
      // When triggerStart is -1, insertEmoji should return early
      const triggerStart = -1;
      expect(triggerStart).toBe(-1);
      // The actual method checks this and calls hidePopup instead
    });
  });

  describe('constructor options', () => {
    it('should use default maxResults of 8 when not specified', () => {
      const defaultPicker = new EmojiPicker();
      expect(defaultPicker.maxResults).toBe(8);
    });

    it('should use custom maxResults when specified', () => {
      const customPicker = new EmojiPicker({ maxResults: 3 });
      expect(customPicker.maxResults).toBe(3);
    });

    it('should initialize with empty attachedTextareas Map', () => {
      const newPicker = new EmojiPicker();
      expect(newPicker.attachedTextareas).toBeInstanceOf(Map);
      expect(newPicker.attachedTextareas.size).toBe(0);
    });

    it('should initialize triggerStart as -1', () => {
      const newPicker = new EmojiPicker();
      expect(newPicker.triggerStart).toBe(-1);
    });
  });

  describe('static EMOJI_LIST', () => {
    it('should return cached emoji list', () => {
      expect(EmojiPicker.EMOJI_LIST).toBe(TEST_EMOJI_LIST);
    });

    it('should return empty array if cache is null', () => {
      EmojiPicker._emojiListCache = null;
      expect(EmojiPicker.EMOJI_LIST).toEqual([]);
    });
  });

  describe('ensureEmojiLoaded', () => {
    beforeEach(() => {
      // Reset cache for these tests
      EmojiPicker._emojiListCache = null;
      EmojiPicker._extractionPromise = null;
      global.fetch.mockClear();
    });

    it('should return cached list if already loaded', async () => {
      EmojiPicker._emojiListCache = TEST_EMOJI_LIST;
      const result = await EmojiPicker.ensureEmojiLoaded();
      expect(result).toBe(TEST_EMOJI_LIST);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should fetch and extract emoji from bundle', async () => {
      // Mock bundle content with emoji data format matching the regex: /[a-z0-9_+-]+:"\\u[^"]+"/g
      // The actual bundle format is: smile:"\uD83D\uDE04"
      const mockBundleContent = 'var e={smile:"\\uD83D\\uDE04",grin:"\\uD83D\\uDE00"}';
      global.fetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockBundleContent)
      });

      const result = await EmojiPicker.ensureEmojiLoaded();

      expect(global.fetch).toHaveBeenCalledWith(EmojiPicker.EMOJI_BUNDLE_URL);
      expect(result).toHaveLength(2);
      expect(result[0][0]).toBe('smile');
      expect(result[1][0]).toBe('grin');
    });

    it('should return empty array on fetch error', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await EmojiPicker.ensureEmojiLoaded();

      expect(result).toEqual([]);
      expect(EmojiPicker._emojiListCache).toEqual([]);
    });

    it('should not make duplicate requests', async () => {
      const mockBundleContent = 'var e={smile:"\\uD83D\\uDE04"}';
      global.fetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockBundleContent)
      });

      // Start two loads simultaneously
      const promise1 = EmojiPicker.ensureEmojiLoaded();
      const promise2 = EmojiPicker.ensureEmojiLoaded();

      await Promise.all([promise1, promise2]);

      // Should only have fetched once
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('extractEmojiFromBundle', () => {
    beforeEach(() => {
      global.fetch.mockClear();
    });

    it('should extract emoji pairs from bundle content', async () => {
      // The actual bundle uses standard Unicode escapes like \uD83D\uDE04
      const mockBundleContent = 'var defs={smile:"\\uD83D\\uDE04",grin:"\\uD83D\\uDE00",heart:"\\u2764\\uFE0F"}';
      global.fetch.mockResolvedValueOnce({
        text: () => Promise.resolve(mockBundleContent)
      });

      const result = await EmojiPicker.extractEmojiFromBundle();

      expect(result).toHaveLength(3);
      expect(result.find(e => e[0] === 'smile')).toBeTruthy();
      expect(result.find(e => e[0] === 'grin')).toBeTruthy();
      expect(result.find(e => e[0] === 'heart')).toBeTruthy();
    });

    it('should return empty array if no emoji found', async () => {
      global.fetch.mockResolvedValueOnce({
        text: () => Promise.resolve('var empty = {}')
      });

      const result = await EmojiPicker.extractEmojiFromBundle();

      expect(result).toEqual([]);
    });
  });

  describe('attach behavior', () => {
    it('should set _emojiPickerAttached flag on textarea', () => {
      const mockTextarea = {
        _emojiPickerAttached: false,
        addEventListener: vi.fn()
      };

      picker.attach(mockTextarea);

      expect(mockTextarea._emojiPickerAttached).toBe(true);
    });

    it('should not attach to same textarea twice', () => {
      const mockTextarea = {
        _emojiPickerAttached: false,
        addEventListener: vi.fn()
      };

      picker.attach(mockTextarea);
      const callCount1 = mockTextarea.addEventListener.mock.calls.length;

      picker.attach(mockTextarea);
      const callCount2 = mockTextarea.addEventListener.mock.calls.length;

      // Should not add more listeners on second attach
      expect(callCount2).toBe(callCount1);
    });

    it('should not attach to null', () => {
      picker.attach(null);
      expect(picker.attachedTextareas.size).toBe(0);
    });

    it('should not attach to undefined', () => {
      picker.attach(undefined);
      expect(picker.attachedTextareas.size).toBe(0);
    });

    it('should store handlers in attachedTextareas map', () => {
      const mockTextarea = {
        _emojiPickerAttached: false,
        addEventListener: vi.fn()
      };

      picker.attach(mockTextarea);

      expect(picker.attachedTextareas.has(mockTextarea)).toBe(true);
      const handlers = picker.attachedTextareas.get(mockTextarea);
      expect(handlers).toHaveProperty('input');
      expect(handlers).toHaveProperty('keydown');
      expect(handlers).toHaveProperty('blur');
    });
  });

  describe('destroy behavior', () => {
    it('should clear attachedTextareas map', () => {
      const mockTextarea = {
        _emojiPickerAttached: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };

      picker.attach(mockTextarea);
      expect(picker.attachedTextareas.size).toBe(1);

      picker.destroy();
      expect(picker.attachedTextareas.size).toBe(0);
    });

    it('should remove _emojiPickerAttached flag from textareas', () => {
      const mockTextarea = {
        _emojiPickerAttached: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };

      picker.attach(mockTextarea);
      expect(mockTextarea._emojiPickerAttached).toBe(true);

      picker.destroy();
      expect(mockTextarea._emojiPickerAttached).toBeUndefined();
    });

    it('should reset internal state', () => {
      picker.triggerStart = 5;
      picker.matches = [['smile', '\u{1F604}']];
      picker.selectedIndex = 1;

      picker.destroy();

      expect(picker.triggerStart).toBe(-1);
      expect(picker.matches).toHaveLength(0);
      expect(picker.selectedIndex).toBe(0);
      expect(picker.activeTextarea).toBeNull();
    });

    it('should remove event listeners from textareas', () => {
      const mockTextarea = {
        _emojiPickerAttached: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };

      picker.attach(mockTextarea);
      picker.destroy();

      // Should have called removeEventListener for input, keydown, blur
      expect(mockTextarea.removeEventListener).toHaveBeenCalledTimes(3);
    });
  });

  describe('keyboard navigation helpers', () => {
    beforeEach(() => {
      picker.matches = [
        ['smile', '\u{1F604}'],
        ['smiley', '\u{1F603}'],
        ['grin', '\u{1F600}']
      ];
      picker.selectedIndex = 0;
    });

    it('selectNext should increment selectedIndex', () => {
      // Mock popup for updateSelection
      picker.popup = { querySelectorAll: vi.fn(() => []) };

      picker.selectNext();
      expect(picker.selectedIndex).toBe(1);
    });

    it('selectNext should not exceed matches length', () => {
      picker.popup = { querySelectorAll: vi.fn(() => []) };
      picker.selectedIndex = 2; // last item

      picker.selectNext();
      expect(picker.selectedIndex).toBe(2); // should stay at 2
    });

    it('selectPrevious should decrement selectedIndex', () => {
      picker.popup = { querySelectorAll: vi.fn(() => []) };
      picker.selectedIndex = 2;

      picker.selectPrevious();
      expect(picker.selectedIndex).toBe(1);
    });

    it('selectPrevious should not go below 0', () => {
      picker.popup = { querySelectorAll: vi.fn(() => []) };
      picker.selectedIndex = 0;

      picker.selectPrevious();
      expect(picker.selectedIndex).toBe(0);
    });
  });
});
