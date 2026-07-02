// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check

import { builtinModules } from 'node:module';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'rolldown';
import { transform } from 'oxc-transform';

const outputRoot = join(__dirname, 'server-dist');
const outputFile = 'ts/web/provisioning/WebProvisioningBridge.node.mjs';
const isProd = process.argv.some(arg => arg === '--minify');

const builtinModuleIds = new Set(
  builtinModules.flatMap(name => [name, `node:${name}`])
);

function isBareModuleId(id: string): boolean {
  return !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0');
}

try {
  rmSync(outputRoot, { recursive: true });
} catch (error) {
  if (
    typeof error === 'object' &&
    error != null &&
    'code' in error &&
    error.code !== 'ENOENT'
  ) {
    throw error;
  }
}

export default defineConfig({
  input: 'ts/web/provisioning/WebProvisioningBridge.node.ts',
  platform: 'node',
  external(id) {
    return builtinModuleIds.has(id) || isBareModuleId(id);
  },
  transform: {
    define: {
      'process.env.NODE_ENV': isProd ? '"production"' : '"development"',
      'process.env.IS_BUNDLED': 'true',
    },
  },
  plugins: [
    {
      name: 'web-server-node-env',
      transform(code, id) {
        if (id.endsWith('.json')) {
          return;
        }

        return transform(id, code, {
          define: {
            'process.env.NODE_ENV': isProd ? '"production"' : '"development"',
            'process.env.IS_BUNDLED': 'true',
          },
          sourcemap: !isProd,
        });
      },
    },
  ],
  output: {
    file: join(outputRoot, outputFile),
    format: 'es',
    codeSplitting: false,
    sourcemap: !isProd,
    generatedCode: {
      symbols: false,
    },
  },
});
