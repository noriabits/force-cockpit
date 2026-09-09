// @ts-check
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const destDir = path.join(__dirname, '..', 'dist', 'vendor');
const dest = path.join(destDir, 'chart.umd.js');

// Wipe before writing, for the same reason copy-feature-assets.js clears its
// STALE_DIRS: nothing else ever prunes dist/vendor, so a vendor bundle that is
// dropped or renamed lingers forever and ships inside every locally-built VSIX.
// That is not hypothetical — codemirror.bundle.js and highlightjs.bundle.js
// outlived their features by months and added ~505 KB to each package.
fs.rmSync(destDir, { recursive: true, force: true });
fs.mkdirSync(destDir, { recursive: true });
// Strip sourceMappingURL: webview CSP has no connect-src, so DevTools' attempt
// to fetch the .map file falls back to default-src 'none' and gets blocked.
const code = fs.readFileSync(src, 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, '');
fs.writeFileSync(dest, code);
console.log('Copied chart.umd.js → dist/vendor/chart.umd.js');
