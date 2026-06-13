import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // A handful of suites recompile modules via vi.resetModules() + dynamic
    // import(); under the contended full-suite run (and on slower Windows file
    // I/O) those occasionally exceed the default 5s. Give comfortable headroom
    // so the suite is deterministic across platforms.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
