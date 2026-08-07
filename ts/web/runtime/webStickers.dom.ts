// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import type { StateType } from '../../state/reducer.preload.ts';
import { parseUnknown } from '../../util/schemas.std.ts';
import { getRenderApiBaseUrl } from '../renderConfig.dom.ts';

const WebStickerSchema = z.object({
  emoji: z.string().optional(),
  height: z.number().int(),
  id: z.number().int(),
  isCoverOnly: z.boolean(),
  packId: z.string(),
  path: z.string(),
  size: z.number().int().optional(),
  version: z.literal(2),
  width: z.number().int(),
});

const WebStickerPackSchema = z.object({
  author: z.string(),
  coverStickerId: z.number().int(),
  createdAt: z.number().int(),
  downloadAttempts: z.number().int(),
  id: z.string(),
  installedAt: z.number().int(),
  key: z.string(),
  lastUsed: z.number().int(),
  status: z.literal('installed'),
  stickerCount: z.number().int(),
  stickers: z.record(z.string(), WebStickerSchema),
  storageNeedsSync: z.literal(false),
  title: z.string(),
});

const WebBlessedStickerPacksResponseSchema = z.object({
  packs: z.array(WebStickerPackSchema),
});

export async function loadWebBlessedStickerPacks(): Promise<
  StateType['stickers']['packs']
> {
  const url = new URL('stickers/blessed-packs', getRenderApiBaseUrl());
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `loadWebBlessedStickerPacks: request failed with status ${response.status}`
    );
  }

  const body: unknown = await response.json();
  const parsed = parseUnknown(WebBlessedStickerPacksResponseSchema, body);

  return Object.fromEntries(
    parsed.packs.map(pack => [
      pack.id,
      {
        ...pack,
        stickers: Object.fromEntries(
          Object.entries(pack.stickers).map(([stickerId, sticker]) => [
            stickerId,
            {
              ...sticker,
              path: new URL(sticker.path, getRenderApiBaseUrl()).toString(),
            },
          ])
        ),
      },
    ])
  ) as StateType['stickers']['packs'];
}
