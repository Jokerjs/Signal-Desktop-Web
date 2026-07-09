// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getRenderApiBaseUrl,
  getRenderCdnBaseUrl,
} from '../renderConfig.dom.ts';
import type {
  ChatShellState,
  LinkedSessionRecord,
  WebAttachment,
  WebConversation,
  WebMessage,
} from '../types.std.ts';
import {
  modifyGroupMember,
  modifyGroupSettings,
  sendDirectExpirationTimerUpdate,
  sendDirectTextMessage,
  sendGroupTextMessage,
  sendMessageRequestResponseSync,
  updateConversationArchive,
  updateConversationMarkedUnread,
  updateConversationMute,
  updateConversationPin,
} from '../api.dom.ts';
import {
  type DesktopMessageMetrics,
  toDesktopConversation,
  toDesktopMessage,
} from './stateAdapter.dom.ts';
import { getNotificationDataForMessage } from '../../util/getNotificationDataForMessage.preload.ts';
import { getMessagePropStatus } from '../../state/selectors/message.preload.ts';
import OS from './osMainShim.dom.ts';
import type { LocalizerType, ThemeType } from '../../types/Util.std.ts';
import { SIGNAL_ACI } from '../../types/SignalConversation.std.ts';
import type { AciString } from '../../types/ServiceId.std.ts';
import { isPniString } from '../../types/ServiceId.std.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import { ReadStatus } from '../../messages/MessageReadStatus.std.ts';
import { SeenStatus } from '../../MessageSeenStatus.std.ts';
import { ToastType } from '../../types/Toast.dom.tsx';
import { isAciString } from '../../util/isAciString.std.ts';
import * as Bytes from '../../Bytes.std.ts';
import { deriveAccessKeyFromProfileKey } from '../../util/zkgroup.node.ts';
import { getPinnedMessagesLimit } from '../../util/pinnedMessages.dom.ts';
import { getPinnedMessageExpiresAt } from '../../util/pinnedMessages.std.ts';
import { getTitle, getTitleNoDefault } from '../../util/getTitle.preload.ts';
import { isBlocked } from '../../util/isBlocked.preload.ts';
import {
  isConversationEverUnregistered,
  isConversationUnregistered,
  isConversationUnregisteredAndStale,
} from '../../util/isConversationUnregistered.dom.ts';
import { DurationInSeconds } from '../../util/durations/duration-in-seconds.std.ts';
import { INITIAL_EXPIRE_TIMER_VERSION } from '../../util/expirationTimer.std.ts';
import { TimelineMessageLoadingState } from '../../util/timelineUtil.std.ts';
import { isNotNil } from '../../util/isNotNil.std.ts';
import countryDisplayNames from '../../../build/country-display-names.json';
import packageJson from '../../../package.json';
import { loadWebSettings, updateWebSettings } from './webSettings.dom.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import type {
  ConversationAttributesType,
  MessageAttributesType,
  PinMessageData,
} from '../../model-types.d.ts';
import type { GroupV2ChangeDetailType } from '../../types/groups.std.ts';
import type { AttachmentType } from '../../types/Attachment.std.ts';
import {
  isAudio,
  isFile,
  isVisualMedia,
  isVoiceMessage,
} from '../../util/Attachment.std.ts';
import type {
  ContactMediaItemDBType,
  GetSortedDocumentsOptionsType,
  GetSortedMediaOptionsType,
  GetSortedNonAttachmentMediaOptionsType,
  MediaItemDBType,
  NonAttachmentMediaItemDBType,
} from '../../sql/Interface.std.ts';
import type {
  PinnedMessage,
  PinnedMessageId,
  PinnedMessageParams,
  PinnedMessagePreloadData,
} from '../../types/PinnedMessage.std.ts';

type Localizer = LocalizerType;
type WebEventCallback = (...args: ReadonlyArray<unknown>) => void;
type ConversationAttributesChanged = (
  id: string,
  attributes: Record<string, unknown>
) => void;
type PinnedMessagesChanged = (
  pinnedMessages: ReadonlyArray<PinnedMessage>
) => void;

const MESSAGE_LOAD_CHUNK_SIZE = 30;

type ConversationRecord = Record<string, unknown> & { id: string };
type MessageRecord = MessageAttributesType &
  Record<string, unknown> & {
    id: string;
    conversationId: string;
    received_at: number;
    sent_at: number;
    timestamp: number;
  };
type DebouncedUpdateLastMessage = (() => void) & {
  flush: () => void;
};
type WebConvoMatch =
  | {
      key: 'serviceId' | 'pni';
      value: string | undefined;
      match: WebConversationModel | undefined;
    }
  | {
      key: 'e164';
      value: string | undefined;
      match: WebConversationModel | undefined;
    };

const { hasOwnProperty } = Object.prototype;

function getGroupAccessControlForRecord(
  attributes: ConversationRecord
): NonNullable<ConversationAttributesType['accessControl']> {
  const { AccessRequired } = Proto.AccessControl;
  const accessControl =
    attributes.accessControl as ConversationAttributesType['accessControl'];
  return {
    attributes: accessControl?.attributes ?? AccessRequired.MEMBER,
    members: accessControl?.members ?? AccessRequired.MEMBER,
    addFromInviteLink:
      accessControl?.addFromInviteLink ?? AccessRequired.UNSATISFIABLE,
    memberLabel: accessControl?.memberLabel ?? AccessRequired.MEMBER,
  };
}

function getDerivedGroupPermissionAttributes(
  attributes: ConversationRecord
): Record<string, unknown> | undefined {
  if (attributes.type !== 'group' && attributes.conversationType !== 'group') {
    return undefined;
  }

  const accessControl = getGroupAccessControlForRecord(attributes);
  const hasMembersV2 = Array.isArray(attributes.membersV2);
  const membersV2 = hasMembersV2
    ? (attributes.membersV2 as NonNullable<WebConversation['membersV2']>)
    : [];
  const ourAci = getOurAci();
  const areWeAdmin = Boolean(
    ourAci &&
    membersV2.some(member => {
      return (
        member &&
        typeof member === 'object' &&
        'aci' in member &&
        member.aci === ourAci &&
        'role' in member &&
        member.role === Proto.Member.Role.ADMINISTRATOR
      );
    })
  );
  const left = Boolean(
    attributes.left ||
    (ourAci &&
      hasMembersV2 &&
      !membersV2.some(member => {
        return (
          member &&
          typeof member === 'object' &&
          'aci' in member &&
          member.aci === ourAci
        );
      }))
  );
  const terminated = Boolean(attributes.terminated);

  return {
    accessControl,
    accessControlAddFromInviteLink: accessControl.addFromInviteLink,
    accessControlAttributes: accessControl.attributes,
    accessControlMembers: accessControl.members,
    accessControlMemberLabel: accessControl.memberLabel,
    areWeAdmin,
    canAddNewMembers:
      !left &&
      !terminated &&
      (areWeAdmin ||
        accessControl.members === Proto.AccessControl.AccessRequired.MEMBER),
    canEditGroupInfo:
      !left &&
      !terminated &&
      (areWeAdmin ||
        accessControl.attributes === Proto.AccessControl.AccessRequired.MEMBER),
  };
}

function getDerivedContactIdentityAttributes(
  attributes: ConversationRecord
): Record<string, unknown> {
  const isGroup =
    attributes.type === 'group' || attributes.conversationType === 'group';
  if (isGroup) {
    return {};
  }

  const pni = typeof attributes.pni === 'string' ? attributes.pni : undefined;
  const serviceId =
    typeof attributes.serviceId === 'string' ? attributes.serviceId : undefined;

  if (pni && (!serviceId || serviceId === pni)) {
    return { serviceId: pni };
  }

  return {};
}

function getDerivedTitleAttributes(
  attributes: ConversationRecord
): Record<string, unknown> {
  const isGroup =
    attributes.type === 'group' || attributes.conversationType === 'group';
  const groupName = isGroup
    ? ((attributes.name ?? attributes.titleNoDefault ?? attributes.title) as
        | string
        | undefined)
    : undefined;
  const directTitleFallback =
    !isGroup &&
    !attributes.systemNickname &&
    !attributes.systemGivenName &&
    !attributes.systemFamilyName &&
    !attributes.profileName &&
    !attributes.firstName &&
    !attributes.profileFamilyName &&
    !attributes.familyName &&
    !attributes.e164 &&
    !attributes.phoneNumber &&
    !attributes.username
      ? ((attributes.titleNoNickname ??
          attributes.titleNoDefault ??
          attributes.title) as string | undefined)
      : undefined;
  const titleAttributes = {
    e164: (attributes.e164 ?? attributes.phoneNumber) as string | undefined,
    name: groupName,
    nicknameFamilyName: attributes.nicknameFamilyName as string | undefined,
    nicknameGivenName: attributes.nicknameGivenName as string | undefined,
    profileFamilyName: (attributes.profileFamilyName ??
      attributes.familyName) as string | undefined,
    profileName: (attributes.profileName ?? attributes.firstName) as
      | string
      | undefined,
    systemFamilyName: attributes.systemFamilyName as string | undefined,
    systemGivenName: attributes.systemGivenName as string | undefined,
    systemNickname:
      (attributes.systemNickname as string | undefined) ?? directTitleFallback,
    type: isGroup ? ('group' as const) : ('private' as const),
    username: attributes.username as string | undefined,
  };
  const title = getTitle(titleAttributes);

  return {
    familyName:
      attributes.nicknameFamilyName ??
      attributes.profileFamilyName ??
      attributes.familyName,
    firstName:
      attributes.nicknameGivenName ??
      attributes.profileName ??
      attributes.firstName,
    searchableTitle: title,
    title,
    titleNoDefault: getTitleNoDefault(titleAttributes),
    titleNoNickname: getTitle(titleAttributes, { ignoreNickname: true }),
    titleShortNoDefault: getTitle(titleAttributes, { isShort: true }),
  };
}

type AddPinnedMessageNotificationParams = Readonly<{
  pinMessage: PinMessageData;
  senderAci: AciString;
  sentAtTimestamp: number;
  receivedAtTimestamp: number;
  expireTimer: DurationInSeconds | null;
  expirationStartTimestamp: number | null;
}>;
type ApplyRemotePinnedMessageParams = Readonly<{
  conversationId: string;
  targetAuthorAci: string;
  targetSentTimestamp: number;
  pinDurationSeconds: number | null;
  senderAci: string;
  timestamp: number;
  receivedAt: number;
}>;
type ApplyRemoteUnpinMessageParams = Readonly<{
  conversationId: string;
  targetAuthorAci: string;
  targetSentTimestamp: number;
  timestamp: number;
  receivedAt: number;
}>;
type WebForwardAttachment = Record<string, unknown> & {
  contentType?: string;
  data?: Uint8Array<ArrayBuffer>;
  dataBase64?: string;
  fileName?: string;
  flags?: number;
  height?: number;
  size?: number;
  url?: string;
  width?: number;
};
type WebEnqueuedMessage = Readonly<{
  attachments?: ReadonlyArray<WebForwardAttachment>;
  body?: string;
  quote?: WebMessage['quote'];
}>;
type WebEnqueueMessageOptions = Readonly<{
  timestamp?: number;
}>;
export const WEB_MESSAGES_REMOVED_EVENT = 'signal-web-runtime-messages-removed';
export const WEB_MESSAGES_ADDED_EVENT = 'signal-web-runtime-messages-added';
let currentLinkedSession: LinkedSessionRecord | undefined;
let webRuntimeMessagesLookup: Record<string, MessageRecord> = {};
let webRuntimeMessagesSource: ChatShellState['messages'] | undefined;
let webRuntimeShellMessagesById = new Map<string, WebMessage>();
let webRuntimeShellMessagesByConversation = new Map<
  string,
  Array<WebMessage>
>();
const webRuntimeDeletedMessageIds = new Set<string>();
let webRuntimePinnedMessages: ReadonlyArray<PinnedMessage> = [];
let nextWebRuntimePinnedMessageId = 1;
let onConversationAttributesChanged: ConversationAttributesChanged | undefined;
let onPinnedMessagesChanged: PinnedMessagesChanged | undefined;
let currentMessageRuntimeSessionId: string | undefined;
let webRuntimeConversationLookupSource:
  | ChatShellState['conversationLookup']
  | undefined;
let webRuntimeConversationLookupLinkedSession: LinkedSessionRecord | undefined;
let webRuntimeConversationLookup: Record<string, ConversationRecord> = {};

type RuntimeMessageEntry =
  | Readonly<{
      kind: 'record';
      id: string;
      conversationId: string;
      receivedAt: number;
      sentAt: number;
      message: MessageRecord;
    }>
  | Readonly<{
      kind: 'web';
      id: string;
      conversationId: string;
      receivedAt: number;
      sentAt: number;
      message: WebMessage;
    }>;

function getBootstrapConversationLookup(): Record<string, ConversationRecord> {
  return (
    (
      window as unknown as {
        SignalWebBootstrapConversationLookup?: Record<
          string,
          ConversationRecord
        >;
      }
    ).SignalWebBootstrapConversationLookup ?? {}
  );
}

function isRenderableMessageRecord(message: MessageRecord): boolean {
  return (
    message.type !== 'pinned-message-notification' ||
    Boolean(message.pinMessage)
  );
}

function getTimestamp(message: MessageRecord): number {
  return message.received_at ?? message.sent_at ?? message.timestamp ?? 0;
}

function compareMessages(left: MessageRecord, right: MessageRecord): number {
  return (
    getTimestamp(left) - getTimestamp(right) ||
    left.sent_at - right.sent_at ||
    left.id.localeCompare(right.id)
  );
}

function compareRuntimeMessageEntries(
  left: RuntimeMessageEntry,
  right: RuntimeMessageEntry
): number {
  return (
    left.receivedAt - right.receivedAt ||
    left.sentAt - right.sentAt ||
    left.id.localeCompare(right.id)
  );
}

function getWebMessageEntry(message: WebMessage): RuntimeMessageEntry {
  return {
    kind: 'web',
    id: message.id,
    conversationId: message.conversationId,
    receivedAt: message.receivedAt ?? message.timestamp,
    sentAt: message.timestamp,
    message,
  };
}

function getMessageRecordEntry(message: MessageRecord): RuntimeMessageEntry {
  return {
    kind: 'record',
    id: message.id,
    conversationId: message.conversationId,
    receivedAt: getTimestamp(message),
    sentAt: message.sent_at ?? message.timestamp ?? getTimestamp(message),
    message,
  };
}

function runtimeMessageEntryToRecord(
  entry: RuntimeMessageEntry
): MessageRecord {
  return entry.kind === 'record'
    ? entry.message
    : (toDesktopMessage(entry.message) as MessageRecord);
}

