// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { createSoundRouter } = require('../../src/routes/sound');

function createMockDeps(platformOverride) {
  return {
    execFile: vi.fn((_cmd, _args, cb) => {
      if (cb) cb(null);
    }),
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    platform: platformOverride || 'darwin',
  };
}

function createApp(deps) {
  const app = express();
  app.use(express.json());
  app.use('/', createSoundRouter(deps));
  return app;
}

describe('POST /api/play-sound', () => {
  let deps;

  describe('macOS (darwin)', () => {
    beforeEach(() => {
      deps = createMockDeps('darwin');
    });

    it('returns 204', async () => {
      const app = createApp(deps);
      const res = await request(app).post('/api/play-sound');
      expect(res.status).toBe(204);
    });

    it('calls execFile with afplay and the Glass sound', async () => {
      const app = createApp(deps);
      await request(app).post('/api/play-sound');
      expect(deps.execFile).toHaveBeenCalledWith(
        'afplay',
        ['/System/Library/Sounds/Glass.aiff'],
        expect.any(Function)
      );
    });
  });

  describe('Linux', () => {
    beforeEach(() => {
      deps = createMockDeps('linux');
    });

    it('returns 204', async () => {
      const app = createApp(deps);
      const res = await request(app).post('/api/play-sound');
      expect(res.status).toBe(204);
    });

    it('calls execFile with paplay and the freedesktop sound', async () => {
      const app = createApp(deps);
      await request(app).post('/api/play-sound');
      expect(deps.execFile).toHaveBeenCalledWith(
        'paplay',
        ['/usr/share/sounds/freedesktop/stereo/complete.oga'],
        expect.any(Function)
      );
    });
  });

  describe('Windows (win32)', () => {
    beforeEach(() => {
      deps = createMockDeps('win32');
    });

    it('returns 204', async () => {
      const app = createApp(deps);
      const res = await request(app).post('/api/play-sound');
      expect(res.status).toBe(204);
    });

    it('calls execFile with powershell SystemSounds command', async () => {
      const app = createApp(deps);
      await request(app).post('/api/play-sound');
      expect(deps.execFile).toHaveBeenCalledWith(
        'powershell',
        ['-Command', '[System.Media.SystemSounds]::Asterisk.Play()'],
        expect.any(Function)
      );
    });
  });

  describe('unsupported platform', () => {
    beforeEach(() => {
      deps = createMockDeps('freebsd');
    });

    it('returns 204 without calling execFile', async () => {
      const app = createApp(deps);
      const res = await request(app).post('/api/play-sound');
      expect(res.status).toBe(204);
      expect(deps.execFile).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('logs a warning when execFile fails but still returns 204', async () => {
      deps = createMockDeps('darwin');
      deps.execFile = vi.fn((_cmd, _args, cb) => {
        if (cb) cb(new Error('afplay not found'));
      });
      const app = createApp(deps);
      const res = await request(app).post('/api/play-sound');
      expect(res.status).toBe(204);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('afplay not found')
      );
    });
  });
});
