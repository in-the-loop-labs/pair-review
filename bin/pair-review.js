#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later

const path = require('path');
const { spawn } = require('child_process');
const pkg = require('../package.json');

const args = process.argv.slice(2);
const isMCP = args.includes('--mcp');

// Check for updates and notify user (skip in MCP mode to avoid stdout pollution)
if (!isMCP) {
  const updateNotifier = require('update-notifier');
  updateNotifier({ pkg }).notify();
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
    const app = spawn('node', [mainPath, ...args], {
      stdio: stdioOption
    });

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

    // Handle graceful shutdown
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