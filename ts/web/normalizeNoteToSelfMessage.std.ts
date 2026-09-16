// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { WebMessage } from './types.std.ts';

export function normalizeNoteToSelfMessage(
  message: WebMessage,
  ourConversationId: string | undefined
): WebMessage {
  if (
    !ourConversationId ||
    message.conversationId !== ourConversationId ||
    message.direction === 'outgoing'
  ) {
    return message;
  }

  return {
    ...message,
    direction: 'outgoing',
    desktopType:
      message.desktopType === 'incoming' ? 'outgoing' : message.desktopType,
  };
}
