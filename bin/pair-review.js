#!/usr/bin/env node
// Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0

const path = require('path');
const { spawn } = require('child_process');
const pkg = require('../package.json');

const args = process.argv.slice(2);
const isMCP = args.includes('--mcp');

// Check for updates and notify user (skip in MCP mode and when config suppresses it)
if (!isMCP) {
  const { shouldSkipUpdateNotifier } = require('../src/config');
  if (!shouldSkipUpdateNotifier()) {
    const updateNotifier = require('update-notifier');
    updateNotifier({ pkg }).notify();
  }
}

async function main() {
  try {
    // Get the path to the main application file
    const mainPath = path.join(__dirname, '..', 'src', 'main.js');

    // In MCP mode, pipe stdin/stdout for JSON-RPC and inherit stderr for logs.
    // In normal mode, inherit all stdio streams.
    const stdioOption = isMCP
      ? ['pipe', 'pipe', 'inherit']
      : 'inherit';

    // Spawn the main process with arguments
    const app = spawn(process.execPath, [mainPath, ...args], {
      stdio: stdioOption
    });

// --- live-validation filler block for bin/pair-review.js (throwaway PR) ---
// pair_review filler line 1: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 2: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 3: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 4: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 5: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 6: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 7: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 8: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 9: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 10: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 11: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 12: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 13: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 14: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 15: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 16: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 17: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 18: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 19: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 20: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 21: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 22: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 23: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 24: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 25: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 26: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 27: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 28: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 29: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 30: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 31: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 32: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 33: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 34: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 35: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 36: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 37: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 38: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 39: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 40: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 41: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 42: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 43: synthetic content so the diff is large enough to virtualize.
// pair_review filler line 44: synthetic content so the diff is large enough to virtualize.
// --- end live-validation filler block ---

    // In MCP mode, bridge stdin/stdout between parent and child
    if (isMCP) {
      process.stdin.pipe(app.stdin);
      app.stdout.pipe(process.stdout);
      app.stdin.on('error', () => {}); // ignore EPIPE if child exits
    }

    app.on('error', (error) => {
      console.error('Failed to start pair-review:', error.message);
      process.exit(1);
    });

    app.on('exit', (code) => {
      process.exit(code);
    });

    process.on('SIGINT', () => {
      app.kill('SIGINT');
    });

    process.on('SIGTERM', () => {
      app.kill('SIGTERM');
    });
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();