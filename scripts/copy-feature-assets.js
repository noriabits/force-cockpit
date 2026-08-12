// @ts-check
// Copies non-TypeScript feature assets from src/features/ to dist/features/,
// preserving the directory structure. Run as part of the build step.

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src', 'features');
const DEST_DIR = path.join(__dirname, '..', 'dist', 'features');

// Wiped alongside dist/features. Nothing is copied here — it holds only esbuild
// output (dist/webview/rest-call.js), which the build regenerates. A bundle that
// moves into a feature folder (as the SOQL editor did) would otherwise linger
// here forever and ship inside every locally-built VSIX.
const STALE_DIRS = [DEST_DIR, path.join(__dirname, '..', 'dist', 'webview')];

/**
 * Recursively copy non-.ts files from src to dest.
 * Skips `view/` directories — those are ESM source bundled by esbuild
 * directly into dist/features/{tab}/{id}/view.js.
 * @param {string} src
 * @param {string} dest
 */
function copyAssets(src, dest) {
  if (!fs.existsSync(src)) return;

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'view') continue;
      copyAssets(srcPath, destPath);
    } else if (!entry.name.endsWith('.ts')) {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

try {
  // Clean destinations first to remove stale files from deleted/renamed features
  for (const dir of STALE_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  copyAssets(SRC_DIR, DEST_DIR);
  console.log('Feature assets copied: src/features/ → dist/features/');
} catch (err) {
  console.error('Failed to copy feature assets:', err);
  process.exit(1);
}
