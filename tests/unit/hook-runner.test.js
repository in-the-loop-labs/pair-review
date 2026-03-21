// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
const EventEmitter = require('events');

const { fireHooks } = require('../../src/hooks/hook-runner');

function createMockChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = vi.fn();
  child.stdin.end = vi.fn();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function createMockDeps(child) {
  return {
    spawn: vi.fn().mockReturnValue(child ?? createMockChild()),
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe('hook-runner', () => {
  let deps;
  let child;

  beforeEach(() => {
    child = createMockChild();
    deps = createMockDeps(child);
  });

  describe('no-op cases', () => {
    it('does nothing when config.hooks is empty object', () => {
      fireHooks('review.started', { id: 1 }, { hooks: {} }, deps);

      expect(deps.spawn).not.toHaveBeenCalled();
    });

    it('does nothing when event has no matching hooks', () => {
      const config = {
        hooks: {
          'analysis.completed': { my_hook: { command: 'echo done' } },
        },
      };

      fireHooks('review.started', { id: 1 }, config, deps);

      expect(deps.spawn).not.toHaveBeenCalled();
    });

    it('does nothing when config.hooks is null', () => {
      fireHooks('review.started', { id: 1 }, { hooks: null }, deps);

      expect(deps.spawn).not.toHaveBeenCalled();
    });

    it('does nothing when config.hooks is undefined', () => {
      fireHooks('review.started', { id: 1 }, { hooks: undefined }, deps);

      expect(deps.spawn).not.toHaveBeenCalled();
    });

    it('does nothing when config itself is null', () => {
      expect(() => fireHooks('review.started', { id: 1 }, null, deps)).not.toThrow();
      expect(deps.spawn).not.toHaveBeenCalled();
    });

    it('does nothing when config itself is undefined', () => {
      expect(() => fireHooks('review.started', { id: 1 }, undefined, deps)).not.toThrow();
      expect(deps.spawn).not.toHaveBeenCalled();
    });

    it('skips hook entries with no command property', () => {
      const config = {
        hooks: {
          'review.started': { empty_hook: {} },
        },
      };

      fireHooks('review.started', { id: 1 }, config, deps);

      expect(deps.spawn).not.toHaveBeenCalled();
    });

    it('skips hook entries that are empty objects (override to disable)', () => {
      const config = {
        hooks: {
          'review.started': { disabled_hook: {} },
        },
      };

      fireHooks('review.started', { id: 1 }, config, deps);

      expect(deps.spawn).not.toHaveBeenCalled();
    });
  });

  describe('single hook execution', () => {
    it('spawns command with shell: true and pipes payload to stdin', () => {
      const config = {
        hooks: {
          'review.started': { telemetry: { command: 'curl http://localhost:9999' } },
        },
      };
      const payload = { pr: 42, repo: 'foo/bar' };

      fireHooks('review.started', payload, config, deps);

      expect(deps.spawn).toHaveBeenCalledWith(
        'curl http://localhost:9999',
        [],
        { shell: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      expect(child.stdin.write).toHaveBeenCalledWith(JSON.stringify(payload));
      expect(child.stdin.end).toHaveBeenCalled();
    });
  });

  describe('multiple hooks', () => {
    it('spawns all matching hooks concurrently', () => {
      const child2 = createMockChild();
      let callCount = 0;
      deps.spawn = vi.fn(() => {
        callCount++;
        return callCount === 1 ? child : child2;
      });

      const config = {
        hooks: {
          'review.started': {
            first: { command: 'echo first' },
            second: { command: 'echo second' },
          },
        },
      };

      fireHooks('review.started', { id: 1 }, config, deps);

      expect(deps.spawn).toHaveBeenCalledTimes(2);
      expect(deps.spawn).toHaveBeenCalledWith('echo first', [], expect.any(Object));
      expect(deps.spawn).toHaveBeenCalledWith('echo second', [], expect.any(Object));
    });
  });

  describe('error handling', () => {
    it('handles child process error event gracefully', () => {
      const config = {
        hooks: {
          'review.started': { bad: { command: 'bad-command' } },
        },
      };

      fireHooks('review.started', { id: 1 }, config, deps);

      child.emit('error', new Error('spawn ENOENT'));

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Hook error')
      );
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('spawn ENOENT')
      );
    });

    it('handles stdin write error gracefully', () => {
      const config = {
        hooks: {
          'review.started': { my_hook: { command: 'some-cmd' } },
        },
      };

      fireHooks('review.started', { id: 1 }, config, deps);

      child.stdin.emit('error', new Error('EPIPE'));

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Hook stdin error')
      );
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('EPIPE')
      );
    });

    it('handles spawn throwing synchronously', () => {
      deps.spawn = vi.fn(() => { throw new Error('spawn failed'); });

      const config = {
        hooks: {
          'review.started': { exploder: { command: 'explode' } },
        },
      };

      expect(() => fireHooks('review.started', { id: 1 }, config, deps)).not.toThrow();
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Hook spawn failed')
      );
    });
  });

  describe('stdout/stderr capture', () => {
    it('pipes stdout to logger.debug', () => {
      const config = {
        hooks: {
          'review.started': { verbose: { command: 'echo hi' } },
        },
      };

      fireHooks('review.started', { id: 1 }, config, deps);

      child.stdout.emit('data', Buffer.from('hello world\n'));

      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('hello world')
      );
    });

    it('pipes stderr to logger.warn', () => {
      const config = {
        hooks: {
          'review.started': { noisy: { command: 'warn-cmd' } },
        },
      };

      fireHooks('review.started', { id: 1 }, config, deps);

      child.stderr.emit('data', Buffer.from('something went wrong\n'));

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('something went wrong')
      );
    });
  });

  describe('timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('kills process after 5000ms timeout', () => {
      const config = {
        hooks: {
          'review.started': { slow: { command: 'slow-hook' } },
        },
      };

      fireHooks('review.started', { id: 1 }, config, deps);

      expect(child.kill).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000);

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Hook timed out after 5000ms')
      );
    });

    it('does not kill process when it completes before timeout', () => {
      const config = {
        hooks: {
          'review.started': { fast: { command: 'fast-hook' } },
        },
      };

      fireHooks('review.started', { id: 1 }, config, deps);

      vi.advanceTimersByTime(1000);
      child.emit('close');

      vi.advanceTimersByTime(5000);

      expect(child.kill).not.toHaveBeenCalled();
    });

    it('clears timeout when child emits error', () => {
      const config = {
        hooks: {
          'review.started': { err: { command: 'err-hook' } },
        },
      };

      fireHooks('review.started', { id: 1 }, config, deps);

      child.emit('error', new Error('boom'));

      vi.advanceTimersByTime(6000);

      expect(child.kill).not.toHaveBeenCalled();
    });
  });
});
