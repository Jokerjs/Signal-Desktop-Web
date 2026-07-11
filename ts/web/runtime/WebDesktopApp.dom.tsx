// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type JSX,
  type SetStateAction,
} from 'react';
import lodash from 'lodash';
import { Provider, useSelector } from 'react-redux';
import type { Store } from 'redux';
import { AppProvider } from '../../windows/AppProvider.dom.tsx';
import { App } from '../../components/App.dom.tsx';
import { Inbox } from '../../components/Inbox.dom.tsx';
import { AppViewType } from '../../types/app.std.ts';
import { SocketStatus } from '../../types/SocketStatus.std.ts';
import { ReadStatus } from '../../messages/MessageReadStatus.std.ts';
import type {
  EditHistoryType,
  MessageReactionType,
} from '../../model-types.d.ts';
import type { StateType } from '../../state/reducer.preload.ts';
import type { MessageForwardDraft } from '../../types/ForwardDraft.std.ts';
import { SmartFunProvider } from '../../state/smart/FunProvider.preload.tsx';
import { SmartNavTabs } from '../../state/smart/NavTabs.preload.tsx';
import { SmartGlobalModalContainer } from '../../state/smart/GlobalModalContainer.preload.tsx';
import { SmartLightbox } from '../../state/smart/Lightbox.preload.tsx';
import { SmartPreferences } from '../../state/smart/Preferences.preload.tsx';
import { SmartVoiceNotesPlaybackProvider } from '../../state/smart/VoiceNotesPlaybackProvider.preload.tsx';
import { getIntl, getTheme } from '../../state/selectors/user.std.ts';
import { getNavTabsCollapsed } from '../../state/selectors/items.dom.ts';
import { getUpdatesState } from '../../state/selectors/updates.std.ts';
import { useItemsActions } from '../../state/ducks/items.preload.ts';
import { BackfillFailureModalKind } from '../../components/BackfillFailureModal.dom.tsx';
import { InstallScreenBackupImportStep } from '../../components/installScreen/InstallScreenBackupImportStep.dom.tsx';
import { InstallScreenBackupStep } from '../../types/InstallScreen.std.ts';
import {
  buildAttachmentAccessUrl,
  consumeMessageTransportStream,
  createGroupConversation,
  confirmSignalUsername,
  confirmSignalUsernameReservation,
  deleteSignalUsername,
  notifySignalNetworkChange,
  requestAttachmentBackfill,
  replaceSignalUsernameLink,
  reserveSignalUsername,
  reserveSignalUsernameByNickname,
  resetSignalUsernameLink,
  sendDirectDeleteForEveryone,
  sendDirectTextMessage,
  sendDirectReaction,
  sendDirectUnpinMessage,
  sendGroupReaction,
  sendGroupTextMessage,
  setPhoneNumberDiscoverability as setSignalPhoneNumberDiscoverability,
  syncSignalUsernameProfile,
  syncContacts,
  writeProfile as writeSignalProfile,
} from '../api.dom.ts';
import { getWebAttachmentContentTypeFromParts } from '../attachmentMime.std.ts';
import {
  applyContactsBootstrap,
  compareWebMessages,
  getConversationTitle,
  getDesktopMessageMetrics,
  getConversationListSortTimestamp,
  getWebAttachmentVirtualPath,
  getWebConversationLastMessage,
  getWebMessagePreviewText,
  normalizeChatShellForLinkedSession,
  registerMessageInCache as registerMessageInCacheImmediately,
  toDesktopConversation,
  toDesktopMessage,
} from './stateAdapter.dom.ts';
import { recoverRetriableAttachmentStates } from './recoverRetriableAttachmentStates.dom.ts';
import { setupWebGlobals } from './setupWebGlobals.dom.ts';
import {
  loadChatShellStateForSession,
  loadContactsBootstrapForSession,
  loadLinkedSessionRecordFromIndexedDb,
  clearWebPersistence,
  persistLinkedSessionRecordToIndexedDb,
  persistLinkedSessionToStorage,
  persistChatShellStateToStorage,
  persistContactsBootstrapForSession,
} from '../persistence.dom.ts';
import type {
  ChatShellState,
  ContactsBootstrap,
  LinkedSessionRecord,
  MessageStreamEvent,
  WebAttachment,
  WebConversation,
  WebMessage,
  WebPinMessage,
  WebUnpinMessage,
} from '../types.std.ts';
import { WebInstallScreen } from './WebInstallScreen.dom.tsx';
import { WebChatsTab } from './WebChatsTab.dom.tsx';
import {
  applyRemoteUnpinMessage,
  applyRemotePinnedMessage,
  getWebPinnedMessagesPreloadDataForConversation,
  setWebRuntimeChatShell,
  setWebRuntimePinnedMessagesChanged,
  WEB_MESSAGES_ADDED_EVENT,
  WEB_MESSAGES_REMOVED_EVENT,
} from './setupWebGlobals.dom.ts';
import { getSelectedConversationId } from '../../state/selectors/nav.std.ts';
import type { Emoji } from '../../axo/emoji.std.ts';
import { ToastType } from '../../types/Toast.dom.tsx';
import { isAciString } from '../../util/isAciString.std.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import * as Registration from '../../util/registration.preload.ts';
import {
  normalizePni,
  type AciString,
  type PniString,
} from '../../types/ServiceId.std.ts';
import type { PinnedMessage } from '../../types/PinnedMessage.std.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import { SECOND } from '../../util/durations/index.std.ts';
import type { ConversationType } from '../../state/ducks/conversations.preload.ts';
import type { AvatarUpdateOptionsType } from '../../types/Avatar.std.ts';
import { isSharingPhoneNumberWithEverybody } from '../../util/phoneNumberSharingMode.preload.ts';
import { getDirectSendAccessKey } from '../directSendAccessKey.dom.ts';

const VIDEO_THUMBNAIL_MAX_SIDE = 480;
const VIDEO_THUMBNAIL_QUALITY = 0.82;
const VIDEO_THUMBNAIL_TIMEOUT = 30_000;
const ATTACHMENT_BACKFILL_REQUEST_TIMEOUT = 4 * SECOND;
const CONTACTS_SYNC_ON_OPEN_THROTTLE_MS = 60 * SECOND;
const MESSAGE_LOAD_CHUNK_SIZE = 30;
const ATTACHMENT_BACKFILL_STATUS_PENDING =
  Proto.SyncMessage.AttachmentBackfillResponse.AttachmentData.Status.PENDING;
const ATTACHMENT_BACKFILL_STATUS_TERMINAL_ERROR =
  Proto.SyncMessage.AttachmentBackfillResponse.AttachmentData.Status
    .TERMINAL_ERROR;

function deferWebRuntimeSideEffect(effect: () => void): Promise<void> {
  return new Promise(resolve => {
    queueMicrotask(() => {
      try {
        effect();
      } catch (error) {
        console.error('Web runtime side effect failed', error);
      } finally {
        resolve();
      }
    });
  });
}

function queueWebRuntimeSideEffect(effect: () => void): void {
  void deferWebRuntimeSideEffect(effect);
}

function registerMessageInCache(message: WebMessage): void {
  queueWebRuntimeSideEffect(() => {
    registerMessageInCacheImmediately(message);
  });
}

function dispatchMessageChanged(
  messageId: string,
  conversationId: string,
  desktopMessage: ReturnType<typeof toDesktopMessage>
): void {
  queueWebRuntimeSideEffect(() => {
    window.reduxActions?.conversations?.messageChanged?.(
      messageId,
      conversationId,
      desktopMessage
    );
  });
}

function dispatchMessagesAdded(
  options: Parameters<
    NonNullable<
      NonNullable<typeof window.reduxActions>['conversations']
    >['messagesAdded']
  >[0]
): Promise<void> {
  return deferWebRuntimeSideEffect(() => {
    window.reduxActions?.conversations?.messagesAdded?.(options);
  });
}

function dispatchMessagesAddedSoon(
  options: Parameters<
    NonNullable<
      NonNullable<typeof window.reduxActions>['conversations']
    >['messagesAdded']
  >[0]
): void {
  queueWebRuntimeSideEffect(() => {
    window.reduxActions?.conversations?.messagesAdded?.(options);
  });
}

const ATTACHMENT_BACKFILL_ERROR_MESSAGE_NOT_FOUND =
  Proto.SyncMessage.AttachmentBackfillResponse.Error.MESSAGE_NOT_FOUND;
const { isEqual } = lodash;
const EMPTY_SHELL: ChatShellState = {
  conversationLookup: {},
  messages: [],
  pinnedMessages: [],
};

const MESSAGE_STREAM_RECONNECT_INITIAL_DELAY = 1_000;
const MESSAGE_STREAM_RECONNECT_MAX_DELAY = 15_000;
const MESSAGE_STREAM_RECONNECT_JITTER_MIN = 0.8;
const MESSAGE_STREAM_RECONNECT_JITTER_MAX = 1.3;

function getMessageStreamReconnectDelay(baseDelay: number): number {
  const jitter =
    MESSAGE_STREAM_RECONNECT_JITTER_MIN +
    Math.random() *
      (MESSAGE_STREAM_RECONNECT_JITTER_MAX -
        MESSAGE_STREAM_RECONNECT_JITTER_MIN);
  return Math.round(baseDelay * jitter);
}
const DEVICE_DELINKED_ERROR = 'DeviceDelinked: device was deregistered';
const pendingAttachmentBackfillTimeouts = new Map<string, number>();

let shellMessageIndexSource: ChatShellState['messages'] | undefined;
let shellMessageIndexById = new Map<string, number>();
let shellMessageIdSet = new Set<string>();
let shellMessagesByConversationId = new Map<
  string,
  ReadonlyArray<WebMessage>
>();
let shellMessageMetricsByConversationId = new Map<
  string,
  ReturnType<typeof getDesktopMessageMetrics>
>();

function getWebMessageMetricPointer(
  message: WebMessage
): NonNullable<ReturnType<typeof getDesktopMessageMetrics>['newest']> {
  return {
    id: message.id,
    received_at: message.receivedAt ?? message.timestamp,
    sent_at: message.timestamp,
  };
}

function addWebMessageToMetrics(
  metrics: ReturnType<typeof getDesktopMessageMetrics> | undefined,
  message: WebMessage
): ReturnType<typeof getDesktopMessageMetrics> {
  const pointer = getWebMessageMetricPointer(message);
  const pointerSentAt = pointer.sent_at ?? 0;
  let oldest = metrics?.oldest;
  let newest = metrics?.newest;

  if (
    !oldest ||
    pointer.received_at < oldest.received_at ||
    (pointer.received_at === oldest.received_at &&
      pointerSentAt < (oldest.sent_at ?? 0))
  ) {
    oldest = pointer;
  }
  if (
    !newest ||
    pointer.received_at > newest.received_at ||
    (pointer.received_at === newest.received_at &&
      pointerSentAt > (newest.sent_at ?? 0))
  ) {
    newest = pointer;
  }

  return {
    newest,
    oldest,
    totalUnseen: 0,
  };
}

function getShellMessageIndexes(
  messages: ChatShellState['messages']
): Readonly<{
  idSet: ReadonlySet<string>;
  indexById: ReadonlyMap<string, number>;
  metricsByConversationId: ReadonlyMap<
    string,
    ReturnType<typeof getDesktopMessageMetrics>
  >;
  messagesByConversationId: ReadonlyMap<string, ReadonlyArray<WebMessage>>;
}> {
  if (shellMessageIndexSource !== messages) {
    shellMessageIndexSource = messages;
    shellMessageIndexById = new Map<string, number>();
    shellMessageIdSet = new Set<string>();
    const mutableMessagesByConversationId = new Map<
      string,
      Array<WebMessage>
    >();
    const mutableMetricsByConversationId = new Map<
      string,
      ReturnType<typeof getDesktopMessageMetrics>
    >();
    messages.forEach((message, index) => {
      shellMessageIndexById.set(message.id, index);
      shellMessageIdSet.add(message.id);
      const conversationMessages =
        mutableMessagesByConversationId.get(message.conversationId) ?? [];
      conversationMessages.push(message);
      mutableMessagesByConversationId.set(
        message.conversationId,
        conversationMessages
      );
      mutableMetricsByConversationId.set(
        message.conversationId,
        addWebMessageToMetrics(
          mutableMetricsByConversationId.get(message.conversationId),
          message
        )
      );
    });
    shellMessagesByConversationId = new Map(mutableMessagesByConversationId);
    shellMessageMetricsByConversationId = new Map(
      mutableMetricsByConversationId
    );
  }

  return {
    idSet: shellMessageIdSet,
    indexById: shellMessageIndexById,
    metricsByConversationId: shellMessageMetricsByConversationId,
    messagesByConversationId: shellMessagesByConversationId,
  };
}

function setShellMessageIndexes(
  messages: ChatShellState['messages'],
  idSet: Set<string>,
  indexById: Map<string, number>,
  metricsByConversationId: Map<
    string,
    ReturnType<typeof getDesktopMessageMetrics>
  >,
  messagesByConversationId: Map<string, ReadonlyArray<WebMessage>>
): void {
  shellMessageIndexSource = messages;
  shellMessageIdSet = idSet;
  shellMessageIndexById = indexById;
  shellMessageMetricsByConversationId = metricsByConversationId;
  shellMessagesByConversationId = messagesByConversationId;
}

function rebuildShellMessageIndexes(
  messages: ChatShellState['messages']
): void {
  shellMessageIndexSource = undefined;
  getShellMessageIndexes(messages);
}

function groupMessagesByConversation(
  messages: ReadonlyArray<WebMessage>
): Map<string, Array<WebMessage>> {
  const result = new Map<string, Array<WebMessage>>();
  for (const message of messages) {
    const conversationMessages = result.get(message.conversationId) ?? [];
    conversationMessages.push(message);
    result.set(message.conversationId, conversationMessages);
  }
  return result;
}

function appendUniqueMessagesSorted(
  currentMessages: ChatShellState['messages'],
  incomingMessages: ReadonlyArray<WebMessage>
): ChatShellState['messages'] {
  if (!incomingMessages.length) {
    return currentMessages;
  }

  const currentIndexes = getShellMessageIndexes(currentMessages);
  const { idSet } = currentIndexes;
  const uniqueMessages = new Array<WebMessage>();
  const incomingIds = new Set<string>();
  for (const message of incomingMessages) {
    if (idSet.has(message.id) || incomingIds.has(message.id)) {
      continue;
    }
    incomingIds.add(message.id);
    uniqueMessages.push(message);
  }

  if (!uniqueMessages.length) {
    return currentMessages;
  }

  const sortedIncoming =
    uniqueMessages.length === 1
      ? uniqueMessages
      : [...uniqueMessages].sort(compareWebMessages);

  const lastCurrent = currentMessages.at(-1);
  if (
    !lastCurrent ||
    compareWebMessages(lastCurrent, sortedIncoming[0] as WebMessage) <= 0
  ) {
    const nextMessages = [...currentMessages, ...sortedIncoming];
    const nextIdSet = new Set(idSet);
    const nextIndexById = new Map(currentIndexes.indexById);
    const nextMessagesByConversationId = new Map(
      currentIndexes.messagesByConversationId
    );
    const nextMetricsByConversationId = new Map(
      currentIndexes.metricsByConversationId
    );
    const incomingByConversation = groupMessagesByConversation(sortedIncoming);
    sortedIncoming.forEach((message, index) => {
      nextIdSet.add(message.id);
      nextIndexById.set(message.id, currentMessages.length + index);
      nextMetricsByConversationId.set(
        message.conversationId,
        addWebMessageToMetrics(
          nextMetricsByConversationId.get(message.conversationId),
          message
        )
      );
    });
    for (const [
      conversationId,
      conversationMessages,
    ] of incomingByConversation) {
      nextMessagesByConversationId.set(conversationId, [
        ...(nextMessagesByConversationId.get(conversationId) ?? []),
        ...conversationMessages,
      ]);
    }
    setShellMessageIndexes(
      nextMessages,
      nextIdSet,
      nextIndexById,
      nextMetricsByConversationId,
      nextMessagesByConversationId
    );
    return nextMessages;
  }

  const firstCurrent = currentMessages[0];
  if (
    firstCurrent &&
    compareWebMessages(
      sortedIncoming[sortedIncoming.length - 1] as WebMessage,
      firstCurrent
    ) <= 0
  ) {
    const nextMessages = [...sortedIncoming, ...currentMessages];
    rebuildShellMessageIndexes(nextMessages);
    return nextMessages;
  }

  const nextMessages = new Array<WebMessage>(
    currentMessages.length + sortedIncoming.length
  );
  let currentIndex = 0;
  let incomingIndex = 0;
  let writeIndex = 0;
  while (
    currentIndex < currentMessages.length ||
    incomingIndex < sortedIncoming.length
  ) {
    const current = currentMessages[currentIndex];
    const incoming = sortedIncoming[incomingIndex];
    if (
      incoming == null ||
      (current != null && compareWebMessages(current, incoming) <= 0)
    ) {
      nextMessages[writeIndex] = current as WebMessage;
      currentIndex += 1;
    } else {
      nextMessages[writeIndex] = incoming;
      incomingIndex += 1;
    }
    writeIndex += 1;
  }

  rebuildShellMessageIndexes(nextMessages);
  return nextMessages;
}

