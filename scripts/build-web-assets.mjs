// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { cp, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const outDir = join(root, 'web-dist');
const runtimeConfigPath =
  process.env.SIGNAL_WEB_RUNTIME_CONFIG ?? join(root, 'web', 'runtime-config.js');

await mkdir(outDir, { recursive: true });
await mkdir(join(outDir, 'stylesheets'), { recursive: true });

for (const file of ['404.html', 'web.css', 'chrome108-fallback.css']) {
  await copyFile(join(root, 'web', file), join(outDir, file));
}
await copyFile(runtimeConfigPath, join(outDir, 'runtime-config.js'));

const assetVersion = Date.now().toString();
const indexHtml = await readFile(join(root, 'web', 'index.html'), 'utf8');
await writeFile(
  join(outDir, 'index.html'),
  indexHtml
    .replace('./web.css"', `./web.css?v=${assetVersion}"`)
    .replace(
      './chrome108-fallback.css"',
      `./chrome108-fallback.css?v=${assetVersion}"`
    )
    .replace('./render.bundle.js"', `./render.bundle.js?v=${assetVersion}"`)
);

for (const file of ['manifest.css', 'quill.css', 'tailwind.css']) {
  const from = join(root, 'stylesheets', file);
  if (existsSync(from)) {
    const css = await readFile(from, 'utf8');
    await writeFile(
      join(outDir, 'stylesheets', file),
      css
        .replaceAll('asset:///fonts/', '../fonts/')
        .replaceAll(
          'asset:///optional-fonts/emoji-large.woff2',
          '../fonts/emoji.woff2'
        )
    );
  }
}

for (const dir of ['images', 'fonts', 'sounds']) {
  const from = join(root, dir);
  if (existsSync(from)) {
    await cp(from, join(outDir, dir), { recursive: true });
  }
}

const workerDir = join(root, 'bundles', 'workers');
if (existsSync(workerDir)) {
  await cp(workerDir, join(outDir, 'bundles', 'workers'), {
    recursive: true,
  });
}
