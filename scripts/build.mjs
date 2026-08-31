// The one place the esbuild bundle list lives.
//
// This used to be two ~1500-character one-liners in package.json — `build` and
// `watch` — carrying the same seven invocations with slightly different flags.
// Keeping them in step by hand is exactly the copy-paste risk it looks like: a
// scripted edit that split the `build` chain on `&&` silently missed `watch`,
// which chains with a single `&` so the bundles run concurrently.
//
// Usage: node scripts/build.mjs [--watch]

import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

/**
 * The browser bundles all carry the JSX flags, including the ones with no JSX
 * today. New webview UI is Preact and existing modules migrate as they are
 * touched (see CLAUDE.md), so a uniform browser config means adding the first
 * component to any bundle just works, rather than failing on a flag the author
 * has no reason to suspect. The host bundle must NOT have them — it is
 * --platform=node.
 */
const BUNDLES = [
  { entry: 'src/extension.ts', out: 'dist/extension.js', platform: 'node' },
  {
    entry: 'src/features/utils/yaml-scripts/view/index.js',
    out: 'dist/features/utils/yaml-scripts/view.js',
  },
  {
    entry: 'src/features/monitoring/dashboard/view/index.js',
    out: 'dist/features/monitoring/dashboard/view.js',
  },
  {
    entry: 'src/features/soql/query-editor/view/index.js',
    out: 'dist/features/soql/query-editor/view.js',
  },
  { entry: 'src/webview/rest-call/index.js', out: 'dist/webview/rest-call.js' },
  {
    entry: 'src/features/debug-logs/explorer/view/index.js',
    out: 'dist/features/debug-logs/explorer/view.js',
  },
  {
    entry: 'src/features/overview/ask-ai/view/index.js',
    out: 'dist/features/overview/ask-ai/view.js',
  },
];

/** @param {{ entry: string, out: string, platform?: string }} bundle */
function optionsFor(bundle) {
  const host = bundle.platform === 'node';
  return {
    entryPoints: [path.join(root, bundle.entry)],
    outfile: path.join(root, bundle.out),
    bundle: true,
    // --keep-names guards the Salesforce libs that rely on class/Function.name.
    minify: true,
    keepNames: true,
    // Production emits no sourcemaps; watch keeps them for F5 debugging.
    sourcemap: watch,
    ...(host
      ? { platform: 'node', format: 'cjs', external: ['vscode'] }
      : { platform: 'browser', format: 'iife', jsx: 'automatic', jsxImportSource: 'preact' }),
  };
}

// Asset copying must finish before esbuild writes into the same dist tree —
// copy-feature-assets wipes dist/features and dist/webview.
for (const script of ['copy-feature-assets.js', 'copy-vendor-assets.js']) {
  execFileSync(process.execPath, [path.join(root, 'scripts', script)], { stdio: 'inherit' });
}

// A production build emits no sourcemaps, but it does not remove the ones a
// previous `npm run watch` left behind — and copy-feature-assets only wipes
// dist/features and dist/webview, so dist/extension.js.map survives and is
// packaged (9.5 MB of it, once). Sweep them before building.
if (!watch && fs.existsSync(path.join(root, 'dist'))) {
  for (const file of fs.readdirSync(path.join(root, 'dist'), { withFileTypes: true })) {
    if (file.isFile() && file.name.endsWith('.map')) {
      fs.rmSync(path.join(root, 'dist', file.name));
    }
  }
}

if (watch) {
  const contexts = await Promise.all(BUNDLES.map((b) => esbuild.context(optionsFor(b))));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log(`Watching ${BUNDLES.length} bundles…`);
} else {
  await Promise.all(BUNDLES.map((b) => esbuild.build(optionsFor(b))));
  console.log(`Built ${BUNDLES.length} bundles.`);
}
