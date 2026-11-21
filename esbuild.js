const esbuild = require('esbuild');
const fs = require('node:fs');

const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts', 'src/fileCompareWorker.ts'],
  bundle: true,
  outdir: 'dist',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

(async () => {
  const worker = await esbuild.build({
    entryPoints: ['node_modules/monaco-editor/esm/vs/editor/editor.worker.js'],
    bundle: true, write: false, format: 'iife', platform: 'browser', minify: true,
  });
  const browserOptions = {
    entryPoints: ['media/file.js'], bundle: true, outfile: 'media/file-editor.js',
    format: 'iife', platform: 'browser', minify: true,
    loader: { '.ttf': 'file' }, assetNames: 'file-assets/[name]-[hash]',
    define: { __EDITOR_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) },
  };
  fs.copyFileSync('node_modules/vscode-oniguruma/release/onig.wasm', 'media/onig.wasm');
  const notices = [
    ['monaco-editor', 'LICENSE'], ['vscode-textmate', 'LICENSE.md'],
    ['vscode-oniguruma', 'LICENSE.txt'], ['jsonc-parser', 'LICENSE.md'], ['iconv-lite', 'LICENSE'],
  ].map(([name, license]) => `${name}\n\n${fs.readFileSync(`node_modules/${name}/${license}`, 'utf8')}`);
  fs.writeFileSync('media/third-party-notices.txt', notices.join('\n\n----------------------------------------\n\n'));
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    const browser = await esbuild.context(browserOptions);
    await browser.watch();
    console.log('watching...');
  } else {
    await esbuild.build(buildOptions);
    await esbuild.build(browserOptions);
    console.log('build complete');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
