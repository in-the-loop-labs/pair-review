// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { WorktreePoolUsageTracker, GRACE_PERIOD_MS } = require('../../src/git/worktree-pool-usage');

describe('WorktreePoolUsageTracker', () => {
  let tracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new WorktreePoolUsageTracker();
  });

  afterEach(() => {
    tracker.reset();
    vi.useRealTimers();
  });

  // ── addSession / removeSession ──────────────────────────────────────────
  describe('addSession / removeSession', () => {
    it('tracks sessions by worktree ID', () => {
      tracker.addSession('wt-1', 'sess-a');
      tracker.addSession('wt-1', 'sess-b');
      expect(tracker.isInUse('wt-1')).toBe(true);

      tracker.removeSession('wt-1', 'sess-a');
      // Still has sess-b
      expect(tracker.isInUse('wt-1')).toBe(true);
    });

    it('removing a session from an unknown worktree is a no-op', () => {
      expect(() => tracker.removeSession('unknown', 'sess-a')).not.toThrow();
    });
  });

  // ── addAnalysis / removeAnalysis ────────────────────────────────────────
  describe('addAnalysis / removeAnalysis', () => {
    it('tracks analyses by worktree ID', () => {
      tracker.addAnalysis('wt-1', 'run-1');
      expect(tracker.isInUse('wt-1')).toBe(true);

      tracker.removeAnalysis('wt-1', 'run-1');
      // Grace timer now pending
      expect(tracker.isInUse('wt-1')).toBe(true);
    });

    it('removing an analysis from an unknown worktree is a no-op', () => {
      expect(() => tracker.removeAnalysis('unknown', 'run-1')).not.toThrow();
    });
  });

  // ── removeAnalysisById ──────────────────────────────────────────────────
  describe('removeAnalysisById', () => {
    it('removes an analysis without knowing the worktree ID', () => {
      tracker.addAnalysis('wt-1', 'run-1');
      tracker.addAnalysis('wt-2', 'run-2');

      tracker.removeAnalysisById('run-1');

      // wt-1 has grace timer pending now, wt-2 still has analysis
      expect(tracker.isInUse('wt-2')).toBe(true);
    });

    it('is a no-op for unknown analysis IDs', () => {
      expect(() => tracker.removeAnalysisById('nonexistent')).not.toThrow();
    });
  });

  // ── getActiveAnalyses ───────────────────────────────────────────────────
  describe('getActiveAnalyses', () => {
    it('returns active analysis IDs for a worktree', () => {
      tracker.addAnalysis('wt-1', 'run-1');
      tracker.addAnalysis('wt-1', 'run-2');

      const result = tracker.getActiveAnalyses('wt-1');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(2);
      expect(result.has('run-1')).toBe(true);
      expect(result.has('run-2')).toBe(true);
    });

    it('returns empty set for unknown worktree', () => {
      const result = tracker.getActiveAnalyses('unknown');
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });

    it('returns a copy, not the internal set', () => {
      tracker.addAnalysis('wt-1', 'run-1');
      const result = tracker.getActiveAnalyses('wt-1');
      result.delete('run-1');
      // Internal state should be unaffected
      expect(tracker.getActiveAnalyses('wt-1').has('run-1')).toBe(true);
    });
  });

  // ── isInUse ─────────────────────────────────────────────────────────────
  describe('isInUse', () => {
    it('returns true when sessions exist', () => {
      tracker.addSession('wt-1', 'sess-a');
      expect(tracker.isInUse('wt-1')).toBe(true);
    });

    it('returns true when analyses exist', () => {
      tracker.addAnalysis('wt-1', 'run-1');
      expect(tracker.isInUse('wt-1')).toBe(true);
    });

    it('returns true when grace timer is pending', () => {
      tracker.addSession('wt-1', 'sess-a');
      tracker.removeSession('wt-1', 'sess-a');
      // Grace timer should be running
      expect(tracker.isInUse('wt-1')).toBe(true);
    });

    it('returns false when nothing is tracked', () => {
      expect(tracker.isInUse('wt-1')).toBe(false);
    });
  });

  // ── Grace period ────────────────────────────────────────────────────────
  describe('grace period', () => {
    it('fires onIdle after GRACE_PERIOD_MS when last session is removed', () => {
      const onIdle = vi.fn();
      tracker.onIdle = onIdle;

      tracker.addSession('wt-1', 'sess-a');
      tracker.removeSession('wt-1', 'sess-a');

      // Not fired yet
      expect(onIdle).not.toHaveBeenCalled();

      // Advance past grace period
      vi.advanceTimersByTime(GRACE_PERIOD_MS);
      expect(onIdle).toHaveBeenCalledWith('wt-1');
      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it('is cancelled when a new session connects before timer fires', () => {
      const onIdle = vi.fn();
      tracker.onIdle = onIdle;

      tracker.addSession('wt-1', 'sess-a');
      tracker.removeSession('wt-1', 'sess-a');

      // Reconnect before grace expires
      vi.advanceTimersByTime(GRACE_PERIOD_MS / 2);
      tracker.addSession('wt-1', 'sess-b');

      // Original timer should not fire
      vi.advanceTimersByTime(GRACE_PERIOD_MS);
      expect(onIdle).not.toHaveBeenCalled();
    });

    it('does NOT fire if an analysis is still running when timer expires', () => {
      const onIdle = vi.fn();
      tracker.onIdle = onIdle;

      tracker.addSession('wt-1', 'sess-a');
      tracker.addAnalysis('wt-1', 'run-1');
      tracker.removeSession('wt-1', 'sess-a');

      // Grace timer won't even start because analysis is still active
      vi.advanceTimersByTime(GRACE_PERIOD_MS * 2);
      expect(onIdle).not.toHaveBeenCalled();
    });

    it('is cancelled when addAnalysis is called before timer fires', () => {
      const onIdle = vi.fn();
      tracker.onIdle = onIdle;

      tracker.addSession('wt-1', 'sess-a');
      tracker.removeSession('wt-1', 'sess-a');

      // Grace timer is now running; start an analysis before it fires
      vi.advanceTimersByTime(GRACE_PERIOD_MS / 2);
      tracker.addAnalysis('wt-1', 'run-1');

      // Original grace timer should NOT fire
      vi.advanceTimersByTime(GRACE_PERIOD_MS);
      expect(onIdle).not.toHaveBeenCalled();

      // Removing the analysis starts a fresh grace period
      tracker.removeAnalysis('wt-1', 'run-1');
      vi.advanceTimersByTime(GRACE_PERIOD_MS);
      expect(onIdle).toHaveBeenCalledWith('wt-1');
      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it('fires onIdle only after both analysis and session are gone', () => {
      const onIdle = vi.fn();
      tracker.onIdle = onIdle;

      tracker.addSession('wt-1', 'sess-a');
      tracker.addAnalysis('wt-1', 'run-1');

      // Remove session — analysis still running, no grace timer
      tracker.removeSession('wt-1', 'sess-a');
      vi.advanceTimersByTime(GRACE_PERIOD_MS);
      expect(onIdle).not.toHaveBeenCalled();

      // Remove analysis — now grace timer starts
      tracker.removeAnalysis('wt-1', 'run-1');
      vi.advanceTimersByTime(GRACE_PERIOD_MS);
      expect(onIdle).toHaveBeenCalledWith('wt-1');
    });
  });

  // ── clearWorktree ───────────────────────────────────────────────────────
  describe('clearWorktree', () => {
    it('removes sessions, analyses, and grace timers for a worktree', () => {
      const onIdle = vi.fn();
      tracker.onIdle = onIdle;

      tracker.addSession('wt-1', 'sess-a');
      tracker.addAnalysis('wt-1', 'run-1');

      tracker.clearWorktree('wt-1');

      expect(tracker.isInUse('wt-1')).toBe(false);

      // onIdle should NOT have been called
      vi.advanceTimersByTime(GRACE_PERIOD_MS * 2);
      expect(onIdle).not.toHaveBeenCalled();
    });

    it('cancels pending grace timer without firing onIdle', () => {
      const onIdle = vi.fn();
      tracker.onIdle = onIdle;

      tracker.addSession('wt-1', 'sess-a');
      tracker.removeSession('wt-1', 'sess-a');
      // Grace timer is now running
      expect(tracker.isInUse('wt-1')).toBe(true);

      tracker.clearWorktree('wt-1');

      expect(tracker.isInUse('wt-1')).toBe(false);
      vi.advanceTimersByTime(GRACE_PERIOD_MS * 2);
      expect(onIdle).not.toHaveBeenCalled();
    });

    it('does not affect other worktrees', () => {
      tracker.addSession('wt-1', 'sess-a');
      tracker.addSession('wt-2', 'sess-b');

      tracker.clearWorktree('wt-1');

      expect(tracker.isInUse('wt-1')).toBe(false);
      expect(tracker.isInUse('wt-2')).toBe(true);
    });

    it('is a no-op for unknown worktree IDs', () => {
      expect(() => tracker.clearWorktree('wt-unknown')).not.toThrow();
    });
  });

  // ── reset ───────────────────────────────────────────────────────────────
  describe('reset', () => {
    it('clears all state', () => {
      const onIdle = vi.fn();
      tracker.onIdle = onIdle;

      tracker.addSession('wt-1', 'sess-a');
      tracker.addAnalysis('wt-1', 'run-1');

      tracker.reset();

      expect(tracker.isInUse('wt-1')).toBe(false);
      expect(tracker.onIdle).toBeNull();
    });

    it('clears pending grace timers', () => {
      const onIdle = vi.fn();
      tracker.onIdle = onIdle;

      tracker.addSession('wt-1', 'sess-a');
      tracker.removeSession('wt-1', 'sess-a');

      tracker.reset();

      // Grace timer should have been cleared
      vi.advanceTimersByTime(GRACE_PERIOD_MS * 2);
      expect(onIdle).not.toHaveBeenCalled();
    });
  });
});
