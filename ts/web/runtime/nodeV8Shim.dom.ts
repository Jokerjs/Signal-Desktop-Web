// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

export function serialize(value: unknown): unknown {
  return value;
}

export function deserialize<T>(value: T): T {
  return value;
}

export function getHeapSnapshot(): never {
  throw new Error('getHeapSnapshot is unavailable in the browser');
}
