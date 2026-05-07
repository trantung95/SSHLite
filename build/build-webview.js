// build/build-webview.js
//
// Bundles the search webview source (webview-src/search/) into media/search/.
// Emits main.js (bundled JS), main.css (lifted from styles.css), and copies
// index.html verbatim. The extension's SearchPanel.getWebviewContent() reads
// these artifacts at runtime via webview.asWebviewUri().

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'webview-src', 'search');
const OUT = path.join(ROOT, 'media', 'search');

const watch = process.argv.includes('--watch');

async function build() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'index.html'), path.join(OUT, 'index.html'));

  const ctx = await esbuild.context({
    entryPoints: [path.join(SRC, 'index.ts')],
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    platform: 'browser',
    outfile: path.join(OUT, 'main.js'),
    sourcemap: 'inline',
    logLevel: 'info',
  });

  const cssCtx = await esbuild.context({
    entryPoints: [path.join(SRC, 'styles.css')],
    bundle: true,
    outfile: path.join(OUT, 'main.css'),
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
    await cssCtx.watch();
    console.log('[build-webview] watching webview-src/search/ ...');
  } else {
    await ctx.rebuild();
    await cssCtx.rebuild();
    await ctx.dispose();
    await cssCtx.dispose();
    console.log('[build-webview] bundled to media/search/');
  }
}

build().catch((err) => {
  console.error('[build-webview] failed:', err);
  process.exit(1);
});
