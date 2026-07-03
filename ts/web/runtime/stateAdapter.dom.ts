// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { buildAttachmentAccessUrl } from '../api.dom.ts';
import { getWebAttachmentContentTypeFromParts } from '../attachmentMime.std.ts';
import lodash from 'lodash';
import type {
  ChatShellState,
  ContactsBootstrap,
  LinkedSessionRecord,
  WebAttachment,
  WebConversation,
  WebMessage,
} from '../types.std.ts';
import { ReadStatus } from '../../messages/MessageReadStatus.std.ts';
import { SendStatus } from '../../messages/MessageSendState.std.ts';
import { MessageModel } from '../../models/messages.preload.ts';
import { createLogger } from '../../logging/log.std.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import { StorySendMode } from '../../types/Stories.std.ts';
import { initializeSchemaVersion } from '../../types/Message2.preload.ts';
import type {
  ConversationAttributesType,
  MessageAttributesType,
} from '../../model-types.d.ts';
import { getNotificationDataForMessage } from '../../util/getNotificationDataForMessage.preload.ts';
import { getMessagePropStatus } from '../../state/selectors/message.preload.ts';
import type { AciString } from '../../types/ServiceId.std.ts';
import { isAciString } from '../../util/isAciString.std.ts';
import { getTitle, getTitleNoDefault } from '../../util/getTitle.preload.ts';
import { getDefaultAvatars } from '../../types/Avatar.std.ts';

const log = createLogger('WebStateAdapter');
const { isEqual } = lodash;

type DesktopConversation = Record<string, unknown> & {
  id: string;
  type: 'direct' | 'group';
  title: string;
  acceptedMessageRequest: boolean;
  badges: ReadonlyArray<unknown>;
  isMe: boolean;
};

type DesktopMessage = Record<string, unknown> & {
  id: string;
  type: MessageAttributesType['type'];
  conversationId: string;
  sent_at: number;
  received_at: number;
  timestamp: number;
};

export type DesktopMessageMetrics = Readonly<{
  newest?: Readonly<{ id: string; received_at: number; sent_at?: number }>;
  oldest?: Readonly<{ id: string; received_at: number; sent_at?: number }>;
  totalUnseen: number;
}>;

function mergeBootstrapAccountForLinkedSession(
  linkedSession: LinkedSessionRecord,
  bootstrap: ContactsBootstrap
): LinkedSessionRecord['account'] {
  const account = bootstrap.account;
  if (!account) {
    return linkedSession.account;
  }

  if (typeof linkedSession.account.localProfileUpdatedAt !== 'number') {
    return {
      ...linkedSession.account,
      ...account,
    };
  }

  return {
    ...linkedSession.account,
    ...account,
    about: linkedSession.account.about,
    aboutEmoji: linkedSession.account.aboutEmoji,
    avatarUrl: linkedSession.account.avatarUrl,
    avatarUrlPath: linkedSession.account.avatarUrlPath,
    familyName: linkedSession.account.familyName,
    firstName: linkedSession.account.firstName,
    localProfileUpdatedAt: linkedSession.account.localProfileUpdatedAt,
    profileFamilyName: linkedSession.account.profileFamilyName,
    profileName: linkedSession.account.profileName,
    title: linkedSession.account.title,
  };
}

export function compareWebMessages(left: WebMessage, right: WebMessage): number {
  return (
    left.timestamp - right.timestamp ||
    (left.receivedAt ?? left.timestamp) - (right.receivedAt ?? right.timestamp) ||
    left.id.localeCompare(right.id)
  );
}

export function getConversationTitle(
  conversation: WebConversation | undefined
): string {
  if (!conversation) {
    return '';
  }
  const isGroup =
    conversation.type === 'group' || conversation.conversationType === 'group';
  const directTitleFallback =
    !isGroup &&
    !conversation.systemNickname &&
    !conversation.systemGivenName &&
    !conversation.systemFamilyName &&
    !conversation.profileName &&
    !conversation.firstName &&
    !conversation.profileFamilyName &&
    !conversation.familyName &&
    !conversation.e164 &&
    !conversation.phoneNumber &&
    !conversation.username
      ? conversation.titleNoNickname ??
        conversation.titleNoDefault ??
        conversation.title
      : undefined;
  return getTitle({
    e164: conversation.e164 ?? conversation.phoneNumber,
    name: isGroup
      ? conversation.name ?? conversation.titleNoDefault ?? conversation.title
      : undefined,
    nicknameFamilyName: conversation.nicknameFamilyName,
    nicknameGivenName: conversation.nicknameGivenName,
    profileFamilyName: conversation.profileFamilyName ?? conversation.familyName,
    profileName: conversation.profileName ?? conversation.firstName,
    systemFamilyName: conversation.systemFamilyName,
    systemGivenName: conversation.systemGivenName,
    systemNickname: conversation.systemNickname ?? directTitleFallback,
    type: isGroup ? 'group' : 'private',
    username: conversation.username,
  });
}

export function getConversationListSortTimestamp(
  conversation: WebConversation | undefined
): number {
  if (!conversation) {
    return 0;
  }

  return (
    conversation.lastMessageReceivedAtMs ??
    conversation.timestamp ??
    conversation.inboxPosition ??
    conversation.activeAt ??
    conversation.lastUpdated ??
    0
  );
}

function mergeConversationForBootstrap({
  existing,
  incoming,
  preserveExistingActivity,
}: Readonly<{
  existing: WebConversation | undefined;
  incoming: WebConversation;
  preserveExistingActivity: boolean;
}>): WebConversation {
  if (!existing || !preserveExistingActivity) {
    if (existing?.messagesDeleted === true && incoming.hasMessages !== true) {
      return {
        ...existing,
        ...incoming,
        activeAt: undefined,
        hasMessages: false,
        inboxPosition: undefined,
        lastMessage: undefined,
        lastMessageReceivedAt: undefined,
        lastMessageReceivedAtMs: undefined,
        lastUpdated: undefined,
        markedUnread: existing.markedUnread,
        messageCount: 0,
        messagesDeleted: true,
        sentMessageCount: existing.sentMessageCount,
        snippet: undefined,
        timestamp: undefined,
        unreadCount: existing.unreadCount,
        left: incoming.left ?? existing.left,
      };
    }

    return {
      ...existing,
      ...incoming,
      left: incoming.left ?? existing?.left,
    };
  }

  return {
    ...existing,
    ...incoming,
    activeAt: existing.activeAt,
    hasMessages: existing.hasMessages,
    inboxPosition: existing.inboxPosition,
    lastMessage: existing.lastMessage,
    lastMessageReceivedAt: existing.lastMessageReceivedAt,
    lastMessageReceivedAtMs: existing.lastMessageReceivedAtMs,
    lastUpdated: existing.lastUpdated,
    markedUnread: existing.markedUnread,
    messageCount: existing.messageCount,
    messagesDeleted: existing.messagesDeleted,
    sentMessageCount: existing.sentMessageCount,
    snippet: existing.snippet,
    timestamp: existing.timestamp,
    unreadCount: existing.unreadCount,
    left: incoming.left ?? existing.left,
  };
}

