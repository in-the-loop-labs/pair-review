// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for DiffOptionsDropdown component
 *
 * Tests scope selector rendering conditions, disabled branch tooltip,
 * branch click-when-disabled behavior, and tooltip clearing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Create a mock DOM element with the methods used by DiffOptionsDropdown.
 */
function createMockElement(tag) {
  const children = [];
  let textContentValue = '';

  const element = {
    tagName: tag?.toUpperCase(),
    className: '',
    style: {},
    title: '',
    dataset: {},
    _children: children,
    _attributes: {},
    get textContent() {
      return textContentValue;
    },
    set textContent(val) {
      textContentValue = val;
    },
    setAttribute: vi.fn(function (name, value) { this._attributes[name] = value; }),
    getAttribute: vi.fn(function (name) { return this._attributes[name] ?? null; }),
    appendChild: vi.fn((child) => {
      children.push(child);
      return child;
    }),
    remove: vi.fn(),
    querySelector: vi.fn((selector) => {
      // Support 'input' selector for checkbox lookup inside labels
      if (selector === 'input') {
        return children.find((c) => c.tagName === 'INPUT') || null;
      }
      return null;
    }),
    querySelectorAll: vi.fn().mockReturnValue([]),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    contains: vi.fn(() => false),
    classList: {
      _classes: [],
      add: vi.fn(function (cls) { if (!this._classes.includes(cls)) this._classes.push(cls); }),
      remove: vi.fn(function (cls) { this._classes = this._classes.filter((c) => c !== cls); }),
      contains: vi.fn(function (cls) { return this._classes.includes(cls); }),
      toggle: vi.fn(function (cls, force) {
        if (force) {
          if (!this._classes.includes(cls)) this._classes.push(cls);
        } else {
          this._classes = this._classes.filter((c) => c !== cls);
        }
      })
    },
    getBoundingClientRect: vi.fn(() => ({ top: 0, left: 0, right: 100, bottom: 30, width: 100, height: 30 })),
    focus: vi.fn(),
    click: vi.fn()
  };
  return element;
}

