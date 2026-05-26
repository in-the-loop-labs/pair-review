// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Unit tests for TourRenderer.
 *
 * Verifies anchor lookup by (file_path, side, line_start), annotation row
 * structure, body class toggling, active-stop highlighting, and graceful
 * handling of missing anchors / collapsed files.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { TourRenderer } = require('../../public/js/modules/tour-renderer.js');

/**
 * Build a minimal table mimicking the diff-renderer output: one file wrapper
 * with a few `<tr>` rows tagged via `data-line-number` / `data-side` /
 * `data-file-name` exactly the way diff-renderer.js does.
 */
function buildDiff(filePath = 'src/foo.js', extra = {}) {
  document.body.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'd2h-file-wrapper';
  wrapper.dataset.fileName = filePath;
  if (extra.collapsed) wrapper.classList.add('collapsed');

  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  const lines = extra.lines || [
    { line: 10, side: 'RIGHT' },
    { line: 11, side: 'RIGHT' },
    { line: 12, side: 'RIGHT' },
    { line: 7,  side: 'LEFT' },
  ];
  for (const { line, side } of lines) {
    const tr = document.createElement('tr');
    tr.dataset.lineNumber = String(line);
    tr.dataset.side = side;
    tr.dataset.fileName = filePath;
    const td = document.createElement('td');
    td.className = 'd2h-code-line-ctn';
    td.textContent = `line ${line}/${side}`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrapper.appendChild(table);
  document.body.appendChild(wrapper);
  return { wrapper, tbody };
}

function makeStop(overrides = {}) {
  return {
    file_path: 'src/foo.js',
    side: 'RIGHT',
    line_start: 11,
    line_end: 11,
    title: 'Stop title',
    description: 'Stop description',
    ...overrides,
  };
}

describe('TourRenderer', () => {
  let renderer;

  beforeEach(() => {
    document.body.classList.remove('tour-active');
    document.body.innerHTML = '';
    renderer = new TourRenderer({});
  });

  describe('setActive', () => {
    it('toggles the body.tour-active class', () => {
      renderer.setActive(true);
      expect(document.body.classList.contains('tour-active')).toBe(true);
      renderer.setActive(false);
      expect(document.body.classList.contains('tour-active')).toBe(false);
    });
  });

  describe('mountStop', () => {
    it('inserts the annotation row immediately before the anchor', () => {
      buildDiff();
      renderer.setStops([makeStop({ line_start: 11 })]);
      const row = renderer.mountStop(0);
      expect(row).toBeTruthy();
      expect(row.classList.contains('tour-annotation-row')).toBe(true);
      const anchor = document.querySelector('tr[data-line-number="11"][data-side="RIGHT"]');
      expect(anchor.previousElementSibling).toBe(row);
    });

    it('looks up by side as well as line number', () => {
      buildDiff();
      renderer.setStops([makeStop({ side: 'LEFT', line_start: 7 })]);
      const row = renderer.mountStop(0);
      expect(row).toBeTruthy();
      const anchor = document.querySelector('tr[data-line-number="7"][data-side="LEFT"]');
      expect(anchor.previousElementSibling).toBe(row);
    });

    it('renders title and description from the stop', () => {
      buildDiff();
      renderer.setStops([makeStop({ title: 'My title', description: 'My description.' })]);
      const row = renderer.mountStop(0);
      expect(row.querySelector('.tour-annotation-title').textContent).toBe('My title');
      expect(row.querySelector('.tour-annotation-description').textContent).toBe('My description.');
    });

    it('includes a per-stop "Stop N of M" marker', () => {
      buildDiff();
      renderer.setStops([
        makeStop({ line_start: 10 }),
        makeStop({ line_start: 11 }),
        makeStop({ line_start: 12 }),
      ]);
      const row = renderer.mountStop(1);
      expect(row.querySelector('.tour-stop-marker').textContent).toMatch(/Stop 2 of 3/);
    });

    it('returns null when no wrapper exists for the file', () => {
      buildDiff('src/other.js');
      renderer.setStops([makeStop({ file_path: 'src/missing.js' })]);
      const row = renderer.mountStop(0);
      expect(row).toBeNull();
    });

    it('returns null when the anchor row is missing', () => {
      buildDiff();
      renderer.setStops([makeStop({ line_start: 9999 })]);
      const row = renderer.mountStop(0);
      expect(row).toBeNull();
    });

    it('expands a collapsed file wrapper before mounting', () => {
      const { wrapper } = buildDiff('src/foo.js', { collapsed: true });
      // Provide a real prManager API; without it the renderer refuses
      // to expand (we don't strip the collapsed class directly because
      // that desyncs PRManager.collapsedFiles from the DOM).
      const pm = {
        toggleFileCollapse(path) {
          if (path === 'src/foo.js') wrapper.classList.remove('collapsed');
        }
      };
      renderer = new TourRenderer(pm);
      renderer.setStops([makeStop({ line_start: 11 })]);
      renderer.mountStop(0);
      expect(wrapper.classList.contains('collapsed')).toBe(false);
    });

    it('prefers prManager.toggleFileCollapse when available', () => {
      const { wrapper } = buildDiff('src/foo.js', { collapsed: true });
      let called = null;
      const pm = {
        toggleFileCollapse(path) {
          called = path;
          wrapper.classList.remove('collapsed');
        },
      };
      renderer = new TourRenderer(pm);
      renderer.setStops([makeStop({ line_start: 11 })]);
      renderer.mountStop(0);
      expect(called).toBe('src/foo.js');
      expect(wrapper.classList.contains('collapsed')).toBe(false);
    });

    it('is idempotent — remount of the same index returns the existing row', () => {
      buildDiff();
      renderer.setStops([makeStop({ line_start: 11 })]);
      const first = renderer.mountStop(0);
      const second = renderer.mountStop(0);
      expect(second).toBe(first);
      expect(document.querySelectorAll('.tour-annotation-row')).toHaveLength(1);
    });
  });

  describe('"Chat about" button', () => {
    it('renders a chat button on every mounted stop annotation', () => {
      buildDiff();
      renderer.setStops([makeStop({ line_start: 11 })]);
      const row = renderer.mountStop(0);
      const btn = row.querySelector('.tour-annotation-chat-btn');
      expect(btn).toBeTruthy();
      // Reuses the shared ai-action / ai-action-chat classes so it matches
      // the comment/suggestion variants visually.
      expect(btn.classList.contains('ai-action')).toBe(true);
      expect(btn.classList.contains('ai-action-chat')).toBe(true);
      expect(btn.getAttribute('title')).toMatch(/chat/i);
      expect(btn.dataset.stopIndex).toBe('0');
    });

    it('invokes window.chatPanel.open with the stop context on click', () => {
      buildDiff();
      const opened = [];
      window.chatPanel = {
        open: (opts) => opened.push(opts),
      };
      const pm = { currentPR: { id: 'review-42' } };
      renderer = new TourRenderer(pm);
      renderer.setStops([
        makeStop({
          line_start: 11,
          line_end: 13,
          title: 'A stop',
          description: 'Describe the change.',
          file_path: 'src/foo.js',
          side: 'RIGHT',
        }),
        makeStop({ line_start: 12 }),
      ]);
      const row = renderer.mountStop(0);
      const btn = row.querySelector('.tour-annotation-chat-btn');
      btn.click();

      expect(opened).toHaveLength(1);
      const call = opened[0];
      expect(call.reviewId).toBe('review-42');
      expect(call.tourContext).toEqual({
        stopIndex: 0,
        totalStops: 2,
        title: 'A stop',
        description: 'Describe the change.',
        file: 'src/foo.js',
        line_start: 11,
        line_end: 13,
        side: 'RIGHT',
      });

      delete window.chatPanel;
    });

    it('is a no-op when window.chatPanel is missing', () => {
      buildDiff();
      renderer.setStops([makeStop({ line_start: 11 })]);
      const row = renderer.mountStop(0);
      const btn = row.querySelector('.tour-annotation-chat-btn');
      // Must not throw even without a chat panel mounted (e.g. very early
      // in startup, or in test harnesses).
      expect(() => btn.click()).not.toThrow();
    });
  });

  describe('unmountStop / unmountAll', () => {
    it('removes a specific stop row', () => {
      buildDiff();
      renderer.setStops([makeStop({ line_start: 11 })]);
      renderer.mountStop(0);
      expect(renderer.unmountStop(0)).toBe(true);
      expect(document.querySelectorAll('.tour-annotation-row')).toHaveLength(0);
      // Second call is a no-op now that the row is gone.
      expect(renderer.unmountStop(0)).toBe(false);
    });

    it('removes every mounted row', () => {
      buildDiff();
      renderer.setStops([
        makeStop({ line_start: 10 }),
        makeStop({ line_start: 11 }),
        makeStop({ line_start: 12 }),
      ]);
      renderer.mountStop(0);
      renderer.mountStop(1);
      renderer.mountStop(2);
      expect(document.querySelectorAll('.tour-annotation-row')).toHaveLength(3);
      renderer.unmountAll();
      expect(document.querySelectorAll('.tour-annotation-row')).toHaveLength(0);
    });
  });

  describe('highlightActive', () => {
    it('moves the active-stop class to the indexed row', () => {
      buildDiff();
      renderer.setStops([
        makeStop({ line_start: 10 }),
        makeStop({ line_start: 11 }),
        makeStop({ line_start: 12 }),
      ]);
      renderer.mountStop(0);
      renderer.mountStop(1);
      renderer.mountStop(2);

      renderer.highlightActive(1);
      const rows = document.querySelectorAll('.tour-annotation-row');
      expect(rows[0].classList.contains('active-stop')).toBe(false);
      expect(rows[1].classList.contains('active-stop')).toBe(true);
      expect(rows[2].classList.contains('active-stop')).toBe(false);

      renderer.highlightActive(2);
      expect(rows[1].classList.contains('active-stop')).toBe(false);
      expect(rows[2].classList.contains('active-stop')).toBe(true);
    });
  });

  describe('setStops', () => {
    it('unmounts every previously-mounted row when stops are replaced', () => {
      buildDiff();
      renderer.setStops([
        makeStop({ line_start: 10 }),
        makeStop({ line_start: 11 }),
      ]);
      renderer.mountStop(0);
      renderer.mountStop(1);
      expect(document.querySelectorAll('.tour-annotation-row')).toHaveLength(2);

      renderer.setStops([makeStop({ line_start: 12 })]);
      // Stale mounted rows from the old indices must be gone — otherwise
      // they would orphan in the DOM since `_mounted` is keyed by index
      // and the index map silently remaps to the new stops list.
      expect(document.querySelectorAll('.tour-annotation-row')).toHaveLength(0);
    });

    it('clears the internal _mounted map on replace', () => {
      buildDiff();
      renderer.setStops([makeStop({ line_start: 10 })]);
      renderer.mountStop(0);
      expect(renderer._mounted.size).toBe(1);

      renderer.setStops([]);
      expect(renderer._mounted.size).toBe(0);
    });
  });

  describe('mountStop does not expand wrappers when anchor is missing', () => {
    it('leaves a collapsed wrapper collapsed when no anchor row exists', () => {
      const { wrapper } = buildDiff('src/foo.js', { collapsed: true });
      renderer.setStops([makeStop({ line_start: 9999 })]);
      const row = renderer.mountStop(0);
      expect(row).toBeNull();
      // Critical: we must not have expanded the file just to learn the
      // anchor was missing — that would visually disrupt the page for nothing.
      expect(wrapper.classList.contains('collapsed')).toBe(true);
    });
  });

  describe('auto-expanded files are restored on tour exit', () => {
    it('records the path in _autoExpanded and triggers exactly one toggle', () => {
      const { wrapper } = buildDiff('src/foo.js', { collapsed: true });
      const calls = [];
      const pm = {
        toggleFileCollapse(path) {
          calls.push(path);
          // Reflect the real PRManager behavior of flipping the class.
          wrapper.classList.toggle('collapsed');
        }
      };
      renderer = new TourRenderer(pm);
      renderer.setStops([makeStop({ line_start: 11 })]);
      renderer.mountStop(0);
      expect(calls).toEqual(['src/foo.js']);
      expect(renderer._autoExpanded.has('src/foo.js')).toBe(true);
      expect(wrapper.classList.contains('collapsed')).toBe(false);
    });

    it('unmountAll re-collapses everything in _autoExpanded and clears it', () => {
      const { wrapper } = buildDiff('src/foo.js', { collapsed: true });
      const calls = [];
      const pm = {
        toggleFileCollapse(path) {
          calls.push(path);
          wrapper.classList.toggle('collapsed');
        }
      };
      renderer = new TourRenderer(pm);
      renderer.setStops([makeStop({ line_start: 11 })]);
      renderer.mountStop(0);
      expect(wrapper.classList.contains('collapsed')).toBe(false);

      renderer.unmountAll();
      // toggleFileCollapse was called twice: once to expand, once to
      // re-collapse on unmountAll.
      expect(calls).toEqual(['src/foo.js', 'src/foo.js']);
      expect(wrapper.classList.contains('collapsed')).toBe(true);
      expect(renderer._autoExpanded.size).toBe(0);
    });

    it('mountStop refuses to strip the class when toggleFileCollapse is missing', () => {
      const { wrapper } = buildDiff('src/foo.js', { collapsed: true });
      // prManager without toggleFileCollapse — must NOT strip the class
      // directly, since that would desync PRManager.collapsedFiles from
      // the DOM. Instead it should bail and skip the stop.
      const pm = {};
      renderer = new TourRenderer(pm);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        renderer.setStops([makeStop({ line_start: 11 })]);
        const row = renderer.mountStop(0);
        expect(row).toBeNull();
        expect(wrapper.classList.contains('collapsed')).toBe(true);
        expect(renderer._autoExpanded.size).toBe(0);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('unmountAll honors a user manually re-collapsing during the tour', () => {
      const { wrapper } = buildDiff('src/foo.js', { collapsed: true });
      const calls = [];
      const pm = {
        toggleFileCollapse(path) {
          calls.push(path);
          wrapper.classList.toggle('collapsed');
        }
      };
      renderer = new TourRenderer(pm);
      renderer.setStops([makeStop({ line_start: 11 })]);
      renderer.mountStop(0);
      // User manually re-collapses mid-tour:
      pm.toggleFileCollapse('src/foo.js');
      expect(wrapper.classList.contains('collapsed')).toBe(true);
      calls.length = 0;

      renderer.unmountAll();
      // Since the file is already collapsed, we should NOT toggle again.
      expect(calls).toEqual([]);
    });
  });

  describe('mountStop range anchor lookup (line_start..line_end)', () => {
    it('anchors at the first existing row inside [line_start+1, line_end]', () => {
      // Only line 13 exists; range is [11, 13].
      buildDiff('src/foo.js', {
        lines: [
          { line: 13, side: 'RIGHT' },
          { line: 14, side: 'RIGHT' }
        ]
      });
      renderer.setStops([makeStop({ line_start: 11, line_end: 13 })]);
      const row = renderer.mountStop(0);
      expect(row).toBeTruthy();
      const anchor = document.querySelector('tr[data-line-number="13"][data-side="RIGHT"]');
      expect(anchor.previousElementSibling).toBe(row);
    });

    it('warns and returns null when no row in [line_start, line_end] exists', () => {
      buildDiff('src/foo.js', {
        lines: [
          { line: 100, side: 'RIGHT' }
        ]
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        renderer.setStops([makeStop({ line_start: 11, line_end: 13 })]);
        const row = renderer.mountStop(0);
        expect(row).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('honors single-line range (line_end === line_start) as exact-match lookup', () => {
      buildDiff();
      renderer.setStops([makeStop({ line_start: 11, line_end: 11 })]);
      const row = renderer.mountStop(0);
      expect(row).toBeTruthy();
      const anchor = document.querySelector('tr[data-line-number="11"][data-side="RIGHT"]');
      expect(anchor.previousElementSibling).toBe(row);
    });
  });

  describe('scrollToStop honors prefers-reduced-motion', () => {
    it('uses behavior:auto when prefers-reduced-motion is set', () => {
      // Mock matchMedia BEFORE constructing the renderer (the value is
      // cached on the instance for the lifetime of the tour).
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = (q) => ({
        matches: q === '(prefers-reduced-motion: reduce)',
        media: q,
        addEventListener() {},
        removeEventListener() {},
      });
      try {
        buildDiff();
        const motionRenderer = new TourRenderer({});
        motionRenderer.setStops([makeStop({ line_start: 11 })]);
        motionRenderer.mountStop(0);
        const row = motionRenderer._mounted.get(0);
        let captured = null;
        row.scrollIntoView = (opts) => { captured = opts; };
        motionRenderer.scrollToStop(0);
        expect(captured).toEqual({ behavior: 'auto', block: 'center' });
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it('uses behavior:smooth when prefers-reduced-motion is NOT set', () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = (q) => ({
        matches: false,
        media: q,
        addEventListener() {},
        removeEventListener() {},
      });
      try {
        buildDiff();
        const motionRenderer = new TourRenderer({});
        motionRenderer.setStops([makeStop({ line_start: 11 })]);
        motionRenderer.mountStop(0);
        const row = motionRenderer._mounted.get(0);
        let captured = null;
        row.scrollIntoView = (opts) => { captured = opts; };
        motionRenderer.scrollToStop(0);
        expect(captured).toEqual({ behavior: 'smooth', block: 'center' });
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });
  });

  // ----------------------------------------------------------------------
  // prepareStop — the async "ensure mountable" step the navigator awaits
  // before mountStop. Two concerns: (1) unfold folded gaps so anchor rows
  // exist (ensureLinesVisible), and (2) auto-add files that aren't in the
  // PR diff at all (ensureContextFile). Both routed through PRManager so
  // the tour doesn't reimplement file-fetch / DB plumbing.
  // ----------------------------------------------------------------------
  describe('prepareStop', () => {
    it('returns false when prManager is missing', async () => {
      buildDiff();
      const r = new TourRenderer(null);
      r.setStops([makeStop({ line_start: 11 })]);
      expect(await r.prepareStop(0)).toBe(false);
    });

    it('returns false when the stop index is out of range', async () => {
      const pm = { ensureLinesVisible: vi.fn().mockResolvedValue() };
      const r = new TourRenderer(pm);
      r.setStops([]);
      expect(await r.prepareStop(0)).toBe(false);
      expect(pm.ensureLinesVisible).not.toHaveBeenCalled();
    });

    it('returns false when file_path or line_start is missing', async () => {
      const pm = { ensureLinesVisible: vi.fn().mockResolvedValue() };
      const r = new TourRenderer(pm);
      r.setStops([{ side: 'RIGHT', line_start: 11 }]); // no file_path
      expect(await r.prepareStop(0)).toBe(false);
      r.setStops([{ file_path: 'src/foo.js', side: 'RIGHT' }]); // no line_start
      expect(await r.prepareStop(0)).toBe(false);
      expect(pm.ensureLinesVisible).not.toHaveBeenCalled();
    });

    it('calls ensureLinesVisible to unfold a gap covering the stop range', async () => {
      buildDiff();
      const pm = {
        ensureLinesVisible: vi.fn().mockResolvedValue(),
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ file_path: 'src/foo.js', line_start: 11, line_end: 14, side: 'RIGHT' })]);
      await r.prepareStop(0);
      expect(pm.ensureLinesVisible).toHaveBeenCalledWith([
        { file: 'src/foo.js', line_start: 11, line_end: 14, side: 'RIGHT' },
      ]);
    });

    it('does NOT call ensureContextFile when the file wrapper is already present', async () => {
      buildDiff('src/foo.js');
      const pm = {
        ensureContextFile: vi.fn().mockResolvedValue({ type: 'context', contextFile: { id: 99 } }),
        ensureLinesVisible: vi.fn().mockResolvedValue(),
        contextFiles: [],
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ file_path: 'src/foo.js', line_start: 11 })]);
      await r.prepareStop(0);
      expect(pm.ensureContextFile).not.toHaveBeenCalled();
    });

    it('calls ensureContextFile when the file wrapper is missing', async () => {
      buildDiff('src/other.js'); // wrapper present for a DIFFERENT file
      const pm = {
        ensureContextFile: vi.fn().mockResolvedValue({
          type: 'context',
          contextFile: { id: 42, file: 'src/missing.js', line_start: 11, line_end: 11 },
        }),
        ensureLinesVisible: vi.fn().mockResolvedValue(),
        contextFiles: [], // file is NOT a pre-existing context file
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ file_path: 'src/missing.js', line_start: 11, line_end: 11 })]);
      await r.prepareStop(0);
      expect(pm.ensureContextFile).toHaveBeenCalledWith('src/missing.js', 11, 11);
    });

    it('tracks the auto-added context-file id for tour-exit cleanup', async () => {
      buildDiff('src/other.js');
      const pm = {
        ensureContextFile: vi.fn().mockResolvedValue({
          type: 'context',
          contextFile: { id: 42, file: 'src/missing.js' },
        }),
        ensureLinesVisible: vi.fn().mockResolvedValue(),
        contextFiles: [],
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ file_path: 'src/missing.js', line_start: 11 })]);
      await r.prepareStop(0);
      expect(r._autoAddedContextFileIds.has(42)).toBe(true);
    });

    it('does NOT track ids of context files that were already user-added', async () => {
      buildDiff('src/other.js');
      const pm = {
        ensureContextFile: vi.fn().mockResolvedValue({
          type: 'context',
          contextFile: { id: 99, file: 'src/already.js' },
          expanded: true,
        }),
        ensureLinesVisible: vi.fn().mockResolvedValue(),
        // User had already added this file as a context file before the
        // tour started; the tour's PATCH-to-expand-range should NOT cause
        // the file to be removed on exit.
        contextFiles: [{ id: 99, file: 'src/already.js', line_start: 1, line_end: 5 }],
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ file_path: 'src/already.js', line_start: 11 })]);
      await r.prepareStop(0);
      expect(r._autoAddedContextFileIds.has(99)).toBe(false);
    });

    it('swallows ensureContextFile errors and still attempts ensureLinesVisible', async () => {
      buildDiff('src/other.js');
      const pm = {
        ensureContextFile: vi.fn().mockRejectedValue(new Error('network')),
        ensureLinesVisible: vi.fn().mockResolvedValue(),
        contextFiles: [],
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ file_path: 'src/missing.js', line_start: 11 })]);
      const result = await r.prepareStop(0);
      expect(result).toBe(true);
      expect(pm.ensureLinesVisible).toHaveBeenCalled();
    });

    it('swallows ensureLinesVisible errors so mountStop still gets a chance', async () => {
      buildDiff();
      const pm = {
        ensureLinesVisible: vi.fn().mockRejectedValue(new Error('boom')),
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ line_start: 11 })]);
      expect(await r.prepareStop(0)).toBe(true);
    });

    it('defaults line_end to line_start when missing', async () => {
      buildDiff();
      const pm = { ensureLinesVisible: vi.fn().mockResolvedValue() };
      const r = new TourRenderer(pm);
      r.setStops([{ file_path: 'src/foo.js', side: 'RIGHT', line_start: 11 }]);
      await r.prepareStop(0);
      expect(pm.ensureLinesVisible).toHaveBeenCalledWith([
        { file: 'src/foo.js', line_start: 11, line_end: 11, side: 'RIGHT' },
      ]);
    });

    // --------------------------------------------------------------------
    // Regression: prepareStop must be staleness-aware against `_tourGen`.
    // The old code unconditionally tracked the auto-added id AFTER the
    // ensureContextFile await — but unmountAll runs synchronously on
    // exit and snapshots `_autoAddedContextFileIds` at that moment.
    // An add after the snapshot would orphan the context file forever.
    // --------------------------------------------------------------------
    it('rolls back the auto-added context file when the tour exits during the POST', async () => {
      buildDiff('src/other.js'); // wrapper missing for src/missing.js
      let resolvePost;
      const ensureCalls = [];
      const pm = {
        _tourGen: 1,
        contextFiles: [],
        ensureContextFile: vi.fn((file, ls, le) => {
          ensureCalls.push({ file, ls, le });
          return new Promise((res) => {
            resolvePost = () => res({
              type: 'context',
              contextFile: { id: 77, file, line_start: ls, line_end: le },
            });
          });
        }),
        ensureLinesVisible: vi.fn().mockResolvedValue(),
        removeContextFile: vi.fn().mockResolvedValue(),
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ file_path: 'src/missing.js', line_start: 11 })]);

      // Start prepareStop — it parks on the ensureContextFile POST.
      const prep = r.prepareStop(0);

      // Tour exits while POST is in flight: unmountAll snapshots an empty
      // `_autoAddedContextFileIds`, then `_tourGen` bumps.
      r.unmountAll();
      pm._tourGen += 1;

      // POST resolves; prepareStop's continuation runs on a stale tour.
      resolvePost();
      const result = await prep;

      expect(result).toBe(false);
      // The just-created id MUST be rolled back directly — unmountAll
      // already ran with an empty snapshot and won't see it.
      expect(pm.removeContextFile).toHaveBeenCalledWith(77);
      // And it must NOT have been added to the tracking set after the
      // staleness check.
      expect(r._autoAddedContextFileIds.has(77)).toBe(false);
      // And ensureLinesVisible MUST be skipped — no UI churn for a
      // dead tour.
      expect(pm.ensureLinesVisible).not.toHaveBeenCalled();
    });

    it('skips ensureLinesVisible after a stale exit on the wasAlreadyContext path', async () => {
      // wasAlreadyContext=true → ensureContextFile resolves but the
      // tracking branch is skipped (no id-add, no rollback). The SECOND
      // isStale gate (before ensureLinesVisible) is the only thing that
      // can catch a mid-await exit on this path.
      buildDiff('src/other.js'); // wrapper missing for src/already.js
      let resolvePost;
      const pm = {
        _tourGen: 1,
        contextFiles: [{ id: 99, file: 'src/already.js', line_start: 1, line_end: 5 }],
        ensureContextFile: vi.fn(() => new Promise((res) => {
          resolvePost = () => res({
            type: 'context',
            contextFile: { id: 99, file: 'src/already.js' },
          });
        })),
        ensureLinesVisible: vi.fn().mockResolvedValue(),
        removeContextFile: vi.fn().mockResolvedValue(),
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ file_path: 'src/already.js', line_start: 11 })]);

      const prep = r.prepareStop(0);
      // Resolve the POST; bump gen BEFORE the await continuation runs.
      resolvePost();
      pm._tourGen += 1;
      const result = await prep;

      expect(result).toBe(false);
      // User-owned context file — must NOT be removed.
      expect(pm.removeContextFile).not.toHaveBeenCalled();
      // And no gap-unfold churn on a dead tour.
      expect(pm.ensureLinesVisible).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------------
  // unmountAll cleanup — the tour-exit hook must DELETE any context files
  // it auto-added so the user's persistent context-files list isn't
  // polluted with transient tour state.
  // ----------------------------------------------------------------------
  describe('unmountAll auto-added context-file cleanup', () => {
    it('calls removeContextFile for every auto-added id', async () => {
      buildDiff('src/other.js');
      const pm = {
        ensureContextFile: vi.fn()
          .mockResolvedValueOnce({ type: 'context', contextFile: { id: 10, file: 'a.js' } })
          .mockResolvedValueOnce({ type: 'context', contextFile: { id: 11, file: 'b.js' } }),
        ensureLinesVisible: vi.fn().mockResolvedValue(),
        removeContextFile: vi.fn().mockResolvedValue(),
        contextFiles: [],
      };
      const r = new TourRenderer(pm);
      r.setStops([
        makeStop({ file_path: 'a.js', line_start: 5 }),
        makeStop({ file_path: 'b.js', line_start: 6 }),
      ]);
      await r.prepareStop(0);
      await r.prepareStop(1);
      r.unmountAll();
      expect(pm.removeContextFile).toHaveBeenCalledTimes(2);
      expect(pm.removeContextFile).toHaveBeenCalledWith(10);
      expect(pm.removeContextFile).toHaveBeenCalledWith(11);
    });

    it('clears _autoAddedContextFileIds after cleanup', async () => {
      buildDiff('src/other.js');
      const pm = {
        ensureContextFile: vi.fn().mockResolvedValue({
          type: 'context',
          contextFile: { id: 42, file: 'a.js' },
        }),
        ensureLinesVisible: vi.fn().mockResolvedValue(),
        removeContextFile: vi.fn().mockResolvedValue(),
        contextFiles: [],
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ file_path: 'a.js', line_start: 5 })]);
      await r.prepareStop(0);
      expect(r._autoAddedContextFileIds.size).toBe(1);
      r.unmountAll();
      expect(r._autoAddedContextFileIds.size).toBe(0);
    });

    it('survives a rejected removeContextFile promise without throwing', async () => {
      buildDiff('src/other.js');
      const pm = {
        ensureContextFile: vi.fn().mockResolvedValue({
          type: 'context',
          contextFile: { id: 42, file: 'a.js' },
        }),
        ensureLinesVisible: vi.fn().mockResolvedValue(),
        removeContextFile: vi.fn().mockRejectedValue(new Error('boom')),
        contextFiles: [],
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ file_path: 'a.js', line_start: 5 })]);
      await r.prepareStop(0);
      expect(() => r.unmountAll()).not.toThrow();
    });

    it('is a no-op when removeContextFile is unavailable', async () => {
      buildDiff('src/other.js');
      const pm = {
        ensureContextFile: vi.fn().mockResolvedValue({
          type: 'context',
          contextFile: { id: 42, file: 'a.js' },
        }),
        ensureLinesVisible: vi.fn().mockResolvedValue(),
        // intentionally no removeContextFile
        contextFiles: [],
      };
      const r = new TourRenderer(pm);
      r.setStops([makeStop({ file_path: 'a.js', line_start: 5 })]);
      await r.prepareStop(0);
      expect(() => r.unmountAll()).not.toThrow();
      // The ids stay tracked since we couldn't clean them up.
      expect(r._autoAddedContextFileIds.has(42)).toBe(true);
    });
  });

  // ----------------------------------------------------------------------
  // Tour and hunk-summary annotations are independent — both can render
  // simultaneously when `body.tour-active` is set. The previous behavior
  // hid `.hunk-summary-row` via CSS during a tour; that exclusion was
  // removed so the user can toggle each independently.
  // ----------------------------------------------------------------------
  // ----------------------------------------------------------------------
  // "Show more" / "Show less" toggle for long descriptions.
  //
  // jsdom returns 0 for both scrollHeight and clientHeight (no layout
  // engine), so the overflow check always returns false there. To force
  // the overflow path in tests we stub `scrollHeight` / `clientHeight`
  // on the wrapper element via `Object.defineProperty`, then call
  // `_evaluateDescriptionOverflow` directly (bypassing the rAF defer
  // that mountStop normally uses to wait for browser layout).
  // ----------------------------------------------------------------------
  describe('show more / show less toggle', () => {
    function mountWithOverflow({ overflow, expanded } = { overflow: true }) {
      buildDiff();
      renderer.setStops([makeStop({ line_start: 11, description: 'long desc' })]);
      if (expanded) {
        renderer._expandedDescriptions.add(0);
      }
      const row = renderer.mountStop(0);
      const wrap = row.querySelector('.tour-annotation-description-wrap');
      // Stub overflow geometry. jsdom returns 0 for both by default —
      // defineProperty is the standard escape hatch for this exact case.
      Object.defineProperty(wrap, 'scrollHeight', {
        configurable: true,
        value: overflow ? 200 : 30,
      });
      Object.defineProperty(wrap, 'clientHeight', {
        configurable: true,
        value: 60,
      });
      // Evaluate synchronously so we don't have to wait for the rAF
      // scheduled inside mountStop.
      renderer._evaluateDescriptionOverflow(0);
      return { row, wrap };
    }

    it('wraps the description in a clamp container', () => {
      buildDiff();
      renderer.setStops([makeStop({ line_start: 11 })]);
      const row = renderer.mountStop(0);
      const wrap = row.querySelector('.tour-annotation-description-wrap');
      expect(wrap).toBeTruthy();
      // Description <p> still exists inside the wrap for backwards
      // compatibility with existing selectors.
      const p = wrap.querySelector('.tour-annotation-description');
      expect(p).toBeTruthy();
    });

    it('does NOT render a Show more button when the description fits', () => {
      const { row } = mountWithOverflow({ overflow: false });
      expect(row.querySelector('.tour-annotation-show-more-btn')).toBeNull();
    });

    it('renders a Show more button when the description overflows', () => {
      const { row } = mountWithOverflow({ overflow: true });
      const btn = row.querySelector('.tour-annotation-show-more-btn');
      expect(btn).toBeTruthy();
      expect(btn.textContent).toBe('Show more');
      expect(btn.getAttribute('aria-expanded')).toBe('false');
    });

    it('clicking Show more flips to Show less and adds .expanded', () => {
      const { row, wrap } = mountWithOverflow({ overflow: true });
      const btn = row.querySelector('.tour-annotation-show-more-btn');
      btn.click();
      expect(wrap.classList.contains('expanded')).toBe(true);
      expect(btn.textContent).toBe('Show less');
      expect(btn.getAttribute('aria-expanded')).toBe('true');
    });

    it('clicking Show less reverses the expansion', () => {
      const { row, wrap } = mountWithOverflow({ overflow: true });
      const btn = row.querySelector('.tour-annotation-show-more-btn');
      btn.click();
      btn.click();
      expect(wrap.classList.contains('expanded')).toBe(false);
      expect(btn.textContent).toBe('Show more');
      expect(btn.getAttribute('aria-expanded')).toBe('false');
    });

    it('a remount preserves the expanded state for the same stop index', () => {
      // First mount: expand.
      const first = mountWithOverflow({ overflow: true });
      first.row.querySelector('.tour-annotation-show-more-btn').click();
      expect(renderer._expandedDescriptions.has(0)).toBe(true);

      // Unmount and re-mount the same index.
      renderer.unmountStop(0);
      const row2 = renderer.mountStop(0);
      const wrap2 = row2.querySelector('.tour-annotation-description-wrap');
      // The wrap should be in expanded state immediately on re-mount
      // (no need to wait for the overflow probe to fire).
      expect(wrap2.classList.contains('expanded')).toBe(true);
      // And calling the evaluator should append the toggle in its
      // "Show less" form, not Show more.
      renderer._evaluateDescriptionOverflow(0);
      const btn2 = row2.querySelector('.tour-annotation-show-more-btn');
      expect(btn2).toBeTruthy();
      expect(btn2.textContent).toBe('Show less');
    });

    it('setStops resets _expandedDescriptions (indices remap to new stops)', () => {
      mountWithOverflow({ overflow: true });
      renderer._toggleDescriptionExpansion(0);
      expect(renderer._expandedDescriptions.size).toBe(1);
      renderer.setStops([makeStop({ line_start: 12 })]);
      expect(renderer._expandedDescriptions.size).toBe(0);
    });

    it('overflow evaluation is idempotent (no duplicate buttons on re-call)', () => {
      const { row } = mountWithOverflow({ overflow: true });
      renderer._evaluateDescriptionOverflow(0);
      renderer._evaluateDescriptionOverflow(0);
      expect(row.querySelectorAll('.tour-annotation-show-more-btn')).toHaveLength(1);
    });
  });

  describe('coexistence with hunk-summary rows under body.tour-active', () => {
    const fs = require('fs');
    const path = require('path');

    it('CSS file has no rule hiding .hunk-summary-row under body.tour-active', () => {
      const cssPath = path.resolve(__dirname, '../../public/css/pr.css');
      const css = fs.readFileSync(cssPath, 'utf8');
      // Strip CSS comments so a commented-out rule never trips the assertion.
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
      // Match any selector that combines `tour-active` with `hunk-summary-row`
      // followed by a block setting `display: none`. Whitespace-tolerant.
      const offender = /body\.tour-active\s+\.hunk-summary-row\s*\{[^}]*display\s*:\s*none/;
      expect(stripped).not.toMatch(offender);
    });

    it('keeps both .tour-annotation-row and .hunk-summary-row in the DOM when tour is active', () => {
      buildDiff('src/foo.js');
      // Mount a tour stop above line 11.
      renderer.setStops([makeStop({ line_start: 11 })]);
      renderer.setActive(true);
      renderer.mountStop(0);

      // Mount a hunk-summary row above line 12 by hand — the HunkSummaryRenderer
      // module is loaded as a window-global; importing it here would add no
      // signal beyond what the minimal hand-built row covers. The point is
      // that both classes can be siblings in the same <tbody> with the
      // body class set.
      const anchor = document.querySelector('tr[data-line-number="12"][data-side="RIGHT"]');
      const summaryRow = document.createElement('tr');
      summaryRow.className = 'hunk-summary-row';
      const cell = document.createElement('td');
      cell.colSpan = 2;
      cell.className = 'hunk-summary-cell';
      cell.textContent = 'Summary text';
      summaryRow.appendChild(cell);
      anchor.parentNode.insertBefore(summaryRow, anchor);

      expect(document.body.classList.contains('tour-active')).toBe(true);
      // Both annotation rows must coexist.
      expect(document.querySelectorAll('.tour-annotation-row')).toHaveLength(1);
      expect(document.querySelectorAll('.hunk-summary-row')).toHaveLength(1);
      // Neither row should be marked hidden by inline style or attribute —
      // visibility is purely a CSS/user-toggle concern.
      const tourRow = document.querySelector('.tour-annotation-row');
      expect(tourRow.hasAttribute('hidden')).toBe(false);
      expect(summaryRow.hasAttribute('hidden')).toBe(false);
    });
  });
});