function dropStorageOnlyActivity(
  conversation: WebConversation
): WebConversation {
  return {
    ...conversation,
    activeAt: undefined,
    inboxPosition: undefined,
    lastMessage: undefined,
    lastMessageReceivedAt: undefined,
    lastMessageReceivedAtMs: undefined,
    lastUpdated: undefined,
    messageCount: 0,
    snippet: undefined,
    timestamp: undefined,
  };
}

function isGroupConversation(conversation: WebConversation): boolean {
  return (
    conversation.type === 'group' || conversation.conversationType === 'group'
  );
}

function hasVisibleConversationActivity(
  conversation: WebConversation | undefined
): boolean {
  return Boolean(
    conversation?.hasMessages ||
      conversation?.activeAt ||
      conversation?.inboxPosition ||
      conversation?.lastMessage ||
      conversation?.lastMessageReceivedAt ||
      conversation?.lastMessageReceivedAtMs ||
      conversation?.lastUpdated ||
      conversation?.messageCount ||
      conversation?.snippet ||
      conversation?.timestamp
  );
}

function shouldHideStorageOnlyArchivedGroup(
  conversation: WebConversation,
  existing: WebConversation | undefined
): boolean {
  return (
    isGroupConversation(conversation) &&
    conversation.isArchived === true &&
    conversation.isPinned !== true &&
    conversation.hasMessages !== true &&
    !hasVisibleConversationActivity(conversation) &&
    !hasVisibleConversationActivity(existing)
  );
}

function shouldDropDeletedGroupConversation(
  conversation: WebConversation,
  conversationMessageCount: number
): boolean {
  return (
    isGroupConversation(conversation) &&
    conversation.messagesDeleted === true &&
    conversationMessageCount === 0
  );
}

function shouldDropArchivedEmptyGroupConversation(
  conversation: WebConversation,
  conversationMessageCount: number
): boolean {
  return (
    isGroupConversation(conversation) &&
    conversation.isArchived === true &&
    conversation.isPinned !== true &&
    conversation.hasMessages !== true &&
    conversationMessageCount === 0
  );
}

function applyDesktopGroupMembershipState(
  conversation: WebConversation,
  linkedSession: LinkedSessionRecord
): WebConversation {
  if (!isGroupConversation(conversation)) {
    return conversation;
  }

  const ourAci = linkedSession.credentials?.aci ?? linkedSession.account.aci;
  const hasMembersV2 = Array.isArray(conversation.membersV2);
  if (!ourAci || !hasMembersV2) {
    return conversation;
  }

  const left = !conversation.membersV2.some(member => member.aci === ourAci);
  if (conversation.left === left) {
    return conversation;
  }

  return {
    ...conversation,
    left,
  };
}

export function normalizeWebConversationForDesktopSemantics(
  conversation: WebConversation,
  linkedSession: LinkedSessionRecord
): WebConversation {
  return applyDesktopGroupMembershipState(conversation, linkedSession);
}

export function normalizeChatShellForLinkedSession(
  shell: ChatShellState,
  linkedSession: LinkedSessionRecord
): ChatShellState {
  const messageCountByConversation = new Map<string, number>();
  for (const message of shell.messages) {
    messageCountByConversation.set(
      message.conversationId,
      (messageCountByConversation.get(message.conversationId) ?? 0) + 1
    );
  }

  let didChange = false;
  const conversationLookup: Record<string, WebConversation> = {};
  for (const conversation of Object.values(shell.conversationLookup)) {
    const normalizedConversation = applyDesktopGroupMembershipState(
      conversation,
      linkedSession
    );
    if (!isEqual(normalizedConversation, conversation)) {
      didChange = true;
    }
    const conversationMessageCount =
      messageCountByConversation.get(normalizedConversation.id) ?? 0;
    if (
      shouldDropDeletedGroupConversation(
        normalizedConversation,
        conversationMessageCount
      ) ||
      shouldDropArchivedEmptyGroupConversation(
        normalizedConversation,
        conversationMessageCount
      )
    ) {
      didChange = true;
      continue;
    }

    conversationLookup[normalizedConversation.id] = normalizedConversation;
  }

  const selectedConversation = shell.selectedConversationId
    ? conversationLookup[shell.selectedConversationId]
    : undefined;
  const selectedConversationId =
    shell.selectedConversationId && selectedConversation
      ? shell.selectedConversationId
      : undefined;

  if (selectedConversationId !== shell.selectedConversationId) {
    didChange = true;
  }

  const nextShell = didChange
    ? {
        ...shell,
        selectedConversationId,
        conversationLookup,
      }
    : shell;

  return ensureNoteToSelf(nextShell, linkedSession);
}

function getMembershipsFromMembersV2(
  conversation: WebConversation
): ReadonlyArray<{
  aci: AciString;
  isAdmin: boolean;
  labelEmoji: unknown;
  labelString: string | undefined;
}> {
  return (conversation.membersV2 ?? []).map(member => ({
    aci: member.aci,
    isAdmin: member.role === Proto.Member.Role.ADMINISTRATOR,
    labelEmoji: member.labelEmoji,
    labelString: member.labelString?.trim() || undefined,
  }));
}

function getPendingMembershipsFromPendingMembersV2(
  conversation: WebConversation
): ReadonlyArray<{
  addedByUserId?: AciString;
  serviceId: string;
}> {
  return (conversation.pendingMembersV2 ?? []).map(member => ({
    addedByUserId: member.addedByUserId,
    serviceId: member.serviceId,
  }));
}

