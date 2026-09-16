// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { inject } = require('postject');

const root = join(import.meta.dirname, '..');
const rootPackagePath = join(root, 'package.json');
const serverDistPath = join(root, 'server-dist');
const outputRoot = join(root, 'server-executable-dist');
const seaMainPath = join(root, 'scripts', 'web-bridge-sea-main.cjs');
const seaSentinelFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
    });

    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      rejectRun(
        new Error(
          `${basename(command)} failed with code ${String(code)} and signal ${String(signal)}`
        )
      );
    });
  });
}

async function assertReadable(path, description) {
  try {
    await access(path, constants.R_OK);
  } catch (error) {
    throw new Error(`${description} is not readable at ${path}`, {
      cause: error,
    });
  }
}

async function findSymbolicLinks(rootPath) {
  const symbolicLinks = [];

  async function visit(directoryPath) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async entry => {
        const entryPath = join(directoryPath, entry.name);
        if (entry.isSymbolicLink()) {
          symbolicLinks.push(entryPath);
        } else if (entry.isDirectory()) {
          await visit(entryPath);
        }
      })
    );
  }

  await visit(rootPath);
  return symbolicLinks.sort((left, right) => left.localeCompare(right));
}

async function assertPortableNodeModules(applicationRoot) {
  const nodeModulesPath = join(applicationRoot, 'node_modules');
  const symbolicLinks = await findSymbolicLinks(nodeModulesPath);
  if (symbolicLinks.length !== 0) {
    throw new Error(
      `Server node_modules must not contain symbolic links:\n${symbolicLinks.join('\n')}`
    );
  }
}

async function assertRuntimeDependencies(applicationRoot, dependencyNames) {
  const applicationRequire = createRequire(
    join(applicationRoot, 'package.json')
  );
  const nodeModulesPath = join(applicationRoot, 'node_modules');

  await Promise.all(
    dependencyNames.map(async dependencyName => {
      const dependencyPath = join(
        nodeModulesPath,
        ...dependencyName.split('/')
      );
      let dependencyStat;
      try {
        dependencyStat = await lstat(dependencyPath);
      } catch (error) {
        throw new Error(
          `Missing server runtime dependency ${dependencyName} at ${dependencyPath}`,
          { cause: error }
        );
      }

      if (dependencyStat.isSymbolicLink() || !dependencyStat.isDirectory()) {
        throw new Error(
          `Server runtime dependency ${dependencyName} must be a physical directory at ${dependencyPath}`
        );
      }

      try {
        applicationRequire.resolve(dependencyName);
      } catch (error) {
        throw new Error(
          `Server runtime dependency ${dependencyName} cannot be resolved from ${applicationRoot}`,
          { cause: error }
        );
      }
    })
  );

  await assertPortableNodeModules(applicationRoot);
}

async function download(url, destinationPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: HTTP ${response.status} ${response.statusText}`
    );
  }

  await writeFile(destinationPath, Buffer.from(await response.arrayBuffer()));
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function readExpectedChecksum(checksumText, archiveName) {
  const suffix = `  ${archiveName}`;
  const line = checksumText
    .split(/\r?\n/u)
    .find(checksumLine => checksumLine.endsWith(suffix));

  if (!line) {
    throw new Error(`Missing checksum for ${archiveName}`);
  }

  const expectedChecksum = line.slice(0, -suffix.length);
  if (
    !/^[a-f0-9]{64}$/u.test(expectedChecksum) ||
    line !== `${expectedChecksum}${suffix}`
  ) {
    throw new Error(`Invalid checksum entry for ${archiveName}: ${line}`);
  }

  return expectedChecksum;
}

async function downloadAndExtractNodeRuntime({
  archiveName,
  archiveType,
  downloadBaseUrl,
  downloadRoot,
  expectedChecksum,
  extractionRoot,
  runtimeRelativePath,
  targetId,
}) {
  const archivePath = join(downloadRoot, archiveName);
  console.log(`Downloading Node runtime for ${targetId}: ${archiveName}`);
  await download(`${downloadBaseUrl}/${archiveName}`, archivePath);

  const actualChecksum = await sha256(archivePath);
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Checksum mismatch for ${archiveName}: expected ${expectedChecksum}, got ${actualChecksum}`
    );
  }

  const targetExtractionRoot = join(extractionRoot, targetId);
  await mkdir(targetExtractionRoot, { recursive: true });
  if (archiveType === 'tar.gz') {
    await run('tar', ['-xzf', archivePath, '-C', targetExtractionRoot]);
  } else if (archiveType === 'zip') {
    await run('unzip', ['-q', archivePath, '-d', targetExtractionRoot]);
  } else {
    throw new Error(`Unsupported Node archive type: ${archiveType}`);
  }

  const runtimePath = join(targetExtractionRoot, runtimeRelativePath);
  await assertReadable(runtimePath, `Node runtime for ${targetId}`);
  return runtimePath;
}