function getReduxMessagesLookup(): Record<string, MessageRecord> {
  return (window.reduxStore?.getState?.().conversations?.messagesLookup ??
    {}) as Record<string, MessageRecord>;
}

function getMessageFromLookup(
  messageId: string,
  reduxMessagesLookup = getReduxMessagesLookup()
): MessageRecord | undefined {
  if (webRuntimeDeletedMessageIds.has(messageId)) {
    return undefined;
  }

  const message = webRuntimeMessagesLookup[messageId];
  if (message) {
    return isRenderableMessageRecord(message) ? message : undefined;
  }

  const webMessage = webRuntimeShellMessagesById.get(messageId);
  if (webMessage) {
    const desktopMessage = toDesktopMessage(webMessage) as MessageRecord;
    return isRenderableMessageRecord(desktopMessage)
      ? desktopMessage
      : undefined;
  }

  const reduxMessage = reduxMessagesLookup[messageId];
  return reduxMessage && isRenderableMessageRecord(reduxMessage)
    ? reduxMessage
    : undefined;
}

function getConversationMessageEntries(
  conversationId: string | undefined
): Array<RuntimeMessageEntry> {
  if (!conversationId) {
    return [];
  }

  const overrideMessages = Object.values(webRuntimeMessagesLookup).filter(
    message =>
      message.conversationId === conversationId &&
      !webRuntimeDeletedMessageIds.has(message.id) &&
      isRenderableMessageRecord(message)
  );
  const overrideIds = new Set(overrideMessages.map(message => message.id));

  const entries: Array<RuntimeMessageEntry> = [];
  for (const message of webRuntimeShellMessagesByConversation.get(
    conversationId
  ) ?? []) {
    if (
      webRuntimeDeletedMessageIds.has(message.id) ||
      overrideIds.has(message.id)
    ) {
      continue;
    }
    entries.push(getWebMessageEntry(message));
  }
  for (const message of overrideMessages) {
    entries.push(getMessageRecordEntry(message));
  }
  return entries;
}

function getConversationMessageEntryById(
  conversationId: string,
  messageId: string
): RuntimeMessageEntry | undefined {
  const message = webRuntimeMessagesLookup[messageId];
  if (
    message &&
    message.conversationId === conversationId &&
    !webRuntimeDeletedMessageIds.has(message.id) &&
    isRenderableMessageRecord(message)
  ) {
    return getMessageRecordEntry(message);
  }

  const webMessage = webRuntimeShellMessagesById.get(messageId);
  if (
    webMessage &&
    webMessage.conversationId === conversationId &&
    !webRuntimeDeletedMessageIds.has(webMessage.id)
  ) {
    return getWebMessageEntry(webMessage);
  }

  const reduxMessage = getReduxMessagesLookup()[messageId];
  if (
    reduxMessage &&
    reduxMessage.conversationId === conversationId &&
    isRenderableMessageRecord(reduxMessage)
  ) {
    return getMessageRecordEntry(reduxMessage);
  }

  return undefined;
}

function insertSortedRuntimeMessageEntry(
  entries: Array<RuntimeMessageEntry>,
  entry: RuntimeMessageEntry
): void {
  const index = entries.findIndex(
    existing => compareRuntimeMessageEntries(entry, existing) < 0
  );
  if (index < 0) {
    entries.push(entry);
  } else {
    entries.splice(index, 0, entry);
  }
}

function getNewestConversationMessageEntries(
  conversationId: string,
  limit: number
): Array<RuntimeMessageEntry> {
  const result: Array<RuntimeMessageEntry> = [];
  for (const entry of getConversationMessageEntries(conversationId)) {
    insertSortedRuntimeMessageEntry(result, entry);
    if (result.length > limit) {
      result.shift();
    }
  }
  return result;
}

function getOlderConversationMessageEntries(
  conversationId: string,
  oldestMessageId: string,
  limit: number
): Array<RuntimeMessageEntry> {
  const anchor = getConversationMessageEntryById(
    conversationId,
    oldestMessageId
  );
  if (!anchor) {
    return [];
  }

  const result: Array<RuntimeMessageEntry> = [];
  for (const entry of getConversationMessageEntries(conversationId)) {
    if (compareRuntimeMessageEntries(entry, anchor) >= 0) {
      continue;
    }
    insertSortedRuntimeMessageEntry(result, entry);
    if (result.length > limit) {
      result.shift();
    }
  }
  return result;
}

function getNewerConversationMessageEntries(
  conversationId: string,
  newestMessageId: string,
  limit: number
): Array<RuntimeMessageEntry> {
  const anchor = getConversationMessageEntryById(
    conversationId,
    newestMessageId
  );
  if (!anchor) {
    return [];
  }

  const result: Array<RuntimeMessageEntry> = [];
  for (const entry of getConversationMessageEntries(conversationId)) {
    if (compareRuntimeMessageEntries(entry, anchor) <= 0) {
      continue;
    }
    insertSortedRuntimeMessageEntry(result, entry);
    if (result.length > limit) {
      result.pop();
    }
  }
  return result;
}

function getConversationMessageEntriesAround(
  conversationId: string,
  messageId: string,
  limit: number
): Array<RuntimeMessageEntry> {
  const anchor = getConversationMessageEntryById(conversationId, messageId);
  if (!anchor) {
    return getNewestConversationMessageEntries(conversationId, limit);
  }

  const sideLimit = Math.floor(limit / 2);
  const older: Array<RuntimeMessageEntry> = [];
  const newer: Array<RuntimeMessageEntry> = [];
  for (const entry of getConversationMessageEntries(conversationId)) {
    const delta = compareRuntimeMessageEntries(entry, anchor);
    if (delta < 0) {
      insertSortedRuntimeMessageEntry(older, entry);
      if (older.length > sideLimit) {
        older.shift();
      }
    } else if (delta > 0) {
      insertSortedRuntimeMessageEntry(newer, entry);
      if (newer.length > sideLimit) {
        newer.pop();
      }
    }
  }
  return [...older, anchor, ...newer];
}

function runtimeMessageEntriesToRecords(
  entries: ReadonlyArray<RuntimeMessageEntry>
): Array<MessageRecord> {
  return entries
    .map(runtimeMessageEntryToRecord)
    .filter(isRenderableMessageRecord);
}

function getMessageMetricsFromEntries(
  entries: ReadonlyArray<RuntimeMessageEntry>
): DesktopMessageMetrics {
  let oldest: RuntimeMessageEntry | undefined;
  let newest: RuntimeMessageEntry | undefined;
  for (const entry of entries) {
    if (!oldest || compareRuntimeMessageEntries(entry, oldest) < 0) {
      oldest = entry;
    }
    if (!newest || compareRuntimeMessageEntries(entry, newest) > 0) {
      newest = entry;
    }
  }

  return {
    newest: newest
      ? {
          id: newest.id,
          received_at: newest.receivedAt,
          sent_at: newest.sentAt,
        }
      : undefined,
    oldest: oldest
      ? {
          id: oldest.id,
          received_at: oldest.receivedAt,
          sent_at: oldest.sentAt,
        }
      : undefined,
    totalUnseen: 0,
  };
}

function getMessageMetricsForConversation(
  conversationId: string | undefined
): DesktopMessageMetrics {
  return getMessageMetricsFromEntries(
    getConversationMessageEntries(conversationId)
  );
}

function getAllShellMessageRecords(): Array<MessageRecord> {
  return [...webRuntimeShellMessagesById.values()]
    .filter(message => !webRuntimeDeletedMessageIds.has(message.id))
    .map(message => toDesktopMessage(message) as MessageRecord)
    .filter(isRenderableMessageRecord);
}

function getMessagesLookup(): Record<string, MessageRecord> {
  const reduxMessagesLookup = getReduxMessagesLookup();
  const lookup = {
    ...Object.fromEntries(
      getAllShellMessageRecords().map(message => [message.id, message])
    ),
    ...webRuntimeMessagesLookup,
    ...reduxMessagesLookup,
  };
  for (const messageId of webRuntimeDeletedMessageIds) {
    delete lookup[messageId];
  }
  for (const [messageId, message] of Object.entries(lookup)) {
    if (!isRenderableMessageRecord(message)) {
      delete lookup[messageId];
    }
  }
  return lookup;
}

function getSortedConversationMessageEntries(
  conversationId: string | undefined
): Array<RuntimeMessageEntry> {
  return getConversationMessageEntries(conversationId).sort(
    compareRuntimeMessageEntries
  );
}

function getConversationMessages(
  conversationId: string | undefined
): Array<MessageRecord> {
  return runtimeMessageEntriesToRecords(
    getSortedConversationMessageEntries(conversationId)
  );
}

function getConversationNewestMessageAndCount(
  conversationId: string
): Readonly<{ count: number; newest: MessageRecord | undefined }> {
  const entries = getConversationMessageEntries(conversationId);
  let newest: RuntimeMessageEntry | undefined;
  for (const entry of entries) {
    if (!newest || compareRuntimeMessageEntries(entry, newest) > 0) {
      newest = entry;
    }
  }
  return {
    count: entries.length,
    newest: newest ? runtimeMessageEntryToRecord(newest) : undefined,
  };
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase();
}

function getWebSearchableMessageText(message: MessageRecord): string {
  if (
    message.poll &&
    typeof message.poll === 'object' &&
    'question' in message.poll
  ) {
    const question = message.poll.question;
    return typeof question === 'string' ? question : '';
  }

  return typeof message.body === 'string' ? message.body : '';
}

function getWebSearchTerms(query: string): Array<string> {
  const normalizedQuery = normalizeSearchText(query.trim());
  if (!normalizedQuery) {
    return [];
  }

  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  return terms.length > 0 ? terms : [normalizedQuery];
}

type WebSearchMention = Readonly<{
  mentionAci: string;
  mentionStart: number;
  mentionLength: number;
}>;

type WebSearchMessageResult = MessageRecord & {
  ftsSnippet: string | null;
  mentionAci: string | null;
  mentionStart: number | null;
  mentionLength: number | null;
};

function findBodyRangeMentionForServiceIds(
  message: MessageRecord,
  serviceIds: ReadonlySet<string>
): WebSearchMention | undefined {
  if (!serviceIds.size || !Array.isArray(message.bodyRanges)) {
    return undefined;
  }

  for (const range of message.bodyRanges) {
    const mentionRange = range as {
      mentionAci?: unknown;
      start?: unknown;
      length?: unknown;
    };

    if (
      mentionRange &&
      typeof mentionRange === 'object' &&
      typeof mentionRange.mentionAci === 'string' &&
      serviceIds.has(mentionRange.mentionAci) &&
      typeof mentionRange.start === 'number' &&
      typeof mentionRange.length === 'number'
    ) {
      return {
        mentionAci: mentionRange.mentionAci,
        mentionStart: mentionRange.start,
        mentionLength: mentionRange.length,
      };
    }
  }

  return undefined;
}

function searchWebMessages(options: {
  query?: string;
  conversationId?: string;
  options?: { limit?: number };
  contactServiceIdsMatchingQuery?: ReadonlyArray<string>;
}): Array<WebSearchMessageResult> {
  const query = options.query ?? '';
  const terms = getWebSearchTerms(query);
  if (!terms.length) {
    return [];
  }

  const limit =
    typeof options.options?.limit === 'number' && options.options.limit > 0
      ? options.options.limit
      : options.conversationId
        ? 100
        : 500;
  const mentionServiceIds = new Set(
    options.contactServiceIdsMatchingQuery ?? []
  );

  return Object.values(getMessagesLookup())
    .map(message => {
      if (
        options.conversationId &&
        message.conversationId !== options.conversationId
      ) {
        return undefined;
      }
      if (message.isViewOnce || message.storyId) {
        return undefined;
      }

      const text = getWebSearchableMessageText(message);
      const searchableText = normalizeSearchText(text);
      const matchesBody = terms.every(term => searchableText.includes(term));
      const mention = findBodyRangeMentionForServiceIds(
        message,
        mentionServiceIds
      );
      if (!matchesBody && !mention) {
        return undefined;
      }

      return {
        ...message,
        ftsSnippet: matchesBody ? text : null,
        mentionAci: mention?.mentionAci ?? null,
        mentionStart: mention?.mentionStart ?? null,
        mentionLength: mention?.mentionLength ?? null,
      };
    })
    .filter((message): message is WebSearchMessageResult => message != null)
    .sort((left, right) => {
      const receivedDelta = getTimestamp(right) - getTimestamp(left);
      if (receivedDelta !== 0) {
        return receivedDelta;
      }
      return getMessageSentTimestamp(right) - getMessageSentTimestamp(left);
    })
    .slice(0, limit);
}

async function getWebMicrophonePermission(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return false;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch {
    return false;
  }
}

function getConversationMessagesPage(options: unknown): Array<MessageRecord> {
  if (!options || typeof options !== 'object') {
    return [];
  }
  const { conversationId, limit, receivedAt } = options as {
    conversationId?: string;
    limit?: number;
    receivedAt?: number;
  };
  const pageLimit = typeof limit === 'number' && limit > 0 ? limit : 50;
  const messages = getConversationMessages(conversationId);
  const filtered =
    typeof receivedAt === 'number'
      ? messages.filter(message => getTimestamp(message) < receivedAt)
      : messages;

  return filtered.slice(Math.max(0, filtered.length - pageLimit));
}

function isGalleryMessage(message: MessageRecord): boolean {
  return (
    !message.isViewOnce &&
    (message.type === 'incoming' || message.type === 'outgoing')
  );
}

function getMediaItemMessage(message: MessageRecord) {
  return {
    id: message.id,
    type: message.type,
    conversationId: message.conversationId,
    receivedAt: message.received_at,
    receivedAtMs: message.received_at_ms,
    sentAt: message.sent_at,
    source: message.source,
    sourceServiceId: message.sourceServiceId,
    isErased: Boolean(message.isErased),
    sendStateByConversationId: message.sendStateByConversationId,
    readStatus: message.readStatus,
    errors: message.errors ?? undefined,
  };
}

function compareGalleryMessageTime(
  left: { receivedAt: number; sentAt: number },
  right: { receivedAt: number; sentAt: number }
): number {
  return left.receivedAt - right.receivedAt || left.sentAt - right.sentAt;
}

function isAfterGalleryCursor(
  item: { receivedAt: number; sentAt: number },
  cursor: { receivedAt: number; sentAt: number }
): boolean {
  return (
    item.receivedAt > cursor.receivedAt ||
    (item.receivedAt === cursor.receivedAt && item.sentAt > cursor.sentAt)
  );
}

