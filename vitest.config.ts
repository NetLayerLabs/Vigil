import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The checkout-api service has its own node:test suite, run by Vigil itself at verification time.
    exclude: ['services/**', 'node_modules/**', 'dist/**', '.vigil-state/**'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    // End-to-end suites spawn real service processes (on ephemeral ports); run the files one at a time.
    fileParallelism: false,
  },
});