async function pruneLibSignalPrebuilds(applicationRoot, target) {
  const applicationRequire = createRequire(
    join(applicationRoot, 'package.json')
  );
  const libSignalPackagePath = applicationRequire.resolve(
    '@signalapp/libsignal-client/package.json'
  );
  const prebuildsPath = join(dirname(libSignalPackagePath), 'prebuilds');
  const requiredPrebuildName = `${target.platform}-${target.arch}`;
  const entries = await readdir(prebuildsPath, { withFileTypes: true });

  if (
    !entries.some(
      entry => entry.isDirectory() && entry.name === requiredPrebuildName
    )
  ) {
    throw new Error(
      `Missing @signalapp/libsignal-client prebuild ${requiredPrebuildName} in ${prebuildsPath}`
    );
  }

  await Promise.all(
    entries.map(entry => {
      if (!entry.isDirectory() || entry.name === requiredPrebuildName) {
        return Promise.resolve();
      }
      return rm(join(prebuildsPath, entry.name), {
        force: true,
        recursive: true,
      });
    })
  );
}

async function buildTarget({
  commonApplicationRoot,
  nodeRuntimePath,
  nodeVersion,
  seaBlob,
  target,
}) {
  const targetRoot = join(outputRoot, target.id);
  const applicationRoot = join(targetRoot, 'app');
  const executablePath = join(targetRoot, target.executableName);

  await mkdir(targetRoot, { recursive: true });
  await cp(commonApplicationRoot, applicationRoot, {
    recursive: true,
  });
  await pruneLibSignalPrebuilds(applicationRoot, target);
  await assertPortableNodeModules(applicationRoot);
  await copyFile(nodeRuntimePath, executablePath);

  if (target.platform === 'darwin') {
    await run('codesign', ['--remove-signature', executablePath]);
  }

  await inject(executablePath, 'NODE_SEA_BLOB', seaBlob, {
    machoSegmentName: 'NODE_SEA',
    sentinelFuse: seaSentinelFuse,
  });

  if (target.platform === 'darwin') {
    await run('codesign', ['--force', '--sign', '-', executablePath]);
    await chmod(executablePath, 0o755);
  }

  await writeFile(
    join(targetRoot, 'BUILD_INFO.json'),
    `${JSON.stringify(
      {
        executable: target.executableName,
        node: nodeVersion,
        platform: target.platform,
        arch: target.arch,
      },
      null,
      2
    )}\n`
  );

  console.log(`Built ${target.id} at ${targetRoot}`);
}

