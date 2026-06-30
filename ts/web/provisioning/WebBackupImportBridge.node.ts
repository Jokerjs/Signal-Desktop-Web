// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { BackupKey } from '@signalapp/libsignal-client/dist/AccountKeys.js';
import { MessageBackupKey } from '@signalapp/libsignal-client/dist/MessageBackup.js';

import { Backups, SignalService } from '../../protobuf/index.std.ts';
import * as Bytes from '../../Bytes.std.ts';
import { constantTimeEqual } from '../../Crypto.node.ts';
import { toAciObject, fromAciUuidBytes, fromPniUuidBytesOrUntaggedString } from '../../util/ServiceId.node.ts';
import { normalizeAci } from '../../util/normalizeAci.std.ts';
import { strictAssert } from '../../util/assert.std.ts';
import { HashType } from '../../types/Crypto.std.ts';
import { getMacAndUpdateHmac } from '../../util/getMacAndUpdateHmac.node.ts';
import { decipherWithAesKey } from '../../util/decipherWithAesKey.node.ts';
import { DelimitedStream } from '../../util/DelimitedStream.node.ts';
import { bytesToUuid } from '../../util/uuidToBytes.std.ts';
import { MY_STORY_ID } from '../../types/Stories.std.ts';
import { MessageRequestResponseEvent } from '../../types/MessageRequestResponseEvent.std.ts';
import {
  deriveGroupID,
  deriveGroupPublicParams,
  deriveGroupSecretParams,
} from '../../util/zkgroup.node.ts';
import type {
  ChatShellState,
  ContactsBootstrap,
  LinkedPayload,
  WebAttachment,
  WebConversation,
  WebMessage,
} from '../types.std.ts';

type WebBackupMessagePatch = Partial<
  Pick<
    WebMessage,
    | 'body'
    | 'deletedForEveryone'
    | 'deletedForEveryoneByAdminAci'
    | 'deletedForEveryoneTimestamp'
    | 'desktopType'
    | 'expirationTimerUpdate'
    | 'flags'
    | 'isErased'
    | 'key_changed'
	    | 'messageRequestResponseEvent'
	    | 'pinMessage'
    | 'requiredProtocolVersion'
    | 'sourceServiceId'
    | 'supportedVersionAtReceive'
    | 'verified'
    | 'verifiedChanged'
  >
>;

type BackupImportStats = {
  backupInfo: number;
  recipients: number;
  chats: number;
  chatItems: number;
  messages: number;
  skippedChatItems: number;
  skippedChatItemTypes: Record<string, number>;
  unsupportedFrames: number;
};

export type WebBackupImportResult = {
  contactsBootstrap: ContactsBootstrap;
  chatShell: ChatShellState;
  mediaRootBackupKeyBase64?: string;
  stats: BackupImportStats;
};

type BackupKeyMaterial = {
  aesKey: Uint8Array<ArrayBuffer>;
  macKey: Uint8Array<ArrayBuffer>;
};

function getBackupKeyMaterial({
  aci,
  ephemeralBackupKeyBase64,
}: {
  aci: string;
  ephemeralBackupKeyBase64: string;
}): BackupKeyMaterial {
  const backupKey = new BackupKey(Bytes.fromBase64(ephemeralBackupKeyBase64));
  const messageKey = new MessageBackupKey({
    backupKey,
    backupId: backupKey.deriveBackupId(toAciObject(normalizeAci(aci, 'webBackup.aci'))),
  });

  return {
    aesKey: messageKey.aesKey,
    macKey: messageKey.hmacKey,
  };
}

async function verifyBackupMac(
  createBackupStream: () => Readable,
  macKey: Uint8Array<ArrayBuffer>
): Promise<{ totalBytes: number; theirMac: Uint8Array<ArrayBuffer> }> {
  const hmac = createHmac(HashType.size256, macKey);
  let theirMac: Uint8Array<ArrayBuffer> | undefined;
  let totalBytes = 0;
  const sink = new PassThrough();
  sink.on('data', chunk => {
    totalBytes += chunk.byteLength;
  });
  sink.resume();

  await pipeline(
    createBackupStream(),
    getMacAndUpdateHmac(hmac, value => {
      theirMac = value;
    }),
    sink
  );

  strictAssert(theirMac != null, 'verifyBackupMac: Missing MAC');
  strictAssert(constantTimeEqual(hmac.digest(), theirMac), 'verifyBackupMac: Bad MAC');

  return { totalBytes, theirMac };
}