function getAreWeGroupAdmin(
  conversation: WebConversation,
  linkedSession: LinkedSessionRecord
): boolean {
  const ourAci = linkedSession.credentials?.aci ?? linkedSession.account.aci;
  if (!ourAci) {
    return false;
  }

  return Boolean(
    conversation.membersV2?.some(member => {
      return (
        member.aci === ourAci &&
        member.role === Proto.Member.Role.ADMINISTRATOR
      );
    })
  );
}

function getGroupAccessControl(
  conversation: WebConversation
): NonNullable<ConversationAttributesType['accessControl']> {
  const { AccessRequired } = Proto.AccessControl;
  return {
    attributes: conversation.accessControl?.attributes ?? AccessRequired.MEMBER,
    members: conversation.accessControl?.members ?? AccessRequired.MEMBER,
    addFromInviteLink:
      conversation.accessControl?.addFromInviteLink ??
      AccessRequired.UNSATISFIABLE,
    memberLabel:
      conversation.accessControl?.memberLabel ?? AccessRequired.MEMBER,
  };
}

function getCanAddNewMembersForWebGroup({
  accessControl,
  areWeAdmin,
  left,
  terminated,
}: Readonly<{
  accessControl: NonNullable<ConversationAttributesType['accessControl']>;
  areWeAdmin: boolean;
  left: unknown;
  terminated: unknown;
}>): boolean {
  if (left || terminated) {
    return false;
  }

  return (
    areWeAdmin ||
    accessControl.members === Proto.AccessControl.AccessRequired.MEMBER
  );
}

function getCanEditGroupInfoForWebGroup({
  accessControl,
  areWeAdmin,
  left,
  terminated,
}: Readonly<{
  accessControl: NonNullable<ConversationAttributesType['accessControl']>;
  areWeAdmin: boolean;
  left: unknown;
  terminated: unknown;
}>): boolean {
  if (left || terminated) {
    return false;
  }

  return (
    areWeAdmin ||
    accessControl.attributes === Proto.AccessControl.AccessRequired.MEMBER
  );
}

function ensureDirectConversationShellsForGroupMembers(
  conversationLookup: Record<string, WebConversation>
): Record<string, WebConversation> {
  const nextLookup = { ...conversationLookup };
  const existingServiceIds = new Set(
    Object.values(nextLookup)
      .map(conversation => conversation.serviceId)
      .filter((serviceId): serviceId is string => typeof serviceId === 'string')
  );

  for (const conversation of Object.values(conversationLookup)) {
    if (conversation.type !== 'group' && conversation.conversationType !== 'group') {
      continue;
    }

    for (const member of conversation.membersV2 ?? []) {
      if (existingServiceIds.has(member.aci)) {
        continue;
      }
      existingServiceIds.add(member.aci);
      nextLookup[member.aci] = {
        acceptedMessageRequest: true,
        conversationType: 'direct',
        hasMessages: false,
        id: member.aci,
        profileSharing: true,
        serviceId: member.aci,
        title: member.aci,
        type: 'direct',
      };
    }

    for (const member of conversation.pendingMembersV2 ?? []) {
      if (existingServiceIds.has(member.serviceId)) {
        continue;
      }
      existingServiceIds.add(member.serviceId);
      nextLookup[member.serviceId] = {
        acceptedMessageRequest: true,
        conversationType: 'direct',
        hasMessages: false,
        id: member.serviceId,
        profileSharing: true,
        serviceId: member.serviceId,
        title: member.serviceId,
        type: 'direct',
      };
    }
  }

  return nextLookup;
}

export function getWebMessagePreviewText(message: WebMessage): string {
  if (message.deletedForEveryone || message.isErased) {
    return '';
  }

  return getNotificationDataForMessage(toDesktopMessage(message)).text ?? '';
}

export function getWebConversationLastMessage(
  message: WebMessage,
  ourConversationId?: string
): WebConversation['lastMessage'] {
  if (message.deletedForEveryone || message.isErased) {
    return {
      deletedForEveryone: true,
      isOutgoing: message.direction === 'outgoing',
    };
  }

  const desktopMessage = toDesktopMessage(message);
  const notificationData = getNotificationDataForMessage(desktopMessage);
  const author =
    desktopMessage.type === 'outgoing'
      ? window.SignalContext.i18n('icu:you')
      : desktopMessage.type === 'incoming'
        ? (window.ConversationController.get(message.sourceServiceId)?.getTitle() ??
          null)
        : null;
  return {
    author,
    bodyRanges: notificationData.bodyRanges,
    deletedForEveryone: false,
    prefix: notificationData.emoji,
    status: getMessagePropStatus(desktopMessage, ourConversationId),
    text: notificationData.text ?? '',
  };
}

function deriveConversationPreviews(
  shell: ChatShellState,
  linkedSession: LinkedSessionRecord
): ChatShellState {
  const newestByConversation = new Map<string, WebMessage>();
  const ourConversationId =
    linkedSession.credentials?.aci ?? linkedSession.account.aci;
  for (const message of shell.messages) {
    const existing = newestByConversation.get(message.conversationId);
    if (!existing || compareWebMessages(existing, message) <= 0) {
      newestByConversation.set(message.conversationId, message);
    }
  }

  if (newestByConversation.size === 0) {
    return shell;
  }

  let didChange = false;
  const conversationLookup = { ...shell.conversationLookup };
  for (const [conversationId, message] of newestByConversation) {
    const conversation = conversationLookup[conversationId];
    if (!conversation) {
      continue;
    }

    const receivedAt = message.receivedAt ?? message.timestamp;
    const previewText = getWebMessagePreviewText(message);
    const lastMessage = getWebConversationLastMessage(message, ourConversationId);
    const nextConversation: WebConversation = {
      ...conversation,
      activeAt: Math.max(conversation.activeAt ?? 0, receivedAt),
      hasMessages: true,
      inboxPosition: Math.max(conversation.inboxPosition ?? 0, receivedAt),
      lastMessage,
      lastMessageReceivedAt: message.timestamp,
      lastMessageReceivedAtMs: receivedAt,
      lastUpdated: Math.max(conversation.lastUpdated ?? 0, receivedAt),
      messageCount: Math.max(conversation.messageCount ?? 0, 1),
      snippet: previewText || conversation.snippet,
      timestamp: Math.max(conversation.timestamp ?? 0, message.timestamp),
    };

    if (!isEqual(conversation, nextConversation)) {
      conversationLookup[conversationId] = nextConversation;
      didChange = true;
    }
  }

  return didChange
    ? {
        ...shell,
        conversationLookup,
      }
    : shell;
}