function upsertMessageSorted(
  currentMessages: ChatShellState['messages'],
  message: WebMessage
): ChatShellState['messages'] {
  const { indexById } = getShellMessageIndexes(currentMessages);
  const existingIndex = indexById.get(message.id);
  if (existingIndex == null) {
    return appendUniqueMessagesSorted(currentMessages, [message]);
  }

  const existing = currentMessages[existingIndex];
  if (existing === message) {
    return currentMessages;
  }

  const nextMessages = [...currentMessages];
  nextMessages.splice(existingIndex, 1);
  return appendUniqueMessagesSorted(nextMessages, [message]);
}

function replaceMessageById(
  currentMessages: ChatShellState['messages'],
  messageId: string,
  update: (message: WebMessage) => WebMessage
): Readonly<{
  messages: ChatShellState['messages'];
  existing: WebMessage | undefined;
  updated: WebMessage | undefined;
}> {
  const { indexById } = getShellMessageIndexes(currentMessages);
  const index = indexById.get(messageId);
  if (index == null) {
    return {
      existing: undefined,
      messages: currentMessages,
      updated: undefined,
    };
  }

  const existing = currentMessages[index] as WebMessage;
  const updated = update(existing);
  if (updated === existing) {
    return {
      existing,
      messages: currentMessages,
      updated,
    };
  }

  const nextMessages = [...currentMessages];
  nextMessages[index] = updated;
  const nextIdSet = new Set(shellMessageIdSet);
  const nextIndexById = new Map(shellMessageIndexById);
  const nextMetricsByConversationId = new Map(
    shellMessageMetricsByConversationId
  );
  const nextMessagesByConversationId = new Map(shellMessagesByConversationId);
  const existingConversationMessages = shellMessagesByConversationId.get(
    existing.conversationId
  );
  if (existing.conversationId !== updated.conversationId) {
    rebuildShellMessageIndexes(nextMessages);
    return {
      existing,
      messages: nextMessages,
      updated,
    };
  } else if (existingConversationMessages) {
    const conversationIndex = existingConversationMessages.findIndex(
      message => message.id === messageId
    );
    if (conversationIndex >= 0) {
      const nextConversationMessages = existingConversationMessages.slice();
      nextConversationMessages[conversationIndex] = updated;
      nextMessagesByConversationId.set(
        existing.conversationId,
        nextConversationMessages
      );
      nextMetricsByConversationId.set(
        existing.conversationId,
        getDesktopMessageMetricsFromWebMessages(nextConversationMessages)
      );
    } else {
      rebuildShellMessageIndexes(nextMessages);
      return {
        existing,
        messages: nextMessages,
        updated,
      };
    }
  }
  setShellMessageIndexes(
    nextMessages,
    nextIdSet,
    nextIndexById,
    nextMetricsByConversationId,
    nextMessagesByConversationId
  );
  return {
    existing,
    messages: nextMessages,
    updated,
  };
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

function shouldRequestWebAttachmentBackfill(
  attachment: WebAttachment
): boolean {
  if (
    isWebBackupOnlyAudioAttachment(attachment) ||
    isWebBackupOnlyVisualAttachment(attachment)
  ) {
    return true;
  }

  if (!isWebVisualAttachment(attachment)) {
    return false;
  }

  if (
    attachment.dataBase64 != null ||
    attachment.downloadPath != null ||
    attachment.localBlobKey != null ||
    attachment.path != null
  ) {
    return false;
  }

  return (
    !buildAttachmentAccessUrl(attachment) ||
    attachment.backfillError === true ||
    attachment.status === 'failed'
  );
}

type SignalWebRuntime = {
  writeProfile?: (
    conversation: ConversationType,
    options: AvatarUpdateOptionsType
  ) => Promise<void>;
  setPhoneNumberDiscoverability?: (discoverable: boolean) => Promise<void>;
  forwardMessages?: (
    conversationIds: ReadonlyArray<string>,
    drafts: ReadonlyArray<MessageForwardDraft>
  ) => Promise<boolean>;
  pinMessage?: (
    conversationId: string,
    pinMessage: WebPinMessage,
    timestamp: number
  ) => Promise<boolean>;
  unpinMessage?: (
    conversationId: string,
    unpinMessage: WebUnpinMessage,
    timestamp: number
  ) => Promise<boolean>;
  deleteMessagesForEveryone?: (
    messageIds: ReadonlyArray<string>
  ) => Promise<boolean>;
  reactToMessage?: (
    id: string,
    reaction: { emoji: Emoji.Variant; remove: boolean }
  ) => boolean;
  leaveGroup?: (conversationId: string) => Promise<boolean>;
  downloadAttachmentsForMessage?: (messageId: string) => Promise<boolean>;
  markAttachmentReady?: (messageId: string, attachmentPath: string) => void;
  markAttachmentUnavailable?: (
    messageId: string,
    attachmentPath: string
  ) => void;
  reserveUsername?: (
    usernameHashes: ReadonlyArray<string>
  ) => Promise<{ usernameHash: string }>;
  reserveUsernameByNickname?: (
    body: Readonly<{
      customDiscriminator?: string;
      maxNicknameLength: number;
      minNicknameLength: number;
      nickname: string;
      previousUsername?: string;
    }>
  ) => Promise<{ hashBase64: string; username: string }>;
  confirmUsername?: (
    body: Readonly<{
      encryptedUsername: string;
      usernameHash: string;
      zkProof: string;
    }>
  ) => Promise<{ usernameLinkHandle: string }>;
  confirmUsernameReservation?: (
    body: Readonly<{
      hashBase64: string;
      previousLinkEntropyBase64?: string;
      username: string;
    }>
  ) => Promise<{ entropyBase64: string; usernameLinkHandle: string }>;
  deleteUsername?: () => Promise<void>;
  replaceUsernameLink?: (
    body: Readonly<{
      keepLinkHandle: boolean;
      usernameLinkEncryptedValue: string;
    }>
  ) => Promise<{ usernameLinkHandle: string }>;
  resetUsernameLink?: (
    username: string
  ) => Promise<{ entropyBase64: string; usernameLinkHandle: string }>;
  syncUsernameProfile?: (username: string | undefined) => Promise<void>;
  createGroupV2?: (
    options: Readonly<{
      name: string;
      avatar: undefined | Uint8Array<ArrayBuffer>;
      expireTimer: undefined | number;
      conversationIds: ReadonlyArray<string>;
    }>
  ) => Promise<unknown>;
};

type BackupImportStatus = Extract<
  MessageStreamEvent,
  { type: 'backup-import-status' }
>['status'];

type BackupImportScreenState = Readonly<{
  bytes?: number;
  status: BackupImportStatus | 'idle';
}>;

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function uint8ArrayToBase64(value: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < value.length; index += chunkSize) {
    binary += String.fromCharCode(...value.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function renderEmpty(): JSX.Element {
  return <></>;
}

function renderGlobalModalContainer(): JSX.Element {
  return <SmartGlobalModalContainer />;
}

function renderLightbox(): JSX.Element {
  return <SmartLightbox />;
}

function WebBackupImportScreen({
  state,
}: Readonly<{
  state: BackupImportScreenState;
}>): JSX.Element {
  const i18n = useSelector(getIntl);
  const updates = useSelector(getUpdatesState);
  const backupStep =
    state.status === 'importing'
      ? InstallScreenBackupStep.Process
      : InstallScreenBackupStep.WaitForBackup;

  if (backupStep === InstallScreenBackupStep.Process) {
    const bytes = state.bytes && state.bytes > 0 ? state.bytes : 1;
    return (
      <InstallScreenBackupImportStep
        i18n={i18n}
        backupStep={backupStep}
        currentBytes={bytes}
        totalBytes={bytes}
        onCancel={() => undefined}
        onRetry={() => undefined}
        updates={updates}
        currentVersion={window.getVersion()}
        OS={window.Signal.OS.getName()}
        startUpdate={() => undefined}
        forceUpdate={() => undefined}
      />
    );
  }

  return (
    <InstallScreenBackupImportStep
      i18n={i18n}
      backupStep={backupStep}
      onCancel={() => undefined}
      onRetry={() => undefined}
      updates={updates}
      currentVersion={window.getVersion()}
      OS={window.Signal.OS.getName()}
      startUpdate={() => undefined}
      forceUpdate={() => undefined}
    />
  );
}

function shouldImportBackup(
  linkedSession: LinkedSessionRecord | undefined,
  shell: ChatShellState
): boolean {
  return Boolean(
    linkedSession?.linkedPayload.ephemeralBackupKeyBase64 &&
    shell.messages.length === 0
  );
}

function isDeviceDelinkedError(error: string | undefined): boolean {
  const normalizedError = error?.toLowerCase();
  return Boolean(
    normalizedError != null &&
    (normalizedError.includes(DEVICE_DELINKED_ERROR.toLowerCase()) ||
      normalizedError.includes('devicedelinked') ||
      normalizedError.includes('device delinked') ||
      normalizedError.includes('deregistered') ||
      normalizedError.includes('no longer authorized') ||
      normalizedError.includes('unauthorized') ||
      normalizedError === 'failed to open message stream: 401' ||
      normalizedError === 'failed to open message stream: 403' ||
      normalizedError.includes('request failed with status 401') ||
      normalizedError.includes('request failed with status 403'))
  );
}

export async function syncLinkedSessionUserStorage(
  linkedSession: LinkedSessionRecord | undefined
): Promise<void> {
  const credentials = linkedSession?.credentials;
  if (
    !credentials?.aci ||
    typeof credentials.deviceId !== 'number' ||
    !credentials.number
  ) {
    return;
  }

  if (credentials.pni && credentials.password) {
    await itemStorage.user.setCredentials({
      aci: credentials.aci as AciString,
      pni: normalizePni(
        credentials.pni,
        'WebDesktopApp.syncLinkedSessionUserStorage'
      ) as PniString,
      number: credentials.number,
      deviceId: credentials.deviceId,
      password: credentials.password,
    });
    await Registration.markDone();
    return;
  }

  await itemStorage.user.setAciAndDeviceId(
    credentials.aci as AciString,
    credentials.deviceId
  );
  await itemStorage.user.setNumber(credentials.number);
  await Registration.markDone();
}

function dispatchLinkedSessionUserState(
  linkedSession: LinkedSessionRecord | undefined
): void {
  const credentials = linkedSession?.credentials;
  if (!credentials?.aci) {
    return;
  }

  window.reduxActions?.user?.userChanged?.({
    ourAci: credentials.aci as StateType['user']['ourAci'],
    ourConversationId: credentials.aci,
    ourDeviceId: credentials.deviceId,
    ourNumber: credentials.number,
    ourPni: credentials.pni
      ? (normalizePni(
          credentials.pni,
          'WebDesktopApp.dispatchLinkedSessionUserState'
        ) as StateType['user']['ourPni'])
      : undefined,
  });
}

function mergeLinkedSessionAccount(
  linkedSession: LinkedSessionRecord,
  account: ContactsBootstrap['account']
): LinkedSessionRecord {
  if (!account) {
    return linkedSession;
  }

  const nextAccount = {
    ...linkedSession.account,
    ...account,
  };
  const nextLinkedPayloadAccount = {
    ...linkedSession.linkedPayload.account,
    ...account,
  };

  if (
    isEqual(linkedSession.account, nextAccount) &&
    isEqual(linkedSession.linkedPayload.account, nextLinkedPayloadAccount)
  ) {
    return linkedSession;
  }

  return {
    ...linkedSession,
    account: nextAccount,
    linkedPayload: {
      ...linkedSession.linkedPayload,
      account: nextLinkedPayloadAccount,
    },
    lastUpdatedAt: Date.now(),
  };
}

function mergeContactsBootstrapWithLinkedProfile(
  data: ContactsBootstrap,
  linkedSession: LinkedSessionRecord
): ContactsBootstrap {
  if (
    !data.account ||
    typeof linkedSession.account.localProfileUpdatedAt !== 'number'
  ) {
    return data;
  }

  const nextAccount = {
    ...data.account,
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

  if (isEqual(data.account, nextAccount)) {
    return data;
  }

  return {
    ...data,
    account: nextAccount,
  };
}

function updateNoteToSelfProfile(
  shell: ChatShellState,
  linkedSession: LinkedSessionRecord,
  account: LinkedSessionRecord['account']
): ChatShellState {
  const conversationId =
    linkedSession.credentials?.aci ?? linkedSession.account.aci;
  if (!conversationId) {
    return shell;
  }

  const existing = shell.conversationLookup[conversationId];
  if (!existing) {
    return shell;
  }

  const updated: WebConversation = {
    ...existing,
    about: 'about' in account ? account.about : existing.about,
    aboutEmoji:
      'aboutEmoji' in account ? account.aboutEmoji : existing.aboutEmoji,
    avatarUrl: 'avatarUrl' in account ? account.avatarUrl : existing.avatarUrl,
    avatarUrlPath:
      'avatarUrlPath' in account
        ? account.avatarUrlPath
        : existing.avatarUrlPath,
    e164: account.number ?? account.phoneNumber ?? existing.e164,
    familyName:
      account.familyName ?? account.profileFamilyName ?? existing.familyName,
    firstName: account.firstName ?? account.profileName ?? existing.firstName,
    phoneNumber: account.number ?? account.phoneNumber ?? existing.phoneNumber,
    profileFamilyName:
      account.profileFamilyName ??
      account.familyName ??
      existing.profileFamilyName,
    profileName:
      account.profileName ?? account.firstName ?? existing.profileName,
    username: account.username ?? existing.username,
  };
  const title = getConversationTitle(updated);

  return {
    ...shell,
    conversationLookup: {
      ...shell.conversationLookup,
      [conversationId]: {
        ...updated,
        searchableTitle: title,
        title,
        titleNoDefault: title,
      },
    },
  };
}

function WebInbox({
  isRelinkRequired,
  linkedSession,
  messageRuntimeSessionId,
  onRelinkDevice,
  shell,
  setShell,
}: Readonly<{
  isRelinkRequired: boolean;
  linkedSession: LinkedSessionRecord;
  onRelinkDevice: () => void;
  shell: ChatShellState;
  setShell: Dispatch<SetStateAction<ChatShellState>>;
  messageRuntimeSessionId?: string;
}>): JSX.Element {
  const navTabsCollapsed = useSelector(getNavTabsCollapsed);
  const { toggleNavTabsCollapse } = useItemsActions();

  return (
    <Inbox
      isCustomizingPreferredReactions={false}
      navTabsCollapsed={navTabsCollapsed}
      onToggleNavTabsCollapse={toggleNavTabsCollapse}
      renderChatsTab={() => (
        <WebChatsTab
          isRelinkRequired={isRelinkRequired}
          linkedSession={linkedSession}
          onRelinkDevice={onRelinkDevice}
          shell={shell}
          setShell={setShell}
          messageRuntimeSessionId={messageRuntimeSessionId}
        />
      )}
      renderCallsTab={renderEmpty}
      renderCustomizingPreferredReactionsModal={renderEmpty}
      renderNavTabs={props => <SmartNavTabs {...props} />}
      renderStoriesTab={renderEmpty}
      renderSettingsTab={() => <SmartPreferences isSignalWebRuntime />}
    />
  );
}

function WebDesktopAppBody({
  appState,
  backupImportScreenState,
  isRelinkRequired,
  linkedSession,
  messageRuntimeSessionId,
  onRelinkDevice,
  reloadLinkedSession,
  setShell,
  shell,
}: Readonly<{
  appState: StateType['app'];
  backupImportScreenState?: BackupImportScreenState;
  isRelinkRequired: boolean;
  linkedSession?: LinkedSessionRecord;
  messageRuntimeSessionId?: string;
  onRelinkDevice: () => void;
  reloadLinkedSession: () => Promise<void>;
  setShell: Dispatch<SetStateAction<ChatShellState>>;
  shell: ChatShellState;
}>): JSX.Element {
  const theme = useSelector(getTheme);

  return (
    <SmartFunProvider>
      <SmartVoiceNotesPlaybackProvider>
        <App
          state={appState}
          isMaximized={false}
          isFullScreen={false}
          osClassName={window.Signal.OS.getClassName()}
          renderCallManager={renderEmpty}
          renderGlobalModalContainer={renderGlobalModalContainer}
          renderInstallScreen={() =>
            backupImportScreenState ? (
              <WebBackupImportScreen state={backupImportScreenState} />
            ) : (
              <WebInstallScreen onLinked={reloadLinkedSession} />
            )
          }
          renderLightbox={renderLightbox}
          renderStandaloneRegistration={renderEmpty}
          hasSelectedStoryData={false}
          renderStoryViewer={renderEmpty}
          renderInbox={() =>
            linkedSession ? (
              <WebInbox
                isRelinkRequired={isRelinkRequired}
                linkedSession={linkedSession}
                onRelinkDevice={onRelinkDevice}
                shell={shell}
                setShell={setShell}
                messageRuntimeSessionId={messageRuntimeSessionId}
              />
            ) : (
              <WebInstallScreen onLinked={reloadLinkedSession} />
            )
          }
          theme={theme}
          scrollToMessage={() => undefined}
          viewStory={() => undefined}
        />
      </SmartVoiceNotesPlaybackProvider>
    </SmartFunProvider>
  );
}

function dispatchConversationNow(
  linkedSession: LinkedSessionRecord,
  conversationId: string,
  shell: ChatShellState
): Promise<void> {
  const conversation = shell.conversationLookup[conversationId];
  if (!conversation) {
    return Promise.resolve();
  }
  const desktopConversation = toDesktopConversation(
    conversation,
    linkedSession
  );
  return deferWebRuntimeSideEffect(() => {
    window.reduxActions?.conversations?.conversationsUpdated?.([
      desktopConversation as never,
    ]);
  });
}

function dispatchConversation(
  linkedSession: LinkedSessionRecord,
  conversationId: string,
  shell: ChatShellState
): void {
  void dispatchConversationNow(linkedSession, conversationId, shell);
}

function dispatchConversations(
  linkedSession: LinkedSessionRecord,
  shell: ChatShellState
): void {
  const conversations = Object.values(shell.conversationLookup).map(
    conversation => toDesktopConversation(conversation, linkedSession)
  );
  if (conversations.length > 0) {
    deferWebRuntimeSideEffect(() => {
      window.reduxActions?.conversations?.conversationsUpdated?.(
        conversations as never
      );
    });
  }
}

let conversationMessagesSource: ChatShellState['messages'] | undefined;
let conversationMessagesSourceVersion = 0;
const conversationMessagesById = new Map<string, ReadonlyArray<WebMessage>>();
const desktopMessagesByConversationId = new Map<
  string,
  Readonly<{
    desktopMessages: ReturnType<typeof toDesktopMessage>[];
    metrics: ReturnType<typeof getDesktopMessageMetrics>;
    sourceMessages: ReadonlyArray<WebMessage>;
  }>
>();
let pinnedMessagesSource: ChatShellState['pinnedMessages'] | undefined;
let pinnedMessagesSourceVersion = 0;
const lastMessagesResetKeyByConversationId = new Map<string, string>();

function getConversationMessagesFromShell(
  conversationId: string,
  shell: ChatShellState
): ReadonlyArray<WebMessage> {
  const { messagesByConversationId } = getShellMessageIndexes(shell.messages);
  if (conversationMessagesSource !== shell.messages) {
    conversationMessagesSource = shell.messages;
    conversationMessagesSourceVersion += 1;
    conversationMessagesById.clear();
    for (const [currentConversationId, messages] of messagesByConversationId) {
      conversationMessagesById.set(currentConversationId, messages);
    }
    for (const [currentConversationId, cached] of [
      ...desktopMessagesByConversationId,
    ]) {
      if (
        cached.sourceMessages !==
        messagesByConversationId.get(currentConversationId)
      ) {
        desktopMessagesByConversationId.delete(currentConversationId);
      }
    }
  }

  return conversationMessagesById.get(conversationId) ?? [];
}

function getConversationDesktopMessages(
  conversationId: string,
  shell: ChatShellState
): Readonly<{
  desktopMessages: ReturnType<typeof toDesktopMessage>[];
  metrics: ReturnType<typeof getDesktopMessageMetrics>;
}> {
  const { metricsByConversationId } = getShellMessageIndexes(shell.messages);
  const sourceMessages = getConversationMessagesFromShell(
    conversationId,
    shell
  );
  const cached = desktopMessagesByConversationId.get(conversationId);
  if (cached?.sourceMessages === sourceMessages) {
    return cached;
  }

  const pageMessages = sourceMessages.slice(
    Math.max(0, sourceMessages.length - MESSAGE_LOAD_CHUNK_SIZE)
  );
  pageMessages.forEach(registerMessageInCache);
  const desktopMessages = pageMessages.map(toDesktopMessage);
  const metrics =
    metricsByConversationId.get(conversationId) ??
    getDesktopMessageMetricsFromWebMessages(sourceMessages);
  const next = {
    desktopMessages,
    metrics,
    sourceMessages,
  };
  desktopMessagesByConversationId.set(conversationId, next);
  return next;
}

function getDesktopMessageMetricsFromWebMessages(
  messages: ReadonlyArray<WebMessage>
): ReturnType<typeof getDesktopMessageMetrics> {
  let oldest: ReturnType<typeof getDesktopMessageMetrics>['oldest'];
  let newest: ReturnType<typeof getDesktopMessageMetrics>['newest'];

  for (const message of messages) {
    const pointer = {
      id: message.id,
      received_at: message.receivedAt ?? message.timestamp,
      sent_at: message.timestamp,
    };
    if (
      !oldest ||
      pointer.received_at < oldest.received_at ||
      (pointer.received_at === oldest.received_at &&
        pointer.sent_at < (oldest.sent_at ?? 0))
    ) {
      oldest = pointer;
    }
    if (
      !newest ||
      pointer.received_at > newest.received_at ||
      (pointer.received_at === newest.received_at &&
        pointer.sent_at > (newest.sent_at ?? 0))
    ) {
      newest = pointer;
    }
  }

  return {
    newest,
    oldest,
    totalUnseen: 0,
  };
}

function getMessagesResetKey(
  conversationId: string,
  shell: ChatShellState
): string {
  if (pinnedMessagesSource !== shell.pinnedMessages) {
    pinnedMessagesSource = shell.pinnedMessages;
    pinnedMessagesSourceVersion += 1;
  }

  return [
    conversationId,
    conversationMessagesSourceVersion,
    pinnedMessagesSourceVersion,
  ].join(':');
}

function hasLoadedConversationMessages(conversationId: string): boolean {
  const state = window.reduxStore?.getState?.();
  const messageIds =
    state?.conversations?.messagesByConversation?.[conversationId]?.messageIds;
  return Array.isArray(messageIds) && messageIds.length > 0;
}

function dispatchConversationMessagesNow(
  conversationId: string,
  shell: ChatShellState
): Promise<boolean> {
  if (hasLoadedConversationMessages(conversationId)) {
    return Promise.resolve(false);
  }

  const { desktopMessages, metrics } = getConversationDesktopMessages(
    conversationId,
    shell
  );
  const resetKey = getMessagesResetKey(conversationId, shell);
  if (lastMessagesResetKeyByConversationId.get(conversationId) === resetKey) {
    return Promise.resolve(false);
  }

  const pinnedMessagesPreloadData =
    getWebPinnedMessagesPreloadDataForConversation(conversationId);
  const result = deferWebRuntimeSideEffect(() => {
    window.reduxActions?.conversations?.messagesReset?.({
      conversationId,
      messages: desktopMessages,
      metrics,
      pinnedMessagesPreloadData,
      unboundedFetch: true,
    });
  });
  lastMessagesResetKeyByConversationId.set(conversationId, resetKey);
  return result.then(() => true);
}

function dispatchConversationMessages(
  conversationId: string,
  shell: ChatShellState
): void {
  void dispatchConversationMessagesNow(conversationId, shell);
}

function getActiveConversationId(shell: ChatShellState): string | undefined {
  const state = window.reduxStore?.getState?.();
  if (state) {
    const selectedConversationId = getSelectedConversationId(state);
    if (selectedConversationId) {
      return selectedConversationId;
    }
  }

  return shell.selectedConversationId;
}

function dispatchShell(
  linkedSession: LinkedSessionRecord,
  shell: ChatShellState
): void {
  dispatchConversations(linkedSession, shell);
  const conversationId = getActiveConversationId(shell);
  if (conversationId && shell.conversationLookup[conversationId]) {
    dispatchConversationMessages(conversationId, shell);
  }
}

function dispatchMessage(event: MessageStreamEvent): Promise<void> {
  if (event.type !== 'message') {
    return Promise.resolve();
  }
  const message = event.message;
  const desktopMessage = toDesktopMessage(message);
  const isActive = document.visibilityState === 'visible';
  const result = dispatchMessagesAdded({
    conversationId: message.conversationId,
    isActive,
    isJustSent: message.direction === 'outgoing',
    isNewMessage: true,
    messages: [desktopMessage],
  });
  registerMessageInCache(message);
  return result;
}

const videoThumbnailTasks = new Set<string>();
const failedVideoThumbnailTasks = new Set<string>();

function getVideoThumbnailTaskKey(
  message: WebMessage,
  attachmentIndex: number
): string {
  const attachment = message.attachments?.[attachmentIndex];
  return [
    message.id,
    attachmentIndex,
    attachment?.id,
    attachment?.cdnKey,
    attachment?.cdnId,
    attachment?.plaintextHash,
  ]
    .filter((item): item is string | number => item != null)
    .join(':');
}

function canvasToDataUrl(
  video: HTMLVideoElement,
  sourceWidth: number,
  sourceHeight: number
): string | undefined {
  const scale = Math.min(
    1,
    VIDEO_THUMBNAIL_MAX_SIDE / Math.max(sourceWidth, sourceHeight)
  );
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    return undefined;
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', VIDEO_THUMBNAIL_QUALITY);
}

async function createVideoThumbnailUrl(
  attachment: NonNullable<WebMessage['attachments']>[number]
): Promise<
  | Readonly<{
      duration?: number;
      height?: number;
      thumbnailUrl: string;
      width?: number;
    }>
  | undefined
> {
  const sourceUrl = buildAttachmentAccessUrl(attachment);
  if (!sourceUrl) {
    return undefined;
  }

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('Video thumbnail generation timed out'));
      }, VIDEO_THUMBNAIL_TIMEOUT);
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Failed to load video metadata'));
      video.src = sourceUrl;
    });

    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }

    const width = video.videoWidth || attachment.width || 320;
    const height = video.videoHeight || attachment.height || 240;
    const duration =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : attachment.duration;

    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('Video thumbnail seek timed out'));
      }, VIDEO_THUMBNAIL_TIMEOUT);
      video.onseeked = () => resolve();
      video.onerror = () => reject(new Error('Failed to seek video'));
      try {
        video.currentTime = Math.min(0.1, duration ?? 0);
      } catch (error) {
        reject(error);
      }
    });

    const thumbnailUrl = canvasToDataUrl(video, width, height);
    if (!thumbnailUrl) {
      return undefined;
    }

    return {
      duration,
      height,
      thumbnailUrl,
      width,
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    video.removeAttribute('src');
    video.load();
  }
}

