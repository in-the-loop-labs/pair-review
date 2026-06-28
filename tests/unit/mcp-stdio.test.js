// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';

const { redirectConsoleToStderr } = require('../../src/mcp-stdio');
const logger = require('../../src/utils/logger');

describe('redirectConsoleToStderr', () => {
  let origLog;
  let origInfo;
  let origWarn;
  let origLoggerStdout;
  let origQuiet;

  beforeEach(() => {
    origLog = console.log;
    origInfo = console.info;
    origWarn = console.warn;
    origLoggerStdout = logger._stdout;
    origQuiet = logger.quietEnabled;
  });

  afterEach(() => {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    logger._stdout = origLoggerStdout;
    logger.quietEnabled = origQuiet;
  });

  describe('default (non-quiet) mode — relocates output to stderr', () => {
    it('should redirect console.log to console.error', () => {
      redirectConsoleToStderr();
      expect(console.log).toBe(console.error);
    });

    it('should redirect console.info to console.error', () => {
      redirectConsoleToStderr();
      expect(console.info).toBe(console.error);
    });

    it('should redirect console.warn to console.error', () => {
      redirectConsoleToStderr();
      expect(console.warn).toBe(console.error);
    });

    it('should set logger._stdout to process.stderr', () => {
      redirectConsoleToStderr();
      expect(logger._stdout).toBe(process.stderr);
    });

    it('should NOT put the logger into quiet mode', () => {
      logger.quietEnabled = false;
      redirectConsoleToStderr();
      expect(logger.quietEnabled).toBe(false);
    });
  });

  describe('quiet mode — drops narration, keeps errors', () => {
    it('drops console.log/info but preserves console.warn', () => {
      redirectConsoleToStderr({ quiet: true });
      // log/info are progress narration — no-op'd (not relocated to error).
      expect(console.log).not.toBe(console.error);
      expect(console.info).not.toBe(console.error);
      // warn carries genuine diagnostics — preserved and routed to stderr.
      expect(console.warn).toBe(console.error);
      // Dropped narration must not throw and must produce no output.
      expect(() => console.log('dropped')).not.toThrow();
    });

    it('should keep console.error intact', () => {
      const before = console.error;
      redirectConsoleToStderr({ quiet: true });
      expect(console.error).toBe(before);
    });

    it('should put the logger into quiet mode', () => {
      redirectConsoleToStderr({ quiet: true });
      expect(logger.quietEnabled).toBe(true);
    });

    it('should still point logger output at stderr so logger.warn never hits stdout', () => {
      redirectConsoleToStderr({ quiet: true });
      expect(logger._stdout).toBe(process.stderr);
    });
  });
});

describe('logger.setOutputStream', () => {
  let origLoggerStdout;

  beforeEach(() => {
    origLoggerStdout = logger._stdout;
    logger.enabled = true;
  });

  afterEach(() => {
    logger._stdout = origLoggerStdout;
  });

  it('should change logger._stdout to the provided stream', () => {
    const stream = new PassThrough();
    logger.setOutputStream(stream);
    expect(logger._stdout).toBe(stream);
  });

  it('should cause info() to write to the new stream', () => {
    const stream = new PassThrough();
    logger.setOutputStream(stream);

    const writeSpy = vi.spyOn(stream, 'write');
    logger.info('test message');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toContain('test message');
  });

  it('should cause warn() to write to the new stream', () => {
    const stream = new PassThrough();
    logger.setOutputStream(stream);

    const writeSpy = vi.spyOn(stream, 'write');
    logger.warn('warning message');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toContain('warning message');
  });

  it('should cause log() to write to the new stream', () => {
    const stream = new PassThrough();
    logger.setOutputStream(stream);

    const writeSpy = vi.spyOn(stream, 'write');
    logger.log('PREFIX', 'custom message');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toContain('custom message');
  });

  it('should cause section() to write to the new stream', () => {
    const stream = new PassThrough();
    logger.setOutputStream(stream);

    const writeSpy = vi.spyOn(stream, 'write');
    logger.section('Section Title');

    expect(writeSpy).toHaveBeenCalled();
    expect(writeSpy.mock.calls.some(call => call[0].includes('Section Title'))).toBe(true);
  });

  it('should not affect error() which always writes to process.stderr', () => {
    const stream = new PassThrough();
    logger.setOutputStream(stream);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const streamSpy = vi.spyOn(stream, 'write');

    logger.error('error message');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toContain('error message');
    expect(streamSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });
});
