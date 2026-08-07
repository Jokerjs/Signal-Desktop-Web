// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { Environment, setEnvironment } from '../../environment.std.ts';
import { getRenderApiBaseUrl } from '../renderConfig.dom.ts';

try {
  setEnvironment(Environment.PackagedApp, false);
} catch (error) {
  if (
    !(error instanceof Error) ||
    error.message !== 'Environment has already been set'
  ) {
    throw error;
  }
}

const largeEmojiFontUrl = new URL(
  'emoji/font/large',
  getRenderApiBaseUrl()
).toString();
const largeEmojiFont = new window.FontFace(
  'Signal Web Emoji Large',
  `url(${JSON.stringify(largeEmojiFontUrl)}) format("woff2")`,
  { display: 'swap' }
);
document.fonts.add(largeEmojiFont);
