// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const { registerProtocolHandler, unregisterProtocolHandler } = require('../../src/protocol-handler');

const SAMPLE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleExecutable</key>
\t<string>applet</string>
</dict>
</plist>`;

function createMockDeps() {
  return {
    fs: {
      rmSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue(SAMPLE_PLIST),
      writeFileSync: vi.fn(),
    },
    execSync: vi.fn(),
    getConfigDir: vi.fn().mockReturnValue('/mock/config'),
    logger: {
      warn: vi.fn(),
    },
  };
}

describe('protocol-handler', () => {
  const originalPlatform = process.platform;
  let originalShell;
  let deps;

  beforeEach(() => {
    originalShell = process.env.SHELL;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.SHELL = '/bin/zsh';
    deps = createMockDeps();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalShell !== undefined) {
      process.env.SHELL = originalShell;
    } else {
      delete process.env.SHELL;
    }
  });

  describe('registerProtocolHandler', () => {
    it('warns and returns on non-macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      registerProtocolHandler({ _deps: deps });

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('only supported on macOS')
      );
      expect(deps.execSync).not.toHaveBeenCalled();
    });

    it('compiles AppleScript and mutates plist on macOS', () => {
      registerProtocolHandler({ _deps: deps });

      // Should have called osacompile
      expect(deps.execSync).toHaveBeenCalledWith(
        expect.stringContaining('osacompile -o'),
        expect.objectContaining({ input: expect.stringContaining('on open location') })
      );

      // Should have read the plist
      expect(deps.fs.readFileSync).toHaveBeenCalledWith(
        '/mock/config/PairReview.app/Contents/Info.plist',
        'utf-8'
      );

      // Should have written back plist with URL scheme
      expect(deps.fs.writeFileSync).toHaveBeenCalledWith(
        '/mock/config/PairReview.app/Contents/Info.plist',
        expect.stringContaining('CFBundleURLSchemes')
      );
      expect(deps.fs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('pair-review')
      );

      // Should have called lsregister -R -f to register
      expect(deps.execSync).toHaveBeenCalledWith(
        expect.stringContaining('lsregister')
      );
    });

    it('uses custom command when provided', () => {
      registerProtocolHandler({ command: 'node /dev/bin/pr.js', _deps: deps });

      const osacompileCall = deps.execSync.mock.calls.find(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('osacompile')
      );
      expect(osacompileCall).toBeDefined();
      const inputOption = osacompileCall[1];
      expect(inputOption.input).toContain('node /dev/bin/pr.js');
    });

    it('removes existing .app before creating', () => {
      registerProtocolHandler({ _deps: deps });

      // rmSync should be called before osacompile
      const rmSyncOrder = deps.fs.rmSync.mock.invocationCallOrder[0];
      const osacompileCallIndex = deps.execSync.mock.calls.findIndex(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('osacompile')
      );
      const osacompileOrder = deps.execSync.mock.invocationCallOrder[osacompileCallIndex];
      expect(rmSyncOrder).toBeLessThan(osacompileOrder);
    });

    it('uses SHELL env var for shell detection', () => {
      process.env.SHELL = '/bin/bash';

      registerProtocolHandler({ _deps: deps });

      const osacompileCall = deps.execSync.mock.calls.find(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('osacompile')
      );
      expect(osacompileCall[1].input).toContain('/bin/bash');
    });

    it('escapes special characters in command for AppleScript', () => {
      registerProtocolHandler({ command: 'node "/path with spaces/pr.js"', _deps: deps });

      const osacompileCall = deps.execSync.mock.calls.find(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('osacompile')
      );
      expect(osacompileCall).toBeDefined();

      const scriptSource = osacompileCall[1].input;

      // Double quotes in the command should be escaped for AppleScript
      expect(scriptSource).toContain('node \\"');
      expect(scriptSource).toContain('/path with spaces/pr.js\\"');
    });

    it('escapes backslashes in command for AppleScript', () => {
      registerProtocolHandler({ command: 'node C:\\Users\\dev\\pr.js', _deps: deps });

      const osacompileCall = deps.execSync.mock.calls.find(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('osacompile')
      );
      expect(osacompileCall).toBeDefined();

      const scriptSource = osacompileCall[1].input;

      // Backslashes should be doubled for AppleScript
      expect(scriptSource).toContain('C:\\\\Users\\\\dev\\\\pr.js');
    });
  });

  describe('unregisterProtocolHandler', () => {
    it('warns and returns on non-macOS', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      unregisterProtocolHandler({ _deps: deps });

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('only supported on macOS')
      );
      expect(deps.execSync).not.toHaveBeenCalled();
    });

    it('calls lsregister and removes .app on macOS', () => {
      unregisterProtocolHandler({ _deps: deps });

      expect(deps.execSync).toHaveBeenCalledWith(
        expect.stringContaining('lsregister" -u')
      );
      expect(deps.fs.rmSync).toHaveBeenCalledWith(
        '/mock/config/PairReview.app',
        { recursive: true, force: true }
      );
    });

    it('handles lsregister failure gracefully', () => {
      deps.execSync.mockImplementation((cmd) => {
        if (typeof cmd === 'string' && cmd.includes('lsregister')) {
          throw new Error('lsregister failed');
        }
        return Buffer.from('');
      });

      // Should not throw
      expect(() => unregisterProtocolHandler({ _deps: deps })).not.toThrow();

      // rmSync should still be called
      expect(deps.fs.rmSync).toHaveBeenCalledWith(
        '/mock/config/PairReview.app',
        { recursive: true, force: true }
      );
    });
  });
});
