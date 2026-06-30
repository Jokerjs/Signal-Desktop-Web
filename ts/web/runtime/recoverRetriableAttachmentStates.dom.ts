// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatShellState, WebAttachment } from '../types.std.ts';

function hasRecoverableAttachmentAccess(attachment: WebAttachment): boolean {
  return Boolean(
    attachment.cdnId ||
      attachment.cdnKey ||
      attachment.dataBase64 ||
      attachment.downloadPath ||
      attachment.downloadUrl ||
      attachment.localBlobKey ||
      attachment.previewUrl ||
      attachment.thumbnailUrl ||
      attachment.url
  );
}

function recoverRetriableAttachmentState(
  attachment: WebAttachment
): WebAttachment {
  const thumbnail = attachment.thumbnail
    ? recoverRetriableAttachmentState(attachment.thumbnail)
    : undefined;

  if (!hasRecoverableAttachmentAccess(attachment)) {
    return thumbnail === attachment.thumbnail
      ? attachment
      : {
          ...attachment,
          thumbnail,
        };
  }

  const shouldRecover =
    attachment.backfillError === true ||
    attachment.error != null ||
    attachment.isCorrupted === true ||
    attachment.status === 'failed' ||
    thumbnail !== attachment.thumbnail;

  if (!shouldRecover) {
    return attachment;
  }

  const recovered = { ...attachment, thumbnail };
  delete recovered.backfillError;
  delete recovered.error;
  delete recovered.isCorrupted;
  if (recovered.status === 'failed') {
    delete recovered.status;
  }

  return recovered;
}

export function recoverRetriableAttachmentStates(
  shell: ChatShellState
): ChatShellState {
  let didChange = false;
  const messages = shell.messages.map(message => {
    if (!message.attachments?.length) {
      return message;
    }

    const attachments = message.attachments.map(attachment => {
      const recovered = recoverRetriableAttachmentState(attachment);
      if (recovered !== attachment) {
        didChange = true;
      }
      return recovered;
    });

    return attachments === message.attachments
      ? message
      : {
          ...message,
          attachments,
        };
  });

  return didChange
    ? {
        ...shell,
        messages,
      }
    : shell;
}
