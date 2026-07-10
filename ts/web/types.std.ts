// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import type {
  ConversationAttributesType,
  EditHistoryType,
  GroupV2BannedMemberType,
  GroupV2MemberType,
  GroupV2PendingMemberType,
  MessageReactionType,
} from '../model-types.d.ts';
import type { MessageRequestResponseEvent } from '../types/MessageRequestResponseEvent.std.ts';
import type { ProcessedDataMessage } from '../textsecure/Types.d.ts';
import type { PollMessageAttribute } from '../types/Polls.dom.ts';
import type { PinnedMessage } from '../types/PinnedMessage.std.ts';
import type { ServiceIdString } from '../types/ServiceId.std.ts';
import type { GroupV2ChangeType } from '../types/groups.std.ts';
import type { StoryDistributionIdString } from '../types/StoryDistributionId.std.ts';
import type { Emoji } from '../axo/emoji.std.ts';
import type {
  ConversationColorType,
  CustomColorType,
} from '../types/Colors.std.ts';
import type { DurationInSeconds } from '../util/durations/index.std.ts';
import type { AvatarDataType } from '../types/Avatar.std.ts';

export type WebAccount = Readonly<{
  aci?: string;
  about?: string;
  aboutEmoji?: Emoji.Variant;
  pni?: string;
  number?: string;
  phoneNumber?: string;
  title?: string;
  profileName?: string;
  profileFamilyName?: string;
  firstName?: string;
  familyName?: string;
  localProfileUpdatedAt?: number;
  username?: string;
  avatarUrl?: string;
  avatarUrlPath?: string;
  color?: string;
}>;

export type LinkedPayload = Readonly<{
  account: WebAccount;
  credentials?: WebCredentials;
  storageServiceKey?: string;
  profileKeyBase64?: string;
  masterKeyBase64?: string;
  accountEntropyPool?: string;
  ephemeralBackupKeyBase64?: string;
  mediaRootBackupKeyBase64?: string;
  backupDownloadPath?: string;
  aciIdentityKeyPublic?: string;
  aciIdentityKeyPrivate?: string;
  pniIdentityKeyPublic?: string;
  pniIdentityKeyPrivate?: string;
  aciRegistrationId?: number;
  pniRegistrationId?: number;
  aciSignedPreKeyRecordBase64?: string;
  pniSignedPreKeyRecordBase64?: string;
  aciPqLastResortPreKeyRecordBase64?: string;
  pniPqLastResortPreKeyRecordBase64?: string;
  protocolPersistenceVersion?: 1;
}>;

export type ProtocolState = Readonly<{
  registrationIds: Readonly<{
    aci?: number;
    pni?: number;
  }>;
  identityKeys: Readonly<{
    aci?: IdentityKeyPair;
    pni?: IdentityKeyPair;
  }>;
  identityRecords: ReadonlyArray<unknown>;
  preKeys: ReadonlyArray<ProtocolPreKeyRecord>;
  signedPreKeys: ReadonlyArray<unknown>;
  kyberPreKeys: ReadonlyArray<ProtocolKyberPreKeyRecord>;
  sessions: ReadonlyArray<ProtocolSessionRecord>;
  senderKeys: ReadonlyArray<ProtocolSenderKeyRecord>;
}>;

export type IdentityKeyPair = Readonly<{
  publicKey?: string;
  privateKey?: string;
}>;

export type ProtocolSessionRecord = Readonly<{
  namespace: string;
  addressKey: string;
  recordBase64: string;
}>;

export type ProtocolSenderKeyRecord = Readonly<{
  namespace: string;
  senderKey: string;
  recordBase64: string;
}>;

export type ProtocolPreKeyRecord = Readonly<{
  namespace: string;
  keyId: number;
  recordBase64: string;
}>;

export type ProtocolKyberPreKeyRecord = Readonly<{
  namespace: string;
  keyId: number;
  isLastResort?: boolean;
  recordBase64: string;
}>;

export type LinkedSessionRecord = Readonly<{
  id: 'current';
  version: 1;
  linkedAt: number;
  lastUpdatedAt: number;
  account: WebAccount;
  linkedPayload: LinkedPayload;
  credentials?: WebCredentials;
  storageServiceKey?: string;
  protocol: ProtocolState;
}>;