function isBeforeGalleryCursor(
  item: { receivedAt: number; sentAt: number },
  cursor: { receivedAt: number; sentAt: number }
): boolean {
  return (
    item.receivedAt < cursor.receivedAt ||
    (item.receivedAt === cursor.receivedAt && item.sentAt < cursor.sentAt)
  );
}

function getGalleryCursor(options: {
  receivedAt?: number;
  sentAt?: number;
}): { receivedAt: number; sentAt: number } | undefined {
  if (typeof options.receivedAt !== 'number') {
    return undefined;
  }
  return {
    receivedAt: options.receivedAt,
    sentAt:
      typeof options.sentAt === 'number' ? options.sentAt : Number.MAX_VALUE,
  };
}

function getSortedMediaItems(
  options: GetSortedMediaOptionsType
): Array<MediaItemDBType> {
  const cursor = getGalleryCursor(options);
  const items = getConversationMessages(options.conversationId)
    .filter(isGalleryMessage)
    .flatMap(message => {
      const attachments = Array.isArray(message.attachments)
        ? message.attachments
        : [];
      return attachments.flatMap((attachment, index) => {
        const typedAttachment = attachment as AttachmentType;
        let includeAttachment: boolean;
        if (options.type === 'media') {
          includeAttachment = isVisualMedia(typedAttachment);
        } else if (options.type === 'audio') {
          includeAttachment =
            isVoiceMessage(typedAttachment) || isAudio([typedAttachment]);
        } else if (options.type === 'documents') {
          includeAttachment = isFile(typedAttachment);
        } else {
          includeAttachment = false;
        }
        if (!includeAttachment) {
          return [];
        }
        return [
          {
            type: 'mediaItem' as const,
            attachment: typedAttachment,
            index,
            message: getMediaItemMessage(message),
          },
        ];
      });
    })
    .filter(item => item.message.id !== options.messageId);

  const maxSize = options.size;
  const filtered = items.filter(item => {
    if (options.order === 'newer') {
      return cursor ? isAfterGalleryCursor(item.message, cursor) : true;
    }
    if (options.order === 'older') {
      return cursor ? isBeforeGalleryCursor(item.message, cursor) : true;
    }
    if (options.order === 'bigger') {
      if (typeof maxSize !== 'number') {
        return true;
      }
      if (item.attachment.size < maxSize) {
        return true;
      }
      if (item.attachment.size !== maxSize) {
        return false;
      }
      return cursor ? isBeforeGalleryCursor(item.message, cursor) : true;
    }
    return false;
  });

  const sorted = [...filtered].sort((left, right) => {
    if (options.order === 'newer') {
      return compareGalleryMessageTime(left.message, right.message);
    }
    if (options.order === 'bigger') {
      const sizeDelta = right.attachment.size - left.attachment.size;
      if (sizeDelta !== 0) {
        return sizeDelta;
      }
      return compareGalleryMessageTime(right.message, left.message);
    }
    return compareGalleryMessageTime(right.message, left.message);
  });

  return sorted.slice(0, options.limit);
}

function getSortedNonAttachmentMediaItems(
  options: GetSortedNonAttachmentMediaOptionsType
): Array<NonAttachmentMediaItemDBType> {
  const cursor = getGalleryCursor(options);
  return getConversationMessages(options.conversationId)
    .filter(isGalleryMessage)
    .filter(message => message.id !== options.messageId)
    .filter(message =>
      cursor
        ? isBeforeGalleryCursor(getMediaItemMessage(message), cursor)
        : true
    )
    .sort((left, right) => compareMessages(right, left))
    .flatMap((message): Array<NonAttachmentMediaItemDBType> => {
      if (options.type === 'links') {
        const preview = Array.isArray(message.preview)
          ? message.preview[0]
          : undefined;
        return preview
          ? [
              {
                type: 'link' as const,
                preview,
                message: getMediaItemMessage(message),
              },
            ]
          : [];
      }

      if (options.type === 'contacts') {
        const contact = Array.isArray(message.contact)
          ? message.contact[0]
          : undefined;
        return contact
          ? [
              {
                type: 'contact' as const,
                contact,
                message: getMediaItemMessage(message),
              },
            ]
          : [];
      }

      return [];
    })
    .slice(0, options.limit);
}

function getSortedDocumentItems(
  options: GetSortedDocumentsOptionsType
): Array<MediaItemDBType | ContactMediaItemDBType> {
  const documents = getSortedMediaItems({
    ...options,
    order: 'older',
    type: 'documents',
  });
  const contacts = getSortedNonAttachmentMediaItems({
    ...options,
    type: 'contacts',
  }).filter((item): item is ContactMediaItemDBType => item.type === 'contact');

  return [...documents, ...contacts]
    .sort((left, right) =>
      compareGalleryMessageTime(right.message, left.message)
    )
    .slice(0, options.limit);
}

function hasGalleryMedia(conversationId: string): boolean {
  return getConversationMessages(conversationId)
    .filter(isGalleryMessage)
    .some(message => {
      const attachments = Array.isArray(message.attachments)
        ? message.attachments
        : [];
      const hasAttachment = attachments.some(attachment => {
        const typedAttachment = attachment as AttachmentType;
        return (
          Boolean(typedAttachment.contentType) &&
          typedAttachment.contentType !== 'text/x-signal-plain'
        );
      });
      const hasPreview =
        Array.isArray(message.preview) && message.preview.length > 0;
      const hasContact =
        Array.isArray(message.contact) && message.contact.length > 0;
      return hasAttachment || hasPreview || hasContact;
    });
}

function getMessageMetrics(conversationId: string | undefined) {
  return getMessageMetricsForConversation(conversationId);
}

function getConversationMessageStats(conversationId: string | undefined) {
  const entries = getConversationMessageEntries(conversationId);
  let newest: RuntimeMessageEntry | undefined;
  let hasUserInitiatedMessages = false;
  for (const entry of entries) {
    if (!newest || compareRuntimeMessageEntries(entry, newest) > 0) {
      newest = entry;
    }
    if (hasUserInitiatedMessages) {
      continue;
    }
    const message = runtimeMessageEntryToRecord(entry);
    const maybeStatsMessage = message as MessageRecord & {
      isUserInitiatedMessage?: boolean | number;
    };
    hasUserInitiatedMessages =
      maybeStatsMessage.isUserInitiatedMessage === true ||
      maybeStatsMessage.isUserInitiatedMessage === 1 ||
      message.type === 'outgoing';
  }
  const newestRecord = newest ? runtimeMessageEntryToRecord(newest) : undefined;
  return {
    activity: newestRecord,
    preview: newestRecord,
    hasUserInitiatedMessages,
  };
}

function notifyPinnedMessagesChanged(): void {
  onPinnedMessagesChanged?.(webRuntimePinnedMessages);
}

function appendWebPinnedMessage(
  limit: number,
  params: PinnedMessageParams
): { change: unknown; truncated: ReadonlyArray<PinnedMessageId> } {
  const existing = webRuntimePinnedMessages.find(
    pinnedMessage => pinnedMessage.messageId === params.messageId
  );
  let nextPinnedMessages = webRuntimePinnedMessages;
  let change: unknown = null;

  if (!existing || params.pinnedAt > existing.pinnedAt) {
    nextPinnedMessages = existing
      ? nextPinnedMessages.filter(
          pinnedMessage => pinnedMessage.id !== existing.id
        )
      : nextPinnedMessages;

    const inserted = {
      ...params,
      id: nextWebRuntimePinnedMessageId as PinnedMessageId,
    };
    nextWebRuntimePinnedMessageId += 1;
    nextPinnedMessages = [...nextPinnedMessages, inserted];
    change = {
      inserted,
      replaced: existing?.id ?? null,
    };
  }

  const sortedForConversation = nextPinnedMessages
    .filter(
      pinnedMessage => pinnedMessage.conversationId === params.conversationId
    )
    .sort((left, right) => right.pinnedAt - left.pinnedAt);
  const keptIds = new Set(
    sortedForConversation.slice(0, limit).map(pinnedMessage => pinnedMessage.id)
  );
  const truncated = sortedForConversation
    .slice(limit)
    .map(pinnedMessage => pinnedMessage.id);

  webRuntimePinnedMessages = nextPinnedMessages.filter(
    pinnedMessage =>
      pinnedMessage.conversationId !== params.conversationId ||
      keptIds.has(pinnedMessage.id)
  );
  notifyPinnedMessagesChanged();

  return {
    change,
    truncated,
  };
}

function deleteWebPinnedMessageByMessageId(
  messageId: string
): PinnedMessageId | null {
  const existing = webRuntimePinnedMessages.find(
    pinnedMessage => pinnedMessage.messageId === messageId
  );
  if (!existing) {
    return null;
  }

  webRuntimePinnedMessages = webRuntimePinnedMessages.filter(
    pinnedMessage => pinnedMessage.id !== existing.id
  );
  notifyPinnedMessagesChanged();
  return existing.id;
}

export function getWebPinnedMessagesPreloadDataForConversation(
  conversationId: string
): ReadonlyArray<PinnedMessagePreloadData> {
  const lookup = getMessagesLookup();
  return webRuntimePinnedMessages
    .filter(pinnedMessage => pinnedMessage.conversationId === conversationId)
    .sort((left, right) => left.pinnedAt - right.pinnedAt)
    .map(pinnedMessage => {
      const message = lookup[pinnedMessage.messageId];
      if (!message) {
        return undefined;
      }
      if (!isRenderableMessageRecord(message)) {
        return undefined;
      }
      return {
        pinnedMessage,
        message,
      };
    })
    .filter((item): item is PinnedMessagePreloadData => item != null);
}

function getOurAci(): string | undefined {
  return (
    currentLinkedSession?.credentials?.aci ?? currentLinkedSession?.account.aci
  );
}

function getMessageAuthorAci(message: MessageRecord): string | undefined {
  if (message.type === 'incoming') {
    return typeof message.sourceServiceId === 'string'
      ? message.sourceServiceId
      : undefined;
  }

  return getOurAci();
}

function getMessageSentTimestamp(message: MessageRecord): number {
  return message.editMessageTimestamp ?? message.sent_at ?? message.timestamp;
}

function findPinnedTargetMessage(
  params: ApplyRemotePinnedMessageParams
): MessageRecord | undefined {
  return getConversationMessages(params.conversationId).find(message => {
    return (
      getMessageAuthorAci(message) === params.targetAuthorAci &&
      getMessageSentTimestamp(message) === params.targetSentTimestamp
    );
  });
}

export async function applyRemotePinnedMessage(
  params: ApplyRemotePinnedMessageParams
): Promise<boolean> {
  if (!isAciString(params.senderAci) || !isAciString(params.targetAuthorAci)) {
    return false;
  }

  const targetMessage = findPinnedTargetMessage(params);
  if (!targetMessage) {
    return false;
  }

  const pinnedAt = params.receivedAt;
  const pinDuration =
    params.pinDurationSeconds == null
      ? null
      : DurationInSeconds.fromSeconds(params.pinDurationSeconds);
  const expiresAt = getPinnedMessageExpiresAt(pinnedAt, pinDuration);
  const result = appendWebPinnedMessage(getPinnedMessagesLimit(), {
    conversationId: params.conversationId,
    messageId: targetMessage.id,
    pinnedAt,
    expiresAt,
  });

  if (result.change != null) {
    const targetConversation = window.ConversationController?.get?.(
      params.conversationId
    );
    if (targetConversation) {
      await targetConversation.addPinnedMessageNotification({
        pinMessage: {
          targetAuthorAci: params.targetAuthorAci,
          targetSentTimestamp: params.targetSentTimestamp,
        },
        senderAci: params.senderAci,
        sentAtTimestamp: params.timestamp,
        receivedAtTimestamp: params.receivedAt,
        expireTimer: (targetConversation.get('expireTimer') ??
          null) as DurationInSeconds | null,
        expirationStartTimestamp: params.receivedAt,
      });
    }
  }

  window.reduxActions?.conversations?.onPinnedMessagesChanged?.(
    params.conversationId
  );
  return true;
}

export function applyRemoteUnpinMessage(
  params: ApplyRemoteUnpinMessageParams
): boolean {
  if (!isAciString(params.targetAuthorAci)) {
    return false;
  }

  const targetMessage = findPinnedTargetMessage({
    ...params,
    pinDurationSeconds: null,
    receivedAt: params.receivedAt,
    senderAci: params.targetAuthorAci,
    timestamp: params.timestamp,
  });
  if (!targetMessage) {
    window.reduxActions?.conversations?.onPinnedMessagesChanged?.(
      params.conversationId
    );
    return true;
  }

  const deletedId = deleteWebPinnedMessageByMessageId(targetMessage.id);
  if (deletedId == null) {
    window.reduxActions?.conversations?.onPinnedMessagesChanged?.(
      params.conversationId
    );
    return true;
  }

  window.reduxActions?.conversations?.onPinnedMessagesChanged?.(
    params.conversationId
  );
  return true;
}

function getNewestConversationMessagePage(
  conversationId: string
): Array<MessageRecord> {
  return runtimeMessageEntriesToRecords(
    getNewestConversationMessageEntries(conversationId, MESSAGE_LOAD_CHUNK_SIZE)
  );
}

function getConversationMessagePageAround(
  conversationId: string,
  messageId: string
): Array<MessageRecord> {
  return runtimeMessageEntriesToRecords(
    getConversationMessageEntriesAround(
      conversationId,
      messageId,
      MESSAGE_LOAD_CHUNK_SIZE
    )
  );
}

function getOlderConversationMessagePage(
  conversationId: string,
  oldestMessageId: string
): Array<MessageRecord> {
  return runtimeMessageEntriesToRecords(
    getOlderConversationMessageEntries(
      conversationId,
      oldestMessageId,
      MESSAGE_LOAD_CHUNK_SIZE
    )
  );
}

function getNewerConversationMessagePage(
  conversationId: string,
  newestMessageId: string
): Array<MessageRecord> {
  return runtimeMessageEntriesToRecords(
    getNewerConversationMessageEntries(
      conversationId,
      newestMessageId,
      MESSAGE_LOAD_CHUNK_SIZE
    )
  );
}

function resetConversationMessagePage(
  options: Readonly<{
    conversationId: string;
    messages: ReadonlyArray<MessageRecord>;
    scrollToMessageId?: string;
    shouldHighlight?: boolean;
    unboundedFetch?: boolean;
  }>
): void {
  const { conversationId, messages, scrollToMessageId, shouldHighlight } =
    options;
  window.reduxActions?.conversations?.messagesReset?.({
    conversationId,
    messages,
    metrics: getMessageMetrics(conversationId),
    pinnedMessagesPreloadData:
      getWebPinnedMessagesPreloadDataForConversation(conversationId),
    scrollToMessageId,
    shouldHighlight,
    unboundedFetch: options.unboundedFetch,
  });
}

