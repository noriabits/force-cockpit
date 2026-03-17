// @ts-check
// Copies non-TypeScript feature assets from src/features/ to dist/features/,
// preserving the directory structure. Run as part of the build step.

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src', 'features');
const DEST_DIR = path.join(__dirname, '..', 'dist', 'features');

/**
 * Recursively copy non-.ts files from src to dest.
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
      copyAssets(srcPath, destPath);
    } else if (!entry.name.endsWith('.ts')) {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

try {
  // Clean destination first to remove stale files from deleted/renamed features
  if (fs.existsSync(DEST_DIR)) {
    fs.rmSync(DEST_DIR, { recursive: true, force: true });
  }
  copyAssets(SRC_DIR, DEST_DIR);
  console.log('Feature assets copied: src/features/ → dist/features/');
} catch (err) {
  console.error('Failed to copy feature assets:', err);
  process.exit(1);
}