export type WebCredentials = Readonly<{
  username: string;
  password: string;
  deviceId: number;
  aci: string;
  pni?: string;
  number: string;
}>;

export type WebAttachment = Readonly<{
  id?: string;
  kind?: 'file' | 'image' | 'video';
  cdnId?: string;
  cdnKey?: string;
  cdnNumber?: number;
  keyBase64?: string;
  digestBase64?: string;
  incrementalMacBase64?: string;
  key?: string;
  digest?: string;
  incrementalMac?: string;
  chunkSize?: number;
  size?: number;
  contentType?: string;
  fileName?: string;
  flags?: number;
  width?: number;
  height?: number;
  duration?: number;
  caption?: string;
  blurHash?: string;
  uploadTimestamp?: number;
  clientUuid?: string;
  plaintextHash?: string;
  downloadPath?: string;
  backupCdnNumber?: number;
  localKey?: string;
  downloadUrl?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  localBlobKey?: string;
  thumbnail?: WebAttachment;
  path?: string;
  url?: string;
  dataBase64?: string;
  textAttachment?: unknown;
  status?: 'pending' | 'uploading' | 'ready' | 'failed' | 'sent';
  error?: string;
  backfillError?: boolean;
  isCorrupted?: boolean;
}>;

export type WebPinMessage = Readonly<{
  targetAuthorAci: string;
  targetSentTimestamp: number;
  pinDurationSeconds: number | null;
}>;

export type WebUnpinMessage = Readonly<{
  targetAuthorAci: string;
  targetSentTimestamp: number;
}>;

export type WebDeleteForEveryone = Readonly<{
  targetAuthorAci: string;
  targetSentTimestamp: number;
  isAdminDelete?: boolean;
}>;

export type WebPinMessageEvent = Readonly<{
  type: 'pin-message';
  conversationId: string;
  targetAuthorAci: string;
  targetSentTimestamp: number;
  pinDurationSeconds: number | null;
  senderAci: string;
  timestamp: number;
  receivedAt: number;
}>;

export type WebReactionEvent = Readonly<{
  type: 'reaction';
  conversationId: string;
  targetAuthorAci: string;
  targetTimestamp: number;
  senderAci: string;
  timestamp: number;
  emoji?: string;
  remove: boolean;
}>;

export type WebEditMessageEvent = Readonly<{
  type: 'edit-message';
  conversationId: string;
  targetTimestamp: number;
  senderAci: string;
  timestamp: number;
  message: WebMessage;
}>;

export type WebDeleteMessageEvent = Readonly<{
  type: 'delete-message';
  conversationId: string;
  targetAuthorAci?: string;
  targetSentTimestamp: number;
  senderAci: string;
  timestamp: number;
  isAdminDelete: boolean;
}>;

export type WebUnpinMessageEvent = Readonly<{
  type: 'unpin-message';
  conversationId: string;
  targetAuthorAci: string;
  targetSentTimestamp: number;
  timestamp: number;
  receivedAt: number;
}>;

export type WebAttachmentBackfillData =
  | Readonly<{ attachment: WebAttachment }>
  | Readonly<{ status: number }>;

export type WebAttachmentBackfillEvent = Readonly<{
  type: 'attachment-backfill';
  conversationId: string;
  targetAuthorAci?: string;
  targetSentTimestamp: number;
  attachments?: ReadonlyArray<WebAttachmentBackfillData>;
  longText?: WebAttachmentBackfillData;
  error?: number;
  timestamp: number;
}>;

export type WebReceiptEvent = Readonly<{
  type: 'receipt';
  conversationId: string;
  senderAci: string;
  receiptType: number | null;
  timestamps: ReadonlyArray<number>;
}>;

export type WebTypingEvent = Readonly<{
  type: 'typing';
  conversationId: string;
  senderAci: string;
  sourceDevice?: number;
  timestamp?: number;
  action: number | null;
}>;

export type WebPollVoteEvent = Readonly<{
  type: 'poll-vote';
  conversationId: string;
  targetAuthorAci: string;
  targetTimestamp: number;
  senderAci: string;
  timestamp: number;
  optionIndexes: ReadonlyArray<number>;
  voteCount: number;
}>;

export type WebPollTerminateEvent = Readonly<{
  type: 'poll-terminate';
  conversationId: string;
  targetAuthorAci: string;
  targetTimestamp: number;
  senderAci: string;
  timestamp: number;
}>;

