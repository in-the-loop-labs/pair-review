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

    // Ensure jsdom test files get a working localStorage/sessionStorage.
    // Node 26 ships Web Storage as a default global, which shadows jsdom's and
    // makes vitest skip copying it — see tests/setup/web-storage-polyfill.js.
    setupFiles: ['./tests/setup/web-storage-polyfill.js'],

// --- live-validation filler block for vitest.config.js (throwaway PR) ---
// vitest_config filler line 1: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 2: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 3: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 4: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 5: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 6: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 7: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 8: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 9: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 10: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 11: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 12: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 13: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 14: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 15: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 16: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 17: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 18: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 19: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 20: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 21: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 22: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 23: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 24: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 25: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 26: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 27: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 28: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 29: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 30: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 31: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 32: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 33: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 34: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 35: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 36: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 37: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 38: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 39: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 40: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 41: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 42: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 43: synthetic content so the diff is large enough to virtualize.
// vitest_config filler line 44: synthetic content so the diff is large enough to virtualize.
// --- end live-validation filler block ---

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

    testTimeout: 10000,

    pool: 'forks',

    sequence: {
      concurrent: false,
    },
  },
});