// Setup minimal DOM globals before importing the component
beforeEach(() => {
  vi.resetAllMocks();

  global.document = {
    readyState: 'complete',
    getElementById: vi.fn().mockReturnValue(null),
    createElement: vi.fn().mockImplementation((tag) => createMockElement(tag)),
    createTextNode: vi.fn((text) => ({ nodeType: 3, textContent: text })),
    body: { appendChild: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };

  global.window = {
    PAIR_REVIEW_LOCAL_MODE: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };

  global.localStorage = {
    _store: {},
    getItem: vi.fn((key) => global.localStorage._store[key] ?? null),
    setItem: vi.fn((key, value) => { global.localStorage._store[key] = value; }),
    removeItem: vi.fn((key) => { delete global.localStorage._store[key]; }),
    clear: vi.fn(() => { global.localStorage._store = {}; })
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.document;
  delete global.window;
  delete global.localStorage;
});

/**
 * Import the component after globals are set. Clears the native CJS require
 * cache so the file re-evaluates with the current window/document globals.
 * (vi.resetModules() only clears Vitest's ESM transform cache, not require.cache.)
 */
const MODULE_PATH = '../../public/js/components/DiffOptionsDropdown.js';

function getDiffOptionsDropdown() {
  const resolved = require.resolve(MODULE_PATH);
  delete require.cache[resolved];
  require(MODULE_PATH);
  return global.window.DiffOptionsDropdown;
}

/**
 * Load the module and return the browser-facing readPersistedDiffView global
 * (the same reference pr.js and local.js call).
 */
function getReadPersistedDiffView() {
  getDiffOptionsDropdown();
  return global.window.readPersistedDiffView;
}

/**
 * Helper: create a dropdown instance with sensible defaults.
 * Merges caller overrides into the callbacks object.
 */
function createDropdown(overrides = {}) {
  const DiffOptionsDropdown = getDiffOptionsDropdown();
  const btn = createMockElement('button');
  const opts = {
    onToggleWhitespace: vi.fn(),
    onToggleMinimize: vi.fn(),
    ...overrides
  };
  return new DiffOptionsDropdown(btn, opts);
}

/**
 * Helper: find the scope-selector-section child inside the popover.
 */
function findScopeSection(dropdown) {
  const popover = dropdown._popoverEl;
  if (!popover) return null;
  return popover._children.find((c) => c.className === 'scope-selector-section') || null;
}

/**
 * Helper: find the stop container with dataset.stop === stopName.
 * Walks through the scope stops tracked by the component.
 */
function findStopContainer(dropdown, stopName) {
  const entry = dropdown._scopeStops.find((s) => s.stop === stopName);
  return entry ? entry.containerEl : null;
}

/**
 * Helper: invoke the registered 'click' handler on a mock element.
 * The mock's addEventListener is a vi.fn recording [event, handler] pairs.
 */
function fireClick(el) {
  const call = el.addEventListener.mock.calls.find((c) => c[0] === 'click');
  if (call) call[1]({ stopPropagation: vi.fn() });
}

describe('DiffOptionsDropdown', () => {
  describe('scope selector rendering', () => {
    it('renders scope selector when onScopeChange is provided (fallback path, no globals)', () => {
      // No PAIR_REVIEW_LOCAL_MODE, no window.LocalScope — only the callback
      global.window.PAIR_REVIEW_LOCAL_MODE = false;
      delete global.window.LocalScope;

      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        initialScope: { start: 'unstaged', end: 'untracked' },
        branchAvailable: false
      });

      const section = findScopeSection(dropdown);
      expect(section).not.toBeNull();
    });

    it('renders scope selector when both globals are set (normal local mode path)', () => {
      global.window.PAIR_REVIEW_LOCAL_MODE = true;
      global.window.LocalScope = {
        STOPS: ['branch', 'staged', 'unstaged', 'untracked'],
        DEFAULT_SCOPE: { start: 'unstaged', end: 'untracked' },
        isValidScope: () => true,
        scopeIncludes: (s, e, stop) => {
          const stops = ['branch', 'staged', 'unstaged', 'untracked'];
          return stops.indexOf(stop) >= stops.indexOf(s) && stops.indexOf(stop) <= stops.indexOf(e);
        }
      };

      const dropdown = createDropdown({
        initialScope: { start: 'unstaged', end: 'untracked' },
        branchAvailable: true
      });

      const section = findScopeSection(dropdown);
      expect(section).not.toBeNull();
    });

    it('does NOT render scope selector in PR mode (no globals, no onScopeChange)', () => {
      global.window.PAIR_REVIEW_LOCAL_MODE = false;
      delete global.window.LocalScope;

      const dropdown = createDropdown();

      const section = findScopeSection(dropdown);
      expect(section).toBeNull();
    });
  });

  describe('disabled branch stop tooltip', () => {
    it('shows tooltip when branchAvailable is false', () => {
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        initialScope: { start: 'unstaged', end: 'untracked' },
        branchAvailable: false
      });

      const branchContainer = findStopContainer(dropdown, 'branch');
      expect(branchContainer).not.toBeNull();
      expect(branchContainer.title).toBe('No feature branch detected');
    });

    it('clears tooltip when branchAvailable becomes true', () => {
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        initialScope: { start: 'unstaged', end: 'untracked' },
        branchAvailable: false
      });

      const branchContainer = findStopContainer(dropdown, 'branch');
      expect(branchContainer.title).toBe('No feature branch detected');

      // Simulate branch becoming available
      dropdown.branchAvailable = true;

      expect(branchContainer.title).toBe('');
    });
  });

  describe('branch stop click when disabled', () => {
    it('ignores click on disabled branch stop (scope does not change)', () => {
      vi.useFakeTimers();
      try {
        const onScopeChange = vi.fn();
        const dropdown = createDropdown({
          onScopeChange,
          initialScope: { start: 'staged', end: 'untracked' },
          branchAvailable: false
        });

        const scopeBefore = { ...dropdown.scope };

        // Simulate clicking the branch stop via the internal handler
        dropdown._handleStopClick('branch', { stopPropagation: vi.fn(), altKey: false });

        // Advance past the 600ms debounce window
        vi.advanceTimersByTime(700);

        // Scope should remain unchanged
        expect(dropdown.scope.start).toBe(scopeBefore.start);
        expect(dropdown.scope.end).toBe(scopeBefore.end);
        // onScopeChange should never have been called, not even after debounce
        expect(onScopeChange).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('base branch input', () => {
    /**
     * Helper: invoke a registered event handler on the base branch input.
     */
    function fireInputEvent(input, eventName, eventProps = {}) {
      const call = input.addEventListener.mock.calls.find((c) => c[0] === eventName);
      if (call) call[1]({ stopPropagation: vi.fn(), preventDefault: vi.fn(), ...eventProps });
    }

    it('renders the row visible when branch is in scope', () => {
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange: vi.fn(),
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      expect(dropdown._baseBranchRowEl).not.toBeNull();
      expect(dropdown._baseBranchRowEl.style.display).toBe('flex');
      expect(dropdown._baseBranchInput.value).toBe('main');
    });

    it('hides the row when branch is not in scope', () => {
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange: vi.fn(),
        initialScope: { start: 'unstaged', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      expect(dropdown._baseBranchRowEl.style.display).toBe('none');
    });

    it('does not render the row without onBaseBranchChange', () => {
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        initialScope: { start: 'branch', end: 'untracked' },
        branchAvailable: true
      });

      expect(dropdown._baseBranchRowEl).toBeNull();
      expect(dropdown._baseBranchInput).toBeNull();
    });

    it('shows the row when the scope expands to include branch', () => {
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange: vi.fn(),
        initialScope: { start: 'unstaged', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      expect(dropdown._baseBranchRowEl.style.display).toBe('none');

      dropdown.scope = { start: 'branch', end: 'untracked' };

      expect(dropdown._baseBranchRowEl.style.display).toBe('flex');
    });

    it('fires onBaseBranchChange on Enter with a changed value', () => {
      const onBaseBranchChange = vi.fn();
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange,
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      dropdown._baseBranchInput.value = '  origin/main  ';
      fireInputEvent(dropdown._baseBranchInput, 'keydown', { key: 'Enter' });

      expect(onBaseBranchChange).toHaveBeenCalledTimes(1);
      expect(onBaseBranchChange).toHaveBeenCalledWith('origin/main');
      expect(dropdown.baseBranch).toBe('origin/main');
    });

    it('fires onBaseBranchChange when the confirm button is clicked', () => {
      const onBaseBranchChange = vi.fn();
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange,
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      dropdown._baseBranchInput.value = 'origin/main';
      fireInputEvent(dropdown._baseBranchInput, 'input');
      fireClick(dropdown._baseBranchConfirmBtn);

      expect(onBaseBranchChange).toHaveBeenCalledTimes(1);
      expect(onBaseBranchChange).toHaveBeenCalledWith('origin/main');
    });

    it('enables the confirm button only while the value is dirty', () => {
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange: vi.fn(),
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      expect(dropdown._baseBranchConfirmBtn.disabled).toBe(true);

      dropdown._baseBranchInput.value = 'origin/main';
      fireInputEvent(dropdown._baseBranchInput, 'input');
      expect(dropdown._baseBranchConfirmBtn.disabled).toBe(false);

      dropdown._baseBranchInput.value = 'main';
      fireInputEvent(dropdown._baseBranchInput, 'input');
      expect(dropdown._baseBranchConfirmBtn.disabled).toBe(true);
    });

    it('disables the confirm button after committing', () => {
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange: vi.fn(),
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      dropdown._baseBranchInput.value = 'origin/main';
      fireInputEvent(dropdown._baseBranchInput, 'input');
      fireInputEvent(dropdown._baseBranchInput, 'keydown', { key: 'Enter' });

      expect(dropdown._baseBranchConfirmBtn.disabled).toBe(true);
    });

    it('ignores clicks on the disabled confirm button', () => {
      const onBaseBranchChange = vi.fn();
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange,
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      fireClick(dropdown._baseBranchConfirmBtn);

      expect(onBaseBranchChange).not.toHaveBeenCalled();
    });

    it('discards a pending edit when the popover closes', () => {
      const onBaseBranchChange = vi.fn();
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange,
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      dropdown._baseBranchInput.value = 'origin/main';
      fireInputEvent(dropdown._baseBranchInput, 'input');

      dropdown._hide();

      expect(onBaseBranchChange).not.toHaveBeenCalled();
      expect(dropdown._baseBranchInput.value).toBe('main');
      expect(dropdown._baseBranchConfirmBtn.disabled).toBe(true);
    });

    it('does not fire on an unchanged value', () => {
      const onBaseBranchChange = vi.fn();
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange,
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      dropdown._baseBranchInput.value = 'main';
      fireInputEvent(dropdown._baseBranchInput, 'keydown', { key: 'Enter' });

      expect(onBaseBranchChange).not.toHaveBeenCalled();
    });

    it('reverts an empty value without firing', () => {
      const onBaseBranchChange = vi.fn();
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange,
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      dropdown._baseBranchInput.value = '   ';
      fireInputEvent(dropdown._baseBranchInput, 'keydown', { key: 'Enter' });

      expect(onBaseBranchChange).not.toHaveBeenCalled();
      expect(dropdown._baseBranchInput.value).toBe('main');
    });

    it('reverts the input on Escape without firing', () => {
      const onBaseBranchChange = vi.fn();
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange,
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      dropdown._baseBranchInput.value = 'orig';
      fireInputEvent(dropdown._baseBranchInput, 'input');
      fireInputEvent(dropdown._baseBranchInput, 'keydown', { key: 'Escape' });

      expect(onBaseBranchChange).not.toHaveBeenCalled();
      expect(dropdown._baseBranchInput.value).toBe('main');
      expect(dropdown._baseBranchConfirmBtn.disabled).toBe(true);
    });

    it('locks the input while a commit is in flight', () => {
      const onBaseBranchChange = vi.fn();
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange,
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      dropdown._baseBranchInput.value = 'origin/main';
      fireInputEvent(dropdown._baseBranchInput, 'keydown', { key: 'Enter' });

      expect(onBaseBranchChange).toHaveBeenCalledTimes(1);
      expect(dropdown._baseBranchInput.disabled).toBe(true);
      expect(dropdown._baseBranchConfirmBtn.disabled).toBe(true);

      // A second commit while busy must not fire
      dropdown._baseBranchInput.value = 'origin/master';
      fireInputEvent(dropdown._baseBranchInput, 'keydown', { key: 'Enter' });
      fireClick(dropdown._baseBranchConfirmBtn);

      expect(onBaseBranchChange).toHaveBeenCalledTimes(1);
    });

    it('unlocks the input when clearScopeStatus is called', () => {
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange: vi.fn(),
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      dropdown._baseBranchInput.value = 'origin/main';
      fireInputEvent(dropdown._baseBranchInput, 'keydown', { key: 'Enter' });
      expect(dropdown._baseBranchInput.disabled).toBe(true);

      dropdown.clearScopeStatus();

      expect(dropdown._baseBranchInput.disabled).toBe(false);
      expect(dropdown._scopeMutationBusy).toBe(false);
    });

    it('ignores scope stop clicks while a base commit is in flight', () => {
      vi.useFakeTimers();
      try {
        const onScopeChange = vi.fn();
        const dropdown = createDropdown({
          onScopeChange,
          onBaseBranchChange: vi.fn(),
          initialScope: { start: 'branch', end: 'untracked' },
          initialBaseBranch: 'main',
          branchAvailable: true
        });

        dropdown._baseBranchInput.value = 'origin/main';
        fireInputEvent(dropdown._baseBranchInput, 'keydown', { key: 'Enter' });

        dropdown._handleStopClick('branch', { stopPropagation: vi.fn(), altKey: false });
        vi.advanceTimersByTime(700);

        expect(dropdown.scope.start).toBe('branch');
        expect(onScopeChange).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('locks the base branch input while a scope change is in flight', () => {
      vi.useFakeTimers();
      try {
        const onBaseBranchChange = vi.fn();
        const dropdown = createDropdown({
          onScopeChange: vi.fn(),
          onBaseBranchChange,
          initialScope: { start: 'staged', end: 'untracked' },
          initialBaseBranch: 'main',
          branchAvailable: true
        });

        // Toggle branch on — fires a scope change after the debounce
        dropdown._handleStopClick('branch', { stopPropagation: vi.fn(), altKey: false });
        vi.advanceTimersByTime(700);

        expect(dropdown._scopeMutationBusy).toBe(true);
        expect(dropdown._baseBranchInput.disabled).toBe(true);

        // Base commits are ignored while the scope change is loading
        dropdown._baseBranchInput.value = 'origin/main';
        fireInputEvent(dropdown._baseBranchInput, 'keydown', { key: 'Enter' });
        expect(onBaseBranchChange).not.toHaveBeenCalled();

        dropdown.clearScopeStatus();
        expect(dropdown._baseBranchInput.disabled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('unlocks and reverts on the rollback path', () => {
      const onBaseBranchChange = vi.fn();
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange,
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      dropdown._baseBranchInput.value = 'bogus';
      fireInputEvent(dropdown._baseBranchInput, 'keydown', { key: 'Enter' });
      expect(dropdown._baseBranchInput.disabled).toBe(true);

      // local.js error path: revert then clear
      dropdown.baseBranch = 'main';
      dropdown.clearScopeStatus();

      expect(dropdown._baseBranchInput.disabled).toBe(false);
      expect(dropdown._baseBranchInput.value).toBe('main');
      expect(onBaseBranchChange).toHaveBeenCalledTimes(1);
    });

    it('baseBranch setter updates the input without firing the callback', () => {
      const onBaseBranchChange = vi.fn();
      const dropdown = createDropdown({
        onScopeChange: vi.fn(),
        onBaseBranchChange,
        initialScope: { start: 'branch', end: 'untracked' },
        initialBaseBranch: 'main',
        branchAvailable: true
      });

      dropdown.baseBranch = 'origin/main';

      expect(dropdown._baseBranchInput.value).toBe('origin/main');
      expect(onBaseBranchChange).not.toHaveBeenCalled();
    });
  });

  describe('diff view control', () => {
    it('renders Unified and Split option buttons', () => {
      const dropdown = createDropdown();
      expect(dropdown._diffViewButtons).toBeTruthy();
      expect(dropdown._diffViewButtons.unified).toBeTruthy();
      expect(dropdown._diffViewButtons.split).toBeTruthy();
    });

    it('defaults to unified when no stored value and no option', () => {
      const dropdown = createDropdown();
      expect(dropdown.diffView).toBe('unified');
      expect(dropdown._diffViewButtons.unified.getAttribute('aria-pressed')).toBe('true');
      expect(dropdown._diffViewButtons.split.getAttribute('aria-pressed')).toBe('false');
    });

    it('initializes from localStorage when set to split', () => {
      global.localStorage._store['pair-review-diff-view'] = 'split';
      const dropdown = createDropdown();
      expect(dropdown.diffView).toBe('split');
      expect(dropdown._diffViewButtons.split.getAttribute('aria-pressed')).toBe('true');
    });

    it('localStorage wins over the diffView constructor option', () => {
      global.localStorage._store['pair-review-diff-view'] = 'split';
      const dropdown = createDropdown({ diffView: 'unified' });
      expect(dropdown.diffView).toBe('split');
    });

    it('falls back to the diffView option when localStorage is empty', () => {
      const dropdown = createDropdown({ diffView: 'split' });
      expect(dropdown.diffView).toBe('split');
    });

    it('falls back to unified when the stored value is invalid', () => {
      global.localStorage._store['pair-review-diff-view'] = 'sideways';
      const dropdown = createDropdown({ diffView: 'bogus' });
      expect(dropdown.diffView).toBe('unified');
    });

    it('does NOT fire onDiffViewChange on construction (no double render)', () => {
      global.localStorage._store['pair-review-diff-view'] = 'split';
      const onDiffViewChange = vi.fn();
      createDropdown({ onDiffViewChange });
      expect(onDiffViewChange).not.toHaveBeenCalled();
    });

    it('fires onDiffViewChange and persists when the Split button is clicked', () => {
      const onDiffViewChange = vi.fn();
      const dropdown = createDropdown({ onDiffViewChange });

      fireClick(dropdown._diffViewButtons.split);

      expect(dropdown.diffView).toBe('split');
      expect(onDiffViewChange).toHaveBeenCalledTimes(1);
      expect(onDiffViewChange).toHaveBeenCalledWith('split');
      expect(global.localStorage._store['pair-review-diff-view']).toBe('split');
      expect(dropdown._diffViewButtons.split.getAttribute('aria-pressed')).toBe('true');
      expect(dropdown._diffViewButtons.unified.getAttribute('aria-pressed')).toBe('false');
    });

    it('no-ops when the already-active option is clicked', () => {
      const onDiffViewChange = vi.fn();
      const dropdown = createDropdown({ onDiffViewChange });

      // Already 'unified' — clicking Unified should do nothing.
      fireClick(dropdown._diffViewButtons.unified);

      expect(dropdown.diffView).toBe('unified');
      expect(onDiffViewChange).not.toHaveBeenCalled();
    });

    it('setter ignores invalid values', () => {
      const onDiffViewChange = vi.fn();
      const dropdown = createDropdown({ onDiffViewChange });

      dropdown.diffView = 'diagonal';

      expect(dropdown.diffView).toBe('unified');
      expect(onDiffViewChange).not.toHaveBeenCalled();
    });

    it('setter applies a valid change, persists, and fires the callback', () => {
      const onDiffViewChange = vi.fn();
      const dropdown = createDropdown({ onDiffViewChange });

      dropdown.diffView = 'split';

      expect(dropdown.diffView).toBe('split');
      expect(onDiffViewChange).toHaveBeenCalledWith('split');
      expect(global.localStorage._store['pair-review-diff-view']).toBe('split');
    });

    it('rolls back and does NOT persist when the callback returns false', () => {
      // Renderer can't honor the mode (e.g. no Pierre bridge on a fallback
      // page): the callback vetoes with `false`. The dropdown must revert to
      // the previous mode, leave localStorage untouched, and keep the
      // segmented control showing the old (correct) selection.
      const onDiffViewChange = vi.fn(() => false);
      const dropdown = createDropdown({ onDiffViewChange });

      dropdown.diffView = 'split';

      expect(onDiffViewChange).toHaveBeenCalledWith('split');
      expect(dropdown.diffView).toBe('unified');
      expect(global.localStorage._store['pair-review-diff-view']).toBeUndefined();
      expect(dropdown._diffViewButtons.unified.getAttribute('aria-pressed')).toBe('true');
      expect(dropdown._diffViewButtons.split.getAttribute('aria-pressed')).toBe('false');
    });

    it('rolls back when the Split button click is vetoed by the callback', () => {
      const onDiffViewChange = vi.fn(() => false);
      const dropdown = createDropdown({ onDiffViewChange });

      fireClick(dropdown._diffViewButtons.split);

      expect(dropdown.diffView).toBe('unified');
      expect(global.localStorage._store['pair-review-diff-view']).toBeUndefined();
      expect(dropdown._diffViewButtons.split.getAttribute('aria-pressed')).toBe('false');
      expect(dropdown._diffViewButtons.unified.getAttribute('aria-pressed')).toBe('true');
    });

    it('treats an undefined callback return as success (back-compat)', () => {
      // Callbacks that return nothing must still persist and update the UI.
      const onDiffViewChange = vi.fn(() => undefined);
      const dropdown = createDropdown({ onDiffViewChange });

      dropdown.diffView = 'split';

      expect(dropdown.diffView).toBe('split');
      expect(global.localStorage._store['pair-review-diff-view']).toBe('split');
      expect(dropdown._diffViewButtons.split.getAttribute('aria-pressed')).toBe('true');
    });

    it('treats an explicit true callback return as success', () => {
      const onDiffViewChange = vi.fn(() => true);
      const dropdown = createDropdown({ onDiffViewChange });

      dropdown.diffView = 'split';

      expect(dropdown.diffView).toBe('split');
      expect(global.localStorage._store['pair-review-diff-view']).toBe('split');
      expect(dropdown._diffViewButtons.split.getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('diffViewAvailable capability flag', () => {
    it('renders the control by default (flag omitted)', () => {
      const dropdown = createDropdown();
      expect(dropdown._diffViewButtons).toBeTruthy();
    });

    it('renders the control when diffViewAvailable is true', () => {
      const dropdown = createDropdown({ diffViewAvailable: true });
      expect(dropdown._diffViewButtons).toBeTruthy();
    });

    it('omits the control when diffViewAvailable is false', () => {
      const dropdown = createDropdown({ diffViewAvailable: false });
      expect(dropdown._diffViewButtons).toBeNull();
    });

    it('does not render a diff-view-row when unavailable', () => {
      const dropdown = createDropdown({ diffViewAvailable: false });
      const row = dropdown._popoverEl._children.find((c) => c.className === 'diff-view-row');
      expect(row).toBeUndefined();
    });

    it('still exposes the persisted diffView getter when the control is hidden', () => {
      global.localStorage._store['pair-review-diff-view'] = 'split';
      const dropdown = createDropdown({ diffViewAvailable: false });
      // The stored value is still read; only the toggle UI is suppressed.
      expect(dropdown.diffView).toBe('split');
    });

    it('the setter is a safe no-op on UI when the control is hidden', () => {
      const dropdown = createDropdown({ diffViewAvailable: false });
      expect(() => { dropdown.diffView = 'split'; }).not.toThrow();
      expect(dropdown.diffView).toBe('split');
    });
  });
});

describe('readPersistedDiffView', () => {
  it('returns the stored value when it is a valid mode (split)', () => {
    global.localStorage._store['pair-review-diff-view'] = 'split';
    const readPersistedDiffView = getReadPersistedDiffView();
    expect(readPersistedDiffView()).toBe('split');
  });

  it('returns the stored value when it is a valid mode (unified)', () => {
    global.localStorage._store['pair-review-diff-view'] = 'unified';
    const readPersistedDiffView = getReadPersistedDiffView();
    expect(readPersistedDiffView()).toBe('unified');
  });

  it('returns unified when the key is missing', () => {
    const readPersistedDiffView = getReadPersistedDiffView();
    expect(readPersistedDiffView()).toBe('unified');
  });

  it('returns unified for a garbage stored value', () => {
    global.localStorage._store['pair-review-diff-view'] = 'sideways';
    const readPersistedDiffView = getReadPersistedDiffView();
    expect(readPersistedDiffView()).toBe('unified');
  });

  it('returns unified when localStorage.getItem throws', () => {
    const readPersistedDiffView = getReadPersistedDiffView();
    global.localStorage.getItem = vi.fn(() => { throw new Error('denied'); });
    expect(readPersistedDiffView()).toBe('unified');
  });
});
