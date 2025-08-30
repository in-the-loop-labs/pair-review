#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');

async function main() {
  try {
    // Get command line arguments (excluding 'node' and script path)
    const args = process.argv.slice(2);
    
    // Get the path to the main application file
    const mainPath = path.join(__dirname, '..', 'src', 'main.js');
    
    // Spawn the main process with arguments
    const app = spawn('node', [mainPath, ...args], {
      stdio: 'inherit'
    });

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