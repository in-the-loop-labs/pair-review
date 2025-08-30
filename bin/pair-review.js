#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');

// Get the path to the server file
const serverPath = path.join(__dirname, '..', 'src', 'server.js');

// Spawn the server process
const server = spawn('node', [serverPath], {
  stdio: 'inherit'
});

server.on('error', (error) => {
  console.error('Failed to start pair-review server:', error.message);
  process.exit(1);
});

server.on('exit', (code) => {
  process.exit(code);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  server.kill('SIGINT');
});

process.on('SIGTERM', () => {
  server.kill('SIGTERM');
});