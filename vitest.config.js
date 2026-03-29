import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use Node environment (not browser)
    environment: 'node',

    // Suppress browser opening during tests
    // Isolate test git repos from developer's global/system git config
    // (prevents hangs from e.g. commit.gpgsign requiring TTY-based pinentry)
    env: {
      PAIR_REVIEW_NO_OPEN: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },

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
