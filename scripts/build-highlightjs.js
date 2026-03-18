const esbuild = require('esbuild');

esbuild
  .build({
    entryPoints: ['src/vendor/highlightjs-entry.js'],
    bundle: true,
    format: 'iife',
    outfile: 'dist/vendor/highlightjs.bundle.js',
    minify: true,
    target: 'es2020',
  })
  .catch(() => process.exit(1));
