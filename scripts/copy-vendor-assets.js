// @ts-check
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const destDir = path.join(__dirname, '..', 'dist', 'vendor');
const dest = path.join(destDir, 'chart.umd.js');

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log('Copied chart.umd.js → dist/vendor/chart.umd.js');
