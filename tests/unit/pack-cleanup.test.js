// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { isPidAlive, cleanupOrphanedKeepFiles } = require('../../src/git/pack-cleanup');

const HOST = 'test-host.local';
// Pids for the injected process table below. Nothing here consults the real
// one: an ambient pid is not ours to reason about and can be recycled between
// the write and the check.
const DEAD_PID = 4194303;
const LIVE_PID = process.pid;

describe('pack-cleanup', () => {
  let tmpDir;
  let packDir;
  let logger;

  /**
   * Deps that pin the hostname, capture log output, and supply a deterministic
   * process table where only LIVE_PID is running.
   */
  function makeDeps(overrides = {}) {
    return {
      os: { hostname: () => HOST },
      logger,
      process: {
        kill: vi.fn((pid) => {
          if (pid === LIVE_PID) return true;
          const err = new Error('no such process');
          err.code = 'ESRCH';
          throw err;
        })
      },
      ...overrides,
    };
  }

  /** Write a pack + idx + .keep triple, returning the .keep path. */
  function writePack(name, keepContent) {
    fs.writeFileSync(path.join(packDir, `${name}.pack`), 'packdata');
    fs.writeFileSync(path.join(packDir, `${name}.idx`), 'idxdata');
    const keepPath = path.join(packDir, `${name}.keep`);
    fs.writeFileSync(keepPath, keepContent);
    return keepPath;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-cleanup-test-'));
    packDir = path.join(tmpDir, 'objects', 'pack');
    fs.mkdirSync(packDir, { recursive: true });
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('isPidAlive', () => {
    it('returns true for the current process', () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it('treats EPERM as alive (process owned by another user)', () => {
      const deps = {
        process: {
          kill: () => {
            const err = new Error('operation not permitted');
            err.code = 'EPERM';
            throw err;
          }
        }
      };
      expect(isPidAlive(1, deps)).toBe(true);
    });

    it('treats ESRCH as dead', () => {
      const deps = {
        process: {
          kill: () => {
            const err = new Error('no such process');
            err.code = 'ESRCH';
            throw err;
          }
        }
      };
      expect(isPidAlive(1, deps)).toBe(false);
    });
  });

  describe('cleanupOrphanedKeepFiles', () => {
    it('removes a keep file whose pid is dead on this host', async () => {
      const keepPath = writePack('pack-dead', `fetch-pack ${DEAD_PID} on ${HOST}`);

      const summary = await cleanupOrphanedKeepFiles(packDir, makeDeps());

      expect(summary).toEqual({ scanned: 1, removed: 1, skipped: 0, errors: 0 });
      expect(fs.existsSync(keepPath)).toBe(false);
    });

    it('never removes the pack or its index', async () => {
      writePack('pack-dead', `fetch-pack ${DEAD_PID} on ${HOST}`);

      await cleanupOrphanedKeepFiles(packDir, makeDeps());

      expect(fs.existsSync(path.join(packDir, 'pack-dead.pack'))).toBe(true);
      expect(fs.existsSync(path.join(packDir, 'pack-dead.idx'))).toBe(true);
    });

    it('keeps a marker whose pid is still alive', async () => {
      const keepPath = writePack('pack-live', `fetch-pack ${LIVE_PID} on ${HOST}`);

      const summary = await cleanupOrphanedKeepFiles(packDir, makeDeps());

      expect(summary).toMatchObject({ scanned: 1, removed: 0, skipped: 1 });
      expect(fs.existsSync(keepPath)).toBe(true);
    });

    it('keeps a marker written by a different host', async () => {
      const keepPath = writePack('pack-other', `fetch-pack ${DEAD_PID} on other-host.local`);

      const summary = await cleanupOrphanedKeepFiles(packDir, makeDeps());

      expect(summary).toMatchObject({ scanned: 1, removed: 0, skipped: 1 });
      expect(fs.existsSync(keepPath)).toBe(true);
    });

    it('keeps a marker with unparseable contents', async () => {
      const keepPath = writePack('pack-weird', 'manually pinned, do not delete');

      const summary = await cleanupOrphanedKeepFiles(packDir, makeDeps());

      expect(summary).toMatchObject({ scanned: 1, removed: 0, skipped: 1 });
      expect(fs.existsSync(keepPath)).toBe(true);
    });

    it('keeps an empty marker', async () => {
      const keepPath = writePack('pack-empty', '');

      const summary = await cleanupOrphanedKeepFiles(packDir, makeDeps());

      expect(summary).toMatchObject({ removed: 0, skipped: 1 });
      expect(fs.existsSync(keepPath)).toBe(true);
    });

    it('ignores non-keep files in the pack directory', async () => {
      fs.writeFileSync(path.join(packDir, 'pack-plain.pack'), 'packdata');
      fs.writeFileSync(path.join(packDir, 'pack-plain.idx'), 'idxdata');

      const summary = await cleanupOrphanedKeepFiles(packDir, makeDeps());

      expect(summary).toEqual({ scanned: 0, removed: 0, skipped: 0, errors: 0 });
      expect(fs.existsSync(path.join(packDir, 'pack-plain.pack'))).toBe(true);
    });

    it('returns a zero summary without logging when the directory is missing', async () => {
      const summary = await cleanupOrphanedKeepFiles(path.join(tmpDir, 'nope', 'pack'), makeDeps());

      expect(summary).toEqual({ scanned: 0, removed: 0, skipped: 0, errors: 0 });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('counts a non-ENOENT scan failure as an error instead of throwing', async () => {
      const deps = makeDeps({
        fs: {
          readdirSync: () => {
            const err = new Error('permission denied');
            err.code = 'EACCES';
            throw err;
          }
        }
      });

      const summary = await cleanupOrphanedKeepFiles(packDir, deps);

      expect(summary).toMatchObject({ errors: 1, removed: 0 });
      expect(logger.warn).toHaveBeenCalled();
    });

    it('counts an unreadable keep file as an error and continues with the rest', async () => {
      writePack('pack-bad', `fetch-pack ${DEAD_PID} on ${HOST}`);
      const goodKeep = writePack('pack-good', `fetch-pack ${DEAD_PID} on ${HOST}`);

      const deps = makeDeps({
        fs: {
          readdirSync: fs.readdirSync,
          unlinkSync: fs.unlinkSync,
          readFileSync: (p, enc) => {
            if (String(p).includes('pack-bad')) {
              const err = new Error('permission denied');
              err.code = 'EACCES';
              throw err;
            }
            return fs.readFileSync(p, enc);
          }
        }
      });

      const summary = await cleanupOrphanedKeepFiles(packDir, deps);

      expect(summary).toMatchObject({ scanned: 2, removed: 1, errors: 1 });
      expect(fs.existsSync(path.join(packDir, 'pack-bad.keep'))).toBe(true);
      expect(fs.existsSync(goodKeep)).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('counts a failed unlink as an error and still processes the rest', async () => {
      writePack('pack-stuck', `fetch-pack ${DEAD_PID} on ${HOST}`);
      const removable = writePack('pack-ok', `fetch-pack ${DEAD_PID} on ${HOST}`);

      const deps = makeDeps({
        fs: {
          readdirSync: fs.readdirSync,
          readFileSync: fs.readFileSync,
          unlinkSync: (p) => {
            if (String(p).includes('pack-stuck')) {
              const err = new Error('permission denied');
              err.code = 'EACCES';
              throw err;
            }
            return fs.unlinkSync(p);
          }
        }
      });

      const summary = await cleanupOrphanedKeepFiles(packDir, deps);

      expect(summary).toMatchObject({ scanned: 2, removed: 1, errors: 1 });
      expect(fs.existsSync(path.join(packDir, 'pack-stuck.keep'))).toBe(true);
      expect(fs.existsSync(removable)).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('logs an info line naming the removed markers', async () => {
      writePack('pack-dead', `fetch-pack ${DEAD_PID} on ${HOST}`);

      await cleanupOrphanedKeepFiles(packDir, makeDeps());

      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info.mock.calls[0][0]).toContain('pack-dead.keep');
      expect(logger.info.mock.calls[0][0]).toContain('1');
    });

    it('handles a hostname containing spaces', async () => {
      const spacedHost = "Tim's MacBook Pro.local";
      const keepPath = writePack('pack-spaced', `fetch-pack ${DEAD_PID} on ${spacedHost}\n`);

      const summary = await cleanupOrphanedKeepFiles(packDir, makeDeps({
        os: { hostname: () => spacedHost }
      }));

      expect(summary).toMatchObject({ removed: 1 });
      expect(fs.existsSync(keepPath)).toBe(false);
    });

    it('processes a mixed directory correctly in one pass', async () => {
      const dead = writePack('pack-dead', `fetch-pack ${DEAD_PID} on ${HOST}`);
      const live = writePack('pack-live', `fetch-pack ${LIVE_PID} on ${HOST}`);
      const foreign = writePack('pack-foreign', `fetch-pack ${DEAD_PID} on elsewhere`);

      const summary = await cleanupOrphanedKeepFiles(packDir, makeDeps());

      expect(summary).toEqual({ scanned: 3, removed: 1, skipped: 2, errors: 0 });
      expect(fs.existsSync(dead)).toBe(false);
      expect(fs.existsSync(live)).toBe(true);
      expect(fs.existsSync(foreign)).toBe(true);
    });
  });
});
