// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check

import { defineConfig } from 'rolldown';
import { transform } from 'oxc-transform';
import { resolve } from 'node:path';

const isProd = process.argv.some(arg => arg === '--minify');
const processShim = `var global = globalThis;
var process = globalThis.process || (globalThis.process = {
  arch: 'x64',
  argv: [],
  browser: true,
  config: { variables: {} },
  cwd: function() { return '/'; },
  env: { NODE_ENV: ${JSON.stringify(isProd ? 'production' : 'development')} },
  nextTick: function(callback) { Promise.resolve().then(callback); },
  platform: 'browser',
  version: 'v22.0.0',
  versions: { modules: '0', node: '22.0.0', uv: '0' }
});
if (globalThis.window) {
  globalThis.window.SignalContext = globalThis.window.SignalContext || {};
  globalThis.window.SignalContext.config = globalThis.window.SignalContext.config || {};
  globalThis.window.SignalContext.getPath = globalThis.window.SignalContext.getPath || function() { return '/signal-web'; };
  globalThis.window.SignalContext.i18n = globalThis.window.SignalContext.i18n || function(key) { return key; };
}
if (!globalThis.Buffer) {
  class BrowserBuffer extends Uint8Array {
    static from(input, encoding) {
      if (typeof input === 'string') {
        if (encoding === 'base64') {
          return new BrowserBuffer(Uint8Array.from(atob(input), char => char.charCodeAt(0)));
        }
        if (encoding === 'hex') {
          const bytes = new Uint8Array(input.length / 2);
          for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = Number.parseInt(input.slice(index * 2, index * 2 + 2), 16);
          }
          return new BrowserBuffer(bytes);
        }
        return new BrowserBuffer(new TextEncoder().encode(input));
      }
      return new BrowserBuffer(input);
    }

    static concat(chunks) {
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const result = new BrowserBuffer(size);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    }

    static alloc(size, fill) {
      const result = new BrowserBuffer(size);
      if (fill !== undefined) {
        result.fill(fill);
      }
      return result;
    }

    static allocUnsafe(size) {
      return new BrowserBuffer(size);
    }

    static isBuffer(value) {
      return value instanceof Uint8Array;
    }

    toString(encoding) {
      if (encoding === 'base64') {
        let binary = '';
        for (const byte of this) {
          binary += String.fromCharCode(byte);
        }
        return btoa(binary);
      }
      if (encoding === 'hex') {
        return Array.from(this, byte => byte.toString(16).padStart(2, '0')).join('');
      }
      return new TextDecoder().decode(this);
    }
  }
  globalThis.Buffer = BrowserBuffer;
}`;

export default defineConfig({
  input: {
    'render.bundle': 'ts/web/main.dom.tsx',
  },
  platform: 'browser',
  transform: {
    jsx: 'react-jsx',
    define: {
      'process.env.NODE_ENV': isProd ? '"production"' : '"development"',
      'process.env.IS_BUNDLED': 'true',
      ...(isProd
        ? {
            __REACT_DEVTOOLS_GLOBAL_HOOK__: 'undefined',
          }
        : {}),
    },
  },
  plugins: [
    {
      name: 'web-runtime-shims',
      renderChunk(code) {
        return {
          code: `${processShim}\n${code}`
            .replace(/\bdebugger;\s*/g, '')
            .replaceAll('asset:///fonts/', './fonts/')
            .replaceAll(
              'asset:///optional-fonts/emoji-large.woff2',
              './fonts/emoji.woff2'
            ),
          map: null,
        };
      },
      resolveId(source) {
        if (source === 'electron') {
          return resolve('ts/web/runtime/electronShim.dom.ts');
        }
        if (source === 'fs-extra' || source === 'graceful-fs') {
          return resolve('ts/web/runtime/nodeGenericShim.dom.ts');
        }
        if (
          source === '@signalapp/ringrtc' ||
          source.startsWith('@signalapp/ringrtc/')
        ) {
          return resolve('ts/web/runtime/ringrtcShim.dom.ts');
        }
        if (source === 'node:path') {
          return resolve('ts/web/runtime/nodePathShim.dom.ts');
        }
        if (source === 'path') {
          return resolve('ts/web/runtime/nodePathShim.dom.ts');
        }
        if (source === 'node:buffer') {
          return resolve('ts/web/runtime/nodeBufferShim.dom.ts');
        }
        if (source === 'node:v8') {
          return resolve('ts/web/runtime/nodeV8Shim.dom.ts');
        }
        if (source === 'node:events') {
          return resolve('ts/web/runtime/nodeEventsShim.dom.ts');
        }
        if (source === 'events') {
          return resolve('ts/web/runtime/nodeEventsShim.dom.ts');
        }
        if (
          source === '@signalapp/libsignal-client' ||
          source.startsWith('@signalapp/libsignal-client/')
        ) {
          return resolve('ts/web/runtime/libsignalShim.dom.ts');
        }
        if (
          source.endsWith('/util/zkgroup.node.ts') ||
          source === '../zkgroup.node.ts' ||
          source === './zkgroup.node.ts'
        ) {
          return resolve('ts/web/runtime/libsignalShim.dom.ts');
        }
        if (source === 'node:stream/web') {
          return resolve('ts/web/runtime/nodeStreamWebShim.dom.ts');
        }
        if (
          source === 'node:http' ||
          source === 'node:https' ||
          source === 'node:zlib' ||
          source === 'node:stream' ||
          source === 'stream' ||
          source === 'node:stream/promises' ||
          source === 'node:fs' ||
          source === 'fs' ||
          source === 'node:fs/promises' ||
          source === 'node:querystring' ||
          source === 'querystring' ||
          source === 'node:crypto' ||
          source === 'crypto' ||
          source === 'node:assert' ||
          source === 'assert' ||
          source === 'node:os' ||
          source === 'os' ||
          source === 'node:tls' ||
          source === 'node:net' ||
          source === 'net' ||
          source === 'node:url' ||
          source === 'url' ||
          source === 'node:dns/promises' ||
          source === 'dns' ||
          source === 'node:timers/promises' ||
          source === 'node:module' ||
          source === 'node:util' ||
          source === 'util' ||
          source === 'http' ||
          source === 'https' ||
          source === 'tls' ||
          source === 'constants' ||
          source === 'node:process'
        ) {
          return resolve('ts/web/runtime/nodeGenericShim.dom.ts');
        }
        if (
          source.endsWith('/util/os/osMain.node.ts') ||
          source === '../../util/os/osMain.node.ts' ||
          source === '../util/os/osMain.node.ts'
        ) {
          return resolve('ts/web/runtime/osMainShim.dom.ts');
        }
      },
    },
    {
      name: 'web-node-env',
      transform(code, id) {
        if (id.endsWith('.json')) {
          return;
        }

        return transform(id, code, {
          define: {
            'process.env.NODE_ENV': isProd ? '"production"' : '"development"',
          },
          sourcemap: !isProd,
        });
      },
    },
  ],
  output: {
    dir: 'web-dist',
    format: 'es',
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name]-[hash].js',
    sourcemap: !isProd,
    generatedCode: {
      symbols: false,
    },
  },
  watch: {
    clearScreen: false,
  },
});
