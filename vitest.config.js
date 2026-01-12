import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use Node environment (not browser)
    environment: 'node',

    // Test file patterns
    include: ['tests/**/*.test.js'],

    // Enable globals (describe, it, expect) without imports
    globals: true,

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.js'],
      exclude: [
        'node_modules/**',
        'tests/**',
        'coverage/**',
      ],
    },

    // Timeout for tests (10 seconds)
    testTimeout: 10000,

    // Use forks pool for better test isolation (prevents SQLite race conditions)
    pool: 'forks',

    // Run tests sequentially within each file to prevent database race conditions
    sequence: {
      concurrent: false,
    },
  },
});
