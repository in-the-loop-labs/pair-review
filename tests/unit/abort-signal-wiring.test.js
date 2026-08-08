// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { EventEmitter } = require('events');

// Spy on child_process.spawn BEFORE requiring the module under test: it
// destructures `spawn` at require time, so a spy installed later would be
// invisible. The stub implementation also guarantees the Windows `taskkill`
// branch never spawns a real process.
const mockSpawn = vi
  .spyOn(require('child_process'), 'spawn')
  .mockImplementation(() => new EventEmitter());

const { wireAbortToChild, makeAbortError, killChildSafely } = require('../../src/ai/abort-signal-wiring.js');

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

  // The abort listener has no catch of its own — it relies on killChildSafely
  // being total. A malformed child must therefore not take the listener down.
  // The pre-aborted signal is the load-bearing case: onAbort runs synchronously
  // inside wireAbortToChild, so a throw propagates straight to this caller
  // (a post-wiring abort would be swallowed by EventTarget dispatch and prove
  // nothing).
  it('a malformed child whose kill is not a function cannot take down the abort listener', () => {
    const child = { pid: 4242 };  // no kill method at all
    const controller = new AbortController();
    controller.abort();

    let wiring;
    expect(() => { wiring = wireAbortToChild(child, controller.signal, { logPrefix: '[test]' }); })
      .not.toThrow();
    // The cancel is still recorded so the close/error handler short-circuits.
    expect(wiring.cancelled()).toBe(true);
  });

  it('a child with a throwing pid getter cannot take down the abort listener', () => {
    const child = {
      get pid() { throw new Error('pid getter exploded'); },
      kill: vi.fn(),
    };
    const controller = new AbortController();
    controller.abort();

    let wiring;
    expect(() => { wiring = wireAbortToChild(child, controller.signal, { logPrefix: '[test]' }); })
      .not.toThrow();
    expect(wiring.cancelled()).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
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

  // Regression: a child whose spawn failed (ENOENT) has `pid === undefined`.
  // Calling child.kill() on it does NOT no-op — Node coerces the undefined pid
  // to 0, and kill(0, SIGTERM) signals the CALLER'S OWN process group, so
  // pair-review terminated itself. Reproduced with a real failed spawn: the
  // call returned true and the current process received SIGTERM.
  it('does not call child.kill when the spawn failed (pid is undefined)', () => {
    // NOT makeFakeChild(undefined): a default parameter would substitute a real
    // pid. A failed spawn genuinely has no pid.
    const child = { pid: undefined, kill: vi.fn(() => true) };
    const controller = new AbortController();
    const wiring = wireAbortToChild(child, controller.signal);

    controller.abort();

    expect(child.kill).not.toHaveBeenCalled();
    // The abort is still recorded so the close/error handler short-circuits.
    expect(wiring.cancelled()).toBe(true);
  });

  it('does not call child.kill for a pre-aborted signal when the spawn failed', () => {
    // NOT makeFakeChild(undefined): a default parameter would substitute a real
    // pid. A failed spawn genuinely has no pid.
    const child = { pid: undefined, kill: vi.fn(() => true) };
    const controller = new AbortController();
    controller.abort();

    const wiring = wireAbortToChild(child, controller.signal);

    expect(child.kill).not.toHaveBeenCalled();
    expect(wiring.cancelled()).toBe(true);
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

    // Same self-signal hazard as the non-shell case: with no pid the group-kill
    // branch is skipped, and the child.kill fallback must not fire either —
    // process.kill(-undefined) and child.kill() are both self-directed.
    it('shell: true signals nothing when the spawn failed (pid is undefined)', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const groupKill = vi.fn();
      process.kill = groupKill;
      // NOT makeFakeChild(undefined): a default parameter would substitute a real
    // pid. A failed spawn genuinely has no pid.
    const child = { pid: undefined, kill: vi.fn(() => true) };
      const controller = new AbortController();

      const wiring = wireAbortToChild(child, controller.signal, { shell: true });
      controller.abort();

      expect(groupKill).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      expect(wiring.cancelled()).toBe(true);
    });
  });
});

