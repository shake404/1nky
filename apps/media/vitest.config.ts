import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // sharp re-encodes and native binary load can be slow on a cold run.
    testTimeout: 30_000,
  },
});