export function getWebAttachmentVirtualPath(
  attachment: WebAttachment
): string | undefined {
  const contentType = getWebAttachmentContentTypeFromParts(attachment);
  const accessUrl = buildAttachmentAccessUrl(attachment);
  const isImage = contentType.startsWith('image/');
  const isVideo = contentType.startsWith('video/');
  const isAudio = isWebAudioAttachment(attachment);
  const isDisplayableMedia = isImage || isVideo || isAudio;
  const isUnavailable = attachment.backfillError || attachment.status === 'failed';
  const isPermanentlyUnavailable =
    isUnavailable && !isAudio && !isImage && !isVideo;
  const isBackupOnlyAudio = isWebBackupOnlyAudioAttachment(attachment);
  const isBackupOnlyVisual = isWebBackupOnlyVisualAttachment(attachment);
  return isDisplayableMedia && !isPermanentlyUnavailable
    ? isBackupOnlyAudio
      ? attachment.status === 'ready'
        ? `web:${getWebAttachmentStablePathKey(attachment, accessUrl)}`
        : undefined
      : isBackupOnlyVisual
        ? undefined
      : (attachment.downloadPath ??
        attachment.localBlobKey ??
        `web:${getWebAttachmentStablePathKey(attachment, accessUrl)}`)
    : attachment.downloadPath;
}

function getWebAttachmentStablePathKey(
  attachment: WebAttachment,
  accessUrl: string
): string {
  return (
    attachment.id ??
    attachment.cdnKey ??
    attachment.cdnId ??
    attachment.plaintextHash ??
    attachment.digestBase64 ??
    attachment.digest ??
    accessUrl
  );
}

function getProjectedAttachmentAccessUrl(
  attachment: WebAttachment
): string | undefined {
  const accessUrl = buildAttachmentAccessUrl(attachment);
  if (
    isWebBackupOnlyVisualAttachment(attachment) ||
    (isWebBackupOnlyAudioAttachment(attachment) &&
      attachment.status !== 'ready')
  ) {
    return undefined;
  }
  return accessUrl || undefined;
}

function isWebAudioAttachment(attachment: WebAttachment): boolean {
  const contentType = getWebAttachmentContentTypeFromParts(attachment);
  return (
    contentType.startsWith('audio/') ||
    attachment.flags === Proto.AttachmentPointer.Flags.VOICE_MESSAGE
  );
}

function isWebVisualAttachment(attachment: WebAttachment): boolean {
  const contentType = getWebAttachmentContentTypeFromParts(attachment);
  return contentType.startsWith('image/') || contentType.startsWith('video/');
}

function isWebBackupOnlyAudioAttachment(attachment: WebAttachment): boolean {
  const keyBase64 = attachment.keyBase64 ?? attachment.key;
  return (
    isWebAudioAttachment(attachment) &&
    !attachment.cdnId &&
    !attachment.cdnKey &&
    Boolean(keyBase64) &&
    Boolean(attachment.plaintextHash) &&
    attachment.dataBase64 == null &&
    attachment.localBlobKey == null
  );
}

function isWebBackupOnlyVisualAttachment(attachment: WebAttachment): boolean {
  const keyBase64 = attachment.keyBase64 ?? attachment.key;
  return (
    isWebVisualAttachment(attachment) &&
    !attachment.cdnId &&
    !attachment.cdnKey &&
    Boolean(keyBase64) &&
    Boolean(attachment.plaintextHash) &&
    attachment.dataBase64 == null &&
    attachment.localBlobKey == null
  );
}

function toDesktopAttachment(attachment: WebAttachment): Record<string, unknown> {
  const contentType = getWebAttachmentContentTypeFromParts(attachment);
  const flags = attachment.flags;
  const accessUrl = getProjectedAttachmentAccessUrl(attachment);
  const isImage = contentType.startsWith('image/');
  const isVideo = contentType.startsWith('video/');
  const isAudio = isWebAudioAttachment(attachment);
  const isVisual = isWebVisualAttachment(attachment);
  const isUnavailable = attachment.backfillError || attachment.status === 'failed';
  const shouldProjectAsPermanentlyUnavailable =
    isUnavailable && !isAudio && !isVisual;
  const isPending = attachment.status === 'pending' && !accessUrl;
  const width = attachment.width ?? (isImage || isVideo ? 320 : undefined);
  const height = attachment.height ?? (isImage || isVideo ? 240 : undefined);
  const virtualPath = shouldProjectAsPermanentlyUnavailable
    ? undefined
    : getWebAttachmentVirtualPath(attachment);
  const thumbnailAccessUrl = attachment.thumbnail
    ? buildAttachmentAccessUrl(attachment.thumbnail)
    : undefined;
  const explicitVisualPreviewUrl =
    attachment.thumbnailUrl ?? attachment.previewUrl ?? thumbnailAccessUrl;
  const visualPreviewUrl = explicitVisualPreviewUrl ?? (isImage ? accessUrl : undefined);
  const thumbnailContentType = attachment.thumbnail
    ? getWebAttachmentContentTypeFromParts(attachment.thumbnail)
    : undefined;
  const screenshot =
    isVideo && !shouldProjectAsPermanentlyUnavailable && visualPreviewUrl
      ? {
          contentType: thumbnailContentType ?? 'image/jpeg',
          height,
          size: 0,
          url: visualPreviewUrl,
          width,
        }
      : undefined;
  const thumbnailUrl = shouldProjectAsPermanentlyUnavailable
    ? undefined
    : visualPreviewUrl;
  const thumbnail =
    (isImage || isVideo) && thumbnailUrl
      ? {
          contentType: isImage ? contentType : (thumbnailContentType ?? 'image/jpeg'),
          height,
          path: virtualPath,
          size: attachment.size ?? 0,
          url: thumbnailUrl,
          width,
        }
      : undefined;

  return {
    backupCdnNumber: shouldProjectAsPermanentlyUnavailable
      ? undefined
      : attachment.backupCdnNumber,
    backfillError: shouldProjectAsPermanentlyUnavailable
      ? attachment.backfillError
      : undefined,
    blurHash: attachment.blurHash,
    caption: attachment.caption,
    cdnId: shouldProjectAsPermanentlyUnavailable ? undefined : attachment.cdnId,
    cdnKey: shouldProjectAsPermanentlyUnavailable ? undefined : attachment.cdnKey,
    cdnNumber: shouldProjectAsPermanentlyUnavailable
      ? undefined
      : attachment.cdnNumber,
    chunkSize: shouldProjectAsPermanentlyUnavailable
      ? undefined
      : attachment.chunkSize,
    clientUuid: attachment.clientUuid,
    contentType,
    digest: shouldProjectAsPermanentlyUnavailable
      ? undefined
      : (attachment.digestBase64 ?? attachment.digest),
    downloadPath: shouldProjectAsPermanentlyUnavailable
      ? undefined
      : attachment.downloadPath,
    duration: attachment.duration,
    fileName: attachment.fileName,
    flags,
    height,
    incrementalMac: shouldProjectAsPermanentlyUnavailable
      ? undefined
      : (attachment.incrementalMacBase64 ?? attachment.incrementalMac),
    isVoiceMessage:
      flags === Proto.AttachmentPointer.Flags.VOICE_MESSAGE || undefined,
    isCorrupted: isAudio ? undefined : attachment.isCorrupted,
    key: shouldProjectAsPermanentlyUnavailable
      ? undefined
      : (attachment.keyBase64 ?? attachment.key),
    localKey: shouldProjectAsPermanentlyUnavailable
      ? undefined
      : attachment.localKey,
    path: virtualPath,
    pending: isPending || undefined,
    plaintextHash: shouldProjectAsPermanentlyUnavailable
      ? undefined
      : attachment.plaintextHash,
    screenshot,
    size: attachment.size ?? 0,
    textAttachment: attachment.textAttachment,
    thumbnail,
    thumbnailFromBackup: undefined,
    uploadTimestamp: attachment.uploadTimestamp,
    url: accessUrl,
    width,
  };
}

