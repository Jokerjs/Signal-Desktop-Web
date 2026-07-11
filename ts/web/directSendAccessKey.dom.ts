// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as Bytes from '../Bytes.std.ts';
import {
  SEALED_SENDER,
  ZERO_ACCESS_KEY,
} from '../types/SealedSender.std.ts';
import { missingCaseError } from '../util/missingCaseError.std.ts';
import { deriveAccessKeyFromProfileKey } from '../util/zkgroup.node.ts';

export function getDirectSendAccessKey(
  conversation: Readonly<{
    accessKey?: string | null;
    profileKey?: string | null;
    sealedSender?: SEALED_SENDER;
  }>
): string | undefined {
  switch (conversation.sealedSender) {
    case SEALED_SENDER.DISABLED:
      return undefined;
    case SEALED_SENDER.UNRESTRICTED:
      return ZERO_ACCESS_KEY;
    case SEALED_SENDER.ENABLED:
    case SEALED_SENDER.UNKNOWN:
    case undefined:
      if (conversation.accessKey?.trim()) {
        return conversation.accessKey;
      }
      if (conversation.profileKey) {
        return Bytes.toBase64(
          deriveAccessKeyFromProfileKey(Bytes.fromBase64(conversation.profileKey))
        );
      }
      return ZERO_ACCESS_KEY;
    default:
      throw missingCaseError(conversation.sealedSender);
  }
}