function waitForTimelineLoadingStateRender(): Promise<void> {
  return new Promise(resolve => {
    window.requestAnimationFrame(() => resolve());
  });
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function toWebForwardAttachment(
  attachment: WebForwardAttachment
): WebAttachment {
  return {
    contentType: attachment.contentType,
    dataBase64:
      attachment.dataBase64 ??
      (attachment.data ? bytesToBase64(attachment.data) : undefined),
    fileName: attachment.fileName,
    flags: attachment.flags,
    height: attachment.height,
    size: attachment.size,
    url: attachment.url,
    width: attachment.width,
  };
}

function createDebouncedUpdateLastMessage(
  updateLastMessage: () => Promise<void>
): DebouncedUpdateLastMessage {
  let timeout: number | undefined;

  const run = () => {
    timeout = undefined;
    void updateLastMessage();
  };

  const debounced = (() => {
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
    }
    timeout = window.setTimeout(run, 200);
  }) as DebouncedUpdateLastMessage;

  debounced.flush = () => {
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
      run();
    }
  };

  return debounced;
}

function removeMessagesFromRuntime(messageIds: ReadonlyArray<string>): void {
  const lookup = getMessagesLookup();
  const deletedMessages = messageIds
    .map(id => lookup[id])
    .filter((message): message is MessageRecord => Boolean(message));

  if (messageIds.length === 0) {
    return;
  }

  webRuntimeMessagesLookup = { ...webRuntimeMessagesLookup };
  for (const messageId of messageIds) {
    webRuntimeDeletedMessageIds.add(messageId);
    delete webRuntimeMessagesLookup[messageId];
  }
  for (const message of deletedMessages) {
    window.reduxActions?.conversations?.messageDeleted?.(
      message.id,
      message.conversationId
    );
  }

  window.dispatchEvent(
    new CustomEvent(WEB_MESSAGES_REMOVED_EVENT, {
      detail: {
        messageIds,
      },
    })
  );
}

export function setWebRuntimeChatShell(shell: ChatShellState): void {
  const linkedSession = currentLinkedSession;
  if (linkedSession) {
    if (
      webRuntimeConversationLookupSource !== shell.conversationLookup ||
      webRuntimeConversationLookupLinkedSession !== linkedSession
    ) {
      webRuntimeConversationLookupSource = shell.conversationLookup;
      webRuntimeConversationLookupLinkedSession = linkedSession;
      webRuntimeConversationLookup = Object.fromEntries(
        Object.values(shell.conversationLookup).map(conversation => [
          conversation.id,
          toDesktopConversation(
            conversation,
            linkedSession
          ) as ConversationRecord,
        ])
      );
    }
    (
      window as unknown as {
        SignalWebBootstrapConversationLookup?: Record<
          string,
          ConversationRecord
        >;
      }
    ).SignalWebBootstrapConversationLookup = webRuntimeConversationLookup;
  }

  if (webRuntimeMessagesSource !== shell.messages) {
    webRuntimeMessagesSource = shell.messages;
    const byId = new Map<string, WebMessage>();
    const byConversation = new Map<string, Array<WebMessage>>();
    for (const message of shell.messages) {
      if (webRuntimeDeletedMessageIds.has(message.id)) {
        continue;
      }
      byId.set(message.id, message);
      const messages = byConversation.get(message.conversationId);
      if (messages) {
        messages.push(message);
      } else {
        byConversation.set(message.conversationId, [message]);
      }
    }
    webRuntimeShellMessagesById = byId;
    webRuntimeShellMessagesByConversation = byConversation;
  }
  webRuntimePinnedMessages = shell.pinnedMessages ?? [];
  nextWebRuntimePinnedMessageId =
    Math.max(
      0,
      ...webRuntimePinnedMessages.map(pinnedMessage => Number(pinnedMessage.id))
    ) + 1;
}

export function setWebRuntimePinnedMessagesChanged(
  callback: PinnedMessagesChanged | undefined
): void {
  onPinnedMessagesChanged = callback;
}

function createWebEventEmitter(): {
  emit: (name: string, ...args: ReadonlyArray<unknown>) => void;
  off: (name: string, callback: WebEventCallback) => void;
  on: (name: string, callback: WebEventCallback) => void;
  once: (name: string, callback: WebEventCallback) => void;
} {
  const listeners = new Map<string, Set<WebEventCallback>>();

  return {
    emit(name, ...args) {
      for (const callback of listeners.get(name) ?? []) {
        callback(...args);
      }
    },
    off(name, callback) {
      listeners.get(name)?.delete(callback);
    },
    on(name, callback) {
      const callbacks = listeners.get(name) ?? new Set<WebEventCallback>();
      callbacks.add(callback);
      listeners.set(name, callbacks);
    },
    once(name, callback) {
      const wrapper: WebEventCallback = (...args) => {
        listeners.get(name)?.delete(wrapper);
        callback(...args);
      };
      const callbacks = listeners.get(name) ?? new Set<WebEventCallback>();
      callbacks.add(wrapper);
      listeners.set(name, callbacks);
    },
  };
}

class WebConversationModel {
  public attributes: ConversationRecord;

  public debouncedUpdateLastMessage: DebouncedUpdateLastMessage;

  public id: string;

  public constructor(attributes: ConversationRecord) {
    const derivedContactIdentityAttributes =
      getDerivedContactIdentityAttributes(attributes);
    const attributesWithIdentity = {
      ...attributes,
      ...derivedContactIdentityAttributes,
    };
    this.attributes = {
      ...attributesWithIdentity,
      ...getDerivedGroupPermissionAttributes(attributesWithIdentity),
      ...getDerivedTitleAttributes(attributesWithIdentity),
    };
    this.id = attributes.id;
    this.debouncedUpdateLastMessage = createDebouncedUpdateLastMessage(
      this.updateLastMessage.bind(this)
    );
  }

  public get(key: string): unknown {
    return this.attributes[key];
  }

  public set(key: string | Record<string, unknown>, value?: unknown): void {
    const changes = typeof key === 'string' ? { [key]: value } : key;
    const nextAttributes = { ...this.attributes, ...changes };
    const derivedContactIdentityAttributes =
      getDerivedContactIdentityAttributes(nextAttributes);
    const nextAttributesWithIdentity = {
      ...nextAttributes,
      ...derivedContactIdentityAttributes,
    };
    const derivedGroupPermissionAttributes =
      getDerivedGroupPermissionAttributes(nextAttributesWithIdentity);
    const derivedTitleAttributes = getDerivedTitleAttributes({
      ...nextAttributesWithIdentity,
      ...derivedGroupPermissionAttributes,
    });
    const nextChanges = {
      ...changes,
      ...(derivedContactIdentityAttributes ?? {}),
      ...(derivedGroupPermissionAttributes ?? {}),
      ...derivedTitleAttributes,
    };
    this.attributes = {
      ...nextAttributesWithIdentity,
      ...derivedGroupPermissionAttributes,
      ...derivedTitleAttributes,
    };
    onConversationAttributesChanged?.(this.id, nextChanges);
    if (currentLinkedSession) {
      window.reduxActions?.conversations?.conversationsUpdated?.([
        toDesktopConversation(
          this.attributes as WebConversation,
          currentLinkedSession
        ) as never,
      ]);
    }
  }

  public format(): ConversationRecord {
    return this.attributes;
  }

  public isEverUnregistered(): boolean {
    return isConversationEverUnregistered(
      this.attributes as ConversationAttributesType
    );
  }

  public isUnregistered(): boolean {
    return isConversationUnregistered(
      this.attributes as ConversationAttributesType
    );
  }

  public isUnregisteredAndStale(): boolean {
    return isConversationUnregisteredAndStale(
      this.attributes as ConversationAttributesType
    );
  }

  public isBlocked(): boolean {
    return isBlocked(this.attributes as ConversationAttributesType);
  }

  public onOpenStart(): void {}

  public captureChange(): void {}

  public async preloadNewestMessages(): Promise<void> {
    const messages = getNewestConversationMessagePage(this.id);
    window.reduxActions?.conversations?.addPreloadData?.({
      conversationId: this.id,
      messages,
      metrics: getMessageMetrics(this.id),
      pinnedMessagesPreloadData: getWebPinnedMessagesPreloadDataForConversation(
        this.id
      ),
      unboundedFetch: true,
    });
  }

  public async loadNewestMessages(
    newestMessageId?: string,
    setFocus?: boolean
  ): Promise<void> {
    const messages = newestMessageId
      ? getConversationMessagePageAround(this.id, newestMessageId)
      : getNewestConversationMessagePage(this.id);
    resetConversationMessagePage({
      conversationId: this.id,
      messages,
      scrollToMessageId: setFocus ? messages.at(-1)?.id : undefined,
      unboundedFetch: !newestMessageId,
    });
  }

  public async loadOlderMessages(oldestMessageId: string): Promise<void> {
    window.reduxActions?.conversations?.setMessageLoadingState?.(
      this.id,
      TimelineMessageLoadingState.LoadingOlderMessages
    );
    await waitForTimelineLoadingStateRender();

    const messages = getOlderConversationMessagePage(this.id, oldestMessageId);
    if (messages.length === 0) {
      window.reduxActions?.conversations?.repairOldestMessage?.(this.id);
      window.reduxActions?.conversations?.setMessageLoadingState?.(
        this.id,
        undefined
      );
      return;
    }

    window.reduxActions?.conversations?.messagesAdded?.({
      conversationId: this.id,
      isActive: document.visibilityState === 'visible',
      isJustSent: false,
      isNewMessage: false,
      messages,
    });
  }

  public async loadNewerMessages(newestMessageId: string): Promise<void> {
    window.reduxActions?.conversations?.setMessageLoadingState?.(
      this.id,
      TimelineMessageLoadingState.LoadingNewerMessages
    );
    await waitForTimelineLoadingStateRender();

    const messages = getNewerConversationMessagePage(this.id, newestMessageId);
    if (messages.length === 0) {
      window.reduxActions?.conversations?.repairNewestMessage?.(this.id);
      window.reduxActions?.conversations?.setMessageLoadingState?.(
        this.id,
        undefined
      );
      return;
    }

    window.reduxActions?.conversations?.messagesAdded?.({
      conversationId: this.id,
      isActive: document.visibilityState === 'visible',
      isJustSent: false,
      isNewMessage: false,
      messages,
    });
  }

  public async fetchLatestGroupV2Data(): Promise<void> {}

  public async updateLastMessage(): Promise<void> {
    const { count, newest } = getConversationNewestMessageAndCount(this.id);
    if (!newest) {
      this.set({
        hasMessages: false,
        lastMessage: undefined,
        lastMessageReceivedAt: undefined,
        lastMessageReceivedAtMs: undefined,
        messageCount: 0,
        snippet: undefined,
      });
      return;
    }

    const receivedAt = newest.received_at_ms ?? newest.received_at;
    const notificationData =
      newest.deletedForEveryone || newest.isErased
        ? undefined
        : getNotificationDataForMessage(newest);
    const lastMessageAuthor =
      newest.type === 'outgoing'
        ? window.SignalContext.i18n('icu:you')
        : newest.type === 'incoming'
          ? (window.ConversationController.get(
              newest.sourceServiceId
            )?.getTitle() ?? null)
          : null;
    const lastMessage =
      newest.deletedForEveryone || newest.isErased
        ? { deletedForEveryone: true }
        : {
            author: lastMessageAuthor,
            bodyRanges: notificationData?.bodyRanges,
            deletedForEveryone: false,
            prefix: notificationData?.emoji,
            status: getMessagePropStatus(
              newest,
              currentLinkedSession?.credentials?.aci ??
                currentLinkedSession?.account.aci
            ),
            text: notificationData?.text ?? '',
          };
    const text = lastMessage.deletedForEveryone ? '' : lastMessage.text;

    this.set({
      activeAt: receivedAt,
      hasMessages: true,
      inboxPosition: receivedAt,
      lastMessage,
      lastMessageReceivedAt: newest.sent_at,
      lastMessageReceivedAtMs: receivedAt,
      lastUpdated: receivedAt,
      messageCount: count,
      snippet: text || this.attributes.snippet,
      timestamp: newest.sent_at,
    });
  }

  public async throttledUpdateUnread(): Promise<void> {
    this.set({
      markedUnread: false,
      unreadCount: 0,
    });
  }

  public async throttledMaybeMigrateV1Group(): Promise<void> {}

  public async throttledFetchSMSOnlyUUID(): Promise<void> {}

  public async throttledGetProfiles(): Promise<void> {
    await this.getProfiles();
  }

  public async getProfiles(): Promise<void> {}

  private async addLocalGroupV2Change(
    details: ReadonlyArray<GroupV2ChangeDetailType>,
    attributes: Record<string, unknown> = {}
  ): Promise<void> {
    if (!this.isGroup()) {
      return;
    }

    const ourAci = getOurAci();
    if (!ourAci || !isAciString(ourAci)) {
      throw new Error('addLocalGroupV2Change: missing our ACI');
    }

    const timestamp = Date.now();
    const webMessage: WebMessage = {
      id: `web-group-v2-change:${this.id}:${timestamp}`,
      conversationId: this.id,
      desktopType: 'group-v2-change',
      direction: 'incoming',
      groupV2Change: {
        from: ourAci,
        details,
      },
      readStatus: ReadStatus.Read,
      receivedAt: timestamp,
      sourceServiceId: ourAci,
      timestamp,
    };
    const message = toDesktopMessage(webMessage) as MessageRecord;

    webRuntimeMessagesLookup = {
      ...webRuntimeMessagesLookup,
      [message.id]: message,
    };

    this.set({
      activeAt: timestamp,
      hasMessages: true,
      inboxPosition: timestamp,
      lastMessageReceivedAt: timestamp,
      lastMessageReceivedAtMs: timestamp,
      lastUpdated: timestamp,
      messageCount: getConversationMessages(this.id).length,
      timestamp,
      ...attributes,
    });
    await this.updateLastMessage();

    window.reduxActions?.conversations?.messagesAdded?.({
      conversationId: this.id,
      isActive: document.visibilityState === 'visible',
      isJustSent: true,
      isNewMessage: true,
      messages: [message],
    });
    window.dispatchEvent(
      new CustomEvent(WEB_MESSAGES_ADDED_EVENT, {
        detail: {
          messages: [webMessage],
        },
      })
    );
  }