function toDesktopAttachmentOrUndefined(
  attachment: WebAttachment | undefined
): Record<string, unknown> | undefined {
  return attachment ? toDesktopAttachment(attachment) : undefined;
}

function toDesktopQuote(quote: WebMessage['quote']): unknown {
  if (!quote) {
    return undefined;
  }

  return {
    ...quote,
    attachments: quote.attachments?.map(attachment => ({
      ...attachment,
      thumbnail: toDesktopAttachmentOrUndefined(
        attachment.thumbnail as WebAttachment | undefined
      ),
    })),
  };
}

function toDesktopPreview(preview: WebMessage['preview']): unknown {
  return preview?.map(item => ({
    ...item,
    image: toDesktopAttachmentOrUndefined(item.image as WebAttachment | undefined),
  }));
}

function toDesktopSticker(sticker: WebMessage['sticker']): unknown {
  if (!sticker) {
    return undefined;
  }

  return {
    ...sticker,
    data: toDesktopAttachmentOrUndefined(sticker.data as WebAttachment | undefined),
  };
}

function toDesktopContact(contact: WebMessage['contact']): unknown {
  return contact?.map(item => ({
    ...item,
    avatar: item.avatar
      ? {
          ...item.avatar,
          avatar: toDesktopAttachmentOrUndefined(
            item.avatar.avatar as WebAttachment | undefined
          ),
        }
      : undefined,
  }));
}

function toDesktopPoll(message: WebMessage): unknown {
  if (message.poll) {
    return message.poll;
  }

  if (message.pollCreate) {
    return {
      question: message.pollCreate.question ?? '',
      options: message.pollCreate.options ?? [],
      allowMultiple: Boolean(message.pollCreate.allowMultiple),
    };
  }

  return undefined;
}

function toDesktopEditHistory(
  editHistory: WebMessage['editHistory']
): unknown {
  return editHistory?.map(edit => ({
    ...edit,
    attachments: edit.attachments?.map(attachment =>
      toDesktopAttachment(attachment as WebAttachment)
    ),
    bodyAttachment: toDesktopAttachmentOrUndefined(
      edit.bodyAttachment as WebAttachment | undefined
    ),
    preview: toDesktopPreview(edit.preview as WebMessage['preview']),
    quote: toDesktopQuote(edit.quote as WebMessage['quote']),
  }));
}

function toDesktopSendStatus(status: WebMessage['status']): SendStatus {
  switch (status) {
    case 'queued':
      return SendStatus.Pending;
    case 'delivered':
      return SendStatus.Delivered;
    case 'read':
      return SendStatus.Read;
    case 'error':
      return SendStatus.Failed;
    case 'sent':
    case undefined:
      return SendStatus.Sent;
  }
}

function getDesktopMessageType(message: WebMessage): MessageAttributesType['type'] {
  const type =
    message.desktopType ??
    (message.direction === 'outgoing' ? 'outgoing' : 'incoming');

  if (type === 'pinned-message-notification' && !message.pinMessage) {
    return message.direction === 'outgoing' ? 'outgoing' : 'incoming';
  }
  if (type === 'timer-notification' && !message.expirationTimerUpdate) {
    return message.direction === 'outgoing' ? 'outgoing' : 'incoming';
  }

  return type;
}