function getConversationTitleFromMessage(message: WebMessage): string {
  return (
    getGroupTitleFromMessage(message) ??
    message.sourceServiceId ??
    message.conversationId
  );
}

function getGroupTitleFromMessage(message: WebMessage): string | undefined {
  const detail = message.groupV2Change?.details.find(
    item => item.type === 'title'
  );
  return detail && 'newTitle' in detail && detail.newTitle
    ? detail.newTitle
    : undefined;
}

function getGroupDescriptionFromMessage(message: WebMessage): {
  description: string | undefined;
  didChange: boolean;
} {
  const detail = message.groupV2Change?.details.find(
    item => item.type === 'description'
  );
  if (!detail) {
    return { description: undefined, didChange: false };
  }
  if ('removed' in detail && detail.removed) {
    return { description: undefined, didChange: true };
  }
  return {
    description:
      'description' in detail && typeof detail.description === 'string'
        ? detail.description
        : undefined,
    didChange: true,
  };
}

function getDefaultGroupAccessControl(): NonNullable<
  WebConversation['accessControl']
> {
  const { AccessRequired } = Proto.AccessControl;
  return {
    attributes: AccessRequired.MEMBER,
    members: AccessRequired.MEMBER,
    addFromInviteLink: AccessRequired.UNSATISFIABLE,
    memberLabel: AccessRequired.MEMBER,
  };
}

function applyGroupV2ChangeToConversation(
  conversation: WebConversation,
  message: WebMessage,
  ourAci?: string
): WebConversation {
  const details = message.groupV2Change?.details;
  if (!details?.length) {
    return conversation;
  }

  let next = conversation;
  let accessControl =
    conversation.accessControl ?? getDefaultGroupAccessControl();

  const setAccessControl = (
    updates: Partial<NonNullable<WebConversation['accessControl']>>
  ): void => {
    accessControl = {
      ...accessControl,
      ...updates,
    };
    next = {
      ...next,
      accessControl,
    };
  };

  for (const detail of details) {
    switch (detail.type) {
      case 'access-members':
        setAccessControl({ members: detail.newPrivilege });
        break;
      case 'access-attributes':
        setAccessControl({ attributes: detail.newPrivilege });
        break;
      case 'access-member-label':
        setAccessControl({ memberLabel: detail.newPrivilege });
        break;
      case 'access-invite-link':
        setAccessControl({ addFromInviteLink: detail.newPrivilege });
        break;
      case 'announcements-only':
        next = {
          ...next,
          announcementsOnly: detail.announcementsOnly,
        };
        break;
      case 'member-remove':
        next = {
          ...next,
          membersV2: next.membersV2?.filter(
            member => member.aci !== detail.aci
          ),
          ...(ourAci === detail.aci
            ? {
                left: true,
              }
            : null),
        };
        break;
      case 'member-add':
      case 'member-add-from-link':
      case 'member-add-from-invite':
      case 'member-add-from-admin-approval':
        if (ourAci === detail.aci) {
          next = {
            ...next,
            left: false,
          };
        }
        break;
      default:
        break;
    }
  }

  return next;
}

function createConversationFromMessage(message: WebMessage): WebConversation {
  const timestamp = message.receivedAt ?? message.timestamp;
  const title = getConversationTitleFromMessage(message);
  const isIncoming = message.direction === 'incoming';
  const isGroup = message.groupV2 != null;
  const { description, didChange: didDescriptionChange } =
    getGroupDescriptionFromMessage(message);
  return {
    acceptedMessageRequest: isGroup || !isIncoming,
    id: message.conversationId,
    type: isGroup ? 'group' : 'direct',
    conversationType: isGroup ? 'group' : 'direct',
    serviceId: isGroup ? undefined : message.conversationId,
    title,
    titleNoDefault: title,
    searchableTitle: title,
    ...(didDescriptionChange ? { description } : null),
    activeAt: timestamp,
    lastUpdated: timestamp,
    timestamp,
    snippet: getWebMessagePreviewText(message),
    messageCount: 1,
    profileSharing: isGroup || !isIncoming,
    removalStage: !isGroup && isIncoming ? 'messageRequest' : undefined,
    sentMessageCount: isIncoming ? 0 : 1,
    unreadCount: isIncoming ? 1 : 0,
    hasMessages: true,
  };
}

function ensureConversationForMessage(
  shell: ChatShellState,
  message: WebMessage,
  ourConversationId?: string,
  options: Readonly<{ isNewMessage?: boolean }> = {}
): ChatShellState {
  const existing = shell.conversationLookup[message.conversationId];
  const timestamp = message.receivedAt ?? message.timestamp;
  const isNewMessage = options.isNewMessage !== false;
  const isUnreadIncoming =
    isNewMessage &&
    message.direction === 'incoming' &&
    message.readStatus === ReadStatus.Unread;
  if (existing) {
    const groupTitle = getGroupTitleFromMessage(message);
    const {
      description: groupDescription,
      didChange: didGroupDescriptionChange,
    } = getGroupDescriptionFromMessage(message);
    const shouldShowIncomingMessageRequest =
      message.direction === 'incoming' &&
      (existing.removalStage === 'justNotification' ||
        existing.removalStage === 'messageRequest' ||
        existing.acceptedMessageRequest === false);
    const nextConversation = applyGroupV2ChangeToConversation(
      {
        ...existing,
        ...(groupTitle
          ? {
              name: groupTitle,
              searchableTitle: groupTitle,
              title: groupTitle,
              titleNoDefault: groupTitle,
            }
          : null),
        ...(didGroupDescriptionChange
          ? {
              description: groupDescription,
            }
          : null),
        activeAt: timestamp,
        lastUpdated: timestamp,
        timestamp: message.timestamp,
        lastMessage: getWebConversationLastMessage(message, ourConversationId),
        lastMessageReceivedAt: message.timestamp,
        lastMessageReceivedAtMs: timestamp,
        inboxPosition: timestamp,
        groupId: message.groupV2?.id ?? existing.groupId,
        masterKey: message.groupV2?.masterKey ?? existing.masterKey,
        publicParams: message.groupV2?.publicParams ?? existing.publicParams,
        revision: message.groupV2?.revision ?? existing.revision,
        secretParams: message.groupV2?.secretParams ?? existing.secretParams,
        ...(message.expirationTimerUpdate
          ? {
              expireTimer: message.expirationTimerUpdate.expireTimer,
              expireTimerVersion: message.expireTimerVersion,
            }
          : null),
        snippet: getWebMessagePreviewText(message) || existing.snippet,
        messageCount: (existing.messageCount ?? 0) + (isNewMessage ? 1 : 0),
        sentMessageCount:
          isNewMessage && message.direction === 'outgoing'
            ? (existing.sentMessageCount ?? 0) + 1
            : existing.sentMessageCount,
        messagesDeleted: undefined,
        unreadCount: isUnreadIncoming
          ? (existing.unreadCount ?? 0) + 1
          : existing.unreadCount,
        hasMessages: true,
        ...(shouldShowIncomingMessageRequest
          ? {
              acceptedMessageRequest: false,
              isArchived: false,
              removalStage: 'messageRequest' as const,
            }
          : null),
      },
      message,
      ourConversationId
    );
    return {
      ...shell,
      conversationLookup: {
        ...shell.conversationLookup,
        [message.conversationId]: nextConversation,
      },
    };
  }

  return {
    ...shell,
    conversationLookup: {
      ...shell.conversationLookup,
      [message.conversationId]: applyGroupV2ChangeToConversation(
        {
          ...createConversationFromMessage(message),
          groupId: message.groupV2?.id,
          masterKey: message.groupV2?.masterKey,
          publicParams: message.groupV2?.publicParams,
          revision: message.groupV2?.revision,
          secretParams: message.groupV2?.secretParams,
          lastMessage: getWebConversationLastMessage(
            message,
            ourConversationId
          ),
          lastMessageReceivedAt: message.timestamp,
          lastMessageReceivedAtMs: timestamp,
          inboxPosition: timestamp,
          ...(message.expirationTimerUpdate
            ? {
                expireTimer: message.expirationTimerUpdate.expireTimer,
                expireTimerVersion: message.expireTimerVersion,
              }
            : null),
        },
        message,
        ourConversationId
      ),
    },
  };
}