  public async leaveGroupV2(): Promise<void> {
    if (!currentMessageRuntimeSessionId) {
      throw new Error('leaveGroupV2: missing message runtime session');
    }

    const ourAci = getOurAci();
    if (!ourAci || !isAciString(ourAci)) {
      throw new Error('leaveGroupV2: missing our ACI');
    }

    const membersV2 = Array.isArray(this.attributes.membersV2)
      ? this.attributes.membersV2
      : [];
    const result = await modifyGroupMember({
      action: 'remove',
      conversation: this.attributes as WebConversation,
      recipients: membersV2
        .map(member => {
          return member &&
            typeof member === 'object' &&
            'aci' in member &&
            typeof member.aci === 'string'
            ? member.aci
            : undefined;
        })
        .filter((member): member is string => Boolean(member)),
      runtimeSessionId: currentMessageRuntimeSessionId,
      targetServiceId: ourAci,
    });
    const nextMembersV2 = membersV2.filter(member => {
      return !(
        member &&
        typeof member === 'object' &&
        'aci' in member &&
        member.aci === ourAci
      );
    });

    await this.addLocalGroupV2Change(
      [
        {
          type: 'member-remove',
          aci: ourAci,
        },
      ],
      {
        left: true,
        membersV2: nextMembersV2,
        revision: result.revision,
      }
    );
    window.reduxActions?.toast?.showToast?.({ toastType: ToastType.LeftGroup });
  }

  public getCheckedServiceId(logId: string): AciString {
    const serviceId = this.getServiceId();
    if (typeof serviceId === 'string' && isAciString(serviceId)) {
      return serviceId;
    }
    if (isAciString(this.id)) {
      return this.id;
    }
    throw new Error(`${logId}: missing serviceId`);
  }

  public async toggleAdmin(conversationId: string): Promise<void> {
    if (!currentMessageRuntimeSessionId) {
      throw new Error('toggleAdmin: missing message runtime session');
    }
    const contact = window.ConversationController.get(conversationId);
    const serviceId =
      contact?.getAci?.() ??
      (isAciString(conversationId) ? conversationId : undefined);
    if (!serviceId) {
      throw new Error('toggleAdmin: missing member ACI');
    }

    const membersV2 = Array.isArray(this.attributes.membersV2)
      ? this.attributes.membersV2
      : [];
    const currentMember = membersV2.find(member => {
      return (
        member &&
        typeof member === 'object' &&
        'aci' in member &&
        member.aci === serviceId
      );
    }) as { aci: AciString; role?: number } | undefined;
    const currentRole = currentMember?.role;
    const adminRole = Proto.Member.Role.ADMINISTRATOR;
    const nextRole =
      currentRole === adminRole ? Proto.Member.Role.DEFAULT : adminRole;
    const result = await modifyGroupMember({
      action: nextRole === adminRole ? 'make-admin' : 'make-member',
      conversation: this.attributes as WebConversation,
      recipients: membersV2
        .map(member => {
          return member &&
            typeof member === 'object' &&
            'aci' in member &&
            typeof member.aci === 'string'
            ? member.aci
            : undefined;
        })
        .filter((member): member is string => Boolean(member)),
      runtimeSessionId: currentMessageRuntimeSessionId,
      targetServiceId: serviceId,
    });
    const nextMembersV2 = membersV2.map(member => {
      if (
        member &&
        typeof member === 'object' &&
        'aci' in member &&
        member.aci === serviceId
      ) {
        return {
          ...member,
          role: nextRole,
        };
      }
      return member;
    });

    await this.addLocalGroupV2Change(
      [
        {
          type: 'member-privilege',
          aci: serviceId,
          newPrivilege: nextRole,
        },
      ],
      { membersV2: nextMembersV2, revision: result.revision }
    );
  }

  public async removeFromGroupV2(conversationId: string): Promise<void> {
    if (!currentMessageRuntimeSessionId) {
      throw new Error('removeFromGroupV2: missing message runtime session');
    }
    const contact = window.ConversationController.get(conversationId);
    const serviceId =
      contact?.getAci?.() ??
      (isAciString(conversationId) ? conversationId : undefined);
    if (!serviceId) {
      throw new Error('removeFromGroupV2: missing member ACI');
    }

    const membersV2 = Array.isArray(this.attributes.membersV2)
      ? this.attributes.membersV2
      : [];
    const result = await modifyGroupMember({
      action: 'remove',
      conversation: this.attributes as WebConversation,
      recipients: membersV2
        .map(member => {
          return member &&
            typeof member === 'object' &&
            'aci' in member &&
            typeof member.aci === 'string'
            ? member.aci
            : undefined;
        })
        .filter((member): member is string => Boolean(member)),
      runtimeSessionId: currentMessageRuntimeSessionId,
      targetServiceId: serviceId,
    });
    const nextMembersV2 = membersV2.filter(member => {
      return !(
        member &&
        typeof member === 'object' &&
        'aci' in member &&
        member.aci === serviceId
      );
    });
    const bannedMembersV2 = Array.isArray(this.attributes.bannedMembersV2)
      ? this.attributes.bannedMembersV2
      : [];
    const shouldAddBannedMember =
      serviceId !== currentLinkedSession?.account.aci &&
      !bannedMembersV2.some(member => {
        return member.serviceId === serviceId;
      });
    const nextBannedMembersV2 = shouldAddBannedMember
      ? [
          ...bannedMembersV2,
          {
            serviceId,
            timestamp: Date.now(),
          },
        ]
      : bannedMembersV2;

    await this.addLocalGroupV2Change(
      [
        {
          type: 'member-remove',
          aci: serviceId,
        },
      ],
      {
        bannedMembersV2: nextBannedMembersV2,
        membersV2: nextMembersV2,
        revision: result.revision,
      }
    );
  }

  private getGroupRecipientServiceIds(): Array<string> {
    const membersV2 = Array.isArray(this.attributes.membersV2)
      ? this.attributes.membersV2
      : [];
    return membersV2
      .map(member => {
        return member &&
          typeof member === 'object' &&
          'aci' in member &&
          typeof member.aci === 'string'
          ? member.aci
          : undefined;
      })
      .filter((member): member is string => Boolean(member));
  }

  private async modifyWebGroupSettings({
    action,
    detail,
    localAttributes,
    value,
  }: Readonly<{
    action:
      | 'access-control-add-from-invite-link'
      | 'access-control-attributes'
      | 'access-control-members'
      | 'access-control-member-label'
      | 'announcements-only'
      | 'description'
      | 'title';
    detail: GroupV2ChangeDetailType;
    localAttributes: Record<string, unknown>;
    value: boolean | number | string;
  }>): Promise<void> {
    if (!currentMessageRuntimeSessionId) {
      throw new Error(
        'modifyWebGroupSettings: missing message runtime session'
      );
    }
    const result = await modifyGroupSettings({
      action,
      conversation: this.attributes as WebConversation,
      recipients: this.getGroupRecipientServiceIds(),
      runtimeSessionId: currentMessageRuntimeSessionId,
      value,
    });

    await this.addLocalGroupV2Change([detail], {
      ...localAttributes,
      revision: result.revision,
    });
  }

  public async updateAccessControlMembers(value: number): Promise<void> {
    const accessControl = getGroupAccessControlForRecord(this.attributes);
    await this.modifyWebGroupSettings({
      action: 'access-control-members',
      detail: {
        type: 'access-members',
        newPrivilege: value,
      },
      localAttributes: {
        accessControl: {
          ...accessControl,
          members: value,
        },
      },
      value,
    });
  }

  public async updateAccessControlAttributes(value: number): Promise<void> {
    const accessControl = getGroupAccessControlForRecord(this.attributes);
    await this.modifyWebGroupSettings({
      action: 'access-control-attributes',
      detail: {
        type: 'access-attributes',
        newPrivilege: value,
      },
      localAttributes: {
        accessControl: {
          ...accessControl,
          attributes: value,
        },
      },
      value,
    });
  }

  public async updateAccessControlMemberLabel(value: number): Promise<void> {
    const accessControl = getGroupAccessControlForRecord(this.attributes);
    const membersV2 = Array.isArray(this.attributes.membersV2)
      ? this.attributes.membersV2
      : [];
    const nextMembersV2 =
      value === Proto.AccessControl.AccessRequired.ADMINISTRATOR
        ? membersV2.map(member => {
            if (member.role === Proto.Member.Role.ADMINISTRATOR) {
              return member;
            }
            return {
              ...member,
              labelEmoji: undefined,
              labelString: undefined,
            };
          })
        : membersV2;

    await this.modifyWebGroupSettings({
      action: 'access-control-member-label',
      detail: {
        type: 'access-member-label',
        newPrivilege: value,
      },
      localAttributes: {
        accessControl: {
          ...accessControl,
          memberLabel: value,
        },
        membersV2: nextMembersV2,
      },
      value,
    });
  }

  public async updateAccessControlAddFromInviteLink(
    value: boolean
  ): Promise<void> {
    const accessControl = getGroupAccessControlForRecord(this.attributes);
    const nextValue = value
      ? Proto.AccessControl.AccessRequired.MEMBER
      : Proto.AccessControl.AccessRequired.UNSATISFIABLE;
    await this.modifyWebGroupSettings({
      action: 'access-control-add-from-invite-link',
      detail: {
        type: 'access-invite-link',
        newPrivilege: nextValue,
      },
      localAttributes: {
        accessControl: {
          ...accessControl,
          addFromInviteLink: nextValue,
        },
      },
      value: nextValue,
    });
  }

  public async updateAnnouncementsOnly(value: boolean): Promise<void> {
    await this.modifyWebGroupSettings({
      action: 'announcements-only',
      detail: {
        type: 'announcements-only',
        announcementsOnly: value,
      },
      localAttributes: {
        announcementsOnly: value,
      },
      value,
    });
  }

  public async updateGroupAttributes(
    attributes: Readonly<{
      description?: string;
      title?: string;
    }>
  ): Promise<void> {
    if (typeof attributes.title === 'string') {
      await this.modifyWebGroupSettings({
        action: 'title',
        detail: {
          type: 'title',
          newTitle: attributes.title.trim() || undefined,
        },
        localAttributes: {
          name: attributes.title,
          searchableTitle: attributes.title,
          title: attributes.title,
          titleNoDefault: attributes.title,
        },
        value: attributes.title,
      });
    }

    if (typeof attributes.description === 'string') {
      await this.modifyWebGroupSettings({
        action: 'description',
        detail: {
          type: 'description',
          removed: !attributes.description.trim(),
          description: attributes.description.trim() || undefined,
        },
        localAttributes: {
          description: attributes.description,
          groupDescription: attributes.description,
        },
        value: attributes.description,
      });
    }
  }

  public async addMembersToGroup(
    contactIds: ReadonlyArray<string>
  ): Promise<void> {
    if (!currentMessageRuntimeSessionId) {
      throw new Error('addMembersToGroup: missing message runtime session');
    }

    for (const contactId of contactIds) {
      const contact = window.ConversationController.get(contactId);
      const serviceId =
        contact?.getAci?.() ?? (isAciString(contactId) ? contactId : undefined);
      if (!serviceId || !contact) {
        throw new Error('addMembersToGroup: missing member ACI');
      }

      const membersV2 = Array.isArray(this.attributes.membersV2)
        ? this.attributes.membersV2
        : [];
      if (
        membersV2.some(member => {
          return (
            member &&
            typeof member === 'object' &&
            'aci' in member &&
            member.aci === serviceId
          );
        })
      ) {
        continue;
      }

      const recipients = [
        ...membersV2
          .map(member => {
            return member &&
              typeof member === 'object' &&
              'aci' in member &&
              typeof member.aci === 'string'
              ? member.aci
              : undefined;
          })
          .filter((member): member is string => Boolean(member)),
        serviceId,
      ];
      const result = await modifyGroupMember({
        action: 'add',
        conversation: this.attributes as WebConversation,
        recipients,
        runtimeSessionId: currentMessageRuntimeSessionId,
        targetConversation: contact.attributes as WebConversation,
        targetServiceId: serviceId,
      });
      const nextMembersV2 = [
        ...membersV2,
        {
          aci: serviceId,
          joinedAtVersion: result.revision,
          role: Proto.Member.Role.DEFAULT,
        },
      ];
      const bannedMembersV2 = Array.isArray(this.attributes.bannedMembersV2)
        ? this.attributes.bannedMembersV2
        : [];
      const nextBannedMembersV2 = bannedMembersV2.filter(member => {
        return member.serviceId !== serviceId;
      });

      await this.addLocalGroupV2Change(
        [
          {
            type: 'member-add',
            aci: serviceId,
          },
        ],
        {
          bannedMembersV2: nextBannedMembersV2,
          membersV2: nextMembersV2,
          revision: result.revision,
        }
      );
    }
  }

  public hasProfileKeyCredentialExpired(): boolean {
    return false;
  }

  public async updateVerified(): Promise<void> {}

  public async loadAndScroll(
    messageId?: string,
    options: {
      disableScroll?: boolean;
      shouldHighlight?: boolean;
    } = {}
  ): Promise<void> {
    const messages = messageId
      ? getConversationMessagePageAround(this.id, messageId)
      : getNewestConversationMessagePage(this.id);
    resetConversationMessagePage({
      conversationId: this.id,
      messages,
      scrollToMessageId: options.disableScroll ? undefined : messageId,
      shouldHighlight: options.shouldHighlight,
      unboundedFetch: !messageId,
    });
  }

  public async markRead(): Promise<void> {
    const messages = getConversationMessages(this.id);
    const unreadMessages = messages.filter(
        message =>
            message.type === 'incoming' && message.readStatus === ReadStatus.Unread
    );

    const unreadCount = this.get('unreadCount');
    const markedUnread = this.get('markedUnread');

    if (
        unreadMessages.length === 0 &&
        unreadCount === 0 &&
        markedUnread !== true
    ) {
      return;
    }

    if (unreadCount !== 0 || markedUnread === true) {
      this.set({
        markedUnread: false,
        unreadCount: 0,
      });
    }

    if (unreadMessages.length > 0) {
      webRuntimeMessagesLookup = {
        ...webRuntimeMessagesLookup,
        ...Object.fromEntries(
            unreadMessages.map(message => [
              message.id,
              { ...message, readStatus: ReadStatus.Read },
            ])
        ),
      };

      window.reduxActions?.conversations?.markOpenConversationRead?.(this.id);
    }
  }

  public async maybeUpdateDraftPreview(): Promise<void> {}