export function toDesktopMessage(message: WebMessage): DesktopMessage {
  const timestamp = message.timestamp || Date.now();
  const type = getDesktopMessageType(message);
  const result: DesktopMessage = {
    id: message.id,
    type,
    body: message.body,
    conversationId: message.conversationId,
    sent_at: timestamp,
    received_at: message.receivedAt ?? timestamp,
    received_at_ms: message.receivedAt ?? timestamp,
    serverTimestamp: timestamp,
    timestamp,
    attachments: message.attachments?.map(toDesktopAttachment),
    bodyAttachment: toDesktopAttachmentOrUndefined(message.bodyAttachment),
    bodyRanges: message.bodyRanges,
    canReplyToStory: message.canReplyToStory,
    contact: toDesktopContact(message.contact),
    deletedForEveryone: message.deletedForEveryone ?? false,
    deletedForEveryoneByAdminAci: message.deletedForEveryoneByAdminAci,
    deletedForEveryoneTimestamp: message.deletedForEveryoneTimestamp,
    editHistory: toDesktopEditHistory(message.editHistory),
    editMessageTimestamp: message.editMessageTimestamp,
    editMessageReceivedAt: message.editMessageReceivedAt,
    editMessageReceivedAtMs: message.editMessageReceivedAtMs,
    expireTimer: message.expireTimer,
    expireTimerVersion: message.expireTimerVersion,
    expirationTimerUpdate: message.expirationTimerUpdate,
    flags: message.flags,
    giftBadge: message.giftBadge,
    groupCallUpdate: message.groupCallUpdate,
    groupV2Change: message.groupV2Change,
    groupV2: message.groupV2,
    isErased: message.isErased,
    isStory: message.isStory,
    isViewOnce: message.isViewOnce,
    key_changed: message.key_changed,
    messageRequestResponseEvent: message.messageRequestResponseEvent,
    payment: message.payment,
    pinMessage: message.pinMessage,
    poll: toDesktopPoll(message),
    preview: toDesktopPreview(message.preview),
    quote: toDesktopQuote(message.quote),
    reactions: message.reactions,
    readStatus:
      type === 'incoming'
        ? (message.readStatus ?? ReadStatus.Read)
        : undefined,
    seenStatus:
      type === 'incoming'
        ? (message.readStatus ?? ReadStatus.Read)
        : undefined,
    source: message.sourceServiceId,
    sourceServiceId: message.sourceServiceId,
    sticker: toDesktopSticker(message.sticker),
    supportedVersionAtReceive: message.supportedVersionAtReceive,
    storyContext: message.storyContext,
    storyReplyContext: message.storyContext
      ? {
          authorAci: message.storyContext.authorAci,
          messageId: String(message.storyContext.sentTimestamp),
      }
      : undefined,
    verified: message.verified,
    verifiedChanged: message.verifiedChanged,
  };

  if (type === 'outgoing') {
    result.sendStateByConversationId = {
      [message.conversationId]: {
        status: toDesktopSendStatus(message.status),
        updatedAt: timestamp,
      },
    };
  }

  return initializeSchemaVersion({
    message: result as never,
    logger: log,
  }) as DesktopMessage;
}

export function registerMessageInCache(message: WebMessage): void {
  const attributes = toDesktopMessage(message);
  const existing = window.MessageCache?.getById(message.id);
  if (existing) {
    if (isEqual(existing.attributes, attributes)) {
      return;
    }
    existing.set(attributes as never);
    return;
  }
  window.MessageCache?.register(new MessageModel(attributes as never));
}

export function getDesktopMessageMetrics(
  messages: ReadonlyArray<DesktopMessage>
): DesktopMessageMetrics {
  const sorted = [...messages].sort(
    (left, right) =>
      left.received_at - right.received_at || left.sent_at - right.sent_at
  );
  const oldest = sorted[0];
  const newest = sorted.at(-1);

  return {
    newest: newest
      ? {
          id: newest.id,
          received_at: newest.received_at,
          sent_at: newest.sent_at,
        }
      : undefined,
    oldest: oldest
      ? {
          id: oldest.id,
          received_at: oldest.received_at,
          sent_at: oldest.sent_at,
        }
      : undefined,
    totalUnseen: 0,
  };
}

export function toDesktopConversation(
  conversation: WebConversation,
  linkedSession: LinkedSessionRecord
): DesktopConversation {
  const isGroup =
    conversation.type === 'group' || conversation.conversationType === 'group';
  const sessionAci = linkedSession.credentials?.aci ?? linkedSession.account.aci;
  const sortTimestamp = getConversationListSortTimestamp(conversation);
  const left = conversation.left;
  const groupName = isGroup
    ? conversation.name ?? conversation.titleNoDefault ?? conversation.title
    : undefined;
  const directTitleFallback =
    !isGroup &&
    !conversation.systemNickname &&
    !conversation.systemGivenName &&
    !conversation.systemFamilyName &&
    !conversation.profileName &&
    !conversation.firstName &&
    !conversation.profileFamilyName &&
    !conversation.familyName &&
    !conversation.e164 &&
    !conversation.phoneNumber &&
    !conversation.username
      ? conversation.titleNoNickname ??
        conversation.titleNoDefault ??
        conversation.title
      : undefined;
  const titleAttributes = {
    e164: conversation.e164 ?? conversation.phoneNumber,
    name: groupName,
    nicknameFamilyName: conversation.nicknameFamilyName,
    nicknameGivenName: conversation.nicknameGivenName,
    profileFamilyName: conversation.profileFamilyName ?? conversation.familyName,
    profileName: conversation.profileName ?? conversation.firstName,
    systemFamilyName: conversation.systemFamilyName,
    systemGivenName: conversation.systemGivenName,
    systemNickname: conversation.systemNickname ?? directTitleFallback,
    type: isGroup ? ('group' as const) : ('private' as const),
    username: conversation.username,
  };
  const titleNoDefault = getTitleNoDefault(titleAttributes);
  const titleNoNickname = getTitle(titleAttributes, { ignoreNickname: true });
  const titleShortNoDefault = getTitle(titleAttributes, { isShort: true });
  const title = getTitle(titleAttributes);
  const serviceId =
    conversation.serviceId ??
    (!isGroup && isAciString(conversation.id) ? conversation.id : undefined);
  const base: DesktopConversation = {
    acceptedMessageRequest:
      conversation.removalStage == null &&
      (conversation.acceptedMessageRequest ?? true),
    about: conversation.about,
    aboutEmoji: conversation.aboutEmoji,
    activeAt: conversation.activeAt,
    announcementsOnly: conversation.announcementsOnly,
    avatars:
      conversation.avatars && conversation.avatars.length
        ? conversation.avatars
        : getDefaultAvatars(isGroup),
    avatarUrl: conversation.avatarUrl,
    avatarUrlPath: conversation.avatarUrlPath,
    badges: [],
    capabilities: {
      ...conversation.capabilities,
      ...(Boolean(conversation.isMe) || serviceId === sessionAci
        ? {
            attachmentBackfill: true,
          }
        : null),
    },
    color: conversation.color,
    conversationColor: conversation.conversationColor,
    customColor: conversation.customColor,
    customColorId: conversation.customColorId,
    dontNotifyForMentionsIfMuted: conversation.dontNotifyForMentionsIfMuted,
    draft: conversation.draft,
    draftBodyRanges: conversation.draftBodyRanges,
    draftEditMessage: conversation.draftEditMessage,
    e164: conversation.e164 ?? conversation.phoneNumber,
    expireTimer: conversation.expireTimer,
    expireTimerVersion: conversation.expireTimerVersion,
    firstName:
      conversation.nicknameGivenName ??
      conversation.profileName ??
      conversation.firstName,
    familyName:
      conversation.nicknameFamilyName ??
      conversation.profileFamilyName ??
      conversation.familyName,
    hasAvatar: conversation.hasAvatar ?? Boolean(conversation.avatarUrl),
    hasMessages: conversation.hasMessages ?? true,
    id: conversation.id,
    inboxPosition: conversation.inboxPosition ?? sortTimestamp,
    isArchived: conversation.isArchived,
    isBlocked: conversation.isBlocked,
    isMe: Boolean(conversation.isMe) || serviceId === sessionAci,
    isPinned: conversation.isPinned,
    left,
    lastMessage: conversation.lastMessage,
    lastMessageReceivedAt: conversation.lastMessageReceivedAt,
    lastMessageReceivedAtMs: conversation.lastMessageReceivedAtMs,
    lastUpdated: conversation.lastUpdated,
    markedUnread: conversation.markedUnread,
    messageCount: conversation.messageCount,
    messageCountBeforeMessageRequests:
      conversation.messageCountBeforeMessageRequests,
    messageRequestResponseType: conversation.messageRequestResponseType,
    messagesDeleted: conversation.messagesDeleted,
    muteExpiresAt: conversation.muteExpiresAt,
    nicknameFamilyName: conversation.nicknameFamilyName,
    nicknameGivenName: conversation.nicknameGivenName,
    note: conversation.note,
    name: groupName,
    phoneNumber: conversation.phoneNumber,
    pni: conversation.pni,
    profileKey: conversation.profileKey,
    profileName: conversation.profileName,
    profileSharing: conversation.profileSharing ?? true,
    remoteAvatarUrl: conversation.remoteAvatarUrl,
    quotedMessageId: conversation.quotedMessageId,
    removalStage: conversation.removalStage,
    searchableTitle: title,
    serviceId,
    sharingPhoneNumber: true,
    sentMessageCount: conversation.sentMessageCount,
    timestamp: (conversation.timestamp ?? sortTimestamp) || undefined,
    systemFamilyName: conversation.systemFamilyName,
    systemGivenName: conversation.systemGivenName,
    systemNickname: conversation.systemNickname,
    title,
    titleNoDefault,
    titleNoNickname,
    titleShortNoDefault,
    type: isGroup ? 'group' : 'direct',
    unreadCount: conversation.unreadCount ?? 0,
    username: conversation.username,
  };

  if (isGroup) {
    const areWeAdmin = getAreWeGroupAdmin(conversation, linkedSession);
    const groupAccessControl = getGroupAccessControl(conversation);
    return {
      ...base,
      acknowledgedGroupNameCollisions: {},
      accessControl: groupAccessControl,
      accessControlAddFromInviteLink: groupAccessControl.addFromInviteLink,
      accessControlAttributes: groupAccessControl.attributes,
      accessControlMembers: groupAccessControl.members,
      accessControlMemberLabel: groupAccessControl.memberLabel,
      areWeAdmin,
      canAddNewMembers: getCanAddNewMembersForWebGroup({
        accessControl: groupAccessControl,
        areWeAdmin,
        left,
        terminated: conversation.terminated,
      }),
      canEditGroupInfo: getCanEditGroupInfoForWebGroup({
        accessControl: groupAccessControl,
        areWeAdmin,
        left,
        terminated: conversation.terminated,
      }),
      groupId: conversation.groupId ?? conversation.id,
      groupVersion: 2,
      masterKey: conversation.masterKey,
      membersCount: conversation.membersV2?.length ?? 0,
      memberships: getMembershipsFromMembersV2(conversation),
      membersV2: conversation.membersV2,
      pendingMemberships: getPendingMembershipsFromPendingMembersV2(
        conversation
      ),
      pendingMembersV2: conversation.pendingMembersV2,
      publicParams: conversation.publicParams,
      revision: conversation.revision ?? 0,
      secretParams: conversation.secretParams,
      storySendMode: StorySendMode.IfActive,
    };
  }

  return base;
}

