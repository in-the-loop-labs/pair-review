// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';

const { isProcessAlive, getBootTimeMs } = require('../../src/utils/process-liveness');

function errWithCode(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

describe('isProcessAlive', () => {
  it('returns true when signal 0 succeeds, probing with signal 0', () => {
    const kill = vi.fn();
    expect(isProcessAlive(1234, { kill })).toBe(true);
    expect(kill).toHaveBeenCalledWith(1234, 0);
  });

  it('returns false on ESRCH (no such process)', () => {
    const kill = vi.fn(() => { throw errWithCode('ESRCH'); });
    expect(isProcessAlive(1234, { kill })).toBe(false);
  });

  it('returns true on EPERM (process exists, owned by another user)', () => {
    const kill = vi.fn(() => { throw errWithCode('EPERM'); });
    expect(isProcessAlive(1234, { kill })).toBe(true);
  });

  it('fails safe (alive) on any other error', () => {
    const kill = vi.fn(() => { throw errWithCode('EINVAL'); });
    expect(isProcessAlive(1234, { kill })).toBe(true);

    const killNoCode = vi.fn(() => { throw new Error('boom'); });
    expect(isProcessAlive(1234, { kill: killNoCode })).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['negative', -5],
    ['non-integer', 12.5],
    ['string', '1234'],
    ['NaN', NaN],
  ])('returns false without probing for an invalid pid (%s)', (_label, pid) => {
    const kill = vi.fn();
    expect(isProcessAlive(pid, { kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('reports the current process as alive with the real kill', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

describe('getBootTimeMs', () => {
  it('subtracts OS uptime (seconds) from now (ms)', () => {
    expect(getBootTimeMs({ now: () => 1_000_000, uptime: () => 250 })).toBe(750_000);
  });

  it('returns a time in the past with real dependencies', () => {
    expect(getBootTimeMs()).toBeLessThanOrEqual(Date.now());
  });
});