function timestampFromLong(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return undefined;
}

function e164FromLong(value: unknown): string | undefined {
  const number = timestampFromLong(value);
  return number == null || number === 0 ? undefined : `+${number}`;
}

function getContactTitle(contact: Backups.Contact, fallback: string): string {
  const nickname = [contact.nickname?.given, contact.nickname?.family]
    .filter(Boolean)
    .join(' ')
    .trim();
  const systemName = [
    contact.systemGivenName,
    contact.systemFamilyName,
    contact.systemNickname,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  const profileName = [contact.profileGivenName, contact.profileFamilyName]
    .filter(Boolean)
    .join(' ')
    .trim();

  return nickname || systemName || profileName || contact.username || fallback;
}

function getGroupTitle(group: Backups.Group, fallback: string): string {
  return group.snapshot?.title?.content?.title?.trim() || fallback;
}

function getRemovalStageFromContact(
  contact: Backups.Contact
): WebConversation['removalStage'] {
  switch (contact.visibility) {
    case Backups.Contact.Visibility.HIDDEN:
      return 'justNotification';
    case Backups.Contact.Visibility.HIDDEN_MESSAGE_REQUEST:
      return 'messageRequest';
    case Backups.Contact.Visibility.VISIBLE:
    default:
      return undefined;
  }
}

function fromAvatarColor(
  color: Backups.Contact['avatarColor'] | Backups.Group['avatarColor'] | null | undefined
): string | undefined {
  switch (color) {
    case Backups.AvatarColor.A100:
      return 'A100';
    case Backups.AvatarColor.A110:
      return 'A110';
    case Backups.AvatarColor.A120:
      return 'A120';
    case Backups.AvatarColor.A130:
      return 'A130';
    case Backups.AvatarColor.A140:
      return 'A140';
    case Backups.AvatarColor.A150:
      return 'A150';
    case Backups.AvatarColor.A160:
      return 'A160';
    case Backups.AvatarColor.A170:
      return 'A170';
    case Backups.AvatarColor.A180:
      return 'A180';
    case Backups.AvatarColor.A190:
      return 'A190';
    case Backups.AvatarColor.A200:
      return 'A200';
    case Backups.AvatarColor.A210:
      return 'A210';
    case undefined:
    case null:
      return undefined;
    default:
      return 'A100';
  }
}

function createConversationFromContact(
  contact: Backups.Contact,
  fallbackId: string
): WebConversation {
  const aci = fromAciUuidBytes(contact.aci);
  const pni = fromPniUuidBytesOrUntaggedString(contact.pni, undefined, 'webBackup.contact.pni');
  const phoneNumber = e164FromLong(contact.e164);
  const id = aci ?? pni ?? phoneNumber ?? fallbackId;
  const title = getContactTitle(contact, phoneNumber ?? id);
  const removalStage = getRemovalStageFromContact(contact);

  return {
    acceptedMessageRequest: removalStage == null,
    id,
    type: 'direct',
    conversationType: 'direct',
    serviceId: aci ?? undefined,
    phoneNumber: phoneNumber ?? undefined,
    e164: phoneNumber ?? undefined,
    username: contact.username ?? undefined,
    profileKey: contact.profileKey?.byteLength
      ? Bytes.toBase64(contact.profileKey)
      : undefined,
    profileName: contact.profileGivenName ?? undefined,
    profileFamilyName: contact.profileFamilyName ?? undefined,
    profileSharing: contact.profileSharing,
    color: fromAvatarColor(contact.avatarColor),
    removalStage,
    title,
    titleNoDefault: title,
    searchableTitle: title,
    hasMessages: false,
  };
}

function createConversationFromSelf(
  linkedPayload: LinkedPayload,
  fallbackId: string
): WebConversation {
  const aci = linkedPayload.credentials?.aci ?? linkedPayload.account.aci ?? fallbackId;
  const title = linkedPayload.account.title ?? linkedPayload.account.number ?? 'Note to Self';
  return {
    id: aci,
    type: 'direct',
    conversationType: 'direct',
    serviceId: aci,
    phoneNumber: linkedPayload.account.number ?? linkedPayload.account.phoneNumber,
    e164: linkedPayload.account.number ?? linkedPayload.account.phoneNumber,
    isMe: true,
    title,
    titleNoDefault: title,
    searchableTitle: title,
    hasMessages: false,
  };
}

function createConversationFromGroup(
  group: Backups.Group,
  fallbackId: string
): WebConversation {
  const secretParams = group.masterKey
    ? deriveGroupSecretParams(group.masterKey)
    : undefined;
  const publicParams = secretParams
    ? deriveGroupPublicParams(secretParams)
    : undefined;
  const groupId = secretParams
    ? Bytes.toBase64(deriveGroupID(secretParams))
    : fallbackId;
  const title = getGroupTitle(group, 'Unknown group');
  const membersV2 = group.snapshot?.members
    .map(member => {
      const aci = fromAciUuidBytes(member.userId);
      if (!aci) {
        return undefined;
      }
      return {
        aci,
        joinedAtVersion: member.joinedAtVersion ?? 0,
        labelString: member.labelString || undefined,
        role: member.role ?? Backups.Group.Member.Role.UNKNOWN,
      };
    })
    .filter((member): member is NonNullable<typeof member> => member != null);
  const pendingMembersV2 = group.snapshot?.membersPendingProfileKey
    .map(memberPendingProfileKey => {
      const member = memberPendingProfileKey.member;
      const serviceId = member ? fromAciUuidBytes(member.userId) : undefined;
      const addedByUserId = fromAciUuidBytes(
        memberPendingProfileKey.addedByUserId
      );
      if (!serviceId || !addedByUserId || !member) {
        return undefined;
      }
      return {
        addedByUserId,
        role: member.role ?? Backups.Group.Member.Role.UNKNOWN,
        serviceId,
        timestamp: Number(memberPendingProfileKey.timestamp ?? 0n),
      };
    })
    .filter((member): member is NonNullable<typeof member> => member != null);
  return {
    id: groupId,
    type: 'group',
    conversationType: 'group',
    groupId,
    masterKey: group.masterKey ? Bytes.toBase64(group.masterKey) : undefined,
    publicParams: publicParams ? Bytes.toBase64(publicParams) : undefined,
    revision: group.snapshot?.version ?? 0,
    secretParams: secretParams ? Bytes.toBase64(secretParams) : undefined,
    membersV2,
    pendingMembersV2,
    color: fromAvatarColor(group.avatarColor),
    remoteAvatarUrl: group.snapshot?.avatarUrl ?? undefined,
    title,
    titleNoDefault: title,
    searchableTitle: title,
    hasMessages: false,
  };
}

function getTextBody(chatItem: Backups.ChatItem): string | undefined {
  const item = chatItem.item;
  if (!item) {
    return undefined;
  }
  if (item.standardMessage?.text?.body) {
    return item.standardMessage.text.body;
  }
  if (item.directStoryReplyMessage?.reply?.textReply?.text?.body) {
    return item.directStoryReplyMessage.reply.textReply.text.body;
  }
  if (item.stickerMessage) {
    return '[Sticker]';
  }
  if (item.contactMessage) {
    return '[Contact]';
  }
  if (item.paymentNotification) {
    return '[Payment]';
  }
  if (item.giftBadge) {
    return '[Gift badge]';
  }
  return undefined;
}

function incrementCounter(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function getChatItemType(chatItem: Backups.ChatItem): string {
  const item = chatItem.item;
  if (!item) {
    return 'missing-item';
  }
  if (item.standardMessage) {
    return 'standardMessage';
  }
  if (item.viewOnceMessage) {
    return 'viewOnceMessage';
  }
  if (item.directStoryReplyMessage) {
    return 'directStoryReplyMessage';
  }
  if (item.poll) {
    return 'poll';
  }
  if (item.contactMessage) {
    return 'contactMessage';
  }
  if (item.adminDeletedMessage) {
    return 'adminDeletedMessage';
  }
  if (item.remoteDeletedMessage) {
    return 'remoteDeletedMessage';
  }
  if (item.stickerMessage) {
    return 'stickerMessage';
  }
  if (item.paymentNotification) {
    return 'paymentNotification';
  }
  if (item.giftBadge) {
    return 'giftBadge';
  }
  if (item.updateMessage) {
    const update = item.updateMessage.update;
    if (!update) {
      return 'updateMessage';
    }
    if (update.groupChange) {
      return 'updateMessage.groupChange';
    }
    if (update.expirationTimerChange) {
      return 'updateMessage.expirationTimerChange';
    }
    if (update.simpleUpdate) {
      return 'updateMessage.simpleUpdate';
    }
    if (update.profileChange) {
      return 'updateMessage.profileChange';
    }
    if (update.learnedProfileChange) {
      return 'updateMessage.learnedProfileChange';
    }
    if (update.threadMerge) {
      return 'updateMessage.threadMerge';
    }
    if (update.sessionSwitchover) {
      return 'updateMessage.sessionSwitchover';
    }
    if (update.groupCall) {
      return 'updateMessage.groupCall';
    }
    if (update.individualCall) {
      return 'updateMessage.individualCall';
    }
    return 'updateMessage.unknown';
  }
  return 'unknown';
}

function bytesToBase64(
  value: Uint8Array<ArrayBuffer> | null | undefined
): string | undefined {
  if (!value || value.byteLength === 0) {
    return undefined;
  }

  return Bytes.toBase64(value);
}

function getEncryptedDigestBase64(
  integrityCheck: Backups.FilePointer.LocatorInfo['integrityCheck']
): string | undefined {
  if (!integrityCheck || !('encryptedDigest' in integrityCheck)) {
    return undefined;
  }

  return bytesToBase64(integrityCheck.encryptedDigest);
}

function getPlaintextHashHex(
  integrityCheck: Backups.FilePointer.LocatorInfo['integrityCheck']
): string | undefined {
  if (!integrityCheck || !('plaintextHash' in integrityCheck)) {
    return undefined;
  }

  const { plaintextHash } = integrityCheck;
  if (!plaintextHash || plaintextHash.byteLength === 0) {
    return undefined;
  }

  return Bytes.toHex(plaintextHash);
}

function convertBackupFilePointerToWebAttachment(
  filePointer: Backups.FilePointer
): WebAttachment | undefined {
  const { locatorInfo } = filePointer;
  if (!locatorInfo) {
    return undefined;
  }

  const keyBase64 = bytesToBase64(locatorInfo.key);
  if (!keyBase64) {
    return undefined;
  }

  const digestBase64 = getEncryptedDigestBase64(locatorInfo.integrityCheck);
  const incrementalMacBase64 = bytesToBase64(filePointer.incrementalMac);
  const cdnNumber = locatorInfo.transitCdnNumber ?? undefined;

  return {
    cdnKey: locatorInfo.transitCdnKey ?? undefined,
    cdnNumber,
    keyBase64,
    key: keyBase64,
    digestBase64,
    digest: digestBase64,
    incrementalMacBase64,
    incrementalMac: incrementalMacBase64,
    chunkSize: filePointer.incrementalMacChunkSize ?? undefined,
    size: locatorInfo.size ?? 0,
    contentType: filePointer.contentType ?? 'application/octet-stream',
    fileName: filePointer.fileName ?? undefined,
    width: filePointer.width ?? undefined,
    height: filePointer.height ?? undefined,
    caption: filePointer.caption ?? undefined,
    blurHash: filePointer.blurHash ?? undefined,
    uploadTimestamp: timestampFromLong(locatorInfo.transitTierUploadTimestamp),
    plaintextHash: getPlaintextHashHex(locatorInfo.integrityCheck),
    backupCdnNumber: locatorInfo.mediaTierCdnNumber ?? undefined,
    localKey: bytesToBase64(locatorInfo.localKey),
    status: 'ready',
  };
}

function convertBackupMessageAttachmentToWebAttachment(
  messageAttachment: Backups.MessageAttachment
): WebAttachment | undefined {
  if (!messageAttachment.pointer) {
    return undefined;
  }

  const attachment = convertBackupFilePointerToWebAttachment(
    messageAttachment.pointer
  );
  if (!attachment) {
    return undefined;
  }

  let flags: number | undefined;
  switch (messageAttachment.flag) {
    case Backups.MessageAttachment.Flag.VOICE_MESSAGE:
      flags = SignalService.AttachmentPointer.Flags.VOICE_MESSAGE;
      break;
    case Backups.MessageAttachment.Flag.BORDERLESS:
      flags = SignalService.AttachmentPointer.Flags.BORDERLESS;
      break;
    case Backups.MessageAttachment.Flag.GIF:
      flags = SignalService.AttachmentPointer.Flags.GIF;
      break;
    case Backups.MessageAttachment.Flag.NONE:
      flags = undefined;
      break;
    default:
      flags = undefined;
      break;
  }

  return {
    ...attachment,
    clientUuid:
      messageAttachment.clientUuid && messageAttachment.clientUuid.byteLength > 0
        ? bytesToUuid(messageAttachment.clientUuid)
        : undefined,
    flags,
  };
}

function getAttachments(chatItem: Backups.ChatItem): ReadonlyArray<WebAttachment> {
  const attachments =
    chatItem.item?.standardMessage?.attachments ??
    (chatItem.item?.viewOnceMessage?.attachment
      ? [chatItem.item.viewOnceMessage.attachment]
      : []);
  return attachments
    .map(convertBackupMessageAttachmentToWebAttachment)
    .filter((attachment): attachment is WebAttachment => attachment != null);
}

function getSnippet(
  body: string | undefined,
  attachments: ReadonlyArray<WebAttachment>
): string {
  if (body) {
    return body;
  }

  const [firstAttachment] = attachments;
  if (!firstAttachment) {
    return '';
  }

  if (firstAttachment.fileName) {
    return firstAttachment.fileName;
  }

  const contentType = firstAttachment.contentType ?? '';
  if (contentType.startsWith('image/')) {
    return '[Photo]';
  }
  if (contentType.startsWith('video/')) {
    return '[Video]';
  }
  if (contentType.startsWith('audio/')) {
    return '[Audio]';
  }

  return '[Attachment]';
}

function getSystemMessageSnippet(patch: WebBackupMessagePatch): string {
  if (patch.deletedForEveryone) {
    return '[Deleted message]';
  }

  switch (patch.desktopType) {
    case 'change-number-notification':
      return '[Number changed]';
    case 'chat-session-refreshed':
      return '[Chat session refreshed]';
    case 'delivery-issue':
      return '[Delivery issue]';
    case 'group-v2-change':
      return '[Group updated]';
    case 'joined-signal-notification':
      return '[Joined Signal]';
    case 'keychange':
      return '[Safety number changed]';
    case 'message-request-response-event':
      return '[Message request update]';
    case 'timer-notification':
      return '[Disappearing messages timer changed]';
    case 'verified-change':
      return '[Safety number verification changed]';
    case 'pinned-message-notification':
      return '[Pinned message]';
    case 'incoming':
    case 'outgoing':
    case undefined:
      return '';
  }
}

function getSimpleUpdateMessagePatch({
  author,
  simpleUpdate,
}: {
  author?: WebConversation;
  simpleUpdate: Backups.SimpleChatUpdate;
}): WebBackupMessagePatch | undefined {
  const { Type } = Backups.SimpleChatUpdate;
  switch (simpleUpdate.type) {
    case Type.END_SESSION:
      return {
        flags: SignalService.DataMessage.Flags.END_SESSION,
      };
    case Type.CHAT_SESSION_REFRESH:
      return {
        desktopType: 'chat-session-refreshed',
      };
    case Type.IDENTITY_UPDATE:
      return {
        desktopType: 'keychange',
        key_changed: author?.id,
      };
    case Type.IDENTITY_VERIFIED:
      return {
        desktopType: 'verified-change',
        verified: true,
        verifiedChanged: author?.id,
      };
    case Type.IDENTITY_DEFAULT:
      return {
        desktopType: 'verified-change',
        verified: false,
        verifiedChanged: author?.id,
      };
    case Type.CHANGE_NUMBER:
      return {
        desktopType: 'change-number-notification',
      };
    case Type.JOINED_SIGNAL:
      return {
        desktopType: 'joined-signal-notification',
      };
    case Type.BAD_DECRYPT:
      return {
        desktopType: 'delivery-issue',
      };
    case Type.UNSUPPORTED_PROTOCOL_MESSAGE:
      return {
        requiredProtocolVersion:
          SignalService.DataMessage.ProtocolVersion.CURRENT - 1,
        supportedVersionAtReceive:
          SignalService.DataMessage.ProtocolVersion.CURRENT - 2,
      };
    case Type.REPORTED_SPAM:
      return {
        desktopType: 'message-request-response-event',
        messageRequestResponseEvent: MessageRequestResponseEvent.SPAM,
      };
    case Type.BLOCKED:
      return {
        desktopType: 'message-request-response-event',
        messageRequestResponseEvent: MessageRequestResponseEvent.BLOCK,
      };
    case Type.UNBLOCKED:
      return {
        desktopType: 'message-request-response-event',
        messageRequestResponseEvent: MessageRequestResponseEvent.UNBLOCK,
      };
    case Type.MESSAGE_REQUEST_ACCEPTED:
      return {
        desktopType: 'message-request-response-event',
        messageRequestResponseEvent: MessageRequestResponseEvent.ACCEPT,
      };
    case Type.PAYMENTS_ACTIVATED:
    case Type.PAYMENT_ACTIVATION_REQUEST:
    case Type.RELEASE_CHANNEL_DONATION_REQUEST:
    case Type.UNKNOWN:
    case undefined:
    case null:
      return undefined;
  }

  return undefined;
}

function getBackupMessagePatch({
  author,
  chatItem,
  conversation,
  deletedByAdminAci,
  targetPinnedAuthorAci,
  timestamp,
}: {
  author?: WebConversation;
  chatItem: Backups.ChatItem;
  conversation: WebConversation;
  deletedByAdminAci?: string;
  targetPinnedAuthorAci?: string;
  timestamp: number;
}): WebBackupMessagePatch | undefined {
  const item = chatItem.item;
  if (!item) {
    return undefined;
  }

  if (item.adminDeletedMessage) {
    return {
      deletedForEveryone: true,
      deletedForEveryoneByAdminAci: deletedByAdminAci,
      deletedForEveryoneTimestamp: timestamp,
      isErased: true,
    };
  }

  if (item.remoteDeletedMessage) {
    return {
      deletedForEveryone: true,
      deletedForEveryoneTimestamp: timestamp,
      isErased: true,
    };
  }

  if (item.updateMessage?.update?.expirationTimerChange) {
    const expiresInMs =
      timestampFromLong(
        item.updateMessage.update.expirationTimerChange.expiresInMs
      ) ?? 0;
    const sourceServiceId = author?.serviceId ?? conversation.serviceId;
    return {
      desktopType: 'timer-notification',
      expirationTimerUpdate: {
        expireTimer: Math.floor(expiresInMs / 1000),
        sourceServiceId,
      },
      flags: SignalService.DataMessage.Flags.EXPIRATION_TIMER_UPDATE,
      sourceServiceId,
    };
  }

  if (item.updateMessage?.update?.pinMessage) {
    const targetSentTimestamp = timestampFromLong(
      item.updateMessage.update.pinMessage.targetSentTimestamp
    );
    if (!targetPinnedAuthorAci || targetSentTimestamp == null) {
      return undefined;
    }
    return {
      desktopType: 'pinned-message-notification',
      pinMessage: {
        targetAuthorAci: targetPinnedAuthorAci,
        targetSentTimestamp,
        pinDurationSeconds: null,
      },
    };
  }

  if (item.updateMessage?.update?.simpleUpdate) {
    return getSimpleUpdateMessagePatch({
      author,
      simpleUpdate: item.updateMessage.update.simpleUpdate,
    });
  }

  return undefined;
}

class WebBackupFrameCollector extends Writable {
  readonly #linkedPayload: LinkedPayload;
  readonly #stats: BackupImportStats = {
    backupInfo: 0,
    recipients: 0,
    chats: 0,
    chatItems: 0,
    messages: 0,
    skippedChatItems: 0,
    skippedChatItemTypes: {},
    unsupportedFrames: 0,
  };

  #parsedBackupInfo = false;
  readonly #recipientIdToConversation = new Map<bigint, WebConversation>();
  readonly #chatIdToConversation = new Map<bigint, WebConversation>();
  readonly #conversationLookup: Record<string, WebConversation> = {};
  readonly #messages = new Array<WebMessage>();
  #selectedConversationId: string | undefined;
  #mediaRootBackupKeyBase64: string | undefined;

  public constructor(linkedPayload: LinkedPayload) {
    super({ objectMode: true });
    this.#linkedPayload = linkedPayload;
  }

  public getResult(): WebBackupImportResult {
    const conversations = Object.values(this.#conversationLookup);
    const active = conversations
      .filter(conversation => !conversation.isArchived)
      .sort((left, right) => (right.activeAt ?? 0) - (left.activeAt ?? 0));
    const messages = [...this.#messages].sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        (left.receivedAt ?? left.timestamp) - (right.receivedAt ?? right.timestamp) ||
        left.id.localeCompare(right.id)
    );

    return {
      contactsBootstrap: {
        version: 1,
        generatedAt: Date.now(),
        account: this.#linkedPayload.account,
        selectedConversationId: this.#selectedConversationId ?? active[0]?.id,
        storyDistributionLists: [
          {
            id: MY_STORY_ID,
            name: '我的动态',
            allowsReplies: true,
            isBlockList: true,
            memberServiceIds: [],
          },
        ],
        pinned: active.filter(conversation => conversation.isPinned),
        conversations: active.filter(conversation => !conversation.isPinned),
        archived: conversations.filter(conversation => conversation.isArchived),
      },
      chatShell: {
        selectedConversationId: this.#selectedConversationId ?? active[0]?.id,
        conversationLookup: this.#conversationLookup,
        messages,
        pinnedMessages: [],
      },
      mediaRootBackupKeyBase64: this.#mediaRootBackupKeyBase64,
      stats: this.#stats,
    };
  }

  override async _write(
    data: Buffer<ArrayBuffer>,
    _encoding: BufferEncoding,
    done: (error?: Error) => void
  ): Promise<void> {
    try {
      if (!this.#parsedBackupInfo) {
        const backupInfo = Backups.BackupInfo.decode(data);
        this.#mediaRootBackupKeyBase64 =
          backupInfo.mediaRootBackupKey &&
          backupInfo.mediaRootBackupKey.byteLength > 0
            ? Bytes.toBase64(backupInfo.mediaRootBackupKey)
            : undefined;
        this.#parsedBackupInfo = true;
        this.#stats.backupInfo += 1;
        done();
        return;
      }

      const frame = Backups.Frame.decode(data);
      this.#processFrame(frame);
      done();
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #upsertConversation(conversation: WebConversation): void {
    this.#conversationLookup[conversation.id] = {
      ...this.#conversationLookup[conversation.id],
      ...conversation,
    };
    this.#selectedConversationId ??= conversation.id;
  }

  #processFrame(frame: Backups.Frame): void {
    const item = frame.item;
    if (!item) {
      this.#stats.unsupportedFrames += 1;
      return;
    }

    if (item.recipient) {
      this.#processRecipient(item.recipient);
      return;
    }
    if (item.chat) {
      this.#processChat(item.chat);
      return;
    }
    if (item.chatItem) {
      this.#processChatItem(item.chatItem);
      return;
    }
    if (item.account) {
      return;
    }

    this.#stats.unsupportedFrames += 1;
  }

  #processRecipient(recipient: Backups.Recipient): void {
    if (recipient.id == null || !recipient.destination) {
      this.#stats.unsupportedFrames += 1;
      return;
    }

    const fallbackId = String(recipient.id);
    let conversation: WebConversation | undefined;
    if (recipient.destination.contact) {
      conversation = createConversationFromContact(
        recipient.destination.contact,
        fallbackId
      );
    } else if (recipient.destination.self) {
      conversation = createConversationFromSelf(this.#linkedPayload, fallbackId);
    } else if (recipient.destination.group) {
      conversation = createConversationFromGroup(recipient.destination.group, fallbackId);
    }

    if (!conversation) {
      this.#stats.unsupportedFrames += 1;
      return;
    }

    this.#stats.recipients += 1;
    this.#recipientIdToConversation.set(recipient.id, conversation);
    this.#upsertConversation(conversation);
  }

  #processChat(chat: Backups.Chat): void {
    if (chat.id == null || chat.recipientId == null) {
      this.#stats.unsupportedFrames += 1;
      return;
    }

    const conversation = this.#recipientIdToConversation.get(chat.recipientId);
    if (!conversation) {
      this.#stats.unsupportedFrames += 1;
      return;
    }

    const updated: WebConversation = {
      ...conversation,
      isArchived: chat.archived,
      isPinned: (chat.pinnedOrder ?? 0) !== 0,
    };
    this.#chatIdToConversation.set(chat.id, updated);
    this.#upsertConversation(updated);
    this.#stats.chats += 1;
  }

  #processChatItem(chatItem: Backups.ChatItem): void {
    if (chatItem.chatId == null || chatItem.dateSent == null) {
      this.#stats.unsupportedFrames += 1;
      return;
    }
    const conversation = this.#chatIdToConversation.get(chatItem.chatId);
    if (!conversation) {
      this.#stats.unsupportedFrames += 1;
      return;
    }
    this.#stats.chatItems += 1;

    const body = getTextBody(chatItem);
    const attachments = getAttachments(chatItem);
    const timestamp = timestampFromLong(chatItem.dateSent) ?? Date.now();
    const poll = chatItem.item?.poll
      ? {
          question: chatItem.item.poll.question ?? '',
          options: chatItem.item.poll.options?.map(option => option.option ?? '') ?? [],
          allowMultiple: chatItem.item.poll.allowMultiple ?? false,
          votes: undefined,
          terminatedAt: chatItem.item.poll.hasEnded ? timestamp : undefined,
        }
      : undefined;
    const author =
      chatItem.authorId == null
        ? undefined
        : this.#recipientIdToConversation.get(chatItem.authorId);
    const deletedByAdminAci =
      chatItem.item?.adminDeletedMessage?.adminId == null
        ? undefined
        : this.#recipientIdToConversation.get(
            chatItem.item.adminDeletedMessage.adminId
          )?.serviceId;
    const targetPinnedAuthorAci =
      chatItem.item?.updateMessage?.update?.pinMessage?.authorId == null
        ? undefined
        : this.#recipientIdToConversation.get(
            chatItem.item.updateMessage.update.pinMessage.authorId
          )?.serviceId;
    const patch = getBackupMessagePatch({
      author,
      chatItem,
      conversation,
      deletedByAdminAci,
      targetPinnedAuthorAci,
      timestamp,
    });
    if (body == null && attachments.length === 0 && !patch && !poll) {
      this.#stats.skippedChatItems += 1;
      incrementCounter(this.#stats.skippedChatItemTypes, getChatItemType(chatItem));
      return;
    }

    const direction = chatItem.directionalDetails?.outgoing ? 'outgoing' : 'incoming';
    const message: WebMessage = {
      id: `backup:${conversation.id}:${timestamp}:${this.#messages.length}`,
      conversationId: conversation.id,
      body,
      timestamp,
      receivedAt:
        timestampFromLong(chatItem.directionalDetails?.incoming?.dateReceived) ??
        timestampFromLong(chatItem.directionalDetails?.outgoing?.dateReceived) ??
        timestamp,
      direction,
      status: direction === 'outgoing' ? 'sent' : undefined,
      attachments,
      poll,
      isErased:
        chatItem.item?.viewOnceMessage && attachments.length === 0
          ? true
          : undefined,
      isViewOnce: chatItem.item?.viewOnceMessage ? true : undefined,
      sourceServiceId: author?.serviceId ?? conversation.serviceId,
      ...patch,
    };

    this.#messages.push(message);
    this.#stats.messages += 1;
    const activeAt = Math.max(conversation.activeAt ?? 0, timestamp);
    const snippet = patch ? getSystemMessageSnippet(patch) : getSnippet(body, attachments);
    this.#upsertConversation({
      ...conversation,
      activeAt,
      lastMessage: message.deletedForEveryone
        ? { deletedForEveryone: true }
        : {
            deletedForEveryone: false,
            text: snippet,
          },
      lastMessageReceivedAt: timestamp,
      lastMessageReceivedAtMs: message.receivedAt ?? timestamp,
      lastUpdated: activeAt,
      messageCount: (conversation.messageCount ?? 0) + 1,
      sentMessageCount:
        direction === 'outgoing'
          ? (conversation.sentMessageCount ?? 0) + 1
          : conversation.sentMessageCount,
      timestamp: activeAt,
      inboxPosition: activeAt,
      snippet: message.deletedForEveryone ? undefined : snippet,
      hasMessages: true,
    });
  }
}