  public deriveAccessKeyIfNeeded(): void {
    const profileKey = this.get('profileKey');
    if (typeof profileKey !== 'string' || this.get('accessKey')) {
      return;
    }

    this.set({
      accessKey: Bytes.toBase64(
        deriveAccessKeyFromProfileKey(Bytes.fromBase64(profileKey))
      ),
    });
  }

  public async updateUsername(username: string | undefined): Promise<void> {
    this.set({ username });
  }

  public async addPinnedMessageNotification(
    params: AddPinnedMessageNotificationParams
  ): Promise<void> {
    const ourAci =
      currentLinkedSession?.credentials?.aci ??
      currentLinkedSession?.account.aci;
    const senderIsMe = params.senderAci === ourAci;
    const message: MessageRecord = {
      id: `web-pinned-notification:${this.id}:${params.sentAtTimestamp}:${params.pinMessage.targetSentTimestamp}`,
      conversationId: this.id,
      type: 'pinned-message-notification',
      sent_at: params.sentAtTimestamp,
      received_at: params.receivedAtTimestamp,
      received_at_ms: params.receivedAtTimestamp,
      timestamp: params.sentAtTimestamp,
      readStatus: senderIsMe ? ReadStatus.Read : ReadStatus.Unread,
      seenStatus: senderIsMe ? SeenStatus.Seen : SeenStatus.Unseen,
      sourceServiceId: params.senderAci,
      expireTimer: (params.expireTimer ?? undefined) as never,
      expirationStartTimestamp: params.expirationStartTimestamp,
      pinMessage: params.pinMessage,
    };

    webRuntimeMessagesLookup = {
      ...webRuntimeMessagesLookup,
      [message.id]: message,
    };

    window.reduxActions?.conversations?.messagesAdded?.({
      conversationId: this.id,
      isActive: document.visibilityState === 'visible',
      isJustSent: senderIsMe,
      isNewMessage: true,
      messages: [message],
    });
  }

  public idForLogging(): string {
    return this.id;
  }

  public getTitle(): string {
    return String(getDerivedTitleAttributes(this.attributes).title ?? this.id);
  }

  public setMarkedUnread(markedUnread: boolean): void {
    if (Boolean(this.attributes.markedUnread) === markedUnread) {
      return;
    }

    this.set({ markedUnread });
    void updateConversationMarkedUnread({
      conversationId: this.id,
      markedUnread,
    }).catch(error => {
      console.error(
        'setMarkedUnread: failed to sync marked unread state to storage service',
        error
      );
    });
  }

  public setArchived(isArchived: boolean): void {
    const previous = Boolean(this.attributes.isArchived);
    this.set({ isArchived });
    if (isArchived) {
      this.unpin();
    }
    if (previous !== Boolean(isArchived)) {
      void updateConversationArchive({
        conversationId: this.id,
        isArchived,
      }).catch(error => {
        console.error(
          'setArchived: failed to sync archive state to storage service',
          error
        );
      });
    }
  }

  public setMuteExpiration(muteExpiresAt: number): void {
    const previous = this.attributes.muteExpiresAt;
    this.set('muteExpiresAt', muteExpiresAt || undefined);
    if ((previous ?? 0) !== (muteExpiresAt || 0)) {
      void updateConversationMute({
        conversationId: this.id,
        muteExpiresAt,
      }).catch(error => {
        console.error(
          'setMuteExpiration: failed to sync mute state to storage service',
          error
        );
      });
    }
  }

  public pin(): void {
    if (this.attributes.isPinned) {
      return;
    }

    const pinnedConversationIds = new Set(
      itemStorage.get('pinnedConversationIds', new Array<string>())
    );
    pinnedConversationIds.add(this.id);
    this.writePinnedConversations([...pinnedConversationIds]);

    this.set({ isPinned: true });
    if (this.attributes.isArchived) {
      this.set({ isArchived: false });
    }
    void updateConversationPin({
      conversationId: this.id,
      isPinned: true,
    }).catch(error => {
      console.error(
        'pin: failed to sync pinned state to storage service',
        error
      );
    });
  }

  public unpin(): void {
    if (!this.attributes.isPinned) {
      return;
    }

    const pinnedConversationIds = new Set(
      itemStorage.get('pinnedConversationIds', new Array<string>())
    );
    pinnedConversationIds.delete(this.id);
    this.writePinnedConversations([...pinnedConversationIds]);

    this.set('isPinned', false);
    void updateConversationPin({
      conversationId: this.id,
      isPinned: false,
    }).catch(error => {
      console.error(
        'unpin: failed to sync pinned state to storage service',
        error
      );
    });
  }

  public writePinnedConversations(pinnedConversationIds: Array<string>): void {
    void itemStorage.put('pinnedConversationIds', pinnedConversationIds);
  }

  public async removeContact(): Promise<void> {
    this.set({
      acceptedMessageRequest: false,
      isArchived: true,
      isPinned: false,
      removalStage: 'justNotification',
    });
  }

  public async destroyMessages(): Promise<void> {
    const messageIds = getConversationMessages(this.id).map(
      message => message.id
    );
    removeMessagesFromRuntime(messageIds);
    this.set({
      activeAt: undefined,
      hasMessages: false,
      inboxPosition: undefined,
      lastMessage: undefined,
      lastMessageReceivedAt: undefined,
      lastMessageReceivedAtMs: undefined,
      lastUpdated: undefined,
      messageCount: 0,
      messagesDeleted: true,
      snippet: undefined,
      timestamp: undefined,
    });
  }

  public getUnverified(): ReadonlyArray<unknown> {
    return [];
  }

  public getUntrusted(): ReadonlyArray<unknown> {
    return [];
  }

  public safeGetVerified(): number {
    return 1;
  }

  public isMe(): boolean {
    return Boolean(this.attributes.isMe);
  }

  public isGroup(): boolean {
    return this.attributes.type === 'group';
  }

  public hasMember(): boolean {
    return false;
  }

  public areWeAdmin(): boolean {
    return Boolean(this.attributes.areWeAdmin);
  }

  public getServiceId(): unknown {
    return this.attributes.serviceId;
  }

  public getAci(): AciString | undefined {
    const serviceId = this.getServiceId();
    return typeof serviceId === 'string' && isAciString(serviceId)
      ? serviceId
      : undefined;
  }

  public getPni(): unknown {
    return this.attributes.pni;
  }

  public getCheckedAci(reason: string): AciString {
    const aci = this.getAci();
    if (!aci) {
      throw new Error(reason);
    }
    return aci;
  }

  public getGroupIdBuffer(): undefined {
    return undefined;
  }

  public getGroupV2Info(
    options: Readonly<{
      includePendingMembers?: boolean;
      members?: ReadonlyArray<string>;
      groupChange?: Uint8Array<ArrayBuffer>;
    }> = {}
  ): unknown {
    if (!this.isGroup()) {
      return undefined;
    }

    const masterKey = this.get('masterKey');
    const revision = this.get('revision');
    if (typeof masterKey !== 'string' || typeof revision !== 'number') {
      return undefined;
    }

    const explicitMembers = Array.isArray(options.members)
      ? options.members
      : undefined;
    const membersV2 = Array.isArray(this.attributes.membersV2)
      ? this.attributes.membersV2
      : [];
    const pendingMembersV2 = Array.isArray(this.attributes.pendingMembersV2)
      ? this.attributes.pendingMembersV2
      : [];
    const members = explicitMembers ?? [
      ...membersV2
        .map(member =>
          member && typeof member === 'object'
            ? (member as { aci?: unknown }).aci
            : undefined
        )
        .filter((aci): aci is string => typeof aci === 'string'),
      ...(options.includePendingMembers
        ? pendingMembersV2
            .map(member =>
              member && typeof member === 'object'
                ? (member as { serviceId?: unknown }).serviceId
                : undefined
            )
            .filter(
              (serviceId): serviceId is string => typeof serviceId === 'string'
            )
        : []),
    ];

    return {
      groupChange: options.groupChange,
      masterKey: Bytes.fromBase64(masterKey),
      members,
      revision,
    };
  }

  public async onNewMessage(messageOrModel: unknown): Promise<void> {
    const message =
      messageOrModel &&
      typeof messageOrModel === 'object' &&
      'attributes' in messageOrModel
        ? (messageOrModel as { attributes: MessageRecord }).attributes
        : (messageOrModel as MessageRecord);
    if (!message?.id) {
      return;
    }
    webRuntimeMessagesLookup = {
      ...webRuntimeMessagesLookup,
      [message.id]: message,
    };
    window.reduxActions?.conversations?.messagesAdded?.({
      conversationId: this.id,
      isActive: document.visibilityState === 'visible',
      isJustSent: message.type === 'outgoing',
      isNewMessage: true,
      messages: [message],
    });
  }

  public async updateExpirationTimer(
    providedExpireTimer: unknown
  ): Promise<void> {
    const expireTimer =
      typeof providedExpireTimer === 'number' && providedExpireTimer > 0
        ? (providedExpireTimer as DurationInSeconds)
        : undefined;
    const currentExpireTimer =
      typeof this.attributes.expireTimer === 'number'
        ? this.attributes.expireTimer
        : undefined;
    const timerMatchesLocalValue =
      currentExpireTimer === expireTimer ||
      (!currentExpireTimer && !expireTimer);

    if (timerMatchesLocalValue) {
      return;
    }

    if (this.isGroup()) {
      this.set({ expireTimer });
      await this.maybeRemoveUniversalTimer();
      return;
    }

    const destinationServiceId =
      typeof this.attributes.serviceId === 'string'
        ? this.attributes.serviceId
        : this.id;
    const sourceServiceId = getOurAci();
    if (!sourceServiceId) {
      throw new Error('updateExpirationTimer: missing our ACI');
    }

    const currentVersion =
      typeof this.attributes.expireTimerVersion === 'number'
        ? this.attributes.expireTimerVersion
        : INITIAL_EXPIRE_TIMER_VERSION;
    const nextVersion =
      currentVersion >= 0xffffffff
        ? INITIAL_EXPIRE_TIMER_VERSION
        : currentVersion + 1;
    const timestamp = Date.now();
    const sentAt = timestamp - 1;

    this.set({
      expireTimer,
      expireTimerVersion: nextVersion,
    });
    await this.maybeRemoveUniversalTimer();

    const webMessage: WebMessage = {
      id: `timer:${this.id}:${sentAt}`,
      conversationId: this.id,
      desktopType: 'timer-notification',
      direction: 'outgoing',
      expireTimer,
      expireTimerVersion: nextVersion,
      expirationTimerUpdate: {
        expireTimer,
        fromSync: false,
        source: sourceServiceId,
        sourceServiceId,
      },
      flags: Proto.DataMessage.Flags.EXPIRATION_TIMER_UPDATE,
      readStatus: ReadStatus.Read,
      receivedAt: timestamp,
      sourceServiceId,
      status: 'sent',
      timestamp: sentAt,
    };
    const message = toDesktopMessage(webMessage) as MessageRecord;
    message.seenStatus = SeenStatus.Seen;

    webRuntimeMessagesLookup = {
      ...webRuntimeMessagesLookup,
      [message.id]: message,
    };

    window.reduxActions?.conversations?.messagesAdded?.({
      conversationId: this.id,
      isActive: document.visibilityState === 'visible',
      isJustSent: true,
      isNewMessage: true,
      messages: [message],
    });
    window.dispatchEvent(
      new CustomEvent(WEB_MESSAGES_ADDED_EVENT, {
        detail: {
          messages: [webMessage],
        },
      })
    );
    await this.updateLastMessage();

    if (!currentMessageRuntimeSessionId) {
      return;
    }

    const sent = await sendDirectExpirationTimerUpdate({
      runtimeSessionId: currentMessageRuntimeSessionId,
      destinationServiceId,
      expireTimer,
      expireTimerVersion: nextVersion,
      timestamp,
    });
    const sentMessage = toDesktopMessage({
      ...sent,
      conversationId: this.id,
      expireTimer,
      expireTimerVersion: nextVersion,
      expirationTimerUpdate: webMessage.expirationTimerUpdate,
      id: message.id,
      timestamp: sentAt,
    }) as MessageRecord;

    webRuntimeMessagesLookup = {
      ...webRuntimeMessagesLookup,
      [message.id]: sentMessage,
    };
    window.reduxActions?.conversations?.messageChanged?.(
      message.id,
      this.id,
      sentMessage
    );
  }

  public async applyMessageRequestResponse(response: number): Promise<void> {
    const messageRequestEnum = Proto.SyncMessage.MessageRequestResponse.Type;
    const threadAci = this.getAci();
    const timestamp = Date.now();
    if (response === messageRequestEnum.ACCEPT) {
      this.set({
        acceptedMessageRequest: true,
        messageRequestResponseType: response,
        profileSharing: true,
        removalStage: undefined,
      });
    } else if (response === messageRequestEnum.DELETE) {
      await this.destroyMessages();
      this.set({
        acceptedMessageRequest: false,
        isArchived: true,
        isPinned: false,
        messageRequestResponseType: response,
        profileSharing: false,
        removalStage: 'justNotification',
      });
    } else {
      this.set({
        acceptedMessageRequest: false,
        isBlocked:
          response === messageRequestEnum.BLOCK ||
          response === messageRequestEnum.BLOCK_AND_DELETE ||
          response === messageRequestEnum.BLOCK_AND_SPAM,
        messageRequestResponseType: response,
        profileSharing: false,
      });
    }

    if (!threadAci || !currentMessageRuntimeSessionId) {
      return;
    }

    try {
      await sendMessageRequestResponseSync({
        runtimeSessionId: currentMessageRuntimeSessionId,
        threadAci,
        timestamp,
        type: response,
      });
    } catch (error) {
      console.error('Failed to sync message request response', error);
    }
  }

  public queueJob<T>(callback: () => T): T;
  public queueJob<T>(
    name: string,
    callback: (abortSignal: AbortSignal) => T
  ): T;
  public queueJob<T>(
    first: string | (() => T),
    second?: (abortSignal: AbortSignal) => T
  ): T {
    const callback = typeof first === 'function' ? first : second;
    if (typeof callback !== 'function') {
      throw new TypeError('WebConversationModel.queueJob callback is required');
    }

    return callback(new AbortController().signal);
  }

  public async maybeRemoveUniversalTimer(): Promise<boolean> {
    if (!this.attributes.pendingUniversalTimer) {
      return false;
    }

    this.set({ pendingUniversalTimer: undefined });
    return true;
  }

  public async maybeSetPendingUniversalTimer(
    hasUserInitiatedMessages: boolean
  ): Promise<void> {
    if (hasUserInitiatedMessages) {
      await this.maybeRemoveUniversalTimer();
    }
  }

  public beforeMessageSend(): void {}

