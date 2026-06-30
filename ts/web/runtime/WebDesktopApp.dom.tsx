// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type JSX,
  type SetStateAction,
} from 'react';
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
  requestAttachmentBackfill,
  sendDirectDeleteForEveryone,
  sendDirectTextMessage,
  sendDirectReaction,
  sendDirectUnpinMessage,
  sendGroupReaction,
  sendGroupTextMessage,
  syncContacts,
} from '../api.dom.ts';
import { getWebAttachmentContentTypeFromParts } from '../attachmentMime.std.ts';
import {
  applyContactsBootstrap,
  compareWebMessages,
  getDesktopMessageMetrics,
  getConversationListSortTimestamp,
  getWebAttachmentVirtualPath,
  getWebConversationLastMessage,
  getWebMessagePreviewText,
  registerMessageInCache,
  toDesktopConversation,
  toDesktopMessage,
} from './stateAdapter.dom.ts';
import { recoverRetriableAttachmentStates } from './recoverRetriableAttachmentStates.dom.ts';
import { setupWebGlobals } from './setupWebGlobals.dom.ts';
import {
  loadChatShellStateForSession,
  loadContactsBootstrapForSession,
  loadLinkedSessionRecordFromIndexedDb,
  persistLinkedSessionRecordToIndexedDb,
  persistLinkedSessionToStorage,
  persistChatShellStateToStorage,
  persistContactsBootstrapForSession,
} from '../persistence.dom.ts';
import type {
  ChatShellState,
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

const VIDEO_THUMBNAIL_MAX_SIDE = 480;
const VIDEO_THUMBNAIL_QUALITY = 0.82;
const VIDEO_THUMBNAIL_TIMEOUT = 30_000;
const ATTACHMENT_BACKFILL_REQUEST_TIMEOUT = 10 * SECOND;
const ATTACHMENT_BACKFILL_STATUS_PENDING =
  Proto.SyncMessage.AttachmentBackfillResponse.AttachmentData.Status.PENDING;
const ATTACHMENT_BACKFILL_STATUS_TERMINAL_ERROR =
  Proto.SyncMessage.AttachmentBackfillResponse.AttachmentData.Status
    .TERMINAL_ERROR;
const ATTACHMENT_BACKFILL_ERROR_MESSAGE_NOT_FOUND =
  Proto.SyncMessage.AttachmentBackfillResponse.Error.MESSAGE_NOT_FOUND;
const EMPTY_SHELL: ChatShellState = {
  conversationLookup: {},
  messages: [],
  pinnedMessages: [],
};

const MESSAGE_STREAM_RECONNECT_INITIAL_DELAY = 1_000;
const MESSAGE_STREAM_RECONNECT_MAX_DELAY = 15_000;
const DEVICE_DELINKED_ERROR = 'DeviceDelinked: device was deregistered';
const pendingAttachmentBackfillTimeouts = new Map<string, number>();

function isWebAudioAttachment(attachment: WebAttachment): boolean {
  const contentType = getWebAttachmentContentTypeFromParts(attachment);
  return (
    contentType.startsWith('audio/') ||
    attachment.flags === Proto.AttachmentPointer.Flags.VOICE_MESSAGE
  );
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

type SignalWebRuntime = {
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
  markAttachmentUnavailable?: (messageId: string, attachmentPath: string) => void;
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
  return Boolean(error?.includes(DEVICE_DELINKED_ERROR));
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

function WebInbox({
  linkedSession,
  messageRuntimeSessionId,
  shell,
  setShell,
}: Readonly<{
  linkedSession: LinkedSessionRecord;
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
          linkedSession={linkedSession}
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
  linkedSession,
  messageRuntimeSessionId,
  reloadLinkedSession,
  setShell,
  shell,
}: Readonly<{
  appState: StateType['app'];
  backupImportScreenState?: BackupImportScreenState;
  linkedSession?: LinkedSessionRecord;
  messageRuntimeSessionId?: string;
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
          renderInstallScreen={() => (
            backupImportScreenState ? (
              <WebBackupImportScreen state={backupImportScreenState} />
            ) : (
              <WebInstallScreen onLinked={reloadLinkedSession} />
            )
          )}
          renderLightbox={renderLightbox}
          renderStandaloneRegistration={renderEmpty}
          hasSelectedStoryData={false}
          renderStoryViewer={renderEmpty}
          renderInbox={() =>
            linkedSession ? (
              <WebInbox
                linkedSession={linkedSession}
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

function dispatchConversation(
  linkedSession: LinkedSessionRecord,
  conversationId: string,
  shell: ChatShellState
): void {
  const conversation = shell.conversationLookup[conversationId];
  if (!conversation) {
    return;
  }
  window.reduxActions?.conversations?.conversationsUpdated?.([
    toDesktopConversation(conversation, linkedSession) as never,
  ]);
}

function dispatchConversations(
  linkedSession: LinkedSessionRecord,
  shell: ChatShellState
): void {
  const conversations = Object.values(shell.conversationLookup).map(
    conversation => toDesktopConversation(conversation, linkedSession)
  );
  if (conversations.length > 0) {
    window.reduxActions?.conversations?.conversationsUpdated?.(
      conversations as never
    );
  }
}

function dispatchConversationMessages(
  conversationId: string,
  shell: ChatShellState
): void {
  const messages = shell.messages
    .filter(message => message.conversationId === conversationId)
    .sort(compareWebMessages);
  messages.forEach(registerMessageInCache);
  const desktopMessages = messages.map(toDesktopMessage);

  window.reduxActions?.conversations?.messagesReset?.({
    conversationId,
    messages: desktopMessages,
    metrics: getDesktopMessageMetrics(desktopMessages),
    pinnedMessagesPreloadData:
      getWebPinnedMessagesPreloadDataForConversation(conversationId),
    unboundedFetch: true,
  });
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

function dispatchMessage(event: MessageStreamEvent): void {
  if (event.type !== 'message') {
    return;
  }
  window.reduxActions?.conversations?.messagesAdded?.({
    conversationId: event.message.conversationId,
    isActive: document.visibilityState === 'visible',
    isJustSent: event.message.direction === 'outgoing',
    isNewMessage: true,
    messages: [toDesktopMessage(event.message)],
  });
  registerMessageInCache(event.message);
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

function getGroupDescriptionFromMessage(
  message: WebMessage
): { description: string | undefined; didChange: boolean } {
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
  message: WebMessage
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
  ourConversationId?: string
): ChatShellState {
  const existing = shell.conversationLookup[message.conversationId];
  const timestamp = message.receivedAt ?? message.timestamp;
  const isUnreadIncoming =
    message.direction === 'incoming' && message.readStatus === ReadStatus.Unread;
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
        snippet: getWebMessagePreviewText(message) || existing.snippet,
        messageCount: (existing.messageCount ?? 0) + 1,
        sentMessageCount:
          message.direction === 'outgoing'
            ? (existing.sentMessageCount ?? 0) + 1
            : existing.sentMessageCount,
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
      message
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
          lastMessage: getWebConversationLastMessage(message, ourConversationId),
          lastMessageReceivedAt: message.timestamp,
          lastMessageReceivedAtMs: timestamp,
          inboxPosition: timestamp,
        },
        message
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
          }
        : {
            ...incomingConversation,
            ...currentConversation,
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
    messages: shell.messages.map(message =>
      message.conversationId === conversationId &&
      message.direction === 'incoming' &&
      message.readStatus === ReadStatus.Unread
        ? { ...message, readStatus: ReadStatus.Read }
        : message
    ),
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
  if (message.editHistory?.some(item => item.timestamp === edit.message.timestamp)) {
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
  const [messageRuntimeSessionId, setMessageRuntimeSessionId] =
    useState<string>();
  const [backupImportScreenState, setBackupImportScreenState] =
    useState<BackupImportScreenState>();

  const persistShell = useCallback(
    (next: ChatShellState) => {
      setWebRuntimeChatShell(next);
      void persistChatShellStateToStorage(next, linkedSession?.credentials?.aci);
    },
    [linkedSession?.credentials?.aci]
  );

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
              const currentMessage = current.messages.find(
                item => item.id === message.id
              );
              const currentAttachment =
                currentMessage?.attachments?.[attachmentIndex];
              if (
                !currentMessage ||
                !currentAttachment ||
                currentAttachment.thumbnailUrl ||
                currentAttachment.thumbnail ||
                !currentAttachment.contentType?.startsWith('video/')
              ) {
                return current;
              }

              const nextMessage: WebMessage = {
                ...currentMessage,
                attachments: currentMessage.attachments?.map((item, index) =>
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
              const next = {
                ...current,
                messages: current.messages.map(item =>
                  item.id === currentMessage.id ? nextMessage : item
                ),
              };
              persistShell(next);
              registerMessageInCache(nextMessage);
              window.reduxActions?.conversations?.messageChanged?.(
                nextMessage.id,
                nextMessage.conversationId,
                toDesktopMessage(nextMessage)
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
        const target = current.messages.find(message => message.id === messageId);
        if (!target?.attachments?.length) {
          return current;
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
        if (!didChange) {
          return current;
        }

        const next = {
          ...current,
          messages: current.messages.map(message =>
            message.id === messageId ? nextMessage : message
          ),
        };
        persistShell(next);
        registerMessageInCache(nextMessage);
        window.reduxActions?.conversations?.messageChanged?.(
          nextMessage.id,
          nextMessage.conversationId,
          toDesktopMessage(nextMessage)
        );
        return next;
      });
    };

    const showBackfillFailureModal = (
      kind: BackfillFailureModalKind
    ): void => {
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
          const nextShell = {
            ...current,
            messages: [
              ...current.messages.filter(item => item.id !== message.id),
              message,
            ].sort(compareWebMessages),
            conversationLookup: {
              ...current.conversationLookup,
              [conversationId]: nextConversation,
            },
          };
          persistShell(nextShell);
          dispatchConversation(linkedSession, conversationId, nextShell);
          window.reduxActions?.conversations?.messagesAdded?.({
            conversationId,
            isActive: document.visibilityState === 'visible',
            isJustSent: true,
            isNewMessage: true,
            messages: [toDesktopMessage(message)],
          });
          window.reduxActions?.toast?.showToast?.({
            toastType: ToastType.LeftGroup,
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
          targetFromShell?.attachments?.some(isWebBackupOnlyAudioAttachment)
        );
        const canHandle = Boolean(
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
          const target = current.messages.find(message => message.id === messageId);
          if (!target?.attachments?.length) {
            return current;
          }

          const nextMessage: WebMessage = {
            ...target,
            attachments: target.attachments.map(attachment => {
              if (isWebBackupOnlyAudioAttachment(attachment)) {
                const pendingAttachment = { ...attachment };
                delete pendingAttachment.downloadPath;
                delete pendingAttachment.downloadUrl;
                delete pendingAttachment.localBlobKey;
                delete pendingAttachment.path;
                delete pendingAttachment.url;
                return {
                  ...pendingAttachment,
                  backfillError: undefined,
                  error: undefined,
                  isCorrupted: undefined,
                  status: 'pending',
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

          const next = {
            ...current,
            messages: current.messages.map(message =>
              message.id === messageId ? nextMessage : message
            ),
          };
          void persistChatShellStateToStorage(
            next,
            linkedSession?.credentials?.aci
          );
          registerMessageInCache(nextMessage);
          window.reduxActions?.conversations?.messageChanged?.(
            nextMessage.id,
            nextMessage.conversationId,
            toDesktopMessage(nextMessage)
          );
          return next;
        });
        return true;
      },
      markAttachmentUnavailable(messageId, attachmentPath) {
        setShell(current => {
          const target = current.messages.find(message => message.id === messageId);
          if (!target?.attachments?.length) {
            return current;
          }
          let didChange = false;
          const nextMessage: WebMessage = {
            ...target,
            attachments: target.attachments.map(attachment => {
              if (getWebAttachmentVirtualPath(attachment) !== attachmentPath) {
                return attachment;
              }
              didChange = true;
              return {
                ...attachment,
                backfillError: true,
                status: 'failed',
              };
            }),
          };
          if (!didChange) {
            return current;
          }
          const next = {
            ...current,
            messages: current.messages.map(message =>
              message.id === messageId ? nextMessage : message
            ),
          };
          registerMessageInCache(nextMessage);
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
            const conversation = shell.conversationLookup[target.conversationId];
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
                recipients: conversation.membersV2?.map(member => member.aci),
                timestamp,
              });
            } else {
              await sendDirectDeleteForEveryone({
                runtimeSessionId: messageRuntimeSessionId,
                destinationServiceId: conversation.serviceId ?? target.conversationId,
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
            window.reduxActions?.conversations?.messageChanged?.(
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
                      recipients: conversation.membersV2?.map(
                        member => member.aci
                      ),
                    })
                  : await sendDirectTextMessage({
                      runtimeSessionId: messageRuntimeSessionId,
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
            messages: [...nextShell.messages, ...outboundMessages].sort(
              compareWebMessages
            ),
          };
          persistShell(nextShell);
          for (const message of outboundMessages) {
            registerMessageInCache(message);
            dispatchConversation(linkedSession, message.conversationId, nextShell);
          }
          return nextShell;
        });

        for (const message of outboundMessages) {
          window.reduxActions?.conversations?.messagesAdded?.({
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
	            if (current.messages.some(message => message.id === notification.id)) {
	              return current;
	            }
	            const next = {
	              ...current,
	              messages: [...current.messages, notification].sort(compareWebMessages),
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
        const previousMessage = shell.messages.find(message => message.id === id);
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
          nextMessage = applyOutgoingReactionToMessage({
            message: previousMessage,
            reaction,
            timestamp,
            isSent: false,
            ourConversationId,
          });
          const nextShell = {
            ...current,
            messages: current.messages.map(message =>
              message.id === id && nextMessage ? nextMessage : message
            ),
          };
          void persistChatShellStateToStorage(
            nextShell,
            linkedSession.credentials?.aci
          );
          window.reduxActions?.conversations?.messageChanged?.(
            id,
            nextMessage.conversationId,
            toDesktopMessage(nextMessage)
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
                destinationServiceId: conversation.serviceId ?? conversation.id,
                emoji: reaction.emoji,
                remove: reaction.remove,
                targetAuthorAci,
                targetTimestamp: previousMessage.timestamp,
                timestamp,
              });
            }
            setShell(current => {
              const message = current.messages.find(item => item.id === id);
              if (!message) {
                return current;
              }
              const sentMessage = applyOutgoingReactionToMessage({
                message,
                reaction,
                timestamp,
                isSent: true,
                ourConversationId,
              });
              const nextShell = {
                ...current,
                messages: current.messages.map(item =>
                  item.id === id ? sentMessage : item
                ),
              };
              void persistChatShellStateToStorage(
                nextShell,
                linkedSession.credentials?.aci
              );
              window.reduxActions?.conversations?.messageChanged?.(
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
              const nextShell = {
                ...current,
                messages: current.messages.map(message =>
                  message.id === id ? previousMessage : message
                ),
              };
              void persistChatShellStateToStorage(
                nextShell,
                linkedSession.credentials?.aci
              );
              window.reduxActions?.conversations?.messageChanged?.(
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
        const existingIds = new Set(current.messages.map(message => message.id));
        const nextMessages = [
          ...current.messages,
          ...messages.filter(message => !existingIds.has(message.id)),
        ].sort(compareWebMessages);
        if (nextMessages.length === current.messages.length) {
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
          messages: current.messages.filter(message => !deleted.has(message.id)),
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
        const existing = current.conversationLookup[conversationId];
        if (!existing) {
          return current;
        }
        const updated = {
          ...current,
          conversationLookup: {
            ...current.conversationLookup,
            [conversationId]: {
              ...existing,
              ...attributes,
            } as WebConversation,
          },
        };
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
      const nextShell = applyContactsBootstrap(
        recoveredShell,
        contacts,
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

  useEffect(() => {
    if (!linkedSession?.credentials?.aci) {
      return undefined;
    }

    const abortController = new AbortController();
    const importBackup = shouldImportBackup(linkedSession, shell);
    if (importBackup) {
      setBackupImportScreenState({ status: 'idle' });
    } else {
      setBackupImportScreenState(undefined);
    }
    let runtimeSessionId: string | undefined;
    const clearAttachmentBackfillTimeout = (messageId: string): void => {
      const existing = pendingAttachmentBackfillTimeouts.get(messageId);
      if (existing != null) {
        window.clearTimeout(existing);
        pendingAttachmentBackfillTimeouts.delete(messageId);
      }
    };
    const showBackfillFailureModal = (
      kind: BackfillFailureModalKind
    ): void => {
      window.reduxActions?.globalModals?.showBackfillFailureModal?.(kind);
    };
    const handleEvent = (event: MessageStreamEvent) => {
      if (event.type === 'session') {
        runtimeSessionId = event.sessionId;
        setMessageRuntimeSessionId(event.sessionId);
      } else if (event.type === 'linked-session-updated') {
        setLinkedSession(current => {
          if (!current) {
            return current;
          }
          const next: LinkedSessionRecord = {
            ...current,
            account: event.linkedPayload.account,
            credentials: event.linkedPayload.credentials,
            linkedPayload: event.linkedPayload,
            lastUpdatedAt: Date.now(),
            storageServiceKey: event.linkedPayload.storageServiceKey,
          };
          persistLinkedSessionToStorage(next);
          void persistLinkedSessionRecordToIndexedDb(next);
          return next;
        });
      } else if (event.type === 'transport-status') {
        if (isDeviceDelinkedError(event.error)) {
          abortController.abort();
          setMessageRuntimeSessionId(undefined);
          setLinkedSession(undefined);
          persistLinkedSessionToStorage(undefined);
          void persistLinkedSessionRecordToIndexedDb(undefined);
          window.reduxActions?.network?.setNetworkStatus?.({
            isOnline: false,
            socketStatus: SocketStatus.CLOSED,
          });
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
        if (event.status === 'open' && runtimeSessionId) {
          void syncContacts({ runtimeSessionId })
            .then(data => {
              void persistContactsBootstrapForSession(
                linkedSession.credentials?.aci,
                data
              );
              setShell(current => {
                const next = applyContactsBootstrap(
                  current,
                  data,
                  linkedSession
                );
                persistShell(next);
                dispatchShell(linkedSession, next);
                return next;
              });
            })
            .catch(error => {
              console.error('Contacts sync failed', error);
            });
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
        void persistContactsBootstrapForSession(
          linkedSession.credentials?.aci,
          event.data
        );
        setShell(current => {
          const next = applyContactsBootstrap(current, event.data, linkedSession);
          persistShell(next);
          dispatchShell(linkedSession, next);
          return next;
        });
      } else if (event.type === 'chat-shell') {
        setShell(current => {
          const merged = mergeChatShellState(current, event.state);
          const next = applyContactsBootstrap(merged, undefined, linkedSession);
          persistShell(next);
          dispatchShell(linkedSession, next);
          return next;
        });
      } else if (event.type === 'conversation') {
        setShell(current => {
          const next = {
            ...current,
            conversationLookup: {
              ...current.conversationLookup,
              [event.conversation.id]: event.conversation,
            },
          };
          persistShell(next);
          dispatchConversation(linkedSession, event.conversation.id, next);
          return next;
        });
      } else if (event.type === 'message') {
        const selectedConversationId =
          window.reduxStore?.getState
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
        setShell(current => {
          if (current.messages.some(existing => existing.id === message.id)) {
            return current;
          }
          shouldDispatchMessage = true;
          const ourConversationId =
            linkedSession.credentials?.aci ?? linkedSession.account.aci;
          const withConversation = ensureConversationForMessage(
            current,
            message,
            ourConversationId
          );
          const next = {
            ...withConversation,
            messages: [...withConversation.messages, message].sort(
              compareWebMessages
            ),
          };
          persistShell(next);
          dispatchConversation(linkedSession, message.conversationId, next);
          return next;
        });
        if (shouldDispatchMessage) {
          dispatchMessage({ ...event, message });
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
          if (current.messages.some(message => message.id === notification.id)) {
            return current;
          }
          const ourConversationId =
            linkedSession.credentials?.aci ?? linkedSession.account.aci;
          const next = ensureConversationForMessage(
            {
              ...current,
              messages: [...current.messages, notification].sort(compareWebMessages),
            },
            notification,
            ourConversationId
          );
          persistShell(next);
          registerMessageInCache(notification);
          return next;
        });
      } else if (event.type === 'attachment-backfill') {
        const ourAci = linkedSession.credentials?.aci ?? linkedSession.account.aci;
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
            const next = {
              ...current,
              messages: current.messages.map(message =>
                message.id === target.id ? nextMessage : message
              ),
            };
            persistShell(next);
            registerMessageInCache(nextMessage);
            window.reduxActions?.conversations?.messageChanged?.(
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
                didChange = true;
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
                error: undefined,
                isCorrupted: undefined,
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
          const next = {
            ...current,
            messages: current.messages.map(message =>
              message.id === target.id ? nextMessage : message
            ),
          };
          persistShell(next);
          registerMessageInCache(nextMessage);
          window.reduxActions?.conversations?.messageChanged?.(
            nextMessage.id,
            nextMessage.conversationId,
            toDesktopMessage(nextMessage)
          );
          dispatchConversation(linkedSession, nextMessage.conversationId, next);
          dispatchConversationMessages(nextMessage.conversationId, next);
          return next;
        });
      } else if (event.type === 'reaction') {
        const ourAci = linkedSession.credentials?.aci;
        if (!ourAci) {
          return;
        }
        setShell(current => {
          const target = current.messages.find(message => {
            return (
              message.conversationId === event.conversationId &&
              getWebMessageAuthorAci(message, ourAci) === event.targetAuthorAci &&
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
          const next = {
            ...current,
            messages: current.messages.map(message =>
              message.id === target.id ? nextMessage : message
            ),
          };
          persistShell(next);
          window.reduxActions?.conversations?.messageChanged?.(
            target.id,
            target.conversationId,
            toDesktopMessage(nextMessage)
          );
          return next;
        });
      } else if (event.type === 'edit-message') {
        const ourAci = linkedSession.credentials?.aci;
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
	            linkedSession.credentials?.aci ?? linkedSession.account.aci
	          );
          const next = {
            ...withConversation,
            messages: withConversation.messages.map(message =>
              message.id === target.id ? nextMessage : message
            ),
          };
          persistShell(next);
          dispatchConversation(linkedSession, nextMessage.conversationId, next);
          window.reduxActions?.conversations?.messageChanged?.(
            target.id,
            target.conversationId,
            toDesktopMessage(nextMessage)
          );
          registerMessageInCache(nextMessage);
          return next;
        });
      } else if (event.type === 'delete-message') {
        const ourAci = linkedSession.credentials?.aci;
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
            console.warn('Message stream delete-message target was not applied', {
              conversationId: event.conversationId,
              targetAuthorAci: event.targetAuthorAci,
              targetSentTimestamp: event.targetSentTimestamp,
            });
            return current;
          }

          const nextMessage = eraseWebMessageForEveryone(target, event);
          if (nextMessage === target) {
            return current;
          }
	          const withConversation = updateConversationForChangedMessage(
	            current,
	            nextMessage,
	            linkedSession.credentials?.aci ?? linkedSession.account.aci
	          );
          const next = {
            ...withConversation,
            messages: withConversation.messages.map(message =>
              message.id === target.id ? nextMessage : message
            ),
          };
          persistShell(next);
          dispatchConversation(linkedSession, nextMessage.conversationId, next);
          window.reduxActions?.conversations?.messageChanged?.(
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
            window.reduxActions?.conversations?.messageChanged?.(
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
        window.ConversationController?.get?.(event.conversationId)?.notifyTyping?.({
          fromMe: false,
          isTyping: event.action === 0,
          senderDevice: event.sourceDevice,
          senderId: event.senderAci,
        });
      } else if (event.type === 'poll-vote') {
        const ourAci = linkedSession.credentials?.aci;
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
          const next = {
            ...current,
            messages: current.messages.map(message =>
              message.id === target.id ? nextMessage : message
            ),
          };
          persistShell(next);
          window.reduxActions?.conversations?.messageChanged?.(
            target.id,
            target.conversationId,
            toDesktopMessage(nextMessage)
          );
          registerMessageInCache(nextMessage);
          return next;
        });
      } else if (event.type === 'poll-terminate') {
        const ourAci = linkedSession.credentials?.aci;
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
            console.warn('Message stream poll-terminate target was not applied', {
              conversationId: event.conversationId,
              targetAuthorAci: event.targetAuthorAci,
              targetTimestamp: event.targetTimestamp,
            });
            return current;
          }
          const nextMessage = applyPollTerminateToMessage(target, event);
          if (!nextMessage || nextMessage === target) {
            return current;
          }
          const next = {
            ...current,
            messages: current.messages.map(message =>
              message.id === target.id ? nextMessage : message
            ),
          };
          persistShell(next);
          window.reduxActions?.conversations?.messageChanged?.(
            target.id,
            target.conversationId,
            toDesktopMessage(nextMessage)
          );
          registerMessageInCache(nextMessage);
          return next;
        });
      } else if (event.type === 'message-status') {
        setShell(current => {
          const existing = current.messages.find(message => message.id === event.id);
          const next = {
            ...current,
            messages: current.messages.map(message =>
              message.id === event.id
                ? { ...message, status: event.status }
                : message
            ),
          };
          persistShell(next);
          if (existing) {
            dispatchConversationMessages(existing.conversationId, next);
          }
          return next;
        });
      } else if (event.type === 'error') {
        console.error('Message stream event error', event.error);
      }
    };

    const run = async () => {
      let reconnectDelay = MESSAGE_STREAM_RECONNECT_INITIAL_DELAY;
      while (!abortController.signal.aborted) {
        try {
          await consumeMessageTransportStream({
            importBackup,
            linkedSession,
            includeProtocol: true,
            signal: abortController.signal,
            onEvent: handleEvent,
          });
          reconnectDelay = MESSAGE_STREAM_RECONNECT_INITIAL_DELAY;
        } catch (error) {
          if (abortController.signal.aborted) {
            return;
          }
          console.error('Message stream failed', error);
        }
        setMessageRuntimeSessionId(undefined);
        try {
          await delay(reconnectDelay, abortController.signal);
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
  }, [linkedSession]);

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
          linkedSession={linkedSession}
          messageRuntimeSessionId={messageRuntimeSessionId}
          reloadLinkedSession={reloadLinkedSession}
          setShell={setShell}
          shell={shell}
        />
      </Provider>
    </AppProvider>
  );
}