function updateConversationForChangedMessage(
  shell: ChatShellState,
  message: WebMessage,
  ourConversationId?: string
): ChatShellState {
  const existing = shell.conversationLookup[message.conversationId];
  if (!existing) {
    return shell;
  }

  const timestamp = message.receivedAt ?? message.timestamp;
  const currentActivity = getConversationListSortTimestamp(existing);
  if (currentActivity > timestamp) {
    return shell;
  }

  return {
    ...shell,
    conversationLookup: {
      ...shell.conversationLookup,
      [message.conversationId]: {
        ...existing,
        lastMessage: message.deletedForEveryone
          ? { deletedForEveryone: true as const }
          : getWebConversationLastMessage(message, ourConversationId),
        snippet: message.deletedForEveryone
          ? existing.snippet
          : getWebMessagePreviewText(message) || existing.snippet,
      },
    },
  };
}

function createPinnedNotificationMessage({
  conversationId,
  pinMessage,
  receivedAt,
  senderAci,
  timestamp,
}: Readonly<{
  conversationId: string;
  pinMessage: WebPinMessage;
  receivedAt: number;
  senderAci: string;
  timestamp: number;
}>): WebMessage {
  return {
    id: `web-pinned-notification:${conversationId}:${timestamp}:${pinMessage.targetSentTimestamp}`,
    body: '',
    conversationId,
    desktopType: 'pinned-message-notification',
    direction: 'incoming',
    pinMessage,
    receivedAt,
    sourceServiceId: senderAci,
    timestamp,
  };
}