async function main() {
  const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'));
  const serverPackage = JSON.parse(
    await readFile(join(serverDistPath, 'package.json'), 'utf8')
  );
  const runtimeDependencyNames = Object.keys(serverPackage.dependencies ?? {});
  const requiredNodeVersion = rootPackage.engines?.node;
  if (typeof requiredNodeVersion !== 'string') {
    throw new Error(`Missing engines.node in ${rootPackagePath}`);
  }
  if (process.versions.node !== requiredNodeVersion) {
    throw new Error(
      `Executable build requires Node ${requiredNodeVersion}; current Node is ${process.versions.node}`
    );
  }
  if (
    process.platform !== 'darwin' ||
    (process.arch !== 'arm64' && process.arch !== 'x64')
  ) {
    throw new Error(
      `Cross-platform executable build requires a darwin-arm64 or darwin-x64 host; current host is ${process.platform}-${process.arch}`
    );
  }

  const pnpmEntrypoint = process.env.npm_execpath;
  if (!pnpmEntrypoint) {
    throw new Error(
      'Missing npm_execpath. Run this build through pnpm run web:build:server:executable.'
    );
  }

  await assertReadable(
    join(
      serverDistPath,
      'ts',
      'web',
      'provisioning',
      'WebProvisioningBridge.node.mjs'
    ),
    'Web bridge server bundle'
  );
  await assertReadable(seaMainPath, 'SEA main script');

  const nodeArchivePrefix = `node-v${requiredNodeVersion}`;
  const targets = [
    {
      id: 'darwin-arm64',
      platform: 'darwin',
      arch: 'arm64',
      archiveName: `${nodeArchivePrefix}-darwin-arm64.tar.gz`,
      archiveType: 'tar.gz',
      runtimeRelativePath: join(
        `${nodeArchivePrefix}-darwin-arm64`,
        'bin',
        'node'
      ),
      executableName: 'signal-web-bridge',
    },
    {
      id: 'darwin-x64',
      platform: 'darwin',
      arch: 'x64',
      archiveName: `${nodeArchivePrefix}-darwin-x64.tar.gz`,
      archiveType: 'tar.gz',
      runtimeRelativePath: join(
        `${nodeArchivePrefix}-darwin-x64`,
        'bin',
        'node'
      ),
      executableName: 'signal-web-bridge',
    },
    {
      id: 'win32-x64',
      platform: 'win32',
      arch: 'x64',
      archiveName: `${nodeArchivePrefix}-win-x64.zip`,
      archiveType: 'zip',
      runtimeRelativePath: join(`${nodeArchivePrefix}-win-x64`, 'node.exe'),
      executableName: 'signal-web-bridge.exe',
    },
  ];

  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(outputRoot, { recursive: true });

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'signal-web-bridge-sea-'));
  try {
    const commonApplicationRoot = join(temporaryRoot, 'app');
    const downloadRoot = join(temporaryRoot, 'downloads');
    const extractionRoot = join(temporaryRoot, 'node-runtimes');
    await mkdir(downloadRoot, { recursive: true });
    await mkdir(extractionRoot, { recursive: true });
    await cp(serverDistPath, commonApplicationRoot, { recursive: true });

    await run(
      process.execPath,
      [
        pnpmEntrypoint,
        'install',
        '--prod',
        '--no-lockfile',
        '--ignore-workspace',
        '--ignore-scripts',
        '--node-linker=hoisted',
      ],
      { cwd: commonApplicationRoot }
    );
    await rm(join(commonApplicationRoot, 'node_modules', '.bin'), {
      force: true,
      recursive: true,
    });
    await assertRuntimeDependencies(
      commonApplicationRoot,
      runtimeDependencyNames
    );

    const seaBlobPath = join(temporaryRoot, 'sea-prep.blob');
    const seaConfigPath = join(temporaryRoot, 'sea-config.json');
    await writeFile(
      seaConfigPath,
      `${JSON.stringify(
        {
          main: seaMainPath,
          output: seaBlobPath,
          disableExperimentalSEAWarning: true,
          useCodeCache: false,
          useSnapshot: false,
        },
        null,
        2
      )}\n`
    );
    await run(process.execPath, ['--experimental-sea-config', seaConfigPath]);
    const seaBlob = await readFile(seaBlobPath);

    const downloadBaseUrl = `https://nodejs.org/download/release/v${requiredNodeVersion}`;
    const checksumPath = join(downloadRoot, 'SHASUMS256.txt');
    await download(`${downloadBaseUrl}/SHASUMS256.txt`, checksumPath);
    const checksumText = await readFile(checksumPath, 'utf8');

    await Promise.all(
      targets.map(async target => {
        const nodeRuntimePath = await downloadAndExtractNodeRuntime({
          ...target,
          downloadBaseUrl,
          downloadRoot,
          expectedChecksum: readExpectedChecksum(
            checksumText,
            target.archiveName
          ),
          extractionRoot,
          targetId: target.id,
        });
        await buildTarget({
          commonApplicationRoot,
          nodeRuntimePath,
          nodeVersion: requiredNodeVersion,
          seaBlob,
          target,
        });
      })
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }

  await copyFile(
    join(root, 'WEB_BRIDGE_EXECUTABLE.md'),
    join(outputRoot, 'README.md')
  );
  await writeFile(
    join(outputRoot, 'BUILD_INFO.json'),
    `${JSON.stringify(
      {
        node: requiredNodeVersion,
        buildHost: {
          platform: process.platform,
          arch: process.arch,
        },
        targets: targets.map(target => ({
          directory: target.id,
          executable: target.executableName,
          platform: target.platform,
          arch: target.arch,
        })),
      },
      null,
      2
    )}\n`
  );

  console.log(`Built ${targets.length} targets at ${outputRoot}`);
}

await main();
