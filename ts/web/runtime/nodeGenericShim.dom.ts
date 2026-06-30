// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

type AnyFunction = (...args: ReadonlyArray<unknown>) => unknown;

function unavailable(name: string): never {
  throw new Error(`${name} is unavailable in the browser build`);
}

export class PassThrough {}
export class Readable {}
export class Transform {}
export class Writable {}

export const constants = {};
export const promises = {};
export const types = {};

export function Agent(): void {}
export function arch(): string {
  return 'x64';
}
export function createCipheriv(): never {
  return unavailable('createCipheriv');
}
export function createDecipheriv(): never {
  return unavailable('createDecipheriv');
}
export function createGunzip(): PassThrough {
  return new PassThrough();
}
export function createGzip(): PassThrough {
  return new PassThrough();
}
export function createHash() {
  return {
    update() {
      return this;
    },
    digest() {
      return '';
    },
  };
}
export function createHmac() {
  return {
    update() {
      return this;
    },
    digest() {
      return '';
    },
  };
}
export function createReadStream(): never {
  return unavailable('createReadStream');
}
export function createRequire(): () => Record<string, unknown> {
  return () => ({});
}
export function createWriteStream(): never {
  return unavailable('createWriteStream');
}
export function cpus(): Array<{ model: string; speed: number }> {
  const count = Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 1);
  return Array.from({ length: count }, () => ({ model: 'browser', speed: 0 }));
}
export function existsSync(): boolean {
  return false;
}
export function pathExistsSync(): boolean {
  return false;
}
export async function exists(): Promise<boolean> {
  return false;
}
export async function pathExists(): Promise<boolean> {
  return false;
}
export async function emptyDir(): Promise<void> {}
export async function ensureFile(): Promise<void> {}
export function format(value: unknown): string {
  return String(value);
}
export function isIP(): number {
  return 0;
}
export function platform(): string {
  return 'browser';
}
export function release(): string {
  return '0.0.0';
}
export function homedir(): string {
  return '/';
}
export function tmpdir(): string {
  return '/tmp';
}
export function endianness(): string {
  return 'LE';
}
export async function lookup(): Promise<ReadonlyArray<unknown>> {
  return [];
}
export async function mkdir(): Promise<void> {}
export async function open(): Promise<never> {
  return unavailable('open');
}
export function parse(value: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(value));
}
export function pipeline(...args: ReadonlyArray<unknown>): Promise<void> | void {
  const last = args.at(-1);
  if (typeof last === 'function') {
    (last as AnyFunction)(undefined);
    return;
  }
  return Promise.resolve();
}
export function promisify(fn: AnyFunction): AnyFunction {
  return (...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (error: unknown, value: unknown) => {
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      });
    });
}
export function callbackify(fn: AnyFunction): AnyFunction {
  return (...args) => {
    const callback = args.at(-1);
    void Promise.resolve(fn(...args.slice(0, -1))).then(
      value => {
        if (typeof callback === 'function') {
          callback(undefined, value);
        }
      },
      error => {
        if (typeof callback === 'function') {
          callback(error);
        }
      }
    );
  };
}
export function deprecate(fn: AnyFunction): AnyFunction {
  return fn;
}
export function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(size);
  crypto.getRandomValues(result);
  return result;
}
export async function readFile(): Promise<never> {
  return unavailable('readFile');
}
export async function readdir(): Promise<ReadonlyArray<string>> {
  return [];
}
export function readdirSync(): ReadonlyArray<string> {
  return [];
}
export async function rename(): Promise<void> {}
export async function rm(): Promise<void> {}
export async function stat(): Promise<{ size: number }> {
  return { size: 0 };
}
export function statSync(): { size: number } {
  return { size: 0 };
}
export async function statfs(): Promise<{ bavail: number; bsize: number }> {
  return { bavail: 0, bsize: 0 };
}
export function stringify(value: Record<string, string>): string {
  return new URLSearchParams(value).toString();
}
export async function unlink(): Promise<void> {}
export async function writeFile(): Promise<void> {}
export async function copyFile(): Promise<void> {}
export async function setTimeout(ms = 0): Promise<void> {
  await new Promise(resolve => {
    globalThis.setTimeout(resolve, ms);
  });
}

const NodeURL = globalThis.URL;
const NodeURLSearchParams = globalThis.URLSearchParams;
export { NodeURL as URL, NodeURLSearchParams as URLSearchParams };

function assert(value: unknown, message?: string): asserts value {
  if (!value) {
    throw new Error(message ?? 'Assertion failed');
  }
}

const defaultExport = Object.assign(assert, {
  Agent,
  PassThrough,
  Readable,
  Transform,
  Writable,
  arch,
  constants,
  copyFile,
  createCipheriv,
  createDecipheriv,
  createGunzip,
  createGzip,
  createHash,
  createHmac,
  createReadStream,
  createRequire,
  createWriteStream,
  cpus,
  emptyDir,
  ensureFile,
  exists,
  existsSync,
  format,
  homedir,
  isIP,
  lookup,
  mkdir,
  open,
  parse,
  pathExists,
  pathExistsSync,
  platform,
  pipeline,
  promises,
  randomBytes,
  readFile,
  readdir,
  readdirSync,
  release,
  rename,
  rm,
  stat,
  statSync,
  statfs,
  stringify,
  setTimeout,
  endianness,
  tmpdir,
  unlink,
  writeFile,
});

export default defaultExport;