function ensureNoteToSelf(
  shell: ChatShellState,
  linkedSession: LinkedSessionRecord
): ChatShellState {
  const sessionAci = linkedSession.credentials?.aci ?? linkedSession.account.aci;
  if (!sessionAci) {
    return shell;
  }
  const existing = shell.conversationLookup[sessionAci];
  if (existing) {
    const account = linkedSession.account;
    const updated: WebConversation = {
      ...existing,
      about: 'about' in account ? account.about : existing.about,
      aboutEmoji:
        'aboutEmoji' in account ? account.aboutEmoji : existing.aboutEmoji,
      avatarUrl:
        'avatarUrl' in account ? account.avatarUrl : existing.avatarUrl,
      avatarUrlPath:
        'avatarUrlPath' in account
          ? account.avatarUrlPath
          : existing.avatarUrlPath,
      avatars:
        existing.avatars && existing.avatars.length
          ? existing.avatars
          : getDefaultAvatars(false),
      capabilities: {
        ...existing.capabilities,
        attachmentBackfill: true,
      },
      e164: account.number ?? account.phoneNumber ?? existing.e164,
      firstName: account.firstName ?? account.profileName ?? existing.firstName,
      familyName:
        account.familyName ?? account.profileFamilyName ?? existing.familyName,
      isMe: true,
      phoneNumber:
        account.number ?? account.phoneNumber ?? existing.phoneNumber,
      profileFamilyName:
        account.profileFamilyName ??
        account.familyName ??
        existing.profileFamilyName,
      profileName:
        account.profileName ?? account.firstName ?? existing.profileName,
      serviceId: existing.serviceId ?? sessionAci,
      username: account.username ?? existing.username,
    };
    const title = getConversationTitle(updated);
    return {
      ...shell,
      conversationLookup: {
        ...shell.conversationLookup,
        [sessionAci]: {
          ...updated,
          searchableTitle: title,
          title,
          titleNoDefault: title,
        },
      },
    };
  }

  const account = linkedSession.account;
  const title = account.title ?? account.profileName ?? 'Note to Self';
  const selectedConversationId =
    shell.selectedConversationId === 'note-to-self'
      ? sessionAci
      : shell.selectedConversationId;
  return {
    ...shell,
    selectedConversationId: selectedConversationId ?? sessionAci,
    conversationLookup: {
      ...shell.conversationLookup,
      [sessionAci]: {
        id: sessionAci,
        type: 'direct',
        conversationType: 'direct',
        isMe: true,
        serviceId: sessionAci,
        e164: account.number ?? account.phoneNumber,
        phoneNumber: account.number ?? account.phoneNumber,
        title,
        titleNoDefault: title,
        searchableTitle: title,
        profileName: account.profileName,
        profileFamilyName: account.profileFamilyName,
        username: account.username,
        avatarUrl: account.avatarUrl,
        avatarUrlPath: account.avatarUrlPath,
        avatars: getDefaultAvatars(false),
        capabilities: {
          attachmentBackfill: true,
        },
        activeAt: linkedSession.linkedAt,
        lastUpdated: linkedSession.linkedAt,
        timestamp: linkedSession.linkedAt,
        hasMessages: false,
      },
    },
  };
}

