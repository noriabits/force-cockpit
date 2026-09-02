import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['out/**', 'dist/**', 'media/**', 'webviews/**', '**/*.d.ts'],
  },
  eslint.configs.recommended,
  {
    // Build and asset scripts — plain Node, in neither bundle. These sat outside
    // `eslint src/` entirely until scripts/build.mjs became the single owner of
    // the esbuild bundle list; the one file that drives the whole build should
    // not be the one file with no gate on it.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The older asset-copy scripts are still CommonJS.
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Feature webview scripts — run in the browser, not Node.js
    files: ['src/features/**/*.js', 'src/webview/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLLabelElement: 'readonly',
        HTMLPreElement: 'readonly',
        HTMLElement: 'readonly',
        DocumentFragment: 'readonly',
        navigator: 'readonly',
        CSS: 'readonly',
        Event: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // ES module sources bundled by esbuild (feature view/ dirs + webview/)
    files: ['src/features/**/view/**/*.js', 'src/webview/**/*.js'],
    languageOptions: {
      sourceType: 'module',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
      // No `globals` map: `no-undef` is off below, so it would be inert.
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-unused-vars': 'off',
      'no-undef': 'off', // TypeScript handles this
      'preserve-caught-error': 'off',
      // Every host->webview message must go through the one typed post method
      // per class (MainPanel.postWebviewMessage / MessageRouter._post), which
      // takes a `HostMessage` and so checks the `type` against the protocol
      // union. A direct `webview.postMessage({ type: '...' })` checks nothing
      // at the call site — that is how `orgConnecting` ended up as the only
      // message not using the `{ type, data }` envelope. The two chokepoints
      // carry an inline disable; there should never be a third.
      //
      // The selector is STRUCTURAL, not semantic: it matches the shape
      // `<x>.webview.postMessage(...)`, so aliasing first
      // (`const wv = panel.webview; wv.postMessage(...)`) walks straight past
      // it. That is acceptable — this rule exists to stop the accidental
      // direct call, not a determined one — but do not read a green lint as
      // proof that every host post is typed.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='postMessage'][callee.object.property.name='webview']",
          message:
            'Post through the class\'s typed post method (postWebviewMessage / _post), not webview.postMessage directly.',
        },
      ],
    },
  },
  {
    // Browser-context TypeScript: `.tsx` is this repo's marker for a module that
    // runs in the webview sandbox (see the note in shared/view/host.tsx). Same
    // TS rules as the host, plus JSX parsing.
    files: ['src/**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      // No `globals` map here on purpose: `no-undef` is off below (TypeScript
      // resolves DOM names from its own `lib`), so a globals list would be
      // inert — and a third, inevitably-drifting copy of the one the plain-JS
      // webview block genuinely needs. Only that block turns `no-undef` on.
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    // Test files — relax rules that are impractical in tests.
    // Must cover `.tsx` too: webview component tests are `*.test.tsx`, and a
    // glob of `*.test.ts` silently excludes them from both this exemption and
    // the complexity-gate `ignores` below.
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // ── Complexity gates (a ratchet, not a cliff) ────────────────────────────
    //
    // These exist because "keep methods small" was a convention that review kept
    // failing to enforce, and each iteration added another 200-line builder.
    //
    // The thresholds start just above the current worst offender, so CI is green
    // today and nothing can get WORSE. Tighten one step at a time, fixing the
    // handful of files each step surfaces. Measured ceilings when this landed:
    //
    //   max-lines-per-function  429 (tab-strip.js)      -> gate 430, target 120
    //   max-lines               455 (connection.ts)     -> gate 460, target 400
    //   complexity               22 (MessageRouter.handle) -> gate 25, target 15
    //
    // `complexity` has now stepped 40 -> 30 -> 25. Each step so far was paid by
    // the same two shapes, neither of which wanted an `eslint-disable`:
    //   * a 20-plus-arm host-message `switch` -> a `messageHandlers` map, which
    //     is a data structure rather than an extraction and adds no module,
    //     export or protocol name (debug-logs, then ask-ai and monitoring);
    //   * a record assembler or a linear guard chain -> real collaborators
    //     (ScriptParser.parse, then OrgConnectionController.connectFromConfig).
    // The next step is 20, and it costs 4.
    //
    // `complexity` and `max-lines` are the honest signals here. Read
    // `max-lines-per-function` with suspicion: this codebase's module-factory
    // pattern (`createCardBuilder`, `yamlScriptsFeature`) puts every nested
    // helper inside one closure, so that rule counts a well-factored 400-line
    // module as one 400-line "function". Do not chase it below ~150 without
    // splitting those factories for real.
    //
    // Tests are exempt: a `describe` block is one long "function" by design.
    //
    // `scripts/` is in scope too: build.mjs owns the whole bundle list, and the
    // rationale above ("the one file that drives the build should not be the
    // one file with no gate on it") applies to its shape, not just its syntax.
    files: ['src/**/*.{ts,tsx,js}', 'scripts/**/*.{js,mjs}'],
    ignores: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'max-lines-per-function': ['error', { max: 430, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 460, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 25],
    },
  },
  prettier,
];
