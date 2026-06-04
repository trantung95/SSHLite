// build/build-webview.js
//
// Bundles the webview sources (webview-src/<name>/) into media/<name>/.
// For each entry it emits main.js (bundled JS), main.css (lifted from
// styles.css), and copies index.html verbatim. The extension reads these
// artifacts at runtime via webview.asWebviewUri():
//   - search:  SearchPanel.getWebviewContent()
//   - support: SupportViewProvider.getHtml()

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// One entry per webview. Adding a webview = add one line here; no other
// change to this file is needed.
const ENTRIES = [
  { name: 'search', src: path.join(ROOT, 'webview-src', 'search'), out: path.join(ROOT, 'media', 'search') },
  { name: 'support', src: path.join(ROOT, 'webview-src', 'support'), out: path.join(ROOT, 'media', 'support') },
];

const watch = process.argv.includes('--watch');

async function buildEntry(entry) {
  fs.mkdirSync(entry.out, { recursive: true });
  fs.copyFileSync(path.join(entry.src, 'index.html'), path.join(entry.out, 'index.html'));

  const jsCtx = await esbuild.context({
    entryPoints: [path.join(entry.src, 'index.ts')],
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    platform: 'browser',
    outfile: path.join(entry.out, 'main.js'),
    sourcemap: 'inline',
    logLevel: 'info',
  });

  const cssCtx = await esbuild.context({
    entryPoints: [path.join(entry.src, 'styles.css')],
    bundle: true,
    outfile: path.join(entry.out, 'main.css'),
    logLevel: 'info',
  });

  if (watch) {
    await jsCtx.watch();
    await cssCtx.watch();
    console.log(`[build-webview] watching webview-src/${entry.name}/ ...`);
  } else {
    await jsCtx.rebuild();
    await cssCtx.rebuild();
    await jsCtx.dispose();
    await cssCtx.dispose();
    console.log(`[build-webview] bundled to media/${entry.name}/`);
  }
}

async function build() {
  for (const entry of ENTRIES) {
    await buildEntry(entry);
  }
}

build().catch((err) => {
  console.error('[build-webview] failed:', err);
  process.exit(1);
});
