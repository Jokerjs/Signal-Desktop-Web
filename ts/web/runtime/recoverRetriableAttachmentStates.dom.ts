// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatShellState, WebAttachment } from '../types.std.ts';

function isWebAudioAttachment(attachment: WebAttachment): boolean {
  return Boolean(attachment.contentType?.startsWith('audio/'));
}

function isWebVisualAttachment(attachment: WebAttachment): boolean {
  return Boolean(
    attachment.contentType?.startsWith('image/') ||
      attachment.contentType?.startsWith('video/')
  );
}

function hasRecoverableAttachmentAccess(attachment: WebAttachment): boolean {
  const keyBase64 = attachment.keyBase64 ?? attachment.key;
  return Boolean(
    attachment.cdnId ||
      attachment.cdnKey ||
      attachment.dataBase64 ||
      attachment.downloadPath ||
      attachment.downloadUrl ||
      attachment.localBlobKey ||
      (attachment.plaintextHash && keyBase64) ||
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
  const hasTransitTierFields = Boolean(attachment.cdnId || attachment.cdnKey);
  const normalizedTransitFields =
    hasTransitTierFields &&
    (attachment.key != null ||
      attachment.digest != null ||
      attachment.incrementalMac != null)
      ? {
          keyBase64: attachment.key ?? attachment.keyBase64,
          digestBase64: attachment.digest ?? attachment.digestBase64,
          incrementalMacBase64:
            attachment.incrementalMac ?? attachment.incrementalMacBase64,
        }
      : undefined;
  const hasNormalizedTransitFieldChange =
    normalizedTransitFields != null &&
    (normalizedTransitFields.keyBase64 !== attachment.keyBase64 ||
      normalizedTransitFields.digestBase64 !== attachment.digestBase64 ||
      normalizedTransitFields.incrementalMacBase64 !==
        attachment.incrementalMacBase64);

  const shouldRecoverAudioDisplayState =
    isWebAudioAttachment(attachment) &&
    (attachment.backfillError === true ||
      attachment.error != null ||
      attachment.isCorrupted === true ||
      attachment.status === 'failed' ||
      attachment.status === 'pending');
  const shouldRecoverVisualDisplayState =
    isWebVisualAttachment(attachment) &&
    (attachment.backfillError === true ||
      attachment.error != null ||
      attachment.isCorrupted === true ||
      attachment.status === 'failed' ||
      attachment.status === 'pending');

  if (
    !shouldRecoverAudioDisplayState &&
    !shouldRecoverVisualDisplayState &&
    !hasRecoverableAttachmentAccess(attachment)
  ) {
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
    attachment.status === 'pending' ||
    thumbnail !== attachment.thumbnail ||
    hasNormalizedTransitFieldChange;

  if (!shouldRecover) {
    return attachment;
  }

  const recovered = { ...attachment, ...normalizedTransitFields, thumbnail };
  delete recovered.backfillError;
  delete recovered.error;
  delete recovered.isCorrupted;
  if (recovered.status === 'failed' || recovered.status === 'pending') {
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
