// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFileSync } = require('node:fs');

const applicationRoot = join(dirname(process.execPath), 'app');
const bridgeEntry = join(
  applicationRoot,
  'ts',
  'web',
  'provisioning',
  'WebProvisioningBridge.node.mjs'
);

process.chdir(applicationRoot);
process.env.NODE_ENV ??= 'production';
process.env.SIGNAL_WEB_PROVISIONING_HOST ??= '127.0.0.1';
process.env.SIGNAL_WEB_PROVISIONING_PORT ??= '0';

function reportReady(address) {
  const applicationPackage = JSON.parse(
    readFileSync(join(applicationRoot, 'package.json'), 'utf8')
  );
  const message = {
    type: 'server-address',
    protocolVersion: 1,
    address,
    service: {
      name: applicationPackage.name,
      version: applicationPackage.version,
    },
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    pid: process.pid,
  };

  if (typeof process.send === 'function') {
    process.send(message);
  }

  console.log(`SIGNAL_WEB_BRIDGE_READY ${JSON.stringify(message)}`);
}

async function main() {
  const bridge = await import(pathToFileURL(bridgeEntry).href);
  const { address } = await bridge.startWebProvisioningServer();
  reportReady(address);
}

async function run() {
  try {
    await main();
  } catch (error) {
    console.error('Signal Web bridge executable failed to start', error);
    process.exitCode = 1;
  }
}

void run();
