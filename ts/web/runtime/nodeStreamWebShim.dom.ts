// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

export const ReadableStream = globalThis.ReadableStream;
export const TransformStream = globalThis.TransformStream;
export const WritableStream = globalThis.WritableStream;
export const ByteLengthQueuingStrategy = globalThis.ByteLengthQueuingStrategy;
export const CountQueuingStrategy = globalThis.CountQueuingStrategy;
export const TextDecoderStream = globalThis.TextDecoderStream;
export const TextEncoderStream = globalThis.TextEncoderStream;

export default {
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  ReadableStream,
  TextDecoderStream,
  TextEncoderStream,
  TransformStream,
  WritableStream,
};