export type WebMessage = Readonly<
  Partial<
    Omit<
      ProcessedDataMessage,
      | 'attachments'
      | 'bodyAttachment'
      | 'body'
      | 'delete'
      | 'adminDelete'
      | 'pinMessage'
      | 'reaction'
      | 'timestamp'
      | 'unpinMessage'
    >
  > & {
    id: string;
    conversationId: string;
    body?: string;
    timestamp: number;
    receivedAt?: number;
    direction: 'incoming' | 'outgoing';
    desktopType?:
      | 'change-number-notification'
      | 'chat-session-refreshed'
      | 'delivery-issue'
      | 'group-v2-change'
      | 'incoming'
      | 'joined-signal-notification'
      | 'keychange'
      | 'message-request-response-event'
      | 'outgoing'
      | 'pinned-message-notification'
      | 'timer-notification'
      | 'verified-change';
    readStatus?: ReadStatus;
    status?: 'queued' | 'sent' | 'delivered' | 'read' | 'error';
    attachments?: ReadonlyArray<WebAttachment>;
    sourceServiceId?: string;
    reactions?: ReadonlyArray<MessageReactionType>;
    editHistory?: ReadonlyArray<EditHistoryType>;
    editMessageTimestamp?: number;
    editMessageReceivedAt?: number;
    editMessageReceivedAtMs?: number;
    pinMessage?: WebPinMessage;
    unpinMessage?: WebUnpinMessage;
    poll?: PollMessageAttribute;
    bodyAttachment?: WebAttachment;
    deletedForEveryone?: boolean;
    deletedForEveryoneByAdminAci?: string;
    deletedForEveryoneTimestamp?: number;
    expirationTimerUpdate?: {
      expireTimer?: DurationInSeconds;
      fromSync?: boolean;
      source?: string;
      sourceServiceId?: string;
    };
    groupV2Change?: GroupV2ChangeType;
    isErased?: boolean;
    key_changed?: string;
    messageRequestResponseEvent?: MessageRequestResponseEvent;
    supportedVersionAtReceive?: number;
    verified?: boolean;
    verifiedChanged?: string;
  }
>;

export type WebConversation = Readonly<{
  id: string;
  type?: 'direct' | 'group';
  conversationType?: 'direct' | 'group';
  about?: string;
  aboutEmoji?: Emoji.Variant;
  name?: string;
  title?: string;
  titleNoDefault?: string;
  titleNoNickname?: string;
  searchableTitle?: string;
  serviceId?: string;
  pni?: string;
  groupId?: string;
  masterKey?: string;
  publicParams?: string;
  revision?: number;
  secretParams?: string;
  accessControl?: ConversationAttributesType['accessControl'];
  bannedMembersV2?: ReadonlyArray<GroupV2BannedMemberType>;
  membersV2?: ReadonlyArray<GroupV2MemberType>;
  pendingMembersV2?: ReadonlyArray<GroupV2PendingMemberType>;
  description?: string;
  phoneNumber?: string;
  e164?: string;
  expireTimer?: DurationInSeconds;
  expireTimerVersion?: number;
  profileName?: string;
  profileFamilyName?: string;
  firstName?: string;
  familyName?: string;
  nicknameGivenName?: string;
  nicknameFamilyName?: string;
  note?: string;
  systemGivenName?: string;
  systemFamilyName?: string;
  systemNickname?: string;
  profileKey?: string;
  username?: string;
  avatarUrl?: string;
  avatarUrlPath?: string;
  avatars?: ReadonlyArray<AvatarDataType>;
  remoteAvatarUrl?: string;
  color?: string;
  conversationColor?: ConversationColorType;
  customColor?: CustomColorType;
  customColorId?: string;
  lastUpdated?: number;
  lastMessage?: Readonly<
    | {
        author?: string | null;
        bodyRanges?: unknown;
        deletedForEveryone: false;
        prefix?: string;
        status?: string;
        text: string;
      }
    | {
        authorName?: string | null;
        deletedByAdminName?: string | null;
        deletedForEveryone: true;
        isOutgoing?: boolean;
      }
  >;
  lastMessageReceivedAt?: number;
  lastMessageReceivedAtMs?: number;
  inboxPosition?: number;
  activeAt?: number;
  timestamp?: number;
  snippet?: string;
  unreadCount?: number;
  isPinned?: boolean;
  isArchived?: boolean;
  isBlocked?: boolean;
  isMuted?: boolean;
  isMe?: boolean;
  hasAvatar?: boolean;
  hasMessages?: boolean;
  messagesDeleted?: boolean;
  left?: boolean;
  markedUnread?: boolean;
  muteExpiresAt?: number;
  dontNotifyForMentionsIfMuted?: boolean;
  acceptedMessageRequest?: boolean;
  announcementsOnly?: boolean;
  messageCount?: number;
  messageCountBeforeMessageRequests?: number;
  messageRequestResponseType?: number;
  profileSharing?: boolean;
  removalStage?: 'justNotification' | 'messageRequest';
  sentMessageCount?: number;
  terminated?: boolean;
  draft?: string;
  draftBodyRanges?: unknown;
  draftEditMessage?: unknown;
  quotedMessageId?: string;
  capabilities?: Readonly<{
    attachmentBackfill?: boolean;
  }>;
}>;

