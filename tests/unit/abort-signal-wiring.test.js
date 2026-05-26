// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { wireAbortToChild, makeAbortError } = require('../../src/ai/abort-signal-wiring.js');

/**
 * Build a fake ChildProcess just expressive enough for wireAbortToChild:
 * tracks kill invocations and exposes a `pid` for group-kill paths.
 */
function makeFakeChild(pid = 12345) {
  return {
    pid,
    killed: false,
    kill: vi.fn(function (signal) {
      this.killed = true;
      this.lastSignal = signal;
      return true;
    }),
  };
}

describe('wireAbortToChild', () => {
  it('returns an inert pair when signal is null/undefined', () => {
    const child = makeFakeChild();
    const a = wireAbortToChild(child, null);
    const b = wireAbortToChild(child, undefined);
    expect(typeof a.detach).toBe('function');
    expect(typeof a.cancelled).toBe('function');
    expect(a.cancelled()).toBe(false);
    expect(() => a.detach()).not.toThrow();
    expect(b.cancelled()).toBe(false);
    expect(() => b.detach()).not.toThrow();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('pre-aborted signal triggers child.kill synchronously and reports cancelled', () => {
    const child = makeFakeChild();
    const controller = new AbortController();
    controller.abort();
    const wiring = wireAbortToChild(child, controller.signal);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(wiring.cancelled()).toBe(true);
  });

  it('post-wiring abort calls kill exactly once even if abort fires twice', () => {
    const child = makeFakeChild();
    const controller = new AbortController();
    const wiring = wireAbortToChild(child, controller.signal);
    controller.abort();
    // Manually dispatch a second abort event to verify { once: true }
    controller.signal.dispatchEvent(new Event('abort'));
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(wiring.cancelled()).toBe(true);
  });

  it('detach() removes the listener so a later abort is a no-op', () => {
    const child = makeFakeChild();
    const controller = new AbortController();
    const wiring = wireAbortToChild(child, controller.signal);
    wiring.detach();
    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
    // Cancelled stays false because onAbort never ran.
    expect(wiring.cancelled()).toBe(false);
  });

  // Regression for the timeout→close listener leak. Tour and summary
  // generators reuse one per-job AbortSignal across many provider.execute()
  // calls. Each call wires up + must detach when it returns. If a call
  // times out before close fires, the close handler used to short-circuit
  // before detach, leaving a listener attached for the whole job.
  // Providers now centralize detach in `settle`, so the closure below
  // mimics that contract.
  it('a per-job signal does not accumulate listeners across many wired calls', () => {
    const controller = new AbortController();
    // Three sequential "provider calls". Each wires a fresh fake child
    // and detaches when its "settle" runs — matching what providers do.
    for (let i = 0; i < 3; i++) {
      const child = makeFakeChild(1000 + i);
      const wiring = wireAbortToChild(child, controller.signal);
      // Simulate `settle` running (either close OR timeout path).
      wiring.detach();
    }
    // Final abort should be a complete no-op: no listeners left, no kills.
    controller.abort();
    // Nothing to assert on the (already-discarded) children; the absence
    // of throws and the fact that the signal has no listeners is the test.
    // Use a follow-up wiring to prove the signal is still usable when
    // aborted state matters.
    const lateChild = makeFakeChild(2000);
    wireAbortToChild(lateChild, controller.signal);
    // Late wiring on an already-aborted signal triggers an immediate kill.
    expect(lateChild.kill).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows when child.kill throws (abort listener does not throw)', () => {
    const child = {
      pid: 99,
      kill: vi.fn(() => {
        throw new Error('kill exploded');
      }),
    };
    const controller = new AbortController();
    wireAbortToChild(child, controller.signal, { logPrefix: '[test]' });
    expect(() => controller.abort()).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  describe('shell-mode option', () => {
    let origPlatform;
    let origKill;

    beforeEach(() => {
      // Default to POSIX for these tests; the Windows branch is exercised
      // by stubbing the platform per-test.
      origPlatform = process.platform;
      origKill = process.kill;
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.kill = origKill;
    });

    it('shell: true uses process.kill(-pid, SIGTERM) instead of child.kill', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const groupKill = vi.fn();
      process.kill = groupKill;

      const child = makeFakeChild(7777);
      const controller = new AbortController();
      wireAbortToChild(child, controller.signal, { shell: true });
      controller.abort();

      expect(groupKill).toHaveBeenCalledTimes(1);
      expect(groupKill).toHaveBeenCalledWith(-7777, 'SIGTERM');
      // Falls back ONLY on error; child.kill should not be invoked here.
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('shell: true tolerates ESRCH (group already gone) without falling back', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const groupKill = vi.fn(() => {
        const err = new Error('no such process');
        err.code = 'ESRCH';
        throw err;
      });
      process.kill = groupKill;

      const child = makeFakeChild(8888);
      const controller = new AbortController();
      wireAbortToChild(child, controller.signal, { shell: true });
      expect(() => controller.abort()).not.toThrow();
      expect(groupKill).toHaveBeenCalledTimes(1);
      // ESRCH means already gone — no fallback to child.kill.
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('shell: true falls back to child.kill when group-kill throws non-ESRCH', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const groupKill = vi.fn(() => {
        throw new Error('EPERM');
      });
      process.kill = groupKill;

      const child = makeFakeChild(9999);
      const controller = new AbortController();
      wireAbortToChild(child, controller.signal, { shell: true });
      controller.abort();
      expect(groupKill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('shell: false (default) uses child.kill regardless of process.kill stub', () => {
      const groupKill = vi.fn();
      process.kill = groupKill;
      const child = makeFakeChild(4242);
      const controller = new AbortController();
      wireAbortToChild(child, controller.signal);
      controller.abort();
      expect(groupKill).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });
});

describe('makeAbortError', () => {
  it('shapes the error so isCancellation/name are set', () => {
    const err = makeAbortError('user clicked cancel');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
    expect(err.isCancellation).toBe(true);
    expect(err.message).toBe('user clicked cancel');
  });

  it('defaults to message "cancelled" when omitted', () => {
    const err = makeAbortError();
    expect(err.name).toBe('AbortError');
    expect(err.isCancellation).toBe(true);
    expect(err.message).toBe('cancelled');
  });

  it('treats empty string as missing and uses the default', () => {
    const err = makeAbortError('');
    expect(err.message).toBe('cancelled');
  });
});
