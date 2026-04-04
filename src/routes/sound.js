// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
const express = require('express');
const { execFile } = require('child_process');
const logger = require('../utils/logger');

// Default dependencies (overridable for testing)
const defaults = {
  execFile,
  logger,
  platform: process.platform,
};

/**
 * Create a Router for the sound playback endpoint.
 *
 * Plays a system notification sound on the host machine via a platform-specific
 * CLI command.  Fire-and-forget: the response is sent immediately and any
 * playback errors are logged at warn level (sound failure is non-critical).
 *
 * @param {object} [_deps] - Dependency overrides for testing
 * @returns {import('express').Router}
 */
function createSoundRouter(_deps = {}) {
  const { execFile, logger, platform } = { ...defaults, ..._deps };
  const router = express.Router();

  router.post('/api/play-sound', (req, res) => {
    if (platform === 'darwin') {
      execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], (err) => {
        if (err) logger.warn(`Sound playback failed: ${err.message}`);
      });
    } else if (platform === 'linux') {
      execFile('paplay', ['/usr/share/sounds/freedesktop/stereo/complete.oga'], (err) => {
        if (err) logger.warn(`Sound playback failed: ${err.message}`);
      });
    } else if (platform === 'win32') {
      execFile('powershell', ['-Command', '[System.Media.SystemSounds]::Asterisk.Play()'], (err) => {
        if (err) logger.warn(`Sound playback failed: ${err.message}`);
      });
    }
    // Unsupported platforms: silent degradation — no execFile call, still 204.

    res.sendStatus(204);
  });

  return router;
}

module.exports = { createSoundRouter };