export async function importEphemeralBackup({
  createBackupStream,
  linkedPayload,
}: {
  createBackupStream: () => Readable;
  linkedPayload: LinkedPayload;
}): Promise<WebBackupImportResult> {
  const aci = linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
  const ephemeralBackupKeyBase64 = linkedPayload.ephemeralBackupKeyBase64;
  if (!aci) {
    throw new Error('importEphemeralBackup: missing ACI');
  }
  if (!ephemeralBackupKeyBase64) {
    throw new Error('importEphemeralBackup: missing ephemeral backup key');
  }

  const { aesKey, macKey } = getBackupKeyMaterial({
    aci,
    ephemeralBackupKeyBase64,
  });
  const { theirMac } = await verifyBackupMac(createBackupStream, macKey);
  const hmac = createHmac(HashType.size256, macKey);
  const collector = new WebBackupFrameCollector(linkedPayload);

  await pipeline(
    createBackupStream(),
    getMacAndUpdateHmac(hmac, () => undefined),
    decipherWithAesKey(aesKey),
    createGunzip(),
    new DelimitedStream(),
    collector
  );

  strictAssert(
    constantTimeEqual(hmac.digest(), theirMac),
    'importEphemeralBackup: Bad MAC, second pass'
  );

  return collector.getResult();
}

export function readableFromWebResponse(response: Response): Readable {
  if (!response.body) {
    throw new Error('readableFromWebResponse: response body is missing');
  }
  return Readable.fromWeb(response.body as never);
}