export type WebStoryDistributionList = Readonly<{
  id: StoryDistributionIdString | string;
  name: string;
  allowsReplies: boolean;
  isBlockList: boolean;
  memberServiceIds: ReadonlyArray<ServiceIdString | string>;
}>;

export type ContactsBootstrap = Readonly<{
  source?: 'storage' | 'backup' | 'local';
  version?: number;
  storageVersion?: number;
  generatedAt: number;
  account?: WebAccount & {
    noteToSelfArchived?: boolean;
    noteToSelfPinned?: boolean;
    noteToSelfMarkedUnread?: boolean;
  };
  selectedConversationId?: string;
  storyDistributionLists?: ReadonlyArray<WebStoryDistributionList>;
  pinned: ReadonlyArray<WebConversation>;
  conversations: ReadonlyArray<WebConversation>;
  archived: ReadonlyArray<WebConversation>;
}>;

export type ChatShellState = Readonly<{
  selectedConversationId?: string;
  conversationLookup: Record<string, WebConversation>;
  messages: ReadonlyArray<WebMessage>;
  pinnedMessages?: ReadonlyArray<PinnedMessage>;
}>;

export type ProvisioningSession = Readonly<{
  sessionId: string;
  status: string;
  url?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  linkedPayload?: LinkedPayload;
}>;

type MessageStreamEventPayload =
  | Readonly<{ type: 'session'; sessionId: string }>
  | Readonly<{ type: 'ready'; sessionId: string }>
  | Readonly<{ type: 'heartbeat' }>
  | Readonly<{
      type: 'transport-status';
      status: 'connecting' | 'open' | 'closed' | 'error';
      error?: string;
    }>
  | Readonly<{
      type: 'backup-import-status';
      status:
        | 'waiting-for-archive'
        | 'downloading'
        | 'importing'
        | 'done'
        | 'missing'
        | 'skipped'
        | 'error';
      error?: string;
      bytes?: number;
      stats?: unknown;
    }>
  | Readonly<{ type: 'contacts'; contacts: ContactsBootstrap }>
  | Readonly<{ type: 'linked-session-updated'; linkedPayload: LinkedPayload }>
  | Readonly<{ type: 'protocol-state'; protocol: ProtocolState }>
  | Readonly<{ type: 'contacts-bootstrap'; data: ContactsBootstrap }>
  | Readonly<{ type: 'chat-shell'; state: ChatShellState }>
  | Readonly<{ type: 'conversation'; conversation: WebConversation }>
  | Readonly<{ type: 'message'; message: WebMessage }>
  | WebPinMessageEvent
  | WebReactionEvent
  | WebEditMessageEvent
  | WebDeleteMessageEvent
  | WebUnpinMessageEvent
  | WebAttachmentBackfillEvent
  | WebReceiptEvent
  | WebTypingEvent
  | WebPollVoteEvent
  | WebPollTerminateEvent
  | Readonly<{
      type: 'message-status';
      id: string;
      status: WebMessage['status'];
    }>
  | Readonly<{ type: 'queue-empty' }>
  | Readonly<{
      type: 'error';
      error: string;
      timestamp?: number;
      envelopeSize?: number;
      lastDecryptionErrorRetry?: unknown;
      lastDecryptionErrorRetryError?: string;
    }>;

export type MessageStreamEvent = MessageStreamEventPayload &
  Readonly<{ streamEventId?: string }>;