  public getAccepted(): boolean {
    return Boolean(this.attributes.acceptedMessageRequest);
  }

  public async enqueueMessageForSend(
    enqueuedMessage: WebEnqueuedMessage,
    options: WebEnqueueMessageOptions = {}
  ): Promise<MessageRecord | undefined> {
    const timestamp = options.timestamp ?? Date.now();
    const body = enqueuedMessage.body ?? '';
    const quote = enqueuedMessage.quote;
    const attachments = (enqueuedMessage.attachments ?? []).map(
      toWebForwardAttachment
    );
    const isGroupConversation = this.attributes.type === 'group';
    const groupV2Info = isGroupConversation
      ? (this.getGroupV2Info() as
          | { members?: ReadonlyArray<string>; revision?: number }
          | undefined)
      : undefined;
    const localMessageId = `sent:${
      isGroupConversation
        ? String(this.attributes.groupId ?? this.id)
        : String(this.attributes.serviceId ?? this.id)
    }:${timestamp}`;
    const optimisticMessage = toDesktopMessage({
      id: localMessageId,
      attachments,
      body,
      conversationId: this.id,
      direction: 'outgoing',
      quote,
      receivedAt: timestamp,
      status: 'queued',
      timestamp,
    }) as MessageRecord;

    webRuntimeMessagesLookup = {
      ...webRuntimeMessagesLookup,
      [optimisticMessage.id]: optimisticMessage,
    };

    window.reduxActions?.conversations?.messagesAdded?.({
      conversationId: this.id,
      isActive: document.visibilityState === 'visible',
      isJustSent: true,
      isNewMessage: true,
      messages: [optimisticMessage],
    });
    await this.updateLastMessage();

    const sent: WebMessage = isGroupConversation
      ? await sendGroupTextMessage({
          runtimeSessionId: currentMessageRuntimeSessionId,
          groupId: String(this.attributes.groupId ?? this.id),
          attachments,
          body,
          quote,
          timestamp,
          groupV2:
            typeof this.attributes.masterKey === 'string' &&
            typeof this.attributes.revision === 'number'
              ? {
                  masterKey: this.attributes.masterKey,
                  revision: this.attributes.revision,
                }
              : undefined,
          recipients: groupV2Info?.members,
        })
      : await sendDirectTextMessage({
          runtimeSessionId: currentMessageRuntimeSessionId,
          destinationServiceId: String(this.attributes.serviceId ?? this.id),
          body,
          timestamp,
          attachments,
          quote,
        });
    const sentWebMessage: WebMessage = {
      ...sent,
      attachments: sent.attachments ?? attachments,
      body,
      conversationId: this.id,
      direction: 'outgoing',
      status: sent.status ?? 'sent',
      timestamp,
      quote: sent.quote ?? quote,
    };
    const message = toDesktopMessage(sentWebMessage) as MessageRecord;

    webRuntimeMessagesLookup = {
      ...webRuntimeMessagesLookup,
      [message.id]: message,
    };

    window.reduxActions?.conversations?.messageChanged?.(
      message.id,
      this.id,
      message
    );
    window.dispatchEvent(
      new CustomEvent(WEB_MESSAGES_ADDED_EVENT, {
        detail: {
          messages: [sentWebMessage],
        },
      })
    );
    await this.updateLastMessage();
    return message;
  }
}

function getConversationLookup(): Record<string, ConversationRecord> {
  return {
    ...getBootstrapConversationLookup(),
    ...(window.reduxStore?.getState?.().conversations?.conversationLookup ??
      {}),
  };
}

function getConversationModel(
  id: string | undefined
): WebConversationModel | undefined {
  if (!id) {
    return undefined;
  }
  const lookup = getConversationLookup();
  const ownConversationId =
    currentLinkedSession?.credentials?.aci ?? currentLinkedSession?.account.aci;
  const resolvedId = id === 'note-to-self' ? ownConversationId : id;
  const attributes = resolvedId ? lookup[resolvedId] : undefined;
  if (attributes) {
    return new WebConversationModel(attributes);
  }
  if (resolvedId && resolvedId === ownConversationId && currentLinkedSession) {
    return new WebConversationModel({
      acceptedMessageRequest: true,
      capabilities: {
        attachmentBackfill: true,
      },
      id: resolvedId,
      isMe: true,
      serviceId: resolvedId,
      title:
        currentLinkedSession.account.title ??
        currentLinkedSession.account.phoneNumber ??
        resolvedId,
      type: 'direct',
    });
  }
  return undefined;
}

function findConversationModelByIdentifier(
  identifier: string | undefined
): WebConversationModel | undefined {
  if (!identifier) {
    return undefined;
  }

  const lookup = getConversationLookup();
  if (isPniString(identifier)) {
    const pniMatch = Object.values(lookup).find(conversation => {
      return (
        conversation.pni === identifier &&
        typeof conversation.serviceId === 'string' &&
        isAciString(conversation.serviceId)
      );
    });
    if (pniMatch) {
      return new WebConversationModel(pniMatch);
    }
  }

  const direct = getConversationModel(identifier);
  if (direct) {
    return direct;
  }

  const existing = Object.values(lookup).find(conversation => {
    return (
      conversation.serviceId === identifier ||
      conversation.pni === identifier ||
      conversation.e164 === identifier ||
      conversation.phoneNumber === identifier ||
      conversation.groupId === identifier
    );
  });
  return existing ? new WebConversationModel(existing) : undefined;
}

function createConversationModelForIdentifier(
  identifier: string,
  type: 'private' | 'group',
  additionalInitialProps: Record<string, unknown> = {}
): WebConversationModel | undefined {
  if (!currentLinkedSession) {
    return undefined;
  }

  const title = String(additionalInitialProps.title ?? identifier);
  const conversation =
    type === 'group'
      ? {
          id: identifier,
          type: 'group' as const,
          conversationType: 'group' as const,
          groupId: identifier,
          title,
          titleNoDefault: title,
          searchableTitle: title,
          ...additionalInitialProps,
        }
      : {
          id: identifier,
          type: 'direct' as const,
          conversationType: 'direct' as const,
          serviceId:
            isAciString(identifier) || isPniString(identifier)
              ? identifier
              : undefined,
          title,
          titleNoDefault: title,
          searchableTitle: title,
          ...additionalInitialProps,
        };

  const attributes = toDesktopConversation(
    conversation,
    currentLinkedSession
  ) as ConversationRecord;
  window.reduxActions?.conversations?.conversationsUpdated?.([
    attributes as never,
  ]);
  onConversationAttributesChanged?.(conversation.id, conversation);
  return new WebConversationModel(attributes);
}

function applyContactIdentityChange(
  conversation: WebConversationModel,
  suggestedChange: Partial<{
    serviceId: string;
    e164: string;
    phoneNumber: string;
    pni: string;
  }>
): void {
  const change = { ...suggestedChange };

  if (hasOwnProperty.call(change, 'e164') && !change.pni) {
    change.pni = undefined;
  }

  const currentServiceId = conversation.getServiceId();
  const currentPni = conversation.getPni();
  const hasValidCurrentServiceId =
    typeof currentServiceId === 'string' &&
    (isAciString(currentServiceId) || isPniString(currentServiceId));
  if (
    change.pni &&
    !change.serviceId &&
    (!currentServiceId ||
      currentServiceId === currentPni ||
      !hasValidCurrentServiceId)
  ) {
    change.serviceId = change.pni;
  }

  if (
    !change.serviceId &&
    hasOwnProperty.call(change, 'pni') &&
    !change.pni &&
    currentServiceId === currentPni
  ) {
    change.serviceId = undefined;
  }

  conversation.set(change);
}

function removeConversationModelFromRuntime(
  conversation: WebConversationModel
): void {
  window.reduxActions?.conversations?.conversationRemoved?.(conversation.id);
  onConversationAttributesChanged?.(conversation.id, {
    __signalWebDeleteConversation: true,
  });
}

function getContactIdentityValue(
  conversation: WebConversationModel,
  key: 'serviceId' | 'e164' | 'pni'
): unknown {
  if (key === 'serviceId') {
    return conversation.getServiceId();
  }

  return conversation.get(key);
}

function installConversationController(
  linkedSession: LinkedSessionRecord | undefined
): void {
  currentLinkedSession = linkedSession;
  const controller = {
    async load() {},
    get(id: string | undefined) {
      return getConversationModel(id);
    },
    getOrCreate(
      identifier: string | null,
      type: 'private' | 'group',
      additionalInitialProps: Record<string, unknown> = {}
    ) {
      if (typeof identifier !== 'string') {
        throw new TypeError("'id' must be a string");
      }
      if (type !== 'private' && type !== 'group') {
        throw new TypeError(
          `'type' must be 'private' or 'group'; got: '${type}'`
        );
      }
      return (
        findConversationModelByIdentifier(identifier) ??
        createConversationModelForIdentifier(
          identifier,
          type,
          additionalInitialProps
        )
      );
    },
    async getOrCreateAndWait(
      identifier: string | null,
      type: 'private' | 'group',
      additionalInitialProps: Record<string, unknown> = {}
    ) {
      const conversation = this.getOrCreate(
        identifier,
        type,
        additionalInitialProps
      );
      if (!conversation) {
        throw new Error('getOrCreateAndWait: did not get conversation');
      }
      return conversation;
    },
    getAll() {
      return Object.values(getConversationLookup()).map(
        conversation => new WebConversationModel(conversation)
      );
    },
    getOurConversationId() {
      return linkedSession?.credentials?.aci ?? linkedSession?.account.aci;
    },
    getOurConversationIdOrThrow() {
      const conversationId =
        linkedSession?.credentials?.aci ?? linkedSession?.account.aci;
      if (!conversationId) {
        throw new Error(
          'getOurConversationIdOrThrow: Failed to fetch ourConversationId'
        );
      }
      return conversationId;
    },
    getOurConversation() {
      return getConversationModel(
        linkedSession?.credentials?.aci ?? linkedSession?.account.aci
      );
    },
    getOurConversationOrThrow() {
      const conversation = this.getOurConversation();
      if (!conversation) {
        throw new Error('Our conversation is not available');
      }
      return conversation;
    },
    areWePrimaryDevice() {
      return currentLinkedSession?.credentials?.deviceId === 1;
    },
    doWeHaveOtherDevices() {
      return !this.areWePrimaryDevice();
    },
    isSignalConversationId(id: string | undefined) {
      const conversation = getConversationModel(id);
      return (
        conversation?.attributes.serviceId === SIGNAL_ACI || id === SIGNAL_ACI
      );
    },
    lookupOrCreate({
      e164,
      serviceId,
      reason,
    }: {
      e164?: string | null;
      serviceId?: string | null;
      reason: string;
    }) {
      const normalizedServiceId =
        typeof serviceId === 'string' &&
        (isAciString(serviceId) || isPniString(serviceId))
          ? serviceId
          : undefined;
      const identifier = normalizedServiceId || e164;

      if ((!e164 && !serviceId) || !identifier) {
        console.warn(
          `lookupOrCreate: Called with neither e164 nor serviceId! reason: ${reason}`
        );
        return undefined;
      }

      const convoE164 =
        typeof e164 === 'string'
          ? findConversationModelByIdentifier(e164)
          : undefined;
      const convoServiceId = normalizedServiceId
        ? findConversationModelByIdentifier(normalizedServiceId)
        : undefined;

      if (!convoE164 && !convoServiceId) {
        console.info('lookupOrCreate: Creating new contact, no matches found');
        const conversation = this.getOrCreate(identifier, 'private');
        if (conversation && normalizedServiceId && e164) {
          applyContactIdentityChange(conversation, { e164 });
        }
        return conversation;
      }

      if (!convoE164 && convoServiceId) {
        return convoServiceId;
      }

      if (convoE164 && !convoServiceId) {
        return convoE164;
      }

      if (!convoE164 || !convoServiceId) {
        throw new Error(
          `lookupOrCreate: convoE164 or convoServiceId are falsey but should both be true! reason: ${reason}`
        );
      }

      if (convoE164.id === convoServiceId.id) {
        return convoServiceId;
      }

      console.warn(
        `lookupOrCreate: Found a split contact - service id ${normalizedServiceId} and E164 ${e164}. Returning service id match. reason: ${reason}`
      );
      return convoServiceId;
    },
    maybeMergeContacts({
      aci,
      e164,
      pni,
      reason,
    }: {
      aci?: string;
      e164?: string;
      pni?: string;
      reason: string;
    }) {
      const provided = new Array<string>();
      if (aci) {
        provided.push(`aci=${aci}`);
        if (e164) {
          provided.push('e164');
        }
        if (pni) {
          provided.push('pni');
        }
      } else {
        if (e164) {
          provided.push(`e164=${e164}`);
        }
        if (pni) {
          provided.push(`pni=${pni}`);
        }
      }
      const logId = `maybeMergeContacts/${reason}/${provided.join(',')}`;

      if (!aci && !e164 && !pni) {
        throw new Error(
          `${logId}: Need to provide at least one of: aci, e164, pni`
        );
      }

      const matches: Array<WebConvoMatch> = [
        {
          key: 'serviceId',
          value: aci,
          match: findConversationModelByIdentifier(aci),
        },
        {
          key: 'e164',
          value: e164,
          match: findConversationModelByIdentifier(e164),
        },
        {
          key: 'pni',
          value: pni,
          match: findConversationModelByIdentifier(pni),
        },
      ];
      let unusedMatches = new Array<WebConvoMatch>();
      let targetConversation: WebConversationModel | undefined;
      let matchCount = 0;

      matches.forEach(item => {
        const { key, value, match } = item;
        if (!value) {
          return;
        }

        if (!match) {
          if (targetConversation) {
            applyContactIdentityChange(targetConversation, {
              [key]: value,
            });
          } else {
            unusedMatches.push(item);
          }
          return;
        }

        matchCount += 1;
        unusedMatches.forEach(unused => {
          if (!unused.value) {
            return;
          }

          if (
            !targetConversation &&
            !getContactIdentityValue(match, unused.key)
          ) {
            targetConversation = match;
          }

          if (
            !targetConversation &&
            unused.key === 'serviceId' &&
            getContactIdentityValue(match, unused.key) === pni
          ) {
            targetConversation = match;
          }

          if (
            !targetConversation &&
            unused.key === 'serviceId' &&
            getContactIdentityValue(match, unused.key) === match.getPni()
          ) {
            targetConversation = match;
          }

          if (!targetConversation) {
            targetConversation = this.getOrCreate(unused.value, 'private');
          }

          if (!targetConversation) {
            throw new Error(`${logId}: did not get target conversation`);
          }

          applyContactIdentityChange(targetConversation, {
            [unused.key]: unused.value,
          });
        });

        unusedMatches = [];

        if (targetConversation && targetConversation !== match) {
          const change: Partial<{
            serviceId: string;
            e164: string;
            pni: string;
          }> = {
            [key]: undefined,
          };
          if (
            (key === 'pni' || key === 'e164') &&
            match.getServiceId() === pni
          ) {
            change.serviceId = undefined;
          }

          applyContactIdentityChange(match, change);
          const willMerge =
            !match.getServiceId() && !match.get('e164') && !match.getPni();

          applyContactIdentityChange(targetConversation, {
            [key]: value,
          });

          if (willMerge) {
            removeConversationModelFromRuntime(match);
          }
        } else if (
          targetConversation &&
          !getContactIdentityValue(targetConversation, key)
        ) {
          applyContactIdentityChange(targetConversation, {
            [key]: value,
          });
        }

        if (!targetConversation) {
          targetConversation = match;
        }
      });

      if (targetConversation) {
        return { conversation: targetConversation, mergePromises: [] };
      }

      if (matchCount !== 0) {
        throw new Error(
          `${logId}: should be no matches if no targetConversation`
        );
      }

      const identifier = aci ?? pni ?? e164;
      if (!identifier) {
        throw new Error(`${logId}: identifier must be truthy`);
      }

      const conversation = this.getOrCreate(identifier, 'private', {
        e164,
        pni,
      });
      if (!conversation) {
        throw new Error(`${logId}: did not get created conversation`);
      }

      return { conversation, mergePromises: [] };
    },
    onConvoMessageMount() {},
  };
  window.ConversationController =
    controller as unknown as typeof window.ConversationController;
}

