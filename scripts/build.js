'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
// Only publish the app's assets, never arbitrary local or ignored files.
const files = [
  'index.html', 'styles.css', 'favicon.svg', 'preview.png',
  'theme.js', 'providers.js', 'solar.js', 'period.js', 'chart.js', 'location.js', 'app.js',
  'vendor/suncalc.js', 'vendor/SUNCALC-LICENSE'
];

async function build() {
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(dist, { recursive: true });

  for (const relativePath of files) {
    const sourcePath = path.join(root, relativePath);
    const outputPath = path.join(dist, relativePath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const extension = path.extname(relativePath).toLowerCase();
    if (extension === '.js') {
      const source = await fs.readFile(sourcePath, 'utf8');
      const { code } = await esbuild.transform(source, {
        loader: 'js',
        sourcefile: relativePath,
        minify: true,
      });
      await fs.writeFile(outputPath, code);
    } else if (extension === '.css') {
      const source = await fs.readFile(sourcePath, 'utf8');
      const { code } = await esbuild.transform(source, {
        loader: 'css',
        sourcefile: relativePath,
        minify: true,
      });
      await fs.writeFile(outputPath, code);
    } else {
      await fs.copyFile(sourcePath, outputPath);
    }
  }

  console.log(`Built ${files.length} static assets in dist/`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
