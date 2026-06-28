// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';

const logger = require('../../src/utils/logger');

describe('logger quiet mode', () => {
  let origStdout;
  let origQuiet;
  let origEnabled;
  let stream;
  let writeSpy;

  beforeEach(() => {
    origStdout = logger._stdout;
    origQuiet = logger.quietEnabled;
    origEnabled = logger.enabled;
    logger.enabled = true;
    stream = new PassThrough();
    logger.setOutputStream(stream);
    writeSpy = vi.spyOn(stream, 'write');
  });

  afterEach(() => {
    logger._stdout = origStdout;
    logger.quietEnabled = origQuiet;
    logger.enabled = origEnabled;
    vi.restoreAllMocks();
  });

  it('setQuietEnabled / isQuietEnabled toggle the flag', () => {
    logger.setQuietEnabled(true);
    expect(logger.isQuietEnabled()).toBe(true);
    logger.setQuietEnabled(false);
    expect(logger.isQuietEnabled()).toBe(false);
  });

  describe('when quiet is enabled', () => {
    beforeEach(() => {
      logger.setQuietEnabled(true);
    });

    it('suppresses info()', () => {
      logger.info('chatter');
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('suppresses success()', () => {
      logger.success('done');
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('suppresses log()', () => {
      logger.log('PREFIX', 'chatter');
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('suppresses section()', () => {
      logger.section('A Section');
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('still emits warn() (never swallowed)', () => {
      logger.warn('heads up');
      expect(writeSpy).toHaveBeenCalled();
      expect(writeSpy.mock.calls[0][0]).toContain('heads up');
    });

    it('still emits error() to process.stderr (never swallowed)', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      logger.error('boom');
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stderrSpy.mock.calls[0][0]).toContain('boom');
      // error never uses the chatty stream.
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('when quiet is disabled (default)', () => {
    beforeEach(() => {
      logger.setQuietEnabled(false);
    });

    it('emits info()', () => {
      logger.info('chatter');
      expect(writeSpy).toHaveBeenCalled();
      expect(writeSpy.mock.calls[0][0]).toContain('chatter');
    });

    it('emits section()', () => {
      logger.section('A Section');
      expect(writeSpy).toHaveBeenCalled();
      expect(writeSpy.mock.calls.some(c => c[0].includes('A Section'))).toBe(true);
    });
  });
});
