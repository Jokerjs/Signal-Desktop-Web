// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

function normalize(input: string | undefined): string {
  if (!input) {
    return '.';
  }
  const absolute = input.startsWith('/');
  const parts = input.split('/').filter(Boolean);
  const stack = new Array<string>();
  for (const part of parts) {
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `${absolute ? '/' : ''}${stack.join('/')}` || (absolute ? '/' : '.');
}

function join(...parts: ReadonlyArray<string | undefined>): string {
  return normalize(parts.filter(Boolean).join('/'));
}

function basename(input: string | undefined): string {
  const normalized = normalize(input);
  return normalized.split('/').pop() ?? normalized;
}

function dirname(input: string | undefined): string {
  const normalized = normalize(input);
  const index = normalized.lastIndexOf('/');
  if (index <= 0) {
    return normalized.startsWith('/') ? '/' : '.';
  }
  return normalized.slice(0, index);
}

function extname(input: string | undefined): string {
  const base = basename(input);
  const index = base.lastIndexOf('.');
  return index > 0 ? base.slice(index) : '';
}

function parse(input: string | undefined) {
  const dir = dirname(input);
  const base = basename(input);
  const ext = extname(base);
  return {
    root: input?.startsWith('/') ? '/' : '',
    dir,
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
}

function isAbsolute(input: string | undefined): boolean {
  return Boolean(input?.startsWith('/'));
}

function relative(from: string | undefined, to: string | undefined): string {
  const fromParts = normalize(from).split('/').filter(Boolean);
  const toParts = normalize(to).split('/').filter(Boolean);
  while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  return [...fromParts.map(() => '..'), ...toParts].join('/') || '.';
}

function resolvePath(...parts: ReadonlyArray<string | undefined>): string {
  return normalize(join('/', ...parts));
}

const sep = '/';
const posix = {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve: resolvePath,
  sep,
};

export {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolvePath as resolve,
  sep,
  posix,
};

export default {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve: resolvePath,
  sep,
  posix,
};
