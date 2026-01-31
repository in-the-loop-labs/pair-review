// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';

const { redirectConsoleToStderr } = require('../../src/mcp-stdio');
const logger = require('../../src/utils/logger');

describe('redirectConsoleToStderr', () => {
  let origLog;
  let origInfo;
  let origWarn;
  let origLoggerStdout;

  beforeEach(() => {
    origLog = console.log;
    origInfo = console.info;
    origWarn = console.warn;
    origLoggerStdout = logger._stdout;
  });

  afterEach(() => {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    logger._stdout = origLoggerStdout;
  });

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