function setBootstrapConversationLookup(
  shell: ChatShellState,
  linkedSession: LinkedSessionRecord
): void {
  (
    window as unknown as {
      SignalWebBootstrapConversationLookup?: Record<string, DesktopConversation>;
    }
  ).SignalWebBootstrapConversationLookup = Object.fromEntries(
    Object.values(shell.conversationLookup).map(conversation => [
      conversation.id,
      toDesktopConversation(conversation, linkedSession),
    ])
  );
}

function getLinkedSessionWithBootstrapAccount(
  linkedSession: LinkedSessionRecord,
  bootstrap: ContactsBootstrap
): LinkedSessionRecord {
  if (!bootstrap.account) {
    return linkedSession;
  }

  const account = mergeBootstrapAccountForLinkedSession(
    linkedSession,
    bootstrap
  );
  return {
    ...linkedSession,
    account,
    linkedPayload: {
      ...linkedSession.linkedPayload,
      account,
    },
  };
}

export function applyContactsBootstrap(
  shell: ChatShellState,
  bootstrap: ContactsBootstrap | undefined,
  linkedSession: LinkedSessionRecord
): ChatShellState {
  if (!bootstrap) {
    const nextShell = normalizeChatShellForLinkedSession(shell, linkedSession);
    setBootstrapConversationLookup(nextShell, linkedSession);
    return deriveConversationPreviews(nextShell, linkedSession);
  }

  const effectiveLinkedSession = getLinkedSessionWithBootstrapAccount(
    linkedSession,
    bootstrap
  );

  const nextLookup: Record<string, WebConversation> = {
    ...shell.conversationLookup,
  };

  for (const conversation of [
    ...bootstrap.pinned.map(item => ({ ...item, isPinned: true })),
    ...bootstrap.conversations.map(item => ({ ...item, isPinned: false })),
    ...bootstrap.archived.map(item => ({ ...item, isArchived: true })),
  ]) {
    const existing = nextLookup[conversation.id];
    const isStorageBootstrap = bootstrap.source === 'storage';
    if (
      isStorageBootstrap &&
      shouldHideStorageOnlyArchivedGroup(conversation, existing)
    ) {
      delete nextLookup[conversation.id];
      continue;
    }
    const isStorageOnlyConversation =
      isStorageBootstrap &&
      !conversation.hasMessages &&
      !existing?.hasMessages &&
      !existing?.messagesDeleted;
    const incoming = isStorageOnlyConversation
      ? dropStorageOnlyActivity(conversation)
      : conversation;
    const merged = mergeConversationForBootstrap({
      existing:
        isStorageBootstrap && !existing?.hasMessages && !existing?.messagesDeleted
          ? undefined
          : existing,
      incoming,
      preserveExistingActivity:
        isStorageBootstrap &&
        (Boolean(existing?.hasMessages) || Boolean(existing?.messagesDeleted)),
    });
    nextLookup[conversation.id] = {
      ...merged,
      activeAt:
        merged.messagesDeleted === true
          ? undefined
          : merged.activeAt ??
            merged.lastMessageReceivedAtMs ??
            merged.lastUpdated ??
            merged.timestamp ??
            (isStorageOnlyConversation
              ? undefined
              : nextLookup[conversation.id]?.activeAt),
    };
  }

  const nextShell = normalizeChatShellForLinkedSession(
    {
      ...shell,
      selectedConversationId:
        shell.selectedConversationId ?? bootstrap.selectedConversationId,
      conversationLookup: ensureDirectConversationShellsForGroupMembers(
        nextLookup
      ),
    },
    effectiveLinkedSession
  );
  setBootstrapConversationLookup(nextShell, effectiveLinkedSession);
  return deriveConversationPreviews(nextShell, effectiveLinkedSession);
}

export function createDesktopConversationState(
  shell: ChatShellState,
  linkedSession: LinkedSessionRecord
) {
  const conversations = Object.fromEntries(
    Object.values(shell.conversationLookup).map(conversation => [
      conversation.id,
      toDesktopConversation(conversation, linkedSession),
    ])
  );
  const messages = [...shell.messages].sort(compareWebMessages).map(toDesktopMessage);
  const messagesLookup = Object.fromEntries(
    messages.map(message => [message.id, message])
  );
  const messagesByConversation: Record<string, unknown> = {};
  const pinnedMessages = shell.pinnedMessages ?? [];

  for (const conversation of Object.values(shell.conversationLookup)) {
    const conversationMessages = messages
      .filter(message => message.conversationId === conversation.id)
      .sort((left, right) => left.received_at - right.received_at);
    messagesByConversation[conversation.id] = {
      haveNewest: true,
      haveOldest: true,
      isNearBottom: true,
      messageChangeCounter: 0,
      messageIds: conversationMessages.map(message => message.id),
      messageLoadingState: undefined,
      metrics: getDesktopMessageMetrics(conversationMessages),
      pinnedMessages: pinnedMessages.filter(
        pinnedMessage => pinnedMessage.conversationId === conversation.id
      ),
      scrollToMessageCounter: 0,
    };
  }

  return {
    conversationLookup: conversations,
    conversationsByE164: Object.fromEntries(
      Object.values(conversations)
        .filter(conversation => typeof conversation.e164 === 'string')
        .map(conversation => [conversation.e164, conversation])
    ),
    conversationsByGroupId: Object.fromEntries(
      Object.values(conversations)
        .filter(conversation => typeof conversation.groupId === 'string')
        .map(conversation => [conversation.groupId, conversation])
    ),
    conversationsByServiceId: Object.fromEntries(
      Object.values(conversations)
        .filter(conversation => typeof conversation.serviceId === 'string')
        .map(conversation => [conversation.serviceId, conversation])
    ),
    conversationsByUsername: Object.fromEntries(
      Object.values(conversations)
        .filter(conversation => typeof conversation.username === 'string')
        .map(conversation => [conversation.username, conversation])
    ),
    messagesByConversation,
    messagesLookup,
  };
}
