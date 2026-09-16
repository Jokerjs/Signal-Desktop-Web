// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { normalizeNoteToSelfMessage } from '../../web/normalizeNoteToSelfMessage.std.ts';
import type { WebMessage } from '../../web/types.std.ts';

const OUR_CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';

function createMessage(patch: Partial<WebMessage> = {}): WebMessage {
  return {
    id: 'message-id',
    conversationId: OUR_CONVERSATION_ID,
    body: 'note',
    timestamp: 1,
    direction: 'incoming',
    ...patch,
  };
}

describe('normalizeNoteToSelfMessage', () => {
  it('renders an incoming Note to Self message as outgoing', () => {
    const message = createMessage({ desktopType: 'incoming' });

    assert.deepEqual(normalizeNoteToSelfMessage(message, OUR_CONVERSATION_ID), {
      ...message,
      direction: 'outgoing',
      desktopType: 'outgoing',
    });
  });

  it('does not change an incoming message from another conversation', () => {
    const message = createMessage({
      conversationId: CONTACT_CONVERSATION_ID,
    });

    assert.strictEqual(
      normalizeNoteToSelfMessage(message, OUR_CONVERSATION_ID),
      message
    );
  });

  it('does not allocate a new object for an outgoing Note to Self message', () => {
    const message = createMessage({ direction: 'outgoing' });

    assert.strictEqual(
      normalizeNoteToSelfMessage(message, OUR_CONVERSATION_ID),
      message
    );
  });

  it('preserves Note to Self system message types', () => {
    const message = createMessage({ desktopType: 'timer-notification' });

    assert.deepInclude(
      normalizeNoteToSelfMessage(message, OUR_CONVERSATION_ID),
      {
        direction: 'outgoing',
        desktopType: 'timer-notification',
      }
    );
  });
});
