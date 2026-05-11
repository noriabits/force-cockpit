// @ts-check
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const destDir = path.join(__dirname, '..', 'dist', 'vendor');
const dest = path.join(destDir, 'chart.umd.js');

fs.mkdirSync(destDir, { recursive: true });
// Strip sourceMappingURL: webview CSP has no connect-src, so DevTools' attempt
// to fetch the .map file falls back to default-src 'none' and gets blocked.
const code = fs.readFileSync(src, 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, '');
fs.writeFileSync(dest, code);
console.log('Copied chart.umd.js → dist/vendor/chart.umd.js');
