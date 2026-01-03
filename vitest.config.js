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

    // Parallel execution
    pool: 'threads',
  },
});
