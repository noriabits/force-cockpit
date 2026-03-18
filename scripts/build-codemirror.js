// @ts-check
const esbuild = require('esbuild');
const path = require('path');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'vendor', 'codemirror-entry.js')],
  bundle: true,
  format: 'iife',
  outfile: path.join(__dirname, '..', 'dist', 'vendor', 'codemirror.bundle.js'),
  minify: true,
  target: ['es2020'],
});

console.log('Built codemirror.bundle.js → dist/vendor/codemirror.bundle.js');
