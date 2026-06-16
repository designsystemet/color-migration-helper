// Build script: bundles the plugin backend and UI with esbuild.
// Figma requires a single `main` JS file and a single `ui` HTML file, so the
// UI bundle is inlined into ui/index.html and written out as ui.html.
import esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';

const watch = process.argv.includes('--watch');
const target = 'es2017';

const backendOptions = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  target,
  outfile: 'code.js',
  legalComments: 'none',
};

// The UI is bundled to a string and injected into the HTML template, replacing
// the /*__UI_BUNDLE__*/ marker, so the whole UI stays one self-contained file.
const UI_TEMPLATE = 'ui/index.html';
const UI_MARKER = '/*__UI_BUNDLE__*/';

async function buildUi() {
  const result = await esbuild.build({
    entryPoints: ['ui/main.ts'],
    bundle: true,
    target,
    format: 'iife',
    write: false,
    legalComments: 'none',
  });
  const js = result.outputFiles[0].text;
  const template = readFileSync(UI_TEMPLATE, 'utf8');
  if (!template.includes(UI_MARKER)) {
    throw new Error(`UI template ${UI_TEMPLATE} is missing the ${UI_MARKER} marker`);
  }
  writeFileSync('ui.html', template.replace(UI_MARKER, js));
}

if (watch) {
  const backendCtx = await esbuild.context(backendOptions);
  await backendCtx.watch();
  // esbuild has no native "watch + custom step" for the UI inlining, so rebuild
  // the UI via a plugin hook on each backend rebuild and on its own watch.
  const uiCtx = await esbuild.context({
    entryPoints: ['ui/main.ts'],
    bundle: true,
    target,
    format: 'iife',
    outfile: '.ui-bundle.tmp.js',
    legalComments: 'none',
    plugins: [{
      name: 'inline-ui',
      setup(b) {
        b.onEnd(async () => {
          await buildUi();
        });
      },
    }],
  });
  await uiCtx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(backendOptions);
  await buildUi();
  console.log('Build complete: code.js + ui.html');
}
