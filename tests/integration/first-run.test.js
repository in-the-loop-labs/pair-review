// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('First-run welcome message', () => {
  let testHomeDir;
  let originalHome;

  beforeEach(async () => {
    // Create a temporary directory to act as HOME
    testHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pair-review-first-run-'));
    originalHome = process.env.HOME;
  });

  afterEach(async () => {
    // Restore original HOME
    process.env.HOME = originalHome;

    // Cleanup test directory
    if (testHomeDir) {
      await fs.rm(testHomeDir, { recursive: true, force: true });
    }
  });

  it('should show welcome message on first run when config does not exist', async () => {
    // Run pair-review with a fake PR number to trigger the first-run scenario.
    // We verify the welcome message appears; the command may fail later but that's not what we're testing.

    const result = spawnSync('node', ['bin/pair-review.js', '123'], {
      cwd: path.join(__dirname, '../..'),
      env: {
        ...process.env,
        HOME: testHomeDir,
        // Prevent any GITHUB_TOKEN from being used
        GITHUB_TOKEN: ''
      },
      timeout: 10000
    });

    const stdout = result.stdout?.toString() || '';
    const stderr = result.stderr?.toString() || '';
    const output = stdout + stderr;

    // Check for welcome message content
    expect(output).toContain('Welcome to pair-review, your AI-assisted code review partner!');
    expect(output).toContain('--local');
    expect(output).toContain('--configure');
    expect(output).toContain('--help');
    expect(output).toContain('token');
  });

  it('should NOT show welcome message when config already exists', async () => {
    // Pre-create the config directory and file
    const configDir = path.join(testHomeDir, '.pair-review');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ github_token: '', port: 3000, theme: 'light' }, null, 2)
    );

    // Run with a fake PR number to trigger the workflow
    // It will fail due to missing GitHub token, but should NOT show welcome message
    const result = spawnSync('node', ['bin/pair-review.js', '123'], {
      cwd: path.join(__dirname, '../..'),
      env: {
        ...process.env,
        HOME: testHomeDir,
        GITHUB_TOKEN: ''
      },
      timeout: 10000
    });

    const stdout = result.stdout?.toString() || '';
    const stderr = result.stderr?.toString() || '';
    const output = stdout + stderr;

    // Should NOT contain welcome message (config already exists)
    expect(output).not.toContain('Welcome to pair-review, your AI-assisted code review partner!');
  });

  it('should NOT show welcome message when --help flag is used (even on first run)', async () => {
    const result = spawnSync('node', ['bin/pair-review.js', '--help'], {
      cwd: path.join(__dirname, '../..'),
      env: {
        ...process.env,
        HOME: testHomeDir
      },
      timeout: 10000
    });

    const stdout = result.stdout?.toString() || '';

    // Should show help, but NOT the welcome message
    expect(stdout).toContain('USAGE:');
    expect(stdout).not.toContain('Welcome to pair-review, your AI-assisted code review partner!');
  });

  it('should NOT show welcome message when --version flag is used (even on first run)', async () => {
    const result = spawnSync('node', ['bin/pair-review.js', '--version'], {
      cwd: path.join(__dirname, '../..'),
      env: {
        ...process.env,
        HOME: testHomeDir
      },
      timeout: 10000
    });

    const stdout = result.stdout?.toString() || '';

    // Should show version, but NOT the welcome message
    expect(stdout).toMatch(/pair-review v\d+/);
    expect(stdout).not.toContain('Welcome to pair-review, your AI-assisted code review partner!');
  });

  it('should NOT show welcome message when --configure flag is used (even on first run)', async () => {
    const result = spawnSync('node', ['bin/pair-review.js', '--configure'], {
      cwd: path.join(__dirname, '../..'),
      env: {
        ...process.env,
        HOME: testHomeDir
      },
      timeout: 10000
    });

    const stdout = result.stdout?.toString() || '';

    // Should show configure help, but NOT the welcome message
    expect(stdout).toContain('pair-review Configuration');
    expect(stdout).not.toContain('Welcome to pair-review, your AI-assisted code review partner!');
  });

  it('welcome message should have proper box formatting', async () => {
    // Run with a fake PR number to trigger the workflow and show welcome message
    const result = spawnSync('node', ['bin/pair-review.js', '123'], {
      cwd: path.join(__dirname, '../..'),
      env: {
        ...process.env,
        HOME: testHomeDir,
        GITHUB_TOKEN: ''
      },
      timeout: 10000
    });

    const stdout = result.stdout?.toString() || '';

    // Check for box characters (top-left and bottom-right corners)
    expect(stdout).toContain('\u250c'); // top-left corner
    expect(stdout).toContain('\u2514'); // bottom-left corner
    expect(stdout).toContain('\u2510'); // top-right corner
    expect(stdout).toContain('\u2518'); // bottom-right corner
  });
});
