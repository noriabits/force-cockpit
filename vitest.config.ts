import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Match the production bundles: the browser entries in scripts/build.mjs are
  // built with jsx: 'automatic' + jsxImportSource: 'preact'. Without this, Vitest's own
  // transform (oxc, as of Vitest 4) defaults to React and a .tsx import fails
  // on 'react/jsx-runtime'.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  test: {
    environment: 'node',
    // Host tests stay on 'node' — they must not see a `window`. A webview
    // component test opts into a DOM with a `// @vitest-environment jsdom`
    // docblock at the top of the file (Vitest 4 dropped environmentMatchGlobs).
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // A handful of suites recompile modules via vi.resetModules() + dynamic
    // import(); under the contended full-suite run (and on slower Windows file
    // I/O) those occasionally exceed the default 5s. Give comfortable headroom
    // so the suite is deterministic across platforms.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