function mergeMessages(
  left: ReadonlyArray<ChatShellState['messages'][number]>,
  right: ReadonlyArray<ChatShellState['messages'][number]>
): ReadonlyArray<ChatShellState['messages'][number]> {
  const byId = new Map<string, ChatShellState['messages'][number]>();
  for (const message of left) {
    byId.set(message.id, message);
  }
  for (const message of right) {
    if (!byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort(compareWebMessages);
}

function mergePinnedMessages(
  left: ReadonlyArray<PinnedMessage>,
  right: ReadonlyArray<PinnedMessage>
): ReadonlyArray<PinnedMessage> {
  const byMessageId = new Map<string, PinnedMessage>();
  for (const pinnedMessage of left) {
    byMessageId.set(pinnedMessage.messageId, pinnedMessage);
  }
  for (const pinnedMessage of right) {
    const existing = byMessageId.get(pinnedMessage.messageId);
    if (!existing || pinnedMessage.pinnedAt > existing.pinnedAt) {
      byMessageId.set(pinnedMessage.messageId, pinnedMessage);
    }
  }
  return [...byMessageId.values()].sort(
    (leftPinnedMessage, rightPinnedMessage) =>
      leftPinnedMessage.pinnedAt - rightPinnedMessage.pinnedAt
  );
}

function mergeChatShellState(
  current: ChatShellState,
  incoming: ChatShellState
): ChatShellState {
  const conversationLookup: Record<string, WebConversation> = {};
  for (const conversationId of new Set([
    ...Object.keys(incoming.conversationLookup),
    ...Object.keys(current.conversationLookup),
  ])) {
    const currentConversation = current.conversationLookup[conversationId];
    const incomingConversation = incoming.conversationLookup[conversationId];
    if (currentConversation == null && incomingConversation != null) {
      conversationLookup[conversationId] = incomingConversation;
      continue;
    }
    if (incomingConversation == null && currentConversation != null) {
      conversationLookup[conversationId] = currentConversation;
      continue;
    }
    if (currentConversation == null || incomingConversation == null) {
      continue;
    }

    const currentTimestamp =
      getConversationListSortTimestamp(currentConversation);
    const incomingTimestamp =
      getConversationListSortTimestamp(incomingConversation);
    conversationLookup[conversationId] =
      incomingTimestamp > currentTimestamp
        ? {
            ...currentConversation,
            ...incomingConversation,
            messagesDeleted:
              currentConversation.messagesDeleted === true &&
              incomingConversation.hasMessages !== true
                ? true
                : incomingConversation.messagesDeleted,
            activeAt:
              currentConversation.messagesDeleted === true &&
              incomingConversation.hasMessages !== true
                ? undefined
                : incomingConversation.activeAt,
            left: incomingConversation.left ?? currentConversation.left,
          }
        : {
            ...incomingConversation,
            ...currentConversation,
            activeAt:
              currentConversation.messagesDeleted === true
                ? undefined
                : currentConversation.activeAt,
            left: currentConversation.left ?? incomingConversation.left,
          };
  }

  return {
    selectedConversationId:
      current.selectedConversationId ?? incoming.selectedConversationId,
    conversationLookup,
    messages: mergeMessages(current.messages, incoming.messages),
    pinnedMessages: mergePinnedMessages(
      current.pinnedMessages ?? [],
      incoming.pinnedMessages ?? []
    ),
  };
}

function markConversationRead(
  shell: ChatShellState,
  conversationId: string
): ChatShellState {
  const existing = shell.conversationLookup[conversationId];
  if (!existing) {
    return shell;
  }

  return {
    ...shell,
    conversationLookup: {
      ...shell.conversationLookup,
      [conversationId]: {
        ...existing,
        markedUnread: false,
        unreadCount: 0,
      },
    },
  };
}

function applyOutgoingReactionToMessage({
  message,
  reaction,
  timestamp,
  isSent,
  ourConversationId,
}: Readonly<{
  message: WebMessage;
  reaction: { emoji: Emoji.Variant; remove: boolean };
  timestamp: number;
  isSent: boolean;
  ourConversationId: string;
}>): WebMessage {
  const reactions = (message.reactions ?? []).filter(
    item => item.fromId !== ourConversationId
  );

  if (reaction.remove) {
    return {
      ...message,
      reactions,
    };
  }

  const nextReaction: MessageReactionType = {
    emoji: reaction.emoji,
    fromId: ourConversationId,
    targetTimestamp: message.timestamp,
    timestamp,
    isSentByConversationId: {
      [message.conversationId]: isSent,
    },
  };

  return {
    ...message,
    reactions: [...reactions, nextReaction],
  };
}

function getWebMessageAuthorAci(
  message: WebMessage,
  ourConversationId: string
): string | undefined {
  return message.direction === 'outgoing'
    ? ourConversationId
    : message.sourceServiceId;
}

function getWebMessageSentTimestamp(message: WebMessage): number {
  return message.editMessageTimestamp ?? message.timestamp;
}

function findWebMessageByAuthorAndTimestamp({
  conversationId,
  messages,
  ourConversationId,
  targetAuthorAci,
  targetTimestamp,
}: Readonly<{
  conversationId: string;
  messages: ReadonlyArray<WebMessage>;
  ourConversationId: string;
  targetAuthorAci: string | undefined;
  targetTimestamp: number;
}>): WebMessage | undefined {
  if (!targetAuthorAci) {
    return undefined;
  }

  return messages.find(message => {
    return (
      message.conversationId === conversationId &&
      getWebMessageAuthorAci(message, ourConversationId) === targetAuthorAci &&
      getWebMessageSentTimestamp(message) === targetTimestamp
    );
  });
}

function applyRemoteEditToMessage(
  message: WebMessage,
  edit: MessageStreamEvent & { type: 'edit-message' }
): WebMessage {
  if (
    message.editHistory?.some(item => item.timestamp === edit.message.timestamp)
  ) {
    return message;
  }

  const receivedAt = edit.message.receivedAt ?? edit.timestamp;
  const originalEditHistory: ReadonlyArray<EditHistoryType> =
    message.editHistory ?? [
      {
        attachments: message.attachments,
        body: message.body,
        bodyAttachment: message.bodyAttachment,
        bodyRanges: message.bodyRanges,
        preview: message.preview,
        quote: message.quote,
        timestamp: message.timestamp,
        received_at: message.receivedAt ?? message.timestamp,
        received_at_ms: message.receivedAt ?? message.timestamp,
        serverTimestamp: message.timestamp,
        readStatus: message.readStatus,
      } as EditHistoryType,
    ];
  const editedMessage: EditHistoryType = {
    attachments: message.attachments,
    body: edit.message.body,
    bodyAttachment: edit.message.bodyAttachment,
    bodyRanges: edit.message.bodyRanges,
    preview: edit.message.preview,
    quote: edit.message.quote ? message.quote : undefined,
    timestamp: edit.message.timestamp,
    received_at: receivedAt,
    received_at_ms: receivedAt,
    serverTimestamp: edit.timestamp,
    readStatus: message.readStatus,
  } as EditHistoryType;

  return {
    ...message,
    body: editedMessage.body,
    bodyAttachment: editedMessage.bodyAttachment,
    bodyRanges: editedMessage.bodyRanges,
    editHistory: [editedMessage, ...originalEditHistory],
    editMessageTimestamp: editedMessage.timestamp,
    editMessageReceivedAt: editedMessage.received_at,
    editMessageReceivedAtMs: editedMessage.received_at_ms,
    preview: editedMessage.preview,
    quote: edit.message.quote ? message.quote : undefined,
  };
}

function eraseWebMessageForEveryone(
  message: WebMessage,
  event: MessageStreamEvent & { type: 'delete-message' }
): WebMessage {
  if (message.deletedForEveryone) {
    return message;
  }

  return {
    ...message,
    attachments: [],
    body: undefined,
    bodyAttachment: undefined,
    contact: undefined,
    deletedForEveryone: true,
    deletedForEveryoneByAdminAci: event.isAdminDelete
      ? event.senderAci
      : undefined,
    deletedForEveryoneTimestamp: event.timestamp,
    preview: undefined,
    quote: undefined,
    reactions: [],
    sticker: undefined,
  };
}

function getReceiptStatus(
  receiptType: number | null
): WebMessage['status'] | undefined {
  if (receiptType === 0) {
    return 'delivered';
  }
  if (receiptType === 1 || receiptType === 2) {
    return 'read';
  }
  return undefined;
}

function getWebMessagePoll(message: WebMessage): WebMessage['poll'] {
  if (message.poll) {
    return message.poll;
  }
  if (!message.pollCreate) {
    return undefined;
  }

  return {
    question: message.pollCreate.question ?? '',
    options: message.pollCreate.options ?? [],
    allowMultiple: Boolean(message.pollCreate.allowMultiple),
  };
}

function applyPollVoteToMessage(
  message: WebMessage,
  event: MessageStreamEvent & { type: 'poll-vote' }
): WebMessage | undefined {
  const poll = getWebMessagePoll(message);
  if (!poll) {
    return undefined;
  }

  const existingVotes = (poll.votes ?? []).filter(
    vote => vote.fromConversationId !== event.senderAci
  );
  const previousVote = (poll.votes ?? []).find(
    vote => vote.fromConversationId === event.senderAci
  );
  if (
    previousVote?.timestamp === event.timestamp &&
    previousVote.voteCount === event.voteCount &&
    previousVote.optionIndexes.length === event.optionIndexes.length &&
    previousVote.optionIndexes.every(
      (optionIndex, index) => optionIndex === event.optionIndexes[index]
    )
  ) {
    return message;
  }

  const nextVotes =
    event.optionIndexes.length === 0
      ? existingVotes
      : [
          ...existingVotes,
          {
            fromConversationId: event.senderAci,
            optionIndexes: event.optionIndexes,
            voteCount: event.voteCount,
            timestamp: event.timestamp,
          },
        ];

  return {
    ...message,
    poll: {
      ...poll,
      votes: nextVotes,
    },
  };
}

function applyPollTerminateToMessage(
  message: WebMessage,
  event: MessageStreamEvent & { type: 'poll-terminate' }
): WebMessage | undefined {
  const poll = getWebMessagePoll(message);
  if (!poll) {
    return undefined;
  }
  if (poll.terminatedAt) {
    return message;
  }

  return {
    ...message,
    poll: {
      ...poll,
      terminatedAt: event.timestamp,
    },
  };
}

function applyRemoteReactionToMessage({
  message,
  emoji,
  fromId,
  remove,
  timestamp,
  targetTimestamp,
}: Readonly<{
  message: WebMessage;
  emoji?: string;
  fromId: string;
  remove: boolean;
  timestamp: number;
  targetTimestamp: number;
}>): WebMessage {
  const existingReaction = message.reactions?.find(
    item => item.fromId === fromId
  );
  if (
    existingReaction?.emoji === emoji &&
    existingReaction?.timestamp === timestamp &&
    existingReaction?.targetTimestamp === targetTimestamp &&
    !remove
  ) {
    return message;
  }
  if (!existingReaction && (remove || !emoji)) {
    return message;
  }

  const reactions = (message.reactions ?? []).filter(
    item => item.fromId !== fromId
  );

  if (remove || !emoji) {
    return {
      ...message,
      reactions,
    };
  }

  const nextReaction: MessageReactionType = {
    emoji: emoji as Emoji.Variant,
    fromId,
    targetTimestamp,
    timestamp,
  };

  return {
    ...message,
    reactions: [...reactions, nextReaction],
  };
}

export function WebDesktopApp({
  initialLinkedSession,
  initialShell,
  store,
}: Readonly<{
  initialLinkedSession?: LinkedSessionRecord;
  initialShell: ChatShellState;
  store: Store<StateType>;
}>): JSX.Element {
  const [linkedSession, setLinkedSession] = useState(initialLinkedSession);
  const [shell, setShell] = useState(initialShell);
  const linkedSessionRef = useRef(linkedSession);
  const shellRef = useRef(shell);
  const storageContactsRef = useRef<ContactsBootstrap | undefined>(undefined);
  const contactsSyncOnOpenPromiseRef = useRef<Promise<void> | undefined>(
    undefined
  );
  const lastContactsSyncOnOpenAtRef = useRef(0);
  const [messageRuntimeSessionId, setMessageRuntimeSessionId] =
    useState<string>();
  const [backupImportScreenState, setBackupImportScreenState] =
    useState<BackupImportScreenState>();
  const [isRelinkRequired, setIsRelinkRequired] = useState(false);

  useEffect(() => {
    linkedSessionRef.current = linkedSession;
  }, [linkedSession]);

  useEffect(() => {
    shellRef.current = shell;
  }, [shell]);

  useEffect(() => {
    if (initialLinkedSession) {
      dispatchShell(initialLinkedSession, initialShell);
    }
  }, [initialLinkedSession, initialShell]);

  const messageStreamSessionKey = useMemo(() => {
    if (!linkedSession?.credentials?.aci) {
      return undefined;
    }

    return [
      linkedSession.linkedAt,
      linkedSession.credentials.aci,
      linkedSession.credentials.deviceId,
      linkedSession.credentials.username,
    ].join(':');
  }, [
    linkedSession?.credentials?.aci,
    linkedSession?.credentials?.deviceId,
    linkedSession?.credentials?.username,
    linkedSession?.linkedAt,
  ]);

  const persistShellToStorage = useCallback(
    (next: ChatShellState) => {
      void persistChatShellStateToStorage(
        next,
        linkedSession?.credentials?.aci
      );
    },
    [linkedSession?.credentials?.aci]
  );

  const persistShell = useCallback(
    (next: ChatShellState) => {
      setWebRuntimeChatShell(next);
      persistShellToStorage(next);
    },
    [persistShellToStorage]
  );

  useEffect(() => {
    const syncSelectedConversationId = (): void => {
      const selectedConversationId = getSelectedConversationId(
        store.getState()
      );
      if (!selectedConversationId) {
        return;
      }

      setShell(current => {
        if (
          current.selectedConversationId === selectedConversationId ||
          !current.conversationLookup[selectedConversationId]
        ) {
          return current;
        }

        const next = {
          ...current,
          selectedConversationId,
        };
        return next;
      });
    };

    syncSelectedConversationId();
    return store.subscribe(syncSelectedConversationId);
  }, [store]);

  useEffect(() => {
    setWebRuntimePinnedMessagesChanged(pinnedMessages => {
      setShell(current => {
        const next = {
          ...current,
          pinnedMessages,
        };
        persistShell(next);
        return next;
      });
    });

    return () => {
      setWebRuntimePinnedMessagesChanged(undefined);
    };
  }, [persistShell]);

  useEffect(() => {
    for (const message of shell.messages) {
      const attachments = message.attachments ?? [];
      for (
        let attachmentIndex = 0;
        attachmentIndex < attachments.length;
        attachmentIndex += 1
      ) {
        const attachment = attachments[attachmentIndex];
        if (
          !attachment ||
          !attachment.contentType?.startsWith('video/') ||
          attachment.thumbnailUrl ||
          attachment.thumbnail ||
          attachment.backfillError ||
          attachment.status === 'failed'
        ) {
          continue;
        }

        const taskKey = getVideoThumbnailTaskKey(message, attachmentIndex);
        if (
          videoThumbnailTasks.has(taskKey) ||
          failedVideoThumbnailTasks.has(taskKey)
        ) {
          continue;
        }

        videoThumbnailTasks.add(taskKey);
        void createVideoThumbnailUrl(attachment)
          .then(result => {
            if (!result) {
              failedVideoThumbnailTasks.add(taskKey);
              return;
            }

            setShell(current => {
              const { messages, existing, updated } = replaceMessageById(
                current.messages,
                message.id,
                currentMessage => {
                  const currentAttachment =
                    currentMessage.attachments?.[attachmentIndex];
                  if (
                    !currentAttachment ||
                    currentAttachment.thumbnailUrl ||
                    currentAttachment.thumbnail ||
                    !currentAttachment.contentType?.startsWith('video/')
                  ) {
                    return currentMessage;
                  }

                  return {
                    ...currentMessage,
                    attachments: currentMessage.attachments?.map(
                      (item, index) =>
                        index === attachmentIndex
                          ? {
                              ...item,
                              duration: item.duration ?? result.duration,
                              height: item.height ?? result.height,
                              thumbnailUrl: result.thumbnailUrl,
                              width: item.width ?? result.width,
                            }
                          : item
                    ),
                  };
                }
              );
              if (!existing || !updated || updated === existing) {
                return current;
              }
              const next = {
                ...current,
                messages,
              };
              persistShell(next);
              registerMessageInCache(updated);
              dispatchMessageChanged(
                updated.id,
                updated.conversationId,
                toDesktopMessage(updated)
              );
              return next;
            });
          })
          .catch(error => {
            failedVideoThumbnailTasks.add(taskKey);
            console.warn('Failed to generate web video thumbnail', error);
          })
          .finally(() => {
            videoThumbnailTasks.delete(taskKey);
          });
      }
    }
  }, [persistShell, shell.messages]);

  useEffect(() => {
    setWebRuntimeChatShell(shell);
  }, [shell]);

  useEffect(() => {
    setBackupImportScreenState(undefined);
  }, [linkedSession?.linkedAt]);

  useEffect(() => {
    const runtimeWindow = window as typeof window & {
      SignalWebRuntime?: SignalWebRuntime;
    };

    const clearAttachmentBackfillTimeout = (messageId: string): void => {
      const existing = pendingAttachmentBackfillTimeouts.get(messageId);
      if (existing != null) {
        window.clearTimeout(existing);
        pendingAttachmentBackfillTimeouts.delete(messageId);
      }
    };

    const clearPendingBackfillForMessage = (messageId: string): void => {
      setShell(current => {
        const { messages, existing, updated } = replaceMessageById(
          current.messages,
          messageId,
          target => {
            if (!target.attachments?.length) {
              return target;
            }

            let didChange = false;
            const nextMessage: WebMessage = {
              ...target,
              attachments: target.attachments.map(attachment => {
                if (attachment.status !== 'pending') {
                  return attachment;
                }

                didChange = true;
                const nextAttachment = { ...attachment };
                delete nextAttachment.status;
                return nextAttachment;
              }),
            };
            return didChange ? nextMessage : target;
          }
        );
        if (!existing || !updated || updated === existing) {
          return current;
        }

        const next = {
          ...current,
          messages,
        };
        persistShell(next);
        registerMessageInCache(updated);
        dispatchMessageChanged(
          updated.id,
          updated.conversationId,
          toDesktopMessage(updated)
        );
        return next;
      });
    };

    const showBackfillFailureModal = (kind: BackfillFailureModalKind): void => {
      window.reduxActions?.globalModals?.showBackfillFailureModal?.(kind);
    };

    const scheduleAttachmentBackfillTimeout = (messageId: string): void => {
      clearAttachmentBackfillTimeout(messageId);
      const timeout = window.setTimeout(() => {
        pendingAttachmentBackfillTimeouts.delete(messageId);
        clearPendingBackfillForMessage(messageId);
        showBackfillFailureModal(BackfillFailureModalKind.Timeout);
      }, ATTACHMENT_BACKFILL_REQUEST_TIMEOUT);
      pendingAttachmentBackfillTimeouts.set(messageId, timeout);
    };

    runtimeWindow.SignalWebRuntime = {
      ...(runtimeWindow.SignalWebRuntime ?? {}),
      async writeProfile(conversation, options) {
        if (!linkedSession) {
          throw new Error('writeProfile: linked session is not available');
        }
        if (!messageRuntimeSessionId) {
          throw new Error(
            'writeProfile: message runtime session is not available'
          );
        }
        const firstName = conversation.firstName;
        if (!firstName) {
          throw new Error('writeProfile: missing firstName');
        }

        let localAvatarUrl: string | undefined;
        let avatarBase64: string | undefined;
        let shouldClearAvatar = false;
        if (!options.keepAvatar) {
          const { newAvatar } = options.avatarUpdate;
          if (newAvatar) {
            avatarBase64 = uint8ArrayToBase64(newAvatar);
            localAvatarUrl = `data:image/jpeg;base64,${avatarBase64}`;
          } else {
            shouldClearAvatar = true;
          }
        }

        const timestamp = Date.now();
        const result = await writeSignalProfile({
          aboutEmoji: conversation.aboutEmoji,
          aboutText: conversation.aboutText,
          avatarBase64,
          familyName: conversation.familyName,
          firstName,
          hasOtherDevices: true,
          phoneNumberSharing: isSharingPhoneNumberWithEverybody(),
          removeAvatar: shouldClearAvatar,
          runtimeSessionId: messageRuntimeSessionId,
          timestamp,
        });
        const account = {
          ...result.account,
          ...(localAvatarUrl
            ? {
                avatarUrl: localAvatarUrl,
              }
            : null),
          ...(shouldClearAvatar
            ? {
                avatarUrl: undefined,
                avatarUrlPath: undefined,
              }
            : null),
        };

        const nextLinkedSessionBase = mergeLinkedSessionAccount(
          linkedSession,
          account
        );
        const nextLinkedSession: LinkedSessionRecord = result.protocol
          ? {
              ...nextLinkedSessionBase,
              protocol: result.protocol,
            }
          : nextLinkedSessionBase;
        const storedContacts = storageContactsRef.current;
        if (storedContacts) {
          const nextContacts = {
            ...storedContacts,
            account: {
              ...storedContacts.account,
              ...account,
            },
          };
          storageContactsRef.current = nextContacts;
          void persistContactsBootstrapForSession(
            nextLinkedSession.credentials?.aci,
            nextContacts
          );
        }
        persistLinkedSessionToStorage(nextLinkedSession);
        void persistLinkedSessionRecordToIndexedDb(nextLinkedSession);
        setLinkedSession(nextLinkedSession);

        setShell(current => {
          const next = updateNoteToSelfProfile(
            current,
            nextLinkedSession,
            nextLinkedSession.account
          );
          if (next === current) {
            return current;
          }
          persistShell(next);
          const ourConversationId =
            nextLinkedSession.credentials?.aci ?? nextLinkedSession.account.aci;
          if (ourConversationId) {
            dispatchConversation(nextLinkedSession, ourConversationId, next);
          }
          return next;
        });
      },
      async setPhoneNumberDiscoverability(discoverable) {
        if (!messageRuntimeSessionId) {
          throw new Error(
            'setPhoneNumberDiscoverability: message runtime session is not available'
          );
        }

        await setSignalPhoneNumberDiscoverability({
          discoverable,
          runtimeSessionId: messageRuntimeSessionId,
        });
      },
      async reserveUsername(usernameHashes) {
        if (!messageRuntimeSessionId) {
          throw new Error(
            'reserveUsername: message runtime session is not available'
          );
        }

        return reserveSignalUsername({
          runtimeSessionId: messageRuntimeSessionId,
          usernameHashes,
        });
      },
      async reserveUsernameByNickname(body) {
        if (!messageRuntimeSessionId) {
          throw new Error(
            'reserveUsernameByNickname: message runtime session is not available'
          );
        }

        return reserveSignalUsernameByNickname({
          ...body,
          runtimeSessionId: messageRuntimeSessionId,
        });
      },
      async confirmUsername(body) {
        if (!messageRuntimeSessionId) {
          throw new Error(
            'confirmUsername: message runtime session is not available'
          );
        }

        return confirmSignalUsername({
          ...body,
          runtimeSessionId: messageRuntimeSessionId,
        });
      },
      async confirmUsernameReservation(body) {
        if (!messageRuntimeSessionId) {
          throw new Error(
            'confirmUsernameReservation: message runtime session is not available'
          );
        }

        return confirmSignalUsernameReservation({
          ...body,
          runtimeSessionId: messageRuntimeSessionId,
        });
      },
      async deleteUsername() {
        if (!messageRuntimeSessionId) {
          throw new Error(
            'deleteUsername: message runtime session is not available'
          );
        }

        await deleteSignalUsername({
          runtimeSessionId: messageRuntimeSessionId,
        });
      },
      async replaceUsernameLink(body) {
        if (!messageRuntimeSessionId) {
          throw new Error(
            'replaceUsernameLink: message runtime session is not available'
          );
        }

        return replaceSignalUsernameLink({
          ...body,
          runtimeSessionId: messageRuntimeSessionId,
        });
      },
      async resetUsernameLink(username) {
        if (!messageRuntimeSessionId) {
          throw new Error(
            'resetUsernameLink: message runtime session is not available'
          );
        }

        return resetSignalUsernameLink({
          runtimeSessionId: messageRuntimeSessionId,
          username,
        });
      },
      async syncUsernameProfile(username) {
        if (!linkedSession) {
          throw new Error(
            'syncUsernameProfile: linked session is not available'
          );
        }
        if (!messageRuntimeSessionId) {
          throw new Error(
            'syncUsernameProfile: message runtime session is not available'
          );
        }

        const result = await syncSignalUsernameProfile({
          runtimeSessionId: messageRuntimeSessionId,
          timestamp: Date.now(),
          username,
        });
        const account =
          username === undefined
            ? {
                ...result.account,
                username,
              }
            : result.account;

        const nextLinkedSessionBase = mergeLinkedSessionAccount(
          linkedSession,
          account
        );
        const nextLinkedSession: LinkedSessionRecord = result.protocol
          ? {
              ...nextLinkedSessionBase,
              protocol: result.protocol,
            }
          : nextLinkedSessionBase;
        const storedContacts = storageContactsRef.current;
        if (storedContacts) {
          const nextContacts = {
            ...storedContacts,
            account: {
              ...storedContacts.account,
              ...account,
            },
          };
          storageContactsRef.current = nextContacts;
          void persistContactsBootstrapForSession(
            nextLinkedSession.credentials?.aci,
            nextContacts
          );
        }
        persistLinkedSessionToStorage(nextLinkedSession);
        void persistLinkedSessionRecordToIndexedDb(nextLinkedSession);
        setLinkedSession(nextLinkedSession);

        setShell(current => {
          const next = updateNoteToSelfProfile(
            current,
            nextLinkedSession,
            nextLinkedSession.account
          );
          if (next === current) {
            return current;
          }
          persistShell(next);
          const ourConversationId =
            nextLinkedSession.credentials?.aci ?? nextLinkedSession.account.aci;
          if (ourConversationId) {
            dispatchConversation(nextLinkedSession, ourConversationId, next);
          }
          return next;
        });
      },
      async createGroupV2({ avatar, conversationIds, expireTimer, name }) {
        if (!linkedSession) {
          throw new Error('createGroupV2: linked session is not available');
        }
        const group = await createGroupConversation({
          avatar: avatar ? uint8ArrayToBase64(avatar) : undefined,
          conversationIds,
          conversations: shellRef.current.conversationLookup,
          expireTimer,
          name,
        });

        setShell(current => {
          const next = normalizeChatShellForLinkedSession(
            {
              ...current,
              selectedConversationId: group.id,
              conversationLookup: {
                ...current.conversationLookup,
                [group.id]: group,
              },
            },
            linkedSession
          );
          persistShell(next);
          dispatchConversation(linkedSession, group.id, next);
          return next;
        });

        return window.ConversationController.getOrCreateAndWait(
          group.id,
          'group',
          group as Record<string, unknown>
        );
      },
      async leaveGroup(conversationId) {
        if (!linkedSession?.credentials?.aci) {
          return false;
        }
        const timestamp = Date.now();
        const ourAci = linkedSession.credentials.aci;
        if (!isAciString(ourAci)) {
          return false;
        }
        const message: WebMessage = {
          id: `web-group-v2-leave:${conversationId}:${timestamp}`,
          conversationId,
          desktopType: 'group-v2-change',
          direction: 'incoming',
          groupV2Change: {
            from: ourAci,
            details: [
              {
                type: 'member-remove',
                aci: ourAci,
              },
            ],
          },
          readStatus: ReadStatus.Read,
          receivedAt: timestamp,
          sourceServiceId: ourAci,
          timestamp,
        };

        setShell(current => {
          const existing = current.conversationLookup[conversationId];
          if (!existing) {
            return current;
          }
          const nextConversation: WebConversation = {
            ...existing,
            activeAt: timestamp,
            hasMessages: true,
            inboxPosition: timestamp,
            lastMessage: getWebConversationLastMessage(message, ourAci),
            lastMessageReceivedAt: timestamp,
            lastMessageReceivedAtMs: timestamp,
            lastUpdated: timestamp,
            left: true,
            messageCount: (existing.messageCount ?? 0) + 1,
            snippet: getWebMessagePreviewText(message) || existing.snippet,
            timestamp,
          };
          const nextShell = normalizeChatShellForLinkedSession(
            {
              ...current,
              messages: upsertMessageSorted(current.messages, message),
              conversationLookup: {
                ...current.conversationLookup,
                [conversationId]: nextConversation,
              },
            },
            linkedSession
          );
          persistShell(nextShell);
          dispatchConversation(linkedSession, conversationId, nextShell);
          dispatchMessagesAddedSoon({
            conversationId,
            isActive: document.visibilityState === 'visible',
            isJustSent: true,
            isNewMessage: true,
            messages: [toDesktopMessage(message)],
          });
          deferWebRuntimeSideEffect(() => {
            window.reduxActions?.toast?.showToast?.({
              toastType: ToastType.LeftGroup,
            });
          });
          return nextShell;
        });
        return true;
      },
      async downloadAttachmentsForMessage(messageId) {
        const targetFromShell = shell.messages.find(
          message => message.id === messageId
        );
        const shouldRequestBackfill = Boolean(
          targetFromShell?.attachments?.some(shouldRequestWebAttachmentBackfill)
        );
        const canHandle =
          Boolean(
            targetFromShell?.attachments?.some(attachment =>
              Boolean(buildAttachmentAccessUrl(attachment))
            )
          ) || shouldRequestBackfill;
        if (!canHandle) {
          return false;
        }
        if (targetFromShell && shouldRequestBackfill) {
          const ourConversationId =
            linkedSession?.credentials?.aci ?? linkedSession?.account.aci;
          const targetAuthorAci = ourConversationId
            ? getWebMessageAuthorAci(targetFromShell, ourConversationId)
            : undefined;
          const conversationType =
            shell.conversationLookup[targetFromShell.conversationId]?.type ===
            'group'
              ? 'group'
              : 'direct';
          if (messageRuntimeSessionId && targetAuthorAci) {
            scheduleAttachmentBackfillTimeout(targetFromShell.id);
            void requestAttachmentBackfill({
              conversationId: targetFromShell.conversationId,
              conversationType,
              runtimeSessionId: messageRuntimeSessionId,
              targetAuthorAci,
              targetSentTimestamp: getWebMessageSentTimestamp(targetFromShell),
            }).catch(error => {
              clearAttachmentBackfillTimeout(targetFromShell.id);
              clearPendingBackfillForMessage(targetFromShell.id);
              showBackfillFailureModal(BackfillFailureModalKind.Timeout);
              console.error('Attachment backfill request failed', error);
            });
          } else {
            showBackfillFailureModal(BackfillFailureModalKind.Timeout);
          }
        }

        setShell(current => {
          const { messages, existing, updated } = replaceMessageById(
            current.messages,
            messageId,
            target => {
              if (!target.attachments?.length) {
                return target;
              }

              return {
                ...target,
                attachments: target.attachments.map(attachment => {
                  if (
                    isWebBackupOnlyAudioAttachment(attachment) ||
                    isWebBackupOnlyVisualAttachment(attachment)
                  ) {
                    const accessUrl = buildAttachmentAccessUrl(attachment);
                    return {
                      ...attachment,
                      backfillError: undefined,
                      downloadUrl: isWebBackupOnlyVisualAttachment(attachment)
                        ? undefined
                        : accessUrl || attachment.downloadUrl,
                      error: undefined,
                      isCorrupted: undefined,
                      status: isWebBackupOnlyVisualAttachment(attachment)
                        ? 'pending'
                        : 'ready',
                    } satisfies NonNullable<WebMessage['attachments']>[number];
                  }

                  const accessUrl = buildAttachmentAccessUrl(attachment);
                  if (!accessUrl) {
                    return attachment;
                  }

                  const nextAttachment = {
                    ...attachment,
                    backfillError: undefined,
                    downloadUrl: accessUrl,
                    error: undefined,
                    isCorrupted: undefined,
                    status: 'ready',
                  } satisfies NonNullable<WebMessage['attachments']>[number];

                  return nextAttachment;
                }),
              };
            }
          );
          if (!existing || !updated || updated === existing) {
            return current;
          }

          const next = {
            ...current,
            messages,
          };
          void persistChatShellStateToStorage(
            next,
            linkedSession?.credentials?.aci
          );
          registerMessageInCache(updated);
          dispatchMessageChanged(
            updated.id,
            updated.conversationId,
            toDesktopMessage(updated)
          );
          return next;
        });
        return true;
      },
      markAttachmentUnavailable(messageId, attachmentPath) {
        setShell(current => {
          const { messages, existing, updated } = replaceMessageById(
            current.messages,
            messageId,
            target => {
              if (!target.attachments?.length) {
                return target;
              }
              const audioAttachmentCount = target.attachments.filter(
                attachment => isWebAudioAttachment(attachment)
              ).length;
              let didChange = false;
              const nextMessage: WebMessage = {
                ...target,
                attachments: target.attachments.map(attachment => {
                  const isMatchingAttachment =
                    getWebAttachmentVirtualPath(attachment) ===
                      attachmentPath ||
                    (isWebAudioAttachment(attachment) &&
                      audioAttachmentCount === 1 &&
                      attachmentPath.startsWith('web:'));
                  if (!isMatchingAttachment) {
                    return attachment;
                  }
                  didChange = true;
                  if (isWebAudioAttachment(attachment)) {
                    const nextAttachment = { ...attachment };
                    delete nextAttachment.backfillError;
                    delete nextAttachment.downloadPath;
                    delete nextAttachment.downloadUrl;
                    delete nextAttachment.error;
                    delete nextAttachment.isCorrupted;
                    delete nextAttachment.localBlobKey;
                    delete nextAttachment.path;
                    delete nextAttachment.status;
                    delete nextAttachment.url;
                    return nextAttachment;
                  }
                  return {
                    ...attachment,
                    backfillError: true,
                    status: 'failed',
                  };
                }),
              };
              return didChange ? nextMessage : target;
            }
          );
          if (!existing || !updated || updated === existing) {
            return current;
          }
          const next = {
            ...current,
            messages,
          };
          persistShell(next);
          registerMessageInCache(updated);
          dispatchMessageChanged(
            updated.id,
            updated.conversationId,
            toDesktopMessage(updated)
          );
          if (linkedSession) {
            dispatchConversationMessages(updated.conversationId, next);
          }
          return next;
        });
      },
      markAttachmentReady(messageId, attachmentPath) {
        setShell(current => {
          const { messages, existing, updated } = replaceMessageById(
            current.messages,
            messageId,
            target => {
              if (!target.attachments?.length) {
                return target;
              }
              const audioAttachmentCount = target.attachments.filter(
                attachment => isWebAudioAttachment(attachment)
              ).length;
              let didChange = false;
              const nextMessage: WebMessage = {
                ...target,
                attachments: target.attachments.map(attachment => {
                  const isMatchingAttachment =
                    getWebAttachmentVirtualPath(attachment) ===
                      attachmentPath ||
                    attachment.path === attachmentPath ||
                    (isWebAudioAttachment(attachment) &&
                      audioAttachmentCount === 1 &&
                      attachmentPath.startsWith('web:'));
                  if (!isMatchingAttachment) {
                    return attachment;
                  }
                  const accessUrl = buildAttachmentAccessUrl(attachment);
                  if (!accessUrl) {
                    return attachment;
                  }
                  didChange = true;
                  return {
                    ...attachment,
                    backfillError: undefined,
                    downloadUrl: accessUrl,
                    error: undefined,
                    isCorrupted: undefined,
                    status: 'ready',
                  } satisfies NonNullable<WebMessage['attachments']>[number];
                }),
              };
              return didChange ? nextMessage : target;
            }
          );
          if (!existing || !updated || updated === existing) {
            return current;
          }
          const next = {
            ...current,
            messages,
          };
          persistShell(next);
          registerMessageInCache(updated);
          dispatchMessageChanged(
            updated.id,
            updated.conversationId,
            toDesktopMessage(updated)
          );
          if (linkedSession) {
            dispatchConversationMessages(updated.conversationId, next);
          }
          return next;
        });
      },
      async deleteMessagesForEveryone(messageIds) {
        if (!linkedSession?.credentials?.aci || !messageRuntimeSessionId) {
          return false;
        }

        const timestamp = Date.now();
        const ourConversationId = linkedSession.credentials.aci;
        const targets = messageIds
          .map(id => shell.messages.find(message => message.id === id))
          .filter((message): message is WebMessage => message != null);
        if (targets.length !== messageIds.length) {
          return false;
        }

        try {
          for (const target of targets) {
            const conversation =
              shell.conversationLookup[target.conversationId];
            if (!conversation) {
              return false;
            }
            const targetAuthorAci = getWebMessageAuthorAci(
              target,
              ourConversationId
            );
            if (!targetAuthorAci) {
              return false;
            }

            const deleteForEveryone = {
              targetAuthorAci,
              targetSentTimestamp: getWebMessageSentTimestamp(target),
            };
            const isGroupConversation =
              conversation.type === 'group' ||
              conversation.conversationType === 'group';
            if (isGroupConversation) {
              await sendGroupTextMessage({
                runtimeSessionId: messageRuntimeSessionId,
                groupId: conversation.groupId ?? conversation.id,
                body: '',
                deleteForEveryone,
                groupV2:
                  conversation.masterKey &&
                  typeof conversation.revision === 'number'
                    ? {
                        masterKey: conversation.masterKey,
                        revision: conversation.revision,
                      }
                    : undefined,
                groupSendEndorsements: conversation.groupSendEndorsements,
                recipients: conversation.membersV2?.map(member => member.aci),
                timestamp,
              });
            } else {
              await sendDirectDeleteForEveryone({
                runtimeSessionId: messageRuntimeSessionId,
                accessKey: getDirectSendAccessKey(conversation),
                destinationServiceId:
                  conversation.serviceId ?? target.conversationId,
                deleteForEveryone,
                timestamp,
              });
            }
          }
        } catch (error) {
          console.error('Failed to send web delete-for-everyone', error);
          return false;
        }

        setShell(current => {
          const deleted = new Set(messageIds);
          const changedIds = new Set<string>();
          const nextMessages = current.messages.map(message => {
            if (!deleted.has(message.id)) {
              return message;
            }
            const nextMessage = eraseWebMessageForEveryone(message, {
              type: 'delete-message',
              conversationId: message.conversationId,
              targetAuthorAci: getWebMessageAuthorAci(
                message,
                ourConversationId
              ),
              targetSentTimestamp: getWebMessageSentTimestamp(message),
              senderAci: ourConversationId,
              timestamp,
              isAdminDelete: false,
            });
            if (nextMessage !== message) {
              changedIds.add(message.id);
            }
            return nextMessage;
          });
          const next = {
            ...current,
            messages: nextMessages,
          };
          persistShell(next);
          for (const message of nextMessages) {
            if (!changedIds.has(message.id)) {
              continue;
            }
            dispatchMessageChanged(
              message.id,
              message.conversationId,
              toDesktopMessage(message)
            );
            registerMessageInCache(message);
          }
          return next;
        });

        return true;
      },
      async forwardMessages(conversationIds, drafts) {
        if (!linkedSession?.credentials?.aci || !messageRuntimeSessionId) {
          return false;
        }
        if (
          drafts.some(draft => {
            return (
              draft.hasContact ||
              draft.isSticker ||
              (draft.attachments?.length ?? 0) > 0
            );
          })
        ) {
          return false;
        }

        const outboundMessages: Array<WebMessage> = [];
        let nextTimestamp = Date.now();

        try {
          for (const conversationId of conversationIds) {
            const conversation = shell.conversationLookup[conversationId];
            if (!conversation) {
              return false;
            }
            for (const draft of drafts) {
              const body = draft.messageBody?.trim();
              if (!body) {
                continue;
              }
              nextTimestamp += 1;
              const sent =
                conversation.type === 'group' ||
                conversation.conversationType === 'group'
                  ? await sendGroupTextMessage({
                      runtimeSessionId: messageRuntimeSessionId,
                      groupId: conversation.groupId ?? conversation.id,
                      body,
                      timestamp: nextTimestamp,
                      groupV2:
                        conversation.masterKey &&
                        typeof conversation.revision === 'number'
                          ? {
                              masterKey: conversation.masterKey,
                              revision: conversation.revision,
                            }
                          : undefined,
                      groupSendEndorsements: conversation.groupSendEndorsements,
                      recipients: conversation.membersV2?.map(
                        member => member.aci
                      ),
                    })
                  : await sendDirectTextMessage({
                      runtimeSessionId: messageRuntimeSessionId,
                      accessKey: getDirectSendAccessKey(conversation),
                      destinationServiceId:
                        conversation.serviceId ?? conversation.id,
                      body,
                      timestamp: nextTimestamp,
                    });
              outboundMessages.push({
                ...sent,
                conversationId,
                body,
                direction: 'outgoing',
                timestamp: nextTimestamp,
                status: sent.status ?? 'sent',
              });
            }
          }
        } catch (error) {
          console.error('Failed to forward web message', error);
          return false;
        }

        if (outboundMessages.length === 0) {
          return false;
        }

        setShell(current => {
          let nextShell: ChatShellState = current;
          const ourConversationId =
            linkedSession.credentials?.aci ?? linkedSession.account.aci;
          for (const message of outboundMessages) {
            nextShell = ensureConversationForMessage(
              nextShell,
              message,
              ourConversationId
            );
          }
          nextShell = {
            ...nextShell,
            messages: appendUniqueMessagesSorted(
              nextShell.messages,
              outboundMessages
            ),
          };
          persistShell(nextShell);
          for (const message of outboundMessages) {
            registerMessageInCache(message);
            dispatchConversation(
              linkedSession,
              message.conversationId,
              nextShell
            );
          }
          return nextShell;
        });

        for (const message of outboundMessages) {
          dispatchMessagesAddedSoon({
            conversationId: message.conversationId,
            isActive: document.visibilityState === 'visible',
            isJustSent: true,
            isNewMessage: true,
            messages: [toDesktopMessage(message)],
          });
        }

        return true;
      },
      async pinMessage(conversationId, pinMessage, timestamp) {
        if (!linkedSession?.credentials?.aci || !messageRuntimeSessionId) {
          return false;
        }

        const conversation = shell.conversationLookup[conversationId];
        if (
          !conversation ||
          conversation.type === 'group' ||
          conversation.conversationType === 'group'
        ) {
          return false;
        }

        try {
          await sendDirectTextMessage({
            runtimeSessionId: messageRuntimeSessionId,
            accessKey: getDirectSendAccessKey(conversation),
            destinationServiceId: conversation.serviceId ?? conversation.id,
            body: '',
            pinMessage,
            timestamp,
          });
          const notification = createPinnedNotificationMessage({
            conversationId,
            pinMessage,
            receivedAt: timestamp,
            senderAci: linkedSession.credentials.aci,
            timestamp,
          });
          setShell(current => {
            const nextMessages = appendUniqueMessagesSorted(current.messages, [
              notification,
            ]);
            if (nextMessages === current.messages) {
              return current;
            }
            const next = {
              ...current,
              messages: nextMessages,
            };
            persistShell(next);
            registerMessageInCache(notification);
            return next;
          });
          return true;
        } catch (error) {
          console.error('Failed to send web pin message', error);
          return false;
        }
      },
      async unpinMessage(conversationId, unpinMessage, timestamp) {
        if (!linkedSession?.credentials?.aci || !messageRuntimeSessionId) {
          return false;
        }

        const conversation = shell.conversationLookup[conversationId];
        if (
          !conversation ||
          conversation.type === 'group' ||
          conversation.conversationType === 'group'
        ) {
          return false;
        }

        try {
          await sendDirectUnpinMessage({
            runtimeSessionId: messageRuntimeSessionId,
            accessKey: getDirectSendAccessKey(conversation),
            destinationServiceId: conversation.serviceId ?? conversation.id,
            unpinMessage,
            timestamp,
          });
          return true;
        } catch (error) {
          console.error('Failed to send web unpin message', error);
          return false;
        }
      },
      reactToMessage(id, reaction) {
        if (!linkedSession?.credentials?.aci || !messageRuntimeSessionId) {
          return false;
        }

        const timestamp = Date.now();
        const ourConversationId = linkedSession.credentials.aci;
        const previousMessage = shell.messages.find(
          message => message.id === id
        );
        if (!previousMessage) {
          return false;
        }
        const conversation =
          shell.conversationLookup[previousMessage.conversationId];
        if (!conversation) {
          return false;
        }
        const targetAuthorAci =
          previousMessage.direction === 'outgoing'
            ? ourConversationId
            : previousMessage.sourceServiceId;
        if (!targetAuthorAci) {
          return false;
        }

        let nextMessage: WebMessage | undefined;

        setShell(current => {
          const result = replaceMessageById(current.messages, id, message => {
            nextMessage = applyOutgoingReactionToMessage({
              message,
              reaction,
              timestamp,
              isSent: false,
              ourConversationId,
            });
            return nextMessage;
          });
          if (!result.existing || !result.updated) {
            return current;
          }
          const updatedMessage = result.updated;
          const nextShell = {
            ...current,
            messages: result.messages,
          };
          void persistChatShellStateToStorage(
            nextShell,
            linkedSession.credentials?.aci
          );
          dispatchMessageChanged(
            id,
            updatedMessage.conversationId,
            toDesktopMessage(updatedMessage)
          );
          return nextShell;
        });

        if (!nextMessage) {
          return false;
        }

        void (async () => {
          try {
            const isGroupConversation =
              conversation.type === 'group' ||
              conversation.conversationType === 'group';
            if (isGroupConversation) {
              await sendGroupReaction({
                runtimeSessionId: messageRuntimeSessionId,
                groupId: conversation.groupId ?? conversation.id,
                groupV2:
                  conversation.masterKey &&
                  typeof conversation.revision === 'number'
                    ? {
                        masterKey: conversation.masterKey,
                        revision: conversation.revision,
                      }
                    : undefined,
                groupSendEndorsements: conversation.groupSendEndorsements,
                recipients: conversation.membersV2?.map(member => member.aci),
                emoji: reaction.emoji,
                remove: reaction.remove,
                targetAuthorAci,
                targetTimestamp: previousMessage.timestamp,
                timestamp,
              });
            } else {
              await sendDirectReaction({
                runtimeSessionId: messageRuntimeSessionId,
                accessKey: getDirectSendAccessKey(conversation),
                destinationServiceId: conversation.serviceId ?? conversation.id,
                emoji: reaction.emoji,
                remove: reaction.remove,
                targetAuthorAci,
                targetTimestamp: previousMessage.timestamp,
                timestamp,
              });
            }
            setShell(current => {
              let sentMessage: WebMessage | undefined;
              const result = replaceMessageById(
                current.messages,
                id,
                message => {
                  sentMessage = applyOutgoingReactionToMessage({
                    message,
                    reaction,
                    timestamp,
                    isSent: true,
                    ourConversationId,
                  });
                  return sentMessage;
                }
              );
              if (!result.existing || !result.updated || !sentMessage) {
                return current;
              }
              const nextShell = {
                ...current,
                messages: result.messages,
              };
              void persistChatShellStateToStorage(
                nextShell,
                linkedSession.credentials?.aci
              );
              dispatchMessageChanged(
                id,
                sentMessage.conversationId,
                toDesktopMessage(sentMessage)
              );
              return nextShell;
            });
          } catch (error) {
            console.error('Failed to send web reaction', error);
            setShell(current => {
              if (!previousMessage) {
                return current;
              }
              const result = replaceMessageById(
                current.messages,
                id,
                () => previousMessage
              );
              if (!result.existing) {
                return current;
              }
              const nextShell = {
                ...current,
                messages: result.messages,
              };
              void persistChatShellStateToStorage(
                nextShell,
                linkedSession.credentials?.aci
              );
              dispatchMessageChanged(
                id,
                previousMessage.conversationId,
                toDesktopMessage(previousMessage)
              );
              return nextShell;
            });
          }
        })();

        return true;
      },
    };

    return () => {
      if (
        runtimeWindow.SignalWebRuntime?.reactToMessage ||
        runtimeWindow.SignalWebRuntime?.deleteMessagesForEveryone ||
        runtimeWindow.SignalWebRuntime?.forwardMessages ||
        runtimeWindow.SignalWebRuntime?.downloadAttachmentsForMessage ||
        runtimeWindow.SignalWebRuntime?.leaveGroup ||
        runtimeWindow.SignalWebRuntime?.markAttachmentReady ||
        runtimeWindow.SignalWebRuntime?.markAttachmentUnavailable ||
        runtimeWindow.SignalWebRuntime?.pinMessage ||
        runtimeWindow.SignalWebRuntime?.unpinMessage
      ) {
        runtimeWindow.SignalWebRuntime = {
          ...runtimeWindow.SignalWebRuntime,
          deleteMessagesForEveryone: undefined,
          downloadAttachmentsForMessage: undefined,
          forwardMessages: undefined,
          leaveGroup: undefined,
          markAttachmentReady: undefined,
          markAttachmentUnavailable: undefined,
          pinMessage: undefined,
          unpinMessage: undefined,
          reactToMessage: undefined,
        };
      }
    };
  }, [
    linkedSession,
    messageRuntimeSessionId,
    persistShell,
    setShell,
    shell.conversationLookup,
  ]);

  useEffect(() => {
    const handleMessagesAdded = (event: Event) => {
      const { detail } = event as CustomEvent<{
        messages?: ReadonlyArray<WebMessage>;
      }>;
      const messages = detail?.messages;
      if (!messages?.length) {
        return;
      }
      setShell(current => {
        const nextMessages = appendUniqueMessagesSorted(
          current.messages,
          messages
        );
        if (nextMessages === current.messages) {
          return current;
        }
        const nextShell = {
          ...current,
          messages: nextMessages,
        };
        setWebRuntimeChatShell(nextShell);
        void persistChatShellStateToStorage(
          nextShell,
          linkedSession?.credentials?.aci
        );
        return nextShell;
      });
    };

    const handleMessagesRemoved = (event: Event) => {
      const { detail } = event as CustomEvent<{
        messageIds?: ReadonlyArray<string>;
      }>;
      const messageIds = detail?.messageIds;
      if (!messageIds?.length) {
        return;
      }
      const deleted = new Set(messageIds);
      setShell(current => {
        const nextShell = {
          ...current,
          messages: current.messages.filter(
            message => !deleted.has(message.id)
          ),
        };
        setWebRuntimeChatShell(nextShell);
        void persistChatShellStateToStorage(
          nextShell,
          linkedSession?.credentials?.aci
        );
        return nextShell;
      });
    };

    window.addEventListener(WEB_MESSAGES_ADDED_EVENT, handleMessagesAdded);
    window.addEventListener(WEB_MESSAGES_REMOVED_EVENT, handleMessagesRemoved);
    return () => {
      window.removeEventListener(WEB_MESSAGES_ADDED_EVENT, handleMessagesAdded);
      window.removeEventListener(
        WEB_MESSAGES_REMOVED_EVENT,
        handleMessagesRemoved
      );
    };
  }, [linkedSession?.credentials?.aci, setShell]);

  const handleConversationChange = useCallback(
    (conversationId: string, attributes: Record<string, unknown>) => {
      if (!linkedSession) {
        return;
      }
      setShell(current => {
        if (attributes.__signalWebDeleteConversation === true) {
          if (!current.conversationLookup[conversationId]) {
            return current;
          }
          const nextConversationLookup = { ...current.conversationLookup };
          delete nextConversationLookup[conversationId];
          const updated = normalizeChatShellForLinkedSession(
            {
              ...current,
              conversationLookup: nextConversationLookup,
              messages: current.messages.filter(
                message => message.conversationId !== conversationId
              ),
              selectedConversationId:
                current.selectedConversationId === conversationId
                  ? undefined
                  : current.selectedConversationId,
            },
            linkedSession
          );
          persistShell(updated);
          deferWebRuntimeSideEffect(() => {
            window.reduxActions?.conversations?.conversationRemoved?.(
              conversationId
            );
          });
          return updated;
        }

        const existing = current.conversationLookup[conversationId];
        if (!existing) {
          if (typeof attributes.id !== 'string') {
            return current;
          }
          const updated = normalizeChatShellForLinkedSession(
            {
              ...current,
              conversationLookup: {
                ...current.conversationLookup,
                [conversationId]: attributes as WebConversation,
              },
            },
            linkedSession
          );
          persistShell(updated);
          dispatchConversation(linkedSession, conversationId, updated);
          dispatchConversationMessages(conversationId, updated);
          return updated;
        }
        const updated = normalizeChatShellForLinkedSession(
          {
            ...current,
            conversationLookup: {
              ...current.conversationLookup,
              [conversationId]: {
                ...existing,
                ...attributes,
              } as WebConversation,
            },
          },
          linkedSession
        );
        const next =
          attributes.unreadCount === 0 || attributes.markedUnread === false
            ? markConversationRead(updated, conversationId)
            : updated;
        persistShell(next);
        dispatchConversation(linkedSession, conversationId, next);
        dispatchConversationMessages(conversationId, next);
        return next;
      });
    },
    [linkedSession, persistShell]
  );

  useEffect(() => {
    setupWebGlobals({
      i18n: window.SignalContext.i18n,
      linkedSession,
      messageRuntimeSessionId,
      onConversationChange: handleConversationChange,
    });
  }, [handleConversationChange, linkedSession, messageRuntimeSessionId]);

  useEffect(() => {
    if (!linkedSession?.credentials?.aci) {
      return;
    }

    dispatchLinkedSessionUserState(linkedSession);
    void syncLinkedSessionUserStorage(linkedSession).catch(error => {
      console.error('Failed to sync linked session user storage', error);
    });
  }, [linkedSession]);

  const reloadLinkedSession = useCallback(async () => {
    const nextLinkedSession = await loadLinkedSessionRecordFromIndexedDb();
    setLinkedSession(nextLinkedSession);
    setIsRelinkRequired(false);
    if (nextLinkedSession?.credentials?.aci) {
      setupWebGlobals({
        i18n: window.SignalContext.i18n,
        linkedSession: nextLinkedSession,
        messageRuntimeSessionId,
        onConversationChange: handleConversationChange,
      });
      window.reduxActions?.app?.openInbox?.();
      dispatchLinkedSessionUserState(nextLinkedSession);
      await syncLinkedSessionUserStorage(nextLinkedSession);
      const [storedShell, contacts] = await Promise.all([
        loadChatShellStateForSession(nextLinkedSession.credentials.aci),
        loadContactsBootstrapForSession(nextLinkedSession.credentials.aci),
      ]);
      const recoveredShell = recoverRetriableAttachmentStates(
        storedShell ?? EMPTY_SHELL
      );
      const profileAwareContacts = contacts
        ? mergeContactsBootstrapWithLinkedProfile(contacts, nextLinkedSession)
        : contacts;
      if (profileAwareContacts?.source === 'storage') {
        storageContactsRef.current = profileAwareContacts;
      }
      if (profileAwareContacts && profileAwareContacts !== contacts) {
        void persistContactsBootstrapForSession(
          nextLinkedSession.credentials.aci,
          profileAwareContacts
        );
      }
      const nextShell = applyContactsBootstrap(
        recoveredShell,
        profileAwareContacts,
        nextLinkedSession
      );
      if (nextShell !== storedShell) {
        void persistChatShellStateToStorage(
          nextShell,
          nextLinkedSession.credentials.aci
        );
      }
      setWebRuntimeChatShell(nextShell);
      setShell(nextShell);
      dispatchShell(nextLinkedSession, nextShell);
    }
  }, [handleConversationChange, messageRuntimeSessionId]);

  const relinkDevice = useCallback(() => {
    void (async () => {
      await Registration.remove();
      await clearWebPersistence();
      window.location.reload();
    })();
  }, []);

  const handleDeviceDelinked = useCallback(() => {
    setMessageRuntimeSessionId(undefined);
    setIsRelinkRequired(true);
    void Registration.remove();
    window.reduxActions?.network?.setNetworkStatus?.({
      isOnline: false,
      socketStatus: SocketStatus.CLOSED,
    });
  }, []);

  useEffect(() => {
    const handleOnline = (): void => {
      void notifySignalNetworkChange().catch(error => {
        console.error('Signal network change notification failed', error);
      });
    };

    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  useEffect(() => {
    const initialStreamLinkedSession = linkedSessionRef.current;
    if (!initialStreamLinkedSession?.credentials?.aci) {
      return undefined;
    }
    const getCurrentLinkedSession = (): LinkedSessionRecord =>
      linkedSessionRef.current ?? initialStreamLinkedSession;

    const abortController = new AbortController();
    const importBackup = shouldImportBackup(
      initialStreamLinkedSession,
      shellRef.current
    );
    if (importBackup) {
      setBackupImportScreenState({ status: 'idle' });
    } else {
      setBackupImportScreenState(undefined);
    }
    let runtimeSessionId: string | undefined;
    let latestProtocolStateRevision = 0;
    const clearAttachmentBackfillTimeout = (messageId: string): void => {
      const existing = pendingAttachmentBackfillTimeouts.get(messageId);
      if (existing != null) {
        window.clearTimeout(existing);
        pendingAttachmentBackfillTimeouts.delete(messageId);
      }
    };
    const showBackfillFailureModal = (kind: BackfillFailureModalKind): void => {
      window.reduxActions?.globalModals?.showBackfillFailureModal?.(kind);
    };
    const handleEvent = async (event: MessageStreamEvent) => {
      const currentLinkedSession = getCurrentLinkedSession();
      if (event.type === 'session') {
        runtimeSessionId = event.sessionId;
        latestProtocolStateRevision = 0;
        setMessageRuntimeSessionId(event.sessionId);
      } else if (event.type === 'linked-session-updated') {
        setLinkedSession(current => {
          if (!current) {
            return current;
          }
          const account =
            typeof current.account.localProfileUpdatedAt === 'number'
              ? {
                  ...event.linkedPayload.account,
                  familyName: current.account.familyName,
                  firstName: current.account.firstName,
                  localProfileUpdatedAt: current.account.localProfileUpdatedAt,
                  profileFamilyName: current.account.profileFamilyName,
                  profileName: current.account.profileName,
                  title: current.account.title,
                }
              : event.linkedPayload.account;
          const next: LinkedSessionRecord = {
            ...current,
            account,
            credentials: event.linkedPayload.credentials,
            linkedPayload: {
              ...event.linkedPayload,
              account,
            },
            lastUpdatedAt: Date.now(),
            storageServiceKey: event.linkedPayload.storageServiceKey,
          };
          persistLinkedSessionToStorage(next);
          void persistLinkedSessionRecordToIndexedDb(next);
          return next;
        });
      } else if (event.type === 'protocol-state') {
        if (!runtimeSessionId || event.sessionId !== runtimeSessionId) {
          return;
        }
        if (event.protocolRevision <= latestProtocolStateRevision) {
          return;
        }
        latestProtocolStateRevision = event.protocolRevision;
        const current = getCurrentLinkedSession();
        const next: LinkedSessionRecord = {
          ...current,
          lastUpdatedAt: Date.now(),
          protocol: event.protocol,
        };
        linkedSessionRef.current = next;
        void persistLinkedSessionRecordToIndexedDb(next);
      } else if (event.type === 'transport-status') {
        if (isDeviceDelinkedError(event.error)) {
          abortController.abort();
          handleDeviceDelinked();
          return;
        }
        window.reduxActions?.network?.setNetworkStatus?.({
          isOnline: event.status === 'open',
          socketStatus:
            event.status === 'open'
              ? SocketStatus.OPEN
              : event.status === 'connecting'
                ? SocketStatus.CONNECTING
                : event.status === 'closed'
                  ? SocketStatus.CLOSED
                  : SocketStatus.CLOSED,
        });
        if (event.status === 'closed' || event.status === 'error') {
          throw new Error(event.error ?? `Message stream ${event.status}`);
        }
        if (event.status === 'open' && runtimeSessionId) {
          const activeRuntimeSessionId = runtimeSessionId;
          const nowMs = Date.now();
          const hasRecentContactsSync =
            storageContactsRef.current != null &&
            nowMs - lastContactsSyncOnOpenAtRef.current <
              CONTACTS_SYNC_ON_OPEN_THROTTLE_MS;
          const hasContactsSyncInFlight =
            contactsSyncOnOpenPromiseRef.current != null;

          if (!hasRecentContactsSync && !hasContactsSyncInFlight) {
            lastContactsSyncOnOpenAtRef.current = nowMs;
            const contactsSyncPromise = syncContacts({
              runtimeSessionId: activeRuntimeSessionId,
            })
              .then(data => {
                const latestLinkedSession = getCurrentLinkedSession();
                const profileAwareData =
                  mergeContactsBootstrapWithLinkedProfile(
                    data,
                    latestLinkedSession
                  );
                if (profileAwareData.source === 'storage') {
                  storageContactsRef.current = profileAwareData;
                }
                const syncedLinkedSession = mergeLinkedSessionAccount(
                  latestLinkedSession,
                  profileAwareData.account
                );
                if (syncedLinkedSession !== latestLinkedSession) {
                  setLinkedSession(syncedLinkedSession);
                  persistLinkedSessionToStorage(syncedLinkedSession);
                  void persistLinkedSessionRecordToIndexedDb(
                    syncedLinkedSession
                  );
                }
                void persistContactsBootstrapForSession(
                  syncedLinkedSession.credentials?.aci,
                  profileAwareData
                );
                setShell(current => {
                  const next = applyContactsBootstrap(
                    current,
                    profileAwareData,
                    syncedLinkedSession
                  );
                  persistShell(next);
                  dispatchShell(syncedLinkedSession, next);
                  return next;
                });
              })
              .catch(error => {
                console.error('Contacts sync failed', error);
              })
              .finally(() => {
                if (
                  contactsSyncOnOpenPromiseRef.current === contactsSyncPromise
                ) {
                  contactsSyncOnOpenPromiseRef.current = undefined;
                }
              });
            contactsSyncOnOpenPromiseRef.current = contactsSyncPromise;
          } else if (hasContactsSyncInFlight) {
            console.info('Contacts sync skipped: already in flight');
          } else {
            console.info('Contacts sync skipped: recently synced on open', {
              elapsedMs: nowMs - lastContactsSyncOnOpenAtRef.current,
            });
          }
        }
        if (event.error) {
          console.error('Message transport status error', event.error);
        }
      } else if (event.type === 'backup-import-status') {
        if (
          event.status === 'done' ||
          event.status === 'missing' ||
          event.status === 'skipped' ||
          event.status === 'error'
        ) {
          setBackupImportScreenState(undefined);
        } else {
          setBackupImportScreenState({
            bytes: event.bytes,
            status: event.status,
          });
        }
      } else if (event.type === 'contacts-bootstrap') {
        const profileAwareData = mergeContactsBootstrapWithLinkedProfile(
          event.data,
          currentLinkedSession
        );
        if (profileAwareData.source === 'storage') {
          storageContactsRef.current = profileAwareData;
        }
        const syncedLinkedSession = mergeLinkedSessionAccount(
          currentLinkedSession,
          profileAwareData.account
        );
        if (syncedLinkedSession !== currentLinkedSession) {
          setLinkedSession(syncedLinkedSession);
          persistLinkedSessionToStorage(syncedLinkedSession);
          void persistLinkedSessionRecordToIndexedDb(syncedLinkedSession);
        }
        void persistContactsBootstrapForSession(
          syncedLinkedSession.credentials?.aci,
          profileAwareData
        );
        setShell(current => {
          const next = applyContactsBootstrap(
            current,
            profileAwareData,
            syncedLinkedSession
          );
          persistShell(next);
          dispatchShell(syncedLinkedSession, next);
          return next;
        });
      } else if (event.type === 'chat-shell') {
        setShell(current => {
          const merged = mergeChatShellState(current, event.state);
          const next = applyContactsBootstrap(
            merged,
            storageContactsRef.current,
            currentLinkedSession
          );
          persistShell(next);
          dispatchShell(currentLinkedSession, next);
          return next;
        });
      } else if (event.type === 'conversation') {
        setShell(current => {
          const next = normalizeChatShellForLinkedSession(
            {
              ...current,
              conversationLookup: {
                ...current.conversationLookup,
                [event.conversation.id]: {
                  ...current.conversationLookup[event.conversation.id],
                  ...event.conversation,
                },
              },
            },
            currentLinkedSession
          );
          persistShell(next);
          dispatchConversation(
            currentLinkedSession,
            event.conversation.id,
            next
          );
          return next;
        });
      } else if (event.type === 'message') {
        const selectedConversationId = window.reduxStore?.getState
          ? getSelectedConversationId(window.reduxStore.getState())
          : undefined;
        const isSelectedVisible =
          selectedConversationId === event.message.conversationId &&
          document.visibilityState === 'visible';
        const message: WebMessage =
          event.message.direction === 'incoming'
            ? {
                ...event.message,
                readStatus: isSelectedVisible
                  ? ReadStatus.Read
                  : ReadStatus.Unread,
              }
            : event.message;
        let shouldDispatchMessage = false;
        let nextShellForSideEffects: ChatShellState | undefined;
        await new Promise<void>(resolve => {
          setShell(current => {
            const nextMessages = appendUniqueMessagesSorted(current.messages, [
              message,
            ]);
            const isNewMessage = nextMessages !== current.messages;
            const ourConversationId =
              currentLinkedSession.credentials?.aci ??
              currentLinkedSession.account.aci;
            const withConversation = ensureConversationForMessage(
              current,
              message,
              ourConversationId,
              { isNewMessage }
            );
            if (
              nextMessages === current.messages &&
              withConversation === current
            ) {
              resolve();
              return current;
            }
            shouldDispatchMessage = isNewMessage;
            const next = {
              ...withConversation,
              messages: nextMessages,
            };
            nextShellForSideEffects = next;
            resolve();
            return next;
          });
        });
        if (nextShellForSideEffects) {
          persistShell(nextShellForSideEffects);
          await dispatchConversationNow(
            currentLinkedSession,
            message.conversationId,
            nextShellForSideEffects
          );
          if (
            selectedConversationId === message.conversationId &&
            !hasLoadedConversationMessages(message.conversationId)
          ) {
            await dispatchConversationMessagesNow(
              message.conversationId,
              nextShellForSideEffects
            );
          }
        }
        if (shouldDispatchMessage) {
          await dispatchMessage({ ...event, message });
        }
      } else if (event.type === 'pin-message') {
        void applyRemotePinnedMessage(event).then(applied => {
          if (!applied) {
            console.warn('Message stream pin-message target was not applied', {
              conversationId: event.conversationId,
              targetAuthorAci: event.targetAuthorAci,
              targetSentTimestamp: event.targetSentTimestamp,
            });
          }
        });
        const notification = createPinnedNotificationMessage({
          conversationId: event.conversationId,
          pinMessage: {
            targetAuthorAci: event.targetAuthorAci,
            targetSentTimestamp: event.targetSentTimestamp,
            pinDurationSeconds: event.pinDurationSeconds,
          },
          receivedAt: event.receivedAt,
          senderAci: event.senderAci,
          timestamp: event.timestamp,
        });
        setShell(current => {
          const nextMessages = appendUniqueMessagesSorted(current.messages, [
            notification,
          ]);
          if (nextMessages === current.messages) {
            return current;
          }
          const ourConversationId =
            currentLinkedSession.credentials?.aci ??
            currentLinkedSession.account.aci;
          const next = ensureConversationForMessage(
            {
              ...current,
              messages: nextMessages,
            },
            notification,
            ourConversationId
          );
          persistShell(next);
          registerMessageInCache(notification);
          return next;
        });
      } else if (event.type === 'attachment-backfill') {
        const ourAci =
          currentLinkedSession.credentials?.aci ??
          currentLinkedSession.account.aci;
        if (!ourAci) {
          return;
        }
        setShell(current => {
          const target = findWebMessageByAuthorAndTimestamp({
            conversationId: event.conversationId,
            messages: current.messages,
            ourConversationId: ourAci,
            targetAuthorAci: event.targetAuthorAci,
            targetTimestamp: event.targetSentTimestamp,
          });
          if (!target?.attachments?.length) {
            return current;
          }

          if (event.error != null) {
            const didRequestBackfill = pendingAttachmentBackfillTimeouts.has(
              target.id
            );
            clearAttachmentBackfillTimeout(target.id);
            if (
              didRequestBackfill &&
              event.error === ATTACHMENT_BACKFILL_ERROR_MESSAGE_NOT_FOUND
            ) {
              showBackfillFailureModal(BackfillFailureModalKind.NotFound);
            } else if (didRequestBackfill) {
              showBackfillFailureModal(BackfillFailureModalKind.Timeout);
            }
            let didClearPending = false;
            const nextMessage: WebMessage = {
              ...target,
              attachments: target.attachments.map(attachment => {
                if (attachment.status !== 'pending') {
                  return attachment;
                }
                didClearPending = true;
                const nextAttachment = { ...attachment };
                delete nextAttachment.status;
                return nextAttachment;
              }),
            };
            if (!didClearPending) {
              return current;
            }
            const result = replaceMessageById(
              current.messages,
              target.id,
              () => nextMessage
            );
            if (!result.existing) {
              return current;
            }
            const next = {
              ...current,
              messages: result.messages,
            };
            persistShell(next);
            registerMessageInCache(nextMessage);
            dispatchMessageChanged(
              nextMessage.id,
              nextMessage.conversationId,
              toDesktopMessage(nextMessage)
            );
            return next;
          }

          let didChange = false;
          let pendingCount = 0;
          const remoteAttachments = event.attachments ?? [];
          const nextAttachments = target.attachments.slice();
          while (nextAttachments.length < remoteAttachments.length) {
            nextAttachments.push({
              contentType: 'application/octet-stream',
              error: 'attachment-backfill-placeholder',
              size: 0,
            });
            didChange = true;
          }
          const nextMessage: WebMessage = {
            ...target,
            attachments: nextAttachments.map((attachment, index) => {
              const update = remoteAttachments[index];
              if (!update) {
                return attachment;
              }

              if (
                attachment.status === 'ready' &&
                buildAttachmentAccessUrl(attachment)
              ) {
                return attachment;
              }

              if ('status' in update) {
                if (update.status === ATTACHMENT_BACKFILL_STATUS_PENDING) {
                  pendingCount += 1;
                  return attachment;
                }
                if (
                  update.status !== ATTACHMENT_BACKFILL_STATUS_TERMINAL_ERROR
                ) {
                  return attachment;
                }
                const didRequestBackfill =
                  pendingAttachmentBackfillTimeouts.has(target.id);
                if (didRequestBackfill) {
                  clearAttachmentBackfillTimeout(target.id);
                  showBackfillFailureModal(BackfillFailureModalKind.Timeout);
                }
                didChange = true;
                if (isWebAudioAttachment(attachment)) {
                  const nextAttachment = { ...attachment };
                  delete nextAttachment.backfillError;
                  delete nextAttachment.downloadPath;
                  delete nextAttachment.downloadUrl;
                  delete nextAttachment.error;
                  delete nextAttachment.isCorrupted;
                  delete nextAttachment.localBlobKey;
                  delete nextAttachment.path;
                  delete nextAttachment.status;
                  delete nextAttachment.url;
                  return nextAttachment;
                }
                if (isWebVisualAttachment(attachment)) {
                  const nextAttachment = { ...attachment };
                  delete nextAttachment.backfillError;
                  delete nextAttachment.error;
                  delete nextAttachment.isCorrupted;
                  delete nextAttachment.status;
                  return nextAttachment;
                }
                return {
                  ...attachment,
                  backfillError: true,
                  error: undefined,
                  isCorrupted: undefined,
                  status: 'failed',
                } satisfies NonNullable<WebMessage['attachments']>[number];
              }

              const merged = {
                ...attachment,
                ...update.attachment,
                backupCdnNumber: undefined,
                backfillError: undefined,
                digestBase64:
                  update.attachment.digestBase64 ?? update.attachment.digest,
                error: undefined,
                incrementalMacBase64:
                  update.attachment.incrementalMacBase64 ??
                  update.attachment.incrementalMac,
                isCorrupted: undefined,
                keyBase64: update.attachment.keyBase64 ?? update.attachment.key,
                localKey: undefined,
                plaintextHash: undefined,
                status: 'ready',
              } satisfies NonNullable<WebMessage['attachments']>[number];
              const accessUrl = buildAttachmentAccessUrl(merged);
              didChange = true;
              return {
                ...merged,
                downloadUrl: accessUrl || merged.downloadUrl,
              } satisfies NonNullable<WebMessage['attachments']>[number];
            }),
          };

          if (pendingCount === 0) {
            clearAttachmentBackfillTimeout(target.id);
          }

          if (!didChange) {
            return current;
          }
          const result = replaceMessageById(
            current.messages,
            target.id,
            () => nextMessage
          );
          if (!result.existing) {
            return current;
          }
          const next = {
            ...current,
            messages: result.messages,
          };
          persistShell(next);
          registerMessageInCache(nextMessage);
          dispatchMessageChanged(
            nextMessage.id,
            nextMessage.conversationId,
            toDesktopMessage(nextMessage)
          );
          dispatchConversation(
            currentLinkedSession,
            nextMessage.conversationId,
            next
          );
          dispatchConversationMessages(nextMessage.conversationId, next);
          return next;
        });
      } else if (event.type === 'reaction') {
        const ourAci = currentLinkedSession.credentials?.aci;
        if (!ourAci) {
          return;
        }
        setShell(current => {
          const target = current.messages.find(message => {
            return (
              message.conversationId === event.conversationId &&
              getWebMessageAuthorAci(message, ourAci) ===
                event.targetAuthorAci &&
              getWebMessageSentTimestamp(message) === event.targetTimestamp
            );
          });
          if (!target) {
            console.warn('Message stream reaction target was not applied', {
              conversationId: event.conversationId,
              targetAuthorAci: event.targetAuthorAci,
              targetTimestamp: event.targetTimestamp,
            });
            return current;
          }

          const nextMessage = applyRemoteReactionToMessage({
            message: target,
            emoji: event.emoji,
            fromId: event.senderAci,
            remove: event.remove,
            timestamp: event.timestamp,
            targetTimestamp: event.targetTimestamp,
          });
          if (nextMessage === target) {
            return current;
          }
          const result = replaceMessageById(
            current.messages,
            target.id,
            () => nextMessage
          );
          if (!result.existing) {
            return current;
          }
          const next = {
            ...current,
            messages: result.messages,
          };
          persistShell(next);
          dispatchMessageChanged(
            target.id,
            target.conversationId,
            toDesktopMessage(nextMessage)
          );
          return next;
        });
      } else if (event.type === 'edit-message') {
        const ourAci = currentLinkedSession.credentials?.aci;
        if (!ourAci) {
          return;
        }
        setShell(current => {
          const target = findWebMessageByAuthorAndTimestamp({
            conversationId: event.conversationId,
            messages: current.messages,
            ourConversationId: ourAci,
            targetAuthorAci: event.senderAci,
            targetTimestamp: event.targetTimestamp,
          });
          if (!target) {
            console.warn('Message stream edit-message target was not applied', {
              conversationId: event.conversationId,
              senderAci: event.senderAci,
              targetTimestamp: event.targetTimestamp,
            });
            return current;
          }

          const nextMessage = applyRemoteEditToMessage(target, event);
          if (nextMessage === target) {
            return current;
          }
          const withConversation = updateConversationForChangedMessage(
            current,
            nextMessage,
            currentLinkedSession.credentials?.aci ??
              currentLinkedSession.account.aci
          );
          const result = replaceMessageById(
            withConversation.messages,
            target.id,
            () => nextMessage
          );
          if (!result.existing) {
            return current;
          }
          const next = {
            ...withConversation,
            messages: result.messages,
          };
          persistShell(next);
          dispatchConversation(
            currentLinkedSession,
            nextMessage.conversationId,
            next
          );
          dispatchMessageChanged(
            target.id,
            target.conversationId,
            toDesktopMessage(nextMessage)
          );
          registerMessageInCache(nextMessage);
          return next;
        });
      } else if (event.type === 'delete-message') {
        const ourAci = currentLinkedSession.credentials?.aci;
        if (!ourAci) {
          return;
        }
        setShell(current => {
          const target = findWebMessageByAuthorAndTimestamp({
            conversationId: event.conversationId,
            messages: current.messages,
            ourConversationId: ourAci,
            targetAuthorAci: event.targetAuthorAci ?? event.senderAci,
            targetTimestamp: event.targetSentTimestamp,
          });
          if (!target) {
            console.warn(
              'Message stream delete-message target was not applied',
              {
                conversationId: event.conversationId,
                targetAuthorAci: event.targetAuthorAci,
                targetSentTimestamp: event.targetSentTimestamp,
              }
            );
            return current;
          }

          const nextMessage = eraseWebMessageForEveryone(target, event);
          if (nextMessage === target) {
            return current;
          }
          const withConversation = updateConversationForChangedMessage(
            current,
            nextMessage,
            currentLinkedSession.credentials?.aci ??
              currentLinkedSession.account.aci
          );
          const result = replaceMessageById(
            withConversation.messages,
            target.id,
            () => nextMessage
          );
          if (!result.existing) {
            return current;
          }
          const next = {
            ...withConversation,
            messages: result.messages,
          };
          persistShell(next);
          dispatchConversation(
            currentLinkedSession,
            nextMessage.conversationId,
            next
          );
          dispatchMessageChanged(
            target.id,
            target.conversationId,
            toDesktopMessage(nextMessage)
          );
          registerMessageInCache(nextMessage);
          return next;
        });
      } else if (event.type === 'unpin-message') {
        if (!applyRemoteUnpinMessage(event)) {
          console.warn('Message stream unpin-message target was not applied', {
            conversationId: event.conversationId,
            targetAuthorAci: event.targetAuthorAci,
            targetSentTimestamp: event.targetSentTimestamp,
          });
        }
      } else if (event.type === 'receipt') {
        const nextStatus = getReceiptStatus(event.receiptType);
        if (!nextStatus) {
          return;
        }
        const receiptTimestamps = new Set(event.timestamps);
        setShell(current => {
          const changedMessages: Array<WebMessage> = [];
          const next = {
            ...current,
            messages: current.messages.map(message => {
              if (
                message.conversationId !== event.conversationId ||
                message.direction !== 'outgoing' ||
                !receiptTimestamps.has(getWebMessageSentTimestamp(message))
              ) {
                return message;
              }
              const nextMessage = {
                ...message,
                status: nextStatus,
              };
              if (message.status === nextMessage.status) {
                return message;
              }
              changedMessages.push(nextMessage);
              return nextMessage;
            }),
          };
          if (changedMessages.length === 0) {
            return current;
          }
          persistShell(next);
          for (const message of changedMessages) {
            dispatchMessageChanged(
              message.id,
              message.conversationId,
              toDesktopMessage(message)
            );
            registerMessageInCache(message);
          }
          return next;
        });
      } else if (event.type === 'typing') {
        if (event.sourceDevice == null) {
          console.warn('Message stream typing event missing sourceDevice', {
            conversationId: event.conversationId,
            senderAci: event.senderAci,
          });
          return;
        }
        window.ConversationController?.get?.(
          event.conversationId
        )?.notifyTyping?.({
          fromMe: false,
          isTyping: event.action === 0,
          senderDevice: event.sourceDevice,
          senderId: event.senderAci,
        });
      } else if (event.type === 'poll-vote') {
        const ourAci = currentLinkedSession.credentials?.aci;
        if (!ourAci) {
          return;
        }
        setShell(current => {
          const target = findWebMessageByAuthorAndTimestamp({
            conversationId: event.conversationId,
            messages: current.messages,
            ourConversationId: ourAci,
            targetAuthorAci: event.targetAuthorAci,
            targetTimestamp: event.targetTimestamp,
          });
          if (!target) {
            console.warn('Message stream poll-vote target was not applied', {
              conversationId: event.conversationId,
              targetAuthorAci: event.targetAuthorAci,
              targetTimestamp: event.targetTimestamp,
            });
            return current;
          }
          const nextMessage = applyPollVoteToMessage(target, event);
          if (!nextMessage || nextMessage === target) {
            return current;
          }
          const result = replaceMessageById(
            current.messages,
            target.id,
            () => nextMessage
          );
          if (!result.existing) {
            return current;
          }
          const next = {
            ...current,
            messages: result.messages,
          };
          persistShell(next);
          dispatchMessageChanged(
            target.id,
            target.conversationId,
            toDesktopMessage(nextMessage)
          );
          registerMessageInCache(nextMessage);
          return next;
        });
      } else if (event.type === 'poll-terminate') {
        const ourAci = currentLinkedSession.credentials?.aci;
        if (!ourAci) {
          return;
        }
        setShell(current => {
          const target = findWebMessageByAuthorAndTimestamp({
            conversationId: event.conversationId,
            messages: current.messages,
            ourConversationId: ourAci,
            targetAuthorAci: event.targetAuthorAci,
            targetTimestamp: event.targetTimestamp,
          });
          if (!target) {
            console.warn(
              'Message stream poll-terminate target was not applied',
              {
                conversationId: event.conversationId,
                targetAuthorAci: event.targetAuthorAci,
                targetTimestamp: event.targetTimestamp,
              }
            );
            return current;
          }
          const nextMessage = applyPollTerminateToMessage(target, event);
          if (!nextMessage || nextMessage === target) {
            return current;
          }
          const result = replaceMessageById(
            current.messages,
            target.id,
            () => nextMessage
          );
          if (!result.existing) {
            return current;
          }
          const next = {
            ...current,
            messages: result.messages,
          };
          persistShell(next);
          dispatchMessageChanged(
            target.id,
            target.conversationId,
            toDesktopMessage(nextMessage)
          );
          registerMessageInCache(nextMessage);
          return next;
        });
      } else if (event.type === 'message-status') {
        setShell(current => {
          const { existing, messages } = replaceMessageById(
            current.messages,
            event.id,
            message => ({ ...message, status: event.status })
          );
          if (!existing) {
            return current;
          }
          const next = {
            ...current,
            messages,
          };
          persistShell(next);
          dispatchConversationMessages(existing.conversationId, next);
          return next;
        });
      } else if (event.type === 'error') {
        if (isDeviceDelinkedError(event.error)) {
          abortController.abort();
          handleDeviceDelinked();
          return;
        }
        console.error('Message stream event error', event.error);
      }
    };

    const run = async () => {
      let reconnectDelay = MESSAGE_STREAM_RECONNECT_INITIAL_DELAY;
      while (!abortController.signal.aborted) {
        try {
          await consumeMessageTransportStream({
            importBackup,
            linkedSession: getCurrentLinkedSession(),
            includeProtocol: true,
            signal: abortController.signal,
            onEvent: handleEvent,
          });
          reconnectDelay = MESSAGE_STREAM_RECONNECT_INITIAL_DELAY;
        } catch (error) {
          if (abortController.signal.aborted) {
            return;
          }
          if (
            isDeviceDelinkedError(
              error instanceof Error ? error.message : String(error)
            )
          ) {
            handleDeviceDelinked();
            return;
          }
          console.error('Message stream failed', error);
        }
        setMessageRuntimeSessionId(undefined);
        try {
          await delay(
            getMessageStreamReconnectDelay(reconnectDelay),
            abortController.signal
          );
        } catch {
          return;
        }
        reconnectDelay = Math.min(
          reconnectDelay * 2,
          MESSAGE_STREAM_RECONNECT_MAX_DELAY
        );
      }
    };

    void run();

    return () => {
      abortController.abort();
    };
  }, [handleDeviceDelinked, messageStreamSessionKey]);

  const appState = {
    ...store.getState().app,
    appView:
      linkedSession && !backupImportScreenState
        ? AppViewType.Inbox
        : AppViewType.Installer,
    hasInitialLoadCompleted: true,
  };

  return (
    <AppProvider>
      <Provider store={store}>
        <WebDesktopAppBody
          appState={appState}
          backupImportScreenState={backupImportScreenState}
          isRelinkRequired={isRelinkRequired}
          linkedSession={linkedSession}
          messageRuntimeSessionId={messageRuntimeSessionId}
          onRelinkDevice={relinkDevice}
          reloadLinkedSession={reloadLinkedSession}
          setShell={setShell}
          shell={shell}
        />
      </Provider>
    </AppProvider>
  );
}