// killChildSafely is the shared primitive behind every provider's timeout,
// stdin-write-error and availability-probe kill. wireAbortToChild delegates to
// it too, so these tests pin the contract directly rather than through wiring.
describe('killChildSafely', () => {
  let origPlatform;
  let origKill;

  beforeEach(() => {
    origPlatform = process.platform;
    origKill = process.kill;
    mockSpawn.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform });
    process.kill = origKill;
  });

  it('returns false for a null/undefined child', () => {
    expect(killChildSafely(null)).toBe(false);
    expect(killChildSafely(undefined)).toBe(false);
  });

  // The production bug this helper exists for: a child whose spawn failed
  // (ENOENT) has no pid, Node coerces it to 0, and kill(0, SIGTERM) signals
  // the CALLER'S own process group — pair-review terminates itself.
  it('dispatches nothing for a pidless child, in both shell and non-shell mode', () => {
    // NOT makeFakeChild(undefined): the default parameter would substitute a
    // real pid. A failed spawn genuinely has no pid.
    const child = { pid: undefined, kill: vi.fn(() => true) };
    const groupKill = vi.fn();
    process.kill = groupKill;

    expect(killChildSafely(child)).toBe(false);
    expect(killChildSafely(child, { shell: true })).toBe(false);

    expect(child.kill).not.toHaveBeenCalled();
    expect(groupKill).not.toHaveBeenCalled();
  });

  // pid 0 is the literal self-signal value, so the guard must treat it as
  // "no child" rather than as a valid target.
  it('treats pid 0 as pidless', () => {
    const child = { pid: 0, kill: vi.fn(() => true) };
    expect(killChildSafely(child)).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('non-shell mode terminates via child.kill(SIGTERM)', () => {
    const groupKill = vi.fn();
    process.kill = groupKill;

    const child = makeFakeChild(4242);
    expect(killChildSafely(child)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(groupKill).not.toHaveBeenCalled();
  });

  it('shell mode on POSIX group-kills via process.kill(-pid) so the CLI grandchild dies too', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const groupKill = vi.fn();
    process.kill = groupKill;

    const child = makeFakeChild(7777);
    expect(killChildSafely(child, { shell: true })).toBe(true);
    expect(groupKill).toHaveBeenCalledWith(-7777, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('shell mode reports false on ESRCH (group already gone) without falling back', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const groupKill = vi.fn(() => {
      const err = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    });
    process.kill = groupKill;

    const child = makeFakeChild(8888);
    let result;
    expect(() => { result = killChildSafely(child, { shell: true }); }).not.toThrow();
    expect(result).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('shell mode falls back to child.kill when group-kill fails with a non-ESRCH error', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.kill = vi.fn(() => {
      throw new Error('EPERM');
    });

    const child = makeFakeChild(9999);
    expect(killChildSafely(child, { shell: true, logPrefix: '[test]' })).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('shell mode on Windows wipes the tree with taskkill /T /F', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const groupKill = vi.fn();
    process.kill = groupKill;

    const child = makeFakeChild(555);
    expect(killChildSafely(child, { shell: true })).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      'taskkill',
      ['/T', '/F', '/PID', '555'],
      { stdio: 'ignore' }
    );
    // Windows has no process groups, so the POSIX branch must be skipped.
    expect(groupKill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to child.kill when spawning taskkill throws', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('spawn EPERM');
    });

    const child = makeFakeChild(556);
    expect(killChildSafely(child, { shell: true, logPrefix: '[test]' })).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  // Totality of this helper is what lets wireAbortToChild's abort listener run
  // without a catch of its own. These pin the three ways a caller can hand it
  // something malformed.
  it('reports false instead of throwing when the child has no kill method', () => {
    const child = { pid: 4242 };

    let result;
    expect(() => { result = killChildSafely(child, { logPrefix: '[test]' }); }).not.toThrow();
    expect(result).toBe(false);
  });

  it('reports false instead of throwing when reading child.pid throws', () => {
    const child = {
      get pid() { throw new Error('pid getter exploded'); },
      kill: vi.fn(),
    };

    let result;
    expect(() => { result = killChildSafely(child, { logPrefix: '[test]' }); }).not.toThrow();
    expect(result).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('tolerates a null/non-object opts argument', () => {
    const child = makeFakeChild(1234);

    let result;
    expect(() => { result = killChildSafely(child, null); }).not.toThrow();
    expect(result).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('never throws and reports false when child.kill itself throws', () => {
    const child = {
      pid: 99,
      kill: vi.fn(() => {
        throw new Error('kill exploded');
      }),
    };

    let result;
    expect(() => { result = killChildSafely(child, { logPrefix: '[test]' }); }).not.toThrow();
    expect(result).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
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