function installKeyboardLayoutFallback(): void {
  const nav = window.navigator as unknown as {
    keyboard?: {
      getLayoutMap?: () => Promise<{
        get: (code: string) => string | undefined;
      }>;
    };
  };
  if (nav.keyboard?.getLayoutMap) {
    return;
  }
  nav.keyboard = {
    getLayoutMap: async () => ({
      get: (code: string) => code,
    }),
  };
}

function noop(): void {}

export function setupWebGlobals({
  i18n,
  linkedSession,
  messageRuntimeSessionId,
  onConversationChange,
}: Readonly<{
  i18n: Localizer;
  linkedSession?: LinkedSessionRecord;
  messageRuntimeSessionId?: string;
  onConversationChange?: ConversationAttributesChanged;
}>): void {
  onConversationAttributesChanged = onConversationChange;
  currentMessageRuntimeSessionId = messageRuntimeSessionId;
  installKeyboardLayoutFallback();
  installConversationController(linkedSession);

  window.platform = OS.isMacOS()
    ? 'darwin'
    : OS.isWindows()
      ? 'win32'
      : 'linux';
  window.getVersion = () => packageJson.version;

  window.Whisper = {
    ...(window.Whisper ?? {}),
    events: window.Whisper?.events ?? createWebEventEmitter(),
  } as typeof window.Whisper;

  const events = {
    addDarkOverlay: noop,
    getAutoLaunch: async () => false,
    getContentProtection: async () => false,
    getLocaleOverride: async () => null,
    getMediaCameraPermissions: async () => false,
    getMediaPermissions: getWebMicrophonePermission,
    getSpellCheck: async () => true,
    getSystemTraySetting: async () => false,
    getThemeSetting: async () => loadWebSettings().theme,
    getZoomFactor: async () => 1,
    offZoomFactorChange: noop,
    onZoomFactorChange: noop,
    removeDarkOverlay: noop,
    setAutoLaunch: async () => undefined,
    setContentProtection: async () => undefined,
    setLocaleOverride: async () => undefined,
    setMediaCameraPermissions: async () => undefined,
    setMediaPermissions: async () => undefined,
    setSpellCheck: async () => undefined,
    setSystemTraySetting: async () => undefined,
    setThemeSetting: async (value: ThemeType) => {
      updateWebSettings({ theme: value });
    },
    setZoomFactor: async () => undefined,
    showKeyboardShortcuts: noop,
  };

  window.Events = {
    ...(window.Events ?? {}),
    ...events,
  } as unknown as typeof window.Events;
  const ipc = {
    ...(window.IPC ?? {}),
    addSetupMenuItems: noop,
    clearAllWindowsNotifications: async () => undefined,
    closeCallDiagnostic: noop,
    closeDebugLog: noop,
    crashReports: {
      erase: async () => undefined,
      writeToLog: async () => undefined,
    },
    drawAttention: noop,
    getAutoLaunch: async () => false,
    getMediaAccessStatus: async () => 'not-determined',
    getMediaCameraPermissions: async () => false,
    getMediaPermissions: getWebMicrophonePermission,
    openSystemMediaPermissions: async () => undefined,
    readyForUpdates: noop,
    removeSetupMenuItems: noop,
    setAutoHideMenuBar: noop,
    setAutoLaunch: async () => undefined,
    setMediaCameraPermissions: async () => undefined,
    setMediaPermissions: async () => undefined,
    setMenuBarVisibility: noop,
    showCallDiagnostic: noop,
    showDebugLog: noop,
    showPermissionsPopup: async () => undefined,
    showWindow: noop,
    shutdown: noop,
    sqlCall: async (name: string, args?: ReadonlyArray<unknown>) => {
      const state = window.reduxStore?.getState?.();
      if (name === 'getAllItems') {
        return {};
      }
      if (name === 'getAllConversations') {
        return Object.values(state?.conversations?.conversationLookup ?? {});
      }
      if (name === 'getBackupAttachmentDownloadProgress') {
        return {
          completedBytes: 0,
          totalBytes: 0,
        };
      }
      if (name === 'getConversationById') {
        return undefined;
      }
      if (name === 'hasMedia') {
        return typeof args?.[0] === 'string' ? hasGalleryMedia(args[0]) : false;
      }
      if (name === 'getSortedMedia') {
        return getSortedMediaItems(args?.[0] as GetSortedMediaOptionsType);
      }
      if (name === 'getSortedNonAttachmentMedia') {
        return getSortedNonAttachmentMediaItems(
          args?.[0] as GetSortedNonAttachmentMediaOptionsType
        );
      }
      if (name === 'getSortedDocuments') {
        return getSortedDocumentItems(
          args?.[0] as GetSortedDocumentsOptionsType
        );
      }
      if (name === 'getOlderMessagesByConversation') {
        return getConversationMessagesPage(args?.[0]);
      }
      if (name === 'getNewerMessagesByConversation') {
        const options = args?.[0] as
          | { conversationId?: string; limit?: number; receivedAt?: number }
          | undefined;
        const pageLimit =
          typeof options?.limit === 'number' && options.limit > 0
            ? options.limit
            : 50;
        const messages = getConversationMessages(options?.conversationId);
        const receivedAt = options?.receivedAt;
        const filtered =
          typeof receivedAt === 'number'
            ? messages.filter(message => getTimestamp(message) > receivedAt)
            : messages;
        return filtered.slice(0, pageLimit);
      }
      if (name === 'getConversationRangeCenteredOnMessage') {
        const options = args?.[0] as
          | { conversationId?: string; limit?: number; messageId?: string }
          | undefined;
        const messages = getConversationMessages(options?.conversationId);
        const index = messages.findIndex(
          message => message.id === options?.messageId
        );
        if (index < 0) {
          return {
            older: [],
            newer: [],
            metrics: getMessageMetrics(options?.conversationId),
          };
        }
        const limit =
          typeof options?.limit === 'number' && options.limit > 0
            ? options.limit
            : 50;
        const sideLimit = Math.floor(limit / 2);
        return {
          older: messages.slice(Math.max(0, index - sideLimit), index),
          newer: messages.slice(index + 1, index + 1 + sideLimit),
          metrics: getMessageMetrics(options?.conversationId),
        };
      }
      if (name === 'getMessagesById') {
        const ids = args?.[0];
        if (!Array.isArray(ids)) {
          return [];
        }
        const reduxMessagesLookup = getReduxMessagesLookup();
        return ids
          .map(id => getMessageFromLookup(String(id), reduxMessagesLookup))
          .filter(isNotNil);
      }
      if (name === 'getMessageById') {
        const id = args?.[0];
        return typeof id === 'string' ? getMessageFromLookup(id) : undefined;
      }
      if (name === 'getMessagesBySentAt') {
        const sentAt = args?.[0];
        if (typeof sentAt !== 'number') {
          return [];
        }
        return Object.values(getMessagesLookup())
          .filter(message => getMessageSentTimestamp(message) === sentAt)
          .sort((left, right) => getTimestamp(right) - getTimestamp(left));
      }
      if (name === 'searchMessages') {
        const options = args?.[0] as
          | {
              query?: string;
              conversationId?: string;
              options?: { limit?: number };
              contactServiceIdsMatchingQuery?: ReadonlyArray<string>;
            }
          | undefined;
        return searchWebMessages(options ?? {});
      }
      if (name === 'getMessageByAuthorAciAndSentAt') {
        const ourAci = args?.[0];
        const authorAci = args?.[1];
        const sentAt = args?.[2];
        if (
          typeof ourAci !== 'string' ||
          typeof authorAci !== 'string' ||
          typeof sentAt !== 'number'
        ) {
          return null;
        }
        return (
          Object.values(getMessagesLookup()).find(message => {
            if (getMessageSentTimestamp(message) !== sentAt) {
              return false;
            }
            if (authorAci === ourAci && message.type === 'outgoing') {
              return true;
            }
            return getMessageAuthorAci(message) === authorAci;
          }) ?? null
        );
      }
      if (name === 'removeMessages' || name === 'removeMessagesById') {
        const ids = args?.[0];
        if (Array.isArray(ids)) {
          removeMessagesFromRuntime(ids.map(String));
        }
        return undefined;
      }
      if (
        name === 'removeAllBackupAttachmentDownloadJobs' ||
        name === 'resetBackupAttachmentDownloadJobsRetryAfter' ||
        name === 'resetBackupAttachmentDownloadStats'
      ) {
        return undefined;
      }
      if (name === 'getMessageMetricsForConversation') {
        const options = args?.[0] as { conversationId?: string } | undefined;
        return getMessageMetrics(options?.conversationId);
      }
      if (name === 'getConversationMessageStats') {
        const options = args?.[0] as { conversationId?: string } | undefined;
        return getConversationMessageStats(options?.conversationId);
      }
      if (name === 'getPinnedMessagesPreloadDataForConversation') {
        const conversationId = args?.[0];
        return typeof conversationId === 'string'
          ? getWebPinnedMessagesPreloadDataForConversation(conversationId)
          : [];
      }
      if (name === 'getAllBadges') {
        return [];
      }
      if (name === 'getAllStories') {
        return [];
      }
      if (name === 'getAllStoryDistributionsWithMembers') {
        return [];
      }
      if (name === 'getCurrentChatFolders') {
        return [];
      }
      if (name === 'getAllCallHistory') {
        return [];
      }
      if (name === 'getCallHistoryUnreadCount') {
        return 0;
      }
      if (name === 'getAllCallLinks') {
        return [];
      }
      if (name === 'getAllNotificationProfiles') {
        return [];
      }
      if (name === 'getInstalledStickerPacks') {
        return [];
      }
      if (name === 'getUninstalledStickerPacks') {
        return [];
      }
      if (name === 'getRecentEmojis') {
        return [];
      }
      if (name === 'getRecentGifs') {
        return [];
      }
      if (name === 'appendPinnedMessage') {
        const limit = args?.[0];
        const params = args?.[1];
        if (typeof limit === 'number' && params && typeof params === 'object') {
          return appendWebPinnedMessage(limit, params as PinnedMessageParams);
        }
        return {
          change: null,
          truncated: [],
        };
      }
      if (name === 'deletePinnedMessageByMessageId') {
        const messageId = args?.[0];
        return typeof messageId === 'string'
          ? deleteWebPinnedMessageByMessageId(messageId)
          : null;
      }
      if (
        name.startsWith('create') ||
        name.startsWith('update') ||
        name.startsWith('save') ||
        name.startsWith('remove')
      ) {
        return undefined;
      }
      return undefined;
    },
    updateCallDiagnosticData: noop,
  };
  window.IPC = ipc as unknown as typeof window.IPC;

  const signalContext = {
    ...(window.SignalContext ?? {}),
    config: {
      appStartInitialSpellcheckSetting: true,
      cdnBaseUrl: getRenderCdnBaseUrl(),
      disableScreenSecurity: true,
      renderApiBaseUrl: getRenderApiBaseUrl(),
      serverUrl: getRenderApiBaseUrl(),
      sfuUrl: '',
      updatesUrl: '',
    },
    activeWindowService: {
      isActive: () => document.visibilityState === 'visible',
      registerForActive: noop,
      unregisterForActive: noop,
    },
    executeMenuRole: noop,
    getCountryDisplayNames: () => countryDisplayNames,
    getEnvironment: () => 'production',
    getHourCyclePreference: () => 'UnknownPreference',
    getI18nAvailableLocales: () => ['zh-CN'],
    getI18nLocale: () => 'zh-CN',
    getI18nLocaleMessages: () => ({}),
    getLocaleDisplayNames: () => ({
      'zh-CN': {
        'zh-CN': '中文（简体）',
      },
    }),
    getLocaleOverride: () => null,
    getMainWindowStats: async () => ({
      isFullScreen: false,
      isMaximized: false,
    }),
    getMenuOptions: async () => ({
      development: false,
      devTools: false,
      includeSetup: false,
      isNightly: false,
      isProduction: true,
      platform: window.platform,
    }),
    getPath: () => '',
    getPreferredSystemLocales: () => ['zh-CN'],
    getResolvedMessagesLocaleDirection: () => 'ltr',
    getVersion: () => window.getVersion(),
    i18n,
    isTestOrMockEnvironment: () => false,
    nativeThemeListener: {
      getSystemTheme: () => 'light',
      subscribe: noop,
      unsubscribe: noop,
    },
    restartApp: noop,
    setIsCallActive: noop,
    Settings: {
      themeSetting: {
        getValue: async () => loadWebSettings().theme,
        setValue: async (value: ThemeType) => {
          updateWebSettings({ theme: value });
          return value;
        },
      },
      waitForChange: async () => undefined,
    },
  };
  window.SignalContext =
    signalContext as unknown as typeof window.SignalContext;

  const signal = {
    ...(window.Signal ?? {}),
    OS,
    Services: {
      backups: {},
      calling: {},
      donations: {},
      storage: {},
    },
  };
  window.Signal = signal as unknown as typeof window.Signal;
}
