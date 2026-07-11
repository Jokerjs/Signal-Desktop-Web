// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import https from 'node:https';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import {
  ErrorCode as LibSignalErrorCode,
  LibSignalErrorBase,
  SignedPreKeyRecord,
  usernames,
} from '@signalapp/libsignal-client';
import type { PrivateKey, PublicKey } from '@signalapp/libsignal-client';
import { BackupKey } from '@signalapp/libsignal-client/dist/AccountKeys.js';
import type {
  AuthenticatedChatConnection,
  ServiceAuth,
} from '@signalapp/libsignal-client/dist/net.js';
import type {
  ChatConnection,
  UnauthenticatedChatConnection,
} from '@signalapp/libsignal-client/dist/net/Chat.js';
import {
  BackupAuthCredentialRequestContext,
  BackupAuthCredentialResponse,
  GenericServerPublicParams,
} from '@signalapp/libsignal-client/zkgroup.js';
import nodeFetch from 'node-fetch';
import { setEnvironment, Environment } from '../../environment.std.ts';
import * as Bytes from '../../Bytes.std.ts';
import {
  decryptAttachmentV2ToSink,
  encryptAttachmentV2,
} from '../../AttachmentCrypto.node.ts';
import type { PlaintextSourceType } from '../../AttachmentCrypto.node.ts';
import {
  PaddedLengths,
  encryptProfile,
  encryptProfileItemWithPadding,
} from '../../Crypto.node.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import { MediaTier } from '../../types/AttachmentDownload.std.ts';
import { supportsIncrementalMac } from '../../types/MIME.std.ts';
import type { MIMEType } from '../../types/MIME.std.ts';
import { MY_STORY_ID } from '../../types/Stories.std.ts';
import { ZERO_ACCESS_KEY } from '../../types/SealedSender.std.ts';
import {
  getDiscriminator,
  getNickname,
  ReserveUsernameError,
} from '../../types/Username.std.ts';
import type { ProvisionDecryptResult } from '../../textsecure/ProvisioningCipher.node.ts';
import type { AciString, ServiceIdString } from '../../types/ServiceId.std.ts';
import { fromAciObject } from '../../types/ServiceId.std.ts';
import {
  fromServiceIdBinaryOrString,
  toAciObject,
} from '../../util/ServiceId.node.ts';
import { normalizeAci } from '../../util/normalizeAci.std.ts';
import { DAY, DurationInSeconds } from '../../util/durations/index.std.ts';
import { toDayMillis } from '../../util/timestamp.std.ts';
import { getUserAgent } from '../../util/getUserAgent.node.ts';
import { utf16ToEmoji } from '../../util/utf16ToEmoji.node.ts';
import { Emoji } from '../../axo/emoji.std.ts';
import { getAttachmentCiphertextSize } from '../../util/AttachmentCrypto.std.ts';
import {
  fromWebSafeBase64,
  toWebSafeBase64,
} from '../../util/webSafeBase64.std.ts';
import {
  deriveProfileKeyCommitment,
  deriveProfileKeyVersion,
} from '../../util/zkgroup.node.ts';
import {
  _tusCreateWithUploadRequest,
  type FetchFunctionType,
} from '../../util/uploads/tusProtocol.node.ts';
import { importEphemeralBackup } from './WebBackupImportBridge.node.ts';
import {
  type StorageContactsSyncResult,
  syncContactProfile,
  syncStorageContacts,
  updateStorageAccountProfile,
  updateStorageConversationArchive,
  updateStorageConversationMarkedUnread,
  updateStorageConversationMute,
  updateStorageMessageRequestResponse,
  updateStoragePinnedConversations,
} from './WebStorageContactsSync.node.ts';
import {
  decryptIncomingSignalEnvelope,
  cleanupWebSignalSendRuntimeState,
  exportProtocolState,
  getLinkedPayloadProtocolKeyIds,
  getWebSignalSendDiagnostics,
  maybeUpdateWebPreKeys,
  sendAttachmentBackfillRequestSync,
  sendDecryptionErrorMessage,
  sendDirectEditMessage,
  sendDirectExpirationTimerUpdate,
  sendDirectTextMessage,
  sendGroupReaction,
  sendGroupTextMessage,
  sendGroupUpdateMessage,
  sendDirectReaction,
  sendFetchLocalProfileSync,
  sendFetchStorageManifestSync,
  sendMessageRequestResponseSync,
} from './WebSignalSendBridge.node.ts';
import { getDirectSendAccessKey } from '../directSendAccessKey.dom.ts';
import {
  createGroupConversation,
  enrichGroupConversations,
  fetchLatestGroupStateConversation,
  modifyGroupMember,
  modifyGroupSettings,
  type WebGroupMemberModifyAction,
  type WebGroupSettingsModifyAction,
} from './WebGroupStateSync.node.ts';
import type {
  ChatShellState,
  ContactsBootstrap,
  MessageStreamEvent,
  ProtocolState,
  WebAttachment,
  WebAccount,
  WebConversation,
  WebDeleteForEveryone,
  WebGroupSendEndorsements,
  WebMessage,
  WebPinMessage,
  WebUnpinMessage,
} from '../types.std.ts';

try {
  setEnvironment(Environment.PackagedApp, false);
} catch (error) {
  if (
    !(error instanceof Error) ||
    error.message !== 'Environment has already been set'
  ) {
    throw error;
  }
}

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json') as { version: string };
const jumbomojiManifest = require('../../../build/jumbomoji.json') as Record<
  string,
  Array<string>
>;
const optionalResources =
  require('../../../build/optional-resources.json') as Record<
    string,
    {
      digest: string;
      size: number;
      url: string;
    }
  >;
const productionConfig = require('../../../config/production.json') as {
  backupServerPublicParams: string;
  serverUrl: string;
  storageUrl: string;
  cdn: Record<string, string>;
};

function getDefaultCdnUrl(): string {
  const cdnUrl = productionConfig.cdn['0'];
  if (!cdnUrl) {
    throw new Error('CDN 0 is not configured');
  }
  return cdnUrl;
}

const WEB_ATTACHMENT_WORK_DIR = resolve(
  process.cwd(),
  '.signal-web',
  'attachments'
);
const WEB_ATTACHMENT_TMP_DIR = resolve(WEB_ATTACHMENT_WORK_DIR, 'tmp');
const WEB_EMOJI_CACHE_DIR =
  process.env.SIGNAL_WEB_EMOJI_CACHE_DIR ??
  resolve(process.cwd(), '.signal-web', 'emoji');
const WEB_ATTACHMENT_TMP_MAX_AGE_MS = Number(
  process.env.SIGNAL_WEB_ATTACHMENT_TMP_MAX_AGE_MS ?? 24 * 60 * 60 * 1000
);
const WEB_EMOJI_MEMORY_CACHE_MAX_SHEETS = Number(
  process.env.SIGNAL_WEB_EMOJI_MEMORY_CACHE_MAX_SHEETS ?? 16
);
const MAX_PERSISTED_STREAM_EVENTS_PER_ACCOUNT = 500;
const MAX_PERSISTED_STREAM_EVENT_AGE = Number(
  process.env.SIGNAL_WEB_PERSISTED_STREAM_EVENT_TTL_MS ?? 30 * 60 * 1000
);
const PROTOCOL_STATE_EMIT_DEBOUNCE_MS = Number(
  process.env.SIGNAL_WEB_PROTOCOL_STATE_EMIT_DEBOUNCE_MS ?? 1000
);
const PROVISIONING_SESSION_TTL_MS = Number(
  process.env.SIGNAL_WEB_PROVISIONING_SESSION_TTL_MS ?? 10 * 60 * 1000
);
const STREAM_CONNECTING_SESSION_TTL_MS = Number(
  process.env.SIGNAL_WEB_STREAM_CONNECTING_SESSION_TTL_MS ?? 60_000
);
const STREAM_CLOSED_SESSION_TTL_MS = Number(
  process.env.SIGNAL_WEB_STREAM_CLOSED_SESSION_TTL_MS ?? 5 * 60 * 1000
);
const RUNTIME_CLEANUP_INTERVAL_MS = Number(
  process.env.SIGNAL_WEB_RUNTIME_CLEANUP_INTERVAL_MS ?? 60_000
);
const SIGNAL_CHAT_KEEPALIVE_INTERVAL_MS = Number(
  process.env.SIGNAL_WEB_SIGNAL_CHAT_KEEPALIVE_INTERVAL_MS ?? 30_000
);
const SIGNAL_CHAT_KEEPALIVE_TIMEOUT_MS = Number(
  process.env.SIGNAL_WEB_SIGNAL_CHAT_KEEPALIVE_TIMEOUT_MS ?? 30_000
);
const SIGNAL_CHAT_KEEPALIVE_STALE_THRESHOLD_MS = Number(
  process.env.SIGNAL_WEB_SIGNAL_CHAT_KEEPALIVE_STALE_THRESHOLD_MS ??
    5 * 60 * 1000
);
const SIGNAL_CHAT_KEEPALIVE_LOG_AFTER_MS = Number(
  process.env.SIGNAL_WEB_SIGNAL_CHAT_KEEPALIVE_LOG_AFTER_MS ?? 500
);
const PROFILE_FETCH_CONCURRENCY = Number(
  process.env.SIGNAL_WEB_PROFILE_FETCH_CONCURRENCY ?? 30
);
const SESSION_OPERATION_QUEUE_LIMIT = Number(
  process.env.SIGNAL_WEB_SESSION_OPERATION_QUEUE_LIMIT ?? 50
);
const SEND_RATE_LIMIT_DEFAULT_RETRY_AFTER_MS = Number(
  process.env.SIGNAL_WEB_SEND_RATE_LIMIT_DEFAULT_RETRY_AFTER_MS ?? 60_000
);
const ATTACHMENT_UPLOAD_CONCURRENCY = Number(
  process.env.SIGNAL_WEB_ATTACHMENT_UPLOAD_CONCURRENCY ?? 4
);
const ATTACHMENT_DOWNLOAD_CONCURRENCY = Number(
  process.env.SIGNAL_WEB_ATTACHMENT_DOWNLOAD_CONCURRENCY ?? 8
);
const BACKUP_IMPORT_CONCURRENCY = Number(
  process.env.SIGNAL_WEB_BACKUP_IMPORT_CONCURRENCY ?? 2
);
const MAX_JSON_BODY_BYTES = Number(
  process.env.SIGNAL_WEB_MAX_JSON_BODY_BYTES ?? 8 * 1024 * 1024
);
const emojiToSheet = new Map<string, string>();
const emojiSheetCache = new Map<string, Map<string, Uint8Array<ArrayBuffer>>>();

for (const [sheet, emojiList] of Object.entries(jumbomojiManifest)) {
  for (const emoji of emojiList) {
    if (Emoji.isEmoji(emoji)) {
      emojiToSheet.set(Emoji.ignorePreferredSkinTone(emoji), sheet);
    }
  }
}

type SessionStatus =
  | 'starting'
  | 'qr-ready'
  | 'linking'
  | 'ready'
  | 'error'
  | 'closed';

type ProvisioningSession = {
  sessionId: string;
  status: SessionStatus;
  deviceName: string;
  createdAt: number;
  updatedAt: number;
  url?: string;
  error?: string;
  linkedPayload?: LinkedPayload;
  disconnect?: () => Promise<void>;
  events: Array<ProvisioningSessionEvent>;
};

type LinkedPayload = {
  account: {
    aci: string;
    avatarUrl?: string;
    avatarUrlPath?: string;
    color?: string;
    familyName?: string;
    pni?: string;
    number: string;
    phoneNumber: string;
    profileFamilyName?: string;
    profileName?: string;
    title: string;
    username?: string;
  };
  credentials: {
    username: string;
    password: string;
    deviceId: number;
    aci: string;
    pni?: string;
    number: string;
  };
  storageServiceKey: string;
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
};

type JsonRecord = Record<string, unknown>;
type LinkedPayloadWithProtocol = LinkedPayload &
  Readonly<{
    protocol?: ProtocolState;
  }>;
type PersistedStreamEventEntry = {
  id: string;
  createdAt: number;
  event: MessageStreamEvent;
};

type SignalChatKeepaliveHandle = {
  stop: () => void;
};

type TargetOperationStats = {
  activeCount: number;
  completedCount: number;
  failedCount: number;
  lastFailure?: string;
  lastFinishedAt?: number;
  lastOperationName?: string;
  lastQueuedAt?: number;
  lastStartedAt?: number;
  queuedCount: number;
};

type ProvisioningSessionEvent = {
  at: number;
  type: string;
  detail?: string;
};

type MessageStreamSession = {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  username: string;
  status: 'connecting' | 'open' | 'closed' | 'error';
  error?: string;
  lastReceiveError?: string;
  lastSendError?: string;
  sendBlockedUntil?: number;
  sendBlockedStatus?: number;
  sendBlockedReason?: string;
  sendChallenge?: {
    token?: string;
    options?: ReadonlyArray<string>;
  };
  backupImportStatus:
    | 'idle'
    | 'waiting-for-archive'
    | 'downloading'
    | 'importing'
    | 'done'
    | 'missing'
    | 'skipped'
    | 'error';
  backupImportError?: string;
  backupImportStats?: unknown;
  incomingEnvelopeCount: number;
  decodedMessageCount: number;
  lastDecodedMessageSummary?: unknown;
  receivedAlertCount?: number;
  lastReceivedAlerts?: ReadonlyArray<string>;
  lastReceivedAlertsAt?: number;
  attachmentBackfillEventCount?: number;
  lastAttachmentBackfillSummary?: unknown;
  ignoredEnvelopeCount: number;
  lastIgnoredEnvelopeReason?: string;
  lastIgnoredContentSummary?: string;
  retryRequestCount?: number;
  retryRequestResentCount?: number;
  lastRetryRequestSummary?: unknown;
  lastRetryRequestError?: string;
  lastDecryptionErrorRetry?: unknown;
  lastDecryptionErrorRetryError?: string;
  receiveChain?: Promise<void>;
  decryptionErrorRetryChain?: Promise<void>;
  queueEmptyCount: number;
  sendAttemptCount: number;
  lastSendAttemptAt?: number;
  connection?: AuthenticatedChatConnection;
  linkedPayload?: LinkedPayloadWithProtocol;
  conversationLookup?: Record<string, WebConversation>;
  pendingProtocolState?: ProtocolState;
  pendingProtocolStateRevision?: number;
  protocolStateRevision?: number;
  protocolStateEmitTimer?: ReturnType<typeof setTimeout>;
  lastStreamEndedAt?: number;
  lastStreamInterruptedAt?: number;
  lastStreamOpenedAt?: number;
  lastStreamStartedAt?: number;
  lastTransportError?: string;
  lastTransportStatusAt?: number;
  signalKeepalive?: SignalChatKeepaliveHandle;
  signalKeepaliveCount?: number;
  signalKeepaliveFailureCount?: number;
  lastSignalKeepaliveAt?: number;
  lastSignalKeepaliveError?: string;
  lastSignalKeepaliveResponseMs?: number;
  lastSignalKeepaliveStatus?: number;
  backupUnauthKeepalive?: SignalChatKeepaliveHandle;
  backupUnauthKeepaliveCount?: number;
  backupUnauthKeepaliveFailureCount?: number;
  lastBackupUnauthKeepaliveAt?: number;
  lastBackupUnauthKeepaliveError?: string;
  lastBackupUnauthKeepaliveResponseMs?: number;
  lastBackupUnauthKeepaliveStatus?: number;
  streamCloseCount?: number;
  streamOpenCount?: number;
  targetOperationStats?: Map<string, TargetOperationStats>;
  transportReconnectHintCount?: number;
  cdsiAuth?: {
    timestamp: number;
    auth: ServiceAuth;
  };
  backupPresentationHeaders?: {
    headers: Record<string, string>;
    retrievedAtMs: number;
  };
  backupMediaSignatureKeyUploaded?: boolean;
  backupArchiveInfo?: BackupArchiveInfo;
  backupCdnReadCredentials?: Record<
    number,
    { headers: Record<string, string>; retrievedAtMs: number }
  >;
  remoteConfig?: {
    values: Record<string, string>;
    retrievedAtMs: number;
  };
  backupUnauthConnection?: UnauthenticatedChatConnection;
  writeEvent?: (event: unknown) => void;
  closeStream?: () => void;
  disconnect: () => Promise<void>;
};

type ReadyMessageStreamSession = MessageStreamSession &
  Required<Pick<MessageStreamSession, 'connection' | 'linkedPayload'>>;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('JSON request body exceeds maximum size');
  }
}

function mergeStreamConversation(
  streamSession: MessageStreamSession,
  conversation: WebConversation
): WebConversation {
  const previous = streamSession.conversationLookup?.[conversation.id];
  const next = {
    ...previous,
    ...conversation,
  };
  streamSession.conversationLookup = {
    ...streamSession.conversationLookup,
    [conversation.id]: next,
  };
  if (next.serviceId) {
    streamSession.conversationLookup[next.serviceId] = next;
  }
  if (next.pni) {
    streamSession.conversationLookup[next.pni] = next;
  }
  if (next.e164) {
    streamSession.conversationLookup[next.e164] = next;
  }
  return next;
}

function mergeStreamConversations(
  streamSession: MessageStreamSession,
  conversations: ReadonlyArray<WebConversation>
): void {
  for (const conversation of conversations) {
    mergeStreamConversation(streamSession, conversation);
  }
}

function normalizeDirectAccessKey(accessKey: unknown): string | undefined {
  if (typeof accessKey !== 'string') {
    return undefined;
  }

  return accessKey.trim() ? accessKey : ZERO_ACCESS_KEY;
}

type BackupArchiveInfo = Readonly<{
  backupDir: string;
  mediaDir: string;
}>;

type BackupMediaLocation = BackupArchiveInfo &
  Readonly<{
    cdnNumber: number;
  }>;

const PORT = Number(process.env.SIGNAL_WEB_PROVISIONING_PORT ?? 3100);
const HOST = process.env.SIGNAL_WEB_PROVISIONING_HOST ?? '0.0.0.0';
const LINK_AND_SYNC = process.env.SIGNAL_WEB_LINK_AND_SYNC !== '0';
const UPSTREAM_API_BASE_URL = process.env.SIGNAL_WEB_UPSTREAM_API_BASE_URL;
const CDN_BASE_URL = process.env.SIGNAL_WEB_CDN_BASE_URL;
const ALLOW_INSECURE_CDN_TLS =
  process.env.SIGNAL_WEB_ALLOW_INSECURE_CDN_TLS !== '0';
const ALLOW_INSECURE_STORAGE_TLS =
  process.env.SIGNAL_WEB_ALLOW_INSECURE_STORAGE_TLS !== '0' ||
  ALLOW_INSECURE_CDN_TLS;
if (ALLOW_INSECURE_CDN_TLS || ALLOW_INSECURE_STORAGE_TLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });
const insecureNodeFetch: FetchFunctionType = (url, init) =>
  nodeFetch(url, {
    ...init,
    agent: insecureHttpsAgent,
  });
const ALLOWED_ORIGINS = new Set(
  (process.env.SIGNAL_WEB_ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);

const sessions = new Map<string, ProvisioningSession>();
const streamSessions = new Map<string, MessageStreamSession>();
const persistedStreamEventsByAccount = new Map<
  string,
  Array<PersistedStreamEventEntry>
>();
const transferArchiveCooldownUntilByAccount = new Map<string, number>();
const sessionOperationQueues = new Map<string, Promise<unknown>>();
const sessionOperationQueueSizes = new Map<string, number>();
const recentlyClosedStreamAcis = new Map<string, number>();

let signalModulesPromise: ReturnType<typeof loadSignalModules> | undefined;
let libsignalNetInstance:
  | InstanceType<Awaited<ReturnType<typeof getSignalModules>>['Net']['Net']>
  | undefined;

const CDSI_LOOKUP_TIMEOUT_MS = 10_000;
const CACHED_CDSI_AUTH_TTL_MS = 23 * 60 * 60 * 1000;

function now(): number {
  return Date.now();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function startSignalChatKeepalive({
  connection,
  logId,
  onFailure,
  onSuccess,
}: Readonly<{
  connection: ChatConnection;
  logId: string;
  onFailure: (details: {
    error: string;
    responseMs?: number;
    status?: number;
  }) => void;
  onSuccess: (details: {
    responseMs: number;
    status: number;
    timestamp: number;
  }) => void;
}>): SignalChatKeepaliveHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastAliveAt = now();

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const stop = (): void => {
    stopped = true;
    clearTimer();
  };

  const fail = (details: {
    error: string;
    responseMs?: number;
    status?: number;
  }): void => {
    if (stopped) {
      return;
    }
    stop();
    onFailure(details);
  };

  const schedule = (): void => {
    if (
      stopped ||
      !Number.isFinite(SIGNAL_CHAT_KEEPALIVE_INTERVAL_MS) ||
      SIGNAL_CHAT_KEEPALIVE_INTERVAL_MS <= 0
    ) {
      return;
    }
    clearTimer();
    timer = setTimeout(() => {
      void send();
    }, SIGNAL_CHAT_KEEPALIVE_INTERVAL_MS);
  };

  const send = async (): Promise<void> => {
    clearTimer();
    if (stopped) {
      return;
    }

    if (
      Number.isFinite(SIGNAL_CHAT_KEEPALIVE_STALE_THRESHOLD_MS) &&
      SIGNAL_CHAT_KEEPALIVE_STALE_THRESHOLD_MS > 0 &&
      now() - lastAliveAt > SIGNAL_CHAT_KEEPALIVE_STALE_THRESHOLD_MS
    ) {
      fail({
        error: `Last Signal keepalive request was too far in the past: ${lastAliveAt}`,
      });
      return;
    }

    const sentAt = now();
    try {
      const response = await withTimeout(
        connection.fetch({
          verb: 'GET',
          path: '/v1/keepalive',
          headers: [],
          timeoutMillis: SIGNAL_CHAT_KEEPALIVE_TIMEOUT_MS,
        }),
        SIGNAL_CHAT_KEEPALIVE_TIMEOUT_MS,
        `No response to Signal keepalive request after ${SIGNAL_CHAT_KEEPALIVE_TIMEOUT_MS}ms`
      );
      const responseMs = now() - sentAt;
      if (response.status < 200 || response.status >= 300) {
        fail({
          error: `Signal keepalive response with ${response.status} code`,
          responseMs,
          status: response.status,
        });
        return;
      }

      lastAliveAt = now();
      onSuccess({
        responseMs,
        status: response.status,
        timestamp: lastAliveAt,
      });
      if (responseMs > SIGNAL_CHAT_KEEPALIVE_LOG_AFTER_MS) {
        console.warn(
          `${logId}: delayed response to Signal keepalive request, response time: ${responseMs}ms`
        );
      }
      schedule();
    } catch (error) {
      fail({
        error: errorToLogString(error),
        responseMs: now() - sentAt,
      });
    }
  };

  schedule();

  return { stop };
}

function createConcurrencyLimiter(
  limit: number
): <T>(task: () => Promise<T>) => Promise<T> {
  const normalizedLimit =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
  let activeCount = 0;
  const pending = new Array<() => void>();

  const runNext = (): void => {
    if (activeCount >= normalizedLimit) {
      return;
    }
    const next = pending.shift();
    if (!next) {
      return;
    }
    activeCount += 1;
    next();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await new Promise<void>(resolve => {
      pending.push(resolve);
      runNext();
    });

    try {
      return await task();
    } finally {
      activeCount -= 1;
      runNext();
    }
  };
}

const limitAttachmentUpload = createConcurrencyLimiter(
  ATTACHMENT_UPLOAD_CONCURRENCY
);
const limitAttachmentDownload = createConcurrencyLimiter(
  ATTACHMENT_DOWNLOAD_CONCURRENCY
);
const limitBackupImport = createConcurrencyLimiter(BACKUP_IMPORT_CONCURRENCY);
const limitProfileFetch = createConcurrencyLimiter(PROFILE_FETCH_CONCURRENCY);

function getTargetOperationStats(
  streamSession: MessageStreamSession,
  operationKey: string
): TargetOperationStats {
  streamSession.targetOperationStats ??= new Map();
  const existing = streamSession.targetOperationStats.get(operationKey);
  if (existing) {
    return existing;
  }

  const next: TargetOperationStats = {
    activeCount: 0,
    completedCount: 0,
    failedCount: 0,
    queuedCount: 0,
  };
  streamSession.targetOperationStats.set(operationKey, next);
  return next;
}

function getTargetOperationDiagnostics(
  streamSession: MessageStreamSession
): ReadonlyArray<unknown> {
  return [...(streamSession.targetOperationStats?.entries() ?? [])]
    .map(([operationKey, stats]) => ({
      operationKey,
      ...stats,
    }))
    .sort(
      (left, right) =>
        (right.lastQueuedAt ?? right.lastStartedAt ?? 0) -
        (left.lastQueuedAt ?? left.lastStartedAt ?? 0)
    )
    .slice(0, 50);
}

async function runSessionOperation<T>(
  streamSession: MessageStreamSession,
  operationName: string,
  operation: () => Promise<T>,
  operationKey?: string
): Promise<T> {
  const { sessionId } = streamSession;
  const queueSize = sessionOperationQueueSizes.get(sessionId) ?? 0;
  if (queueSize >= SESSION_OPERATION_QUEUE_LIMIT) {
    throw new Error(
      `${operationName}: session operation queue is full for ${sessionId}`
    );
  }

  const targetStats = operationKey
    ? getTargetOperationStats(streamSession, operationKey)
    : undefined;
  if (targetStats) {
    targetStats.queuedCount += 1;
    targetStats.lastOperationName = operationName;
    targetStats.lastQueuedAt = now();
  }

  sessionOperationQueueSizes.set(sessionId, queueSize + 1);
  const previous = sessionOperationQueues.get(sessionId) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>(resolve => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  sessionOperationQueues.set(sessionId, queued);

  await previous.catch(() => undefined);

  if (targetStats) {
    targetStats.queuedCount = Math.max(0, targetStats.queuedCount - 1);
    targetStats.activeCount += 1;
    targetStats.lastStartedAt = now();
  }

  let didFail = false;
  try {
    return await operation();
  } catch (error) {
    didFail = true;
    if (targetStats) {
      targetStats.lastFailure = errorToLogString(error);
    }
    throw error;
  } finally {
    if (targetStats) {
      targetStats.activeCount = Math.max(0, targetStats.activeCount - 1);
      if (didFail) {
        targetStats.failedCount += 1;
      } else {
        targetStats.completedCount += 1;
      }
      targetStats.lastFinishedAt = now();
    }
    releaseCurrent?.();
    const nextQueueSize = (sessionOperationQueueSizes.get(sessionId) ?? 1) - 1;
    if (nextQueueSize <= 0) {
      sessionOperationQueueSizes.delete(sessionId);
      if (sessionOperationQueues.get(sessionId) === queued) {
        sessionOperationQueues.delete(sessionId);
      }
    } else {
      sessionOperationQueueSizes.set(sessionId, nextQueueSize);
    }
  }
}

function touch(session: ProvisioningSession): void {
  session.updatedAt = now();
}

function recordSessionEvent(
  session: ProvisioningSession,
  type: string,
  detail?: string
): void {
  const event: ProvisioningSessionEvent = {
    at: now(),
    type,
    detail,
  };
  session.events = [...session.events.slice(-19), event];
  console.info(
    `[web-bridge] provisioning ${session.sessionId} ${type}` +
      (detail ? `: ${detail}` : '')
  );
}

function getStreamEventAccountKey(
  linkedPayload: LinkedPayloadWithProtocol | undefined,
  fallback: string
): string {
  return linkedPayload?.credentials?.username ?? fallback;
}

function getPersistedStreamEventId(
  event: MessageStreamEvent
): string | undefined {
  if (event.type === 'message') {
    return `message:${event.message.id}`;
  }
  if (event.type === 'message-status') {
    return `message-status:${event.id}:${event.status}`;
  }
  if (event.type === 'pin-message') {
    return `pin-message:${event.conversationId}:${event.targetAuthorAci}:${event.targetSentTimestamp}:${event.timestamp}`;
  }
  if (event.type === 'unpin-message') {
    return `unpin-message:${event.conversationId}:${event.targetAuthorAci}:${event.targetSentTimestamp}:${event.timestamp}`;
  }
  if (event.type === 'attachment-backfill') {
    return `attachment-backfill:${event.conversationId}:${event.targetAuthorAci ?? ''}:${event.targetSentTimestamp}:${event.timestamp}`;
  }
  if (event.type === 'reaction') {
    return `reaction:${event.conversationId}:${event.senderAci}:${event.targetAuthorAci}:${event.targetTimestamp}:${event.timestamp}:${event.emoji ?? ''}:${event.remove}`;
  }
  if (event.type === 'edit-message') {
    return `edit-message:${event.conversationId}:${event.senderAci}:${event.targetTimestamp}:${event.message.timestamp}`;
  }
  if (event.type === 'delete-message') {
    return `delete-message:${event.conversationId}:${event.targetAuthorAci ?? event.senderAci}:${event.targetSentTimestamp}:${event.timestamp}`;
  }
  if (event.type === 'receipt') {
    return `receipt:${event.conversationId}:${event.senderAci}:${event.receiptType}:${event.timestamps.join(',')}`;
  }
  if (event.type === 'typing') {
    return `typing:${event.conversationId}:${event.senderAci}:${event.sourceDevice ?? ''}:${event.action}:${event.timestamp}`;
  }
  if (event.type === 'poll-vote') {
    return `poll-vote:${event.conversationId}:${event.senderAci}:${event.targetAuthorAci}:${event.targetTimestamp}:${event.timestamp}`;
  }
  if (event.type === 'poll-terminate') {
    return `poll-terminate:${event.conversationId}:${event.senderAci}:${event.targetAuthorAci}:${event.targetTimestamp}:${event.timestamp}`;
  }
  return undefined;
}

function withStreamEventId(
  event: MessageStreamEvent,
  streamEventId: string
): MessageStreamEvent {
  return {
    ...event,
    streamEventId,
  };
}

function persistStreamEvent(
  accountKey: string,
  event: MessageStreamEvent
): MessageStreamEvent {
  const id = getPersistedStreamEventId(event);
  if (!id) {
    return event;
  }

  const cutoff = now() - MAX_PERSISTED_STREAM_EVENT_AGE;
  const existing = (
    persistedStreamEventsByAccount.get(accountKey) ?? []
  ).filter(item => item.createdAt >= cutoff && item.id !== id);
  existing.push({
    id,
    createdAt: now(),
    event: withStreamEventId(event, id),
  });
  persistedStreamEventsByAccount.set(
    accountKey,
    existing.slice(-MAX_PERSISTED_STREAM_EVENTS_PER_ACCOUNT)
  );
  return withStreamEventId(event, id);
}

function replayPersistedStreamEvents(
  accountKey: string,
  writeEvent: (event: unknown) => void
): void {
  const items = persistedStreamEventsByAccount.get(accountKey) ?? [];
  const cutoff = now() - MAX_PERSISTED_STREAM_EVENT_AGE;
  for (const item of items) {
    if (item.createdAt < cutoff) {
      continue;
    }
    writeEvent(withStreamEventId(item.event, item.id));
  }
}

function acknowledgePersistedStreamEvent(
  accountKey: string,
  eventId: string
): void {
  const items = persistedStreamEventsByAccount.get(accountKey);
  if (!items) {
    return;
  }
  const nextItems = items.filter(item => item.id !== eventId);
  if (nextItems.length === items.length) {
    return;
  }
  persistedStreamEventsByAccount.set(accountKey, nextItems);
}

function getPersistedStreamEventDiagnostics(accountKey: string): unknown {
  const items = persistedStreamEventsByAccount.get(accountKey) ?? [];
  const oldest = items.reduce<PersistedStreamEventEntry | undefined>(
    (result, item) => {
      if (!result || item.createdAt < result.createdAt) {
        return item;
      }
      return result;
    },
    undefined
  );
  const newest = items.reduce<PersistedStreamEventEntry | undefined>(
    (result, item) => {
      if (!result || item.createdAt > result.createdAt) {
        return item;
      }
      return result;
    },
    undefined
  );

  return {
    count: items.length,
    newestCreatedAt: newest?.createdAt,
    oldestCreatedAt: oldest?.createdAt,
    oldestAgeMs: oldest ? now() - oldest.createdAt : undefined,
  };
}

function getStreamSessionAci(
  streamSession: MessageStreamSession
): string | undefined {
  return (
    streamSession.linkedPayload?.credentials?.aci ??
    streamSession.linkedPayload?.account.aci
  );
}

function getProvisioningSessionAci(
  session: ProvisioningSession
): string | undefined {
  return (
    session.linkedPayload?.credentials?.aci ??
    session.linkedPayload?.account.aci
  );
}

function getActiveStreamSessions(): Array<MessageStreamSession> {
  return [...streamSessions.values()].filter(
    streamSession => streamSession.status === 'open'
  );
}

function getActiveStreamAcis(): Set<string> {
  const activeAcis = new Set<string>();
  for (const streamSession of getActiveStreamSessions()) {
    const aci = getStreamSessionAci(streamSession);
    if (aci) {
      activeAcis.add(aci);
    }
  }
  return activeAcis;
}

function getProtectedStreamAcis(timestamp: number): Set<string> {
  const protectedAcis = getActiveStreamAcis();
  for (const [aci, expiresAt] of recentlyClosedStreamAcis) {
    if (expiresAt <= timestamp) {
      recentlyClosedStreamAcis.delete(aci);
      continue;
    }
    protectedAcis.add(aci);
  }
  return protectedAcis;
}

function getActiveStreamUsernames(): Set<string> {
  return new Set(
    getActiveStreamSessions().map(streamSession => streamSession.username)
  );
}

function getActiveStreamAccountKeys(): Set<string> {
  const accountKeys = new Set<string>();
  for (const streamSession of getActiveStreamSessions()) {
    accountKeys.add(
      getStreamEventAccountKey(
        streamSession.linkedPayload,
        streamSession.username
      )
    );
  }
  return accountKeys;
}

function rememberRecentlyClosedStreamAci(
  streamSession: MessageStreamSession
): void {
  if (!Number.isFinite(STREAM_CLOSED_SESSION_TTL_MS)) {
    return;
  }
  const aci = getStreamSessionAci(streamSession);
  if (!aci) {
    return;
  }
  recentlyClosedStreamAcis.set(
    aci,
    Math.max(
      recentlyClosedStreamAcis.get(aci) ?? 0,
      now() + STREAM_CLOSED_SESSION_TTL_MS
    )
  );
}

function disposeStreamSession(
  sessionId: string,
  streamSession: MessageStreamSession
): void {
  if (streamSession.closeStream) {
    streamSession.closeStream();
  } else {
    rememberRecentlyClosedStreamAci(streamSession);
    if (streamSession.protocolStateEmitTimer) {
      clearTimeout(streamSession.protocolStateEmitTimer);
      streamSession.protocolStateEmitTimer = undefined;
    }
    streamSession.signalKeepalive?.stop();
    streamSession.signalKeepalive = undefined;
    streamSession.backupUnauthKeepalive?.stop();
    streamSession.backupUnauthKeepalive = undefined;
    void streamSession.disconnect().catch(() => undefined);
    void streamSession.backupUnauthConnection
      ?.disconnect()
      .catch(() => undefined);
    void cleanupAttachmentTmpDir(streamSession).catch(() => undefined);
    streamSessions.delete(sessionId);
  }
  sessionOperationQueues.delete(sessionId);
  sessionOperationQueueSizes.delete(sessionId);
}

function cleanupProvisioningSessions(timestamp: number): number {
  if (!Number.isFinite(PROVISIONING_SESSION_TTL_MS)) {
    return 0;
  }

  const activeAcis = getActiveStreamAcis();
  const activeUsernames = getActiveStreamUsernames();
  let removed = 0;
  for (const [sessionId, session] of sessions) {
    const sessionAci = getProvisioningSessionAci(session);
    const sessionUsername = session.linkedPayload?.credentials.username;
    const isBackedByActiveStream =
      (sessionAci != null && activeAcis.has(sessionAci)) ||
      (sessionUsername != null && activeUsernames.has(sessionUsername));
    if (isBackedByActiveStream) {
      continue;
    }
    if (timestamp - session.updatedAt <= PROVISIONING_SESSION_TTL_MS) {
      continue;
    }

    void session.disconnect?.().catch(() => undefined);
    sessions.delete(sessionId);
    removed += 1;
  }
  return removed;
}

function cleanupStreamSessions(timestamp: number): number {
  let removed = 0;
  for (const [sessionId, streamSession] of streamSessions) {
    if (streamSession.status === 'open') {
      continue;
    }

    const ttl =
      streamSession.status === 'connecting'
        ? STREAM_CONNECTING_SESSION_TTL_MS
        : STREAM_CLOSED_SESSION_TTL_MS;
    if (Number.isFinite(ttl) && timestamp - streamSession.updatedAt <= ttl) {
      continue;
    }

    disposeStreamSession(sessionId, streamSession);
    removed += 1;
  }
  return removed;
}

function cleanupPersistedStreamEvents(timestamp: number): number {
  if (!Number.isFinite(MAX_PERSISTED_STREAM_EVENT_AGE)) {
    return 0;
  }

  const activeAccountKeys = getActiveStreamAccountKeys();
  const cutoff = timestamp - MAX_PERSISTED_STREAM_EVENT_AGE;
  let removed = 0;
  for (const [accountKey, items] of persistedStreamEventsByAccount) {
    const nextItems = items
      .filter(item => item.createdAt >= cutoff)
      .slice(-MAX_PERSISTED_STREAM_EVENTS_PER_ACCOUNT);
    if (nextItems.length === 0) {
      persistedStreamEventsByAccount.delete(accountKey);
      removed += items.length;
      continue;
    }

    const newestCreatedAt = nextItems.reduce(
      (result, item) => Math.max(result, item.createdAt),
      0
    );
    if (!activeAccountKeys.has(accountKey) && newestCreatedAt < cutoff) {
      persistedStreamEventsByAccount.delete(accountKey);
      removed += items.length;
      continue;
    }

    if (nextItems.length !== items.length) {
      persistedStreamEventsByAccount.set(accountKey, nextItems);
      removed += items.length - nextItems.length;
    }
  }
  return removed;
}

function cleanupTransferArchiveCooldowns(timestamp: number): number {
  let removed = 0;
  for (const [
    accountKey,
    cooldownUntil,
  ] of transferArchiveCooldownUntilByAccount) {
    if (cooldownUntil <= timestamp) {
      transferArchiveCooldownUntilByAccount.delete(accountKey);
      removed += 1;
    }
  }
  return removed;
}

function cleanupRuntimeState(reason: string): void {
  const timestamp = now();
  const removedProvisioningSessions = cleanupProvisioningSessions(timestamp);
  const removedStreamSessions = cleanupStreamSessions(timestamp);
  const removedPersistedStreamEvents = cleanupPersistedStreamEvents(timestamp);
  const removedTransferArchiveCooldowns =
    cleanupTransferArchiveCooldowns(timestamp);
  const signalCleanup = cleanupWebSignalSendRuntimeState({
    activeAcis: getProtectedStreamAcis(timestamp),
    nowMs: timestamp,
  });

  const removedSignalItems = Object.values(signalCleanup).reduce(
    (total, value) => total + value,
    0
  );
  const removedCount =
    removedProvisioningSessions +
    removedStreamSessions +
    removedPersistedStreamEvents +
    removedTransferArchiveCooldowns +
    removedSignalItems;
  if (removedCount > 0) {
    console.info(
      'Signal Web runtime cleanup',
      JSON.stringify({
        reason,
        removedPersistedStreamEvents,
        removedProvisioningSessions,
        removedStreamSessions,
        removedTransferArchiveCooldowns,
        signalCleanup,
      })
    );
  }
}

function shouldRedeliverAfterDecryptionRetryError(error: unknown): boolean {
  return (
    LibSignalErrorBase.is(error, LibSignalErrorCode.ChatServiceInactive) ||
    LibSignalErrorBase.is(error, LibSignalErrorCode.IoError) ||
    LibSignalErrorBase.is(error, LibSignalErrorCode.Cancelled)
  );
}

function queueDecryptionErrorRetry({
  activeLinkedPayload,
  connection,
  envelope,
  sendAck,
  streamSession,
  timestamp,
  writeEvent,
}: Readonly<{
  activeLinkedPayload: LinkedPayloadWithProtocol;
  connection: AuthenticatedChatConnection | undefined;
  envelope: Uint8Array<ArrayBuffer>;
  sendAck: (statusCode: number) => void;
  streamSession: MessageStreamSession;
  timestamp: number;
  writeEvent: (event: unknown) => void;
}>): void {
  const previousRetry =
    streamSession.decryptionErrorRetryChain ?? Promise.resolve();
  const currentRetry = previousRetry
    .catch(() => undefined)
    .then(async () => {
      if (!connection) {
        writeEvent({
          type: 'error',
          error: streamSession.lastReceiveError,
          timestamp,
          envelopeSize: envelope.byteLength,
          lastDecryptionErrorRetry: streamSession.lastDecryptionErrorRetry,
          lastDecryptionErrorRetryError:
            streamSession.lastDecryptionErrorRetryError,
        });
        sendAck(500);
        return;
      }

      try {
        const envelopeForRetry = Proto.Envelope.decode(envelope);
        const retrySourceServiceId = fromServiceIdBinaryOrString(
          envelopeForRetry.sourceServiceIdBinary,
          envelopeForRetry.sourceServiceId,
          'sendDecryptionErrorRetry.sourceServiceId'
        );
        const retryConversation = retrySourceServiceId
          ? streamSession.conversationLookup?.[retrySourceServiceId]
          : undefined;
        const retryAccessKey = retryConversation
          ? getDirectSendAccessKey(retryConversation)
          : undefined;
        const retryResult = await sendDecryptionErrorMessage({
          accessKey: retryAccessKey,
          chat: connection,
          envelopeBytes: envelope,
          linkedPayload: activeLinkedPayload,
          receivedAt: timestamp,
          unauthChat: retryAccessKey
            ? await getBackupUnauthConnection(streamSession)
            : undefined,
        });
        streamSession.lastDecryptionErrorRetry = retryResult;
        streamSession.lastDecryptionErrorRetryError = undefined;
        streamSession.updatedAt = now();
        if (retryResult.sent) {
          emitProtocolState(streamSession);
          streamSession.lastReceiveError = undefined;
          streamSession.ignoredEnvelopeCount += 1;
          streamSession.lastIgnoredEnvelopeReason =
            'Sent decryption error retry request';
          sendAck(200);
          return;
        }

        writeEvent({
          type: 'error',
          error: streamSession.lastReceiveError,
          timestamp,
          envelopeSize: envelope.byteLength,
          lastDecryptionErrorRetry: streamSession.lastDecryptionErrorRetry,
          lastDecryptionErrorRetryError:
            streamSession.lastDecryptionErrorRetryError,
        });
        sendAck(200);
      } catch (retryError) {
        streamSession.lastDecryptionErrorRetryError =
          errorToLogString(retryError);
        streamSession.updatedAt = now();
        console.warn(
          'message stream failed to send decryption error retry request',
          retryError
        );
        writeEvent({
          type: 'error',
          error: streamSession.lastReceiveError,
          timestamp,
          envelopeSize: envelope.byteLength,
          lastDecryptionErrorRetry: streamSession.lastDecryptionErrorRetry,
          lastDecryptionErrorRetryError:
            streamSession.lastDecryptionErrorRetryError,
        });
        sendAck(
          shouldRedeliverAfterDecryptionRetryError(retryError) ? 500 : 200
        );
      }
    });
  const nextRetryChain = currentRetry.finally(() => {
    if (streamSession.decryptionErrorRetryChain === nextRetryChain) {
      streamSession.decryptionErrorRetryChain = undefined;
    }
  });
  streamSession.decryptionErrorRetryChain = nextRetryChain;
  void streamSession.decryptionErrorRetryChain;
}

async function kickOffProfileFetches({
  streamSession,
  syncResult,
  writeEvent,
}: Readonly<{
  streamSession: MessageStreamSession;
  syncResult: StorageContactsSyncResult;
  writeEvent: (event: MessageStreamEvent) => void;
}>): Promise<void> {
  if (
    !streamSession.connection ||
    syncResult.profileSyncConversations.length === 0
  ) {
    return;
  }
  const { connection } = streamSession;

  for (
    let index = 0;
    index < syncResult.profileSyncConversations.length;
    index += PROFILE_FETCH_CONCURRENCY
  ) {
    const batch = syncResult.profileSyncConversations.slice(
      index,
      index + PROFILE_FETCH_CONCURRENCY
    );
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      batch.map(async conversation => {
        try {
          const profile = await limitProfileFetch(() =>
            syncContactProfile({
              allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
              chat: connection,
              cdnUrl: getDefaultCdnUrl(),
              conversation,
            })
          );
          if (Object.keys(profile).length === 0) {
            return;
          }
          streamSession.updatedAt = now();
          const nextConversation = mergeStreamConversation(streamSession, {
            ...conversation,
            ...profile,
          });
          writeEvent({
            type: 'conversation',
            conversation: nextConversation,
          });
        } catch (error) {
          console.warn('kickOffProfileFetches: failed to fetch profile', {
            conversationId: conversation.id,
            error: errorToLogString(error),
          });
        }
      })
    );
  }
}

async function enrichBackupImportGroups({
  chat,
  chatShell,
  contactsBootstrap,
  linkedPayload,
}: Readonly<{
  chat: AuthenticatedChatConnection;
  chatShell: ChatShellState;
  contactsBootstrap: ContactsBootstrap;
  linkedPayload: LinkedPayload;
}>): Promise<
  Readonly<{
    chatShell: ChatShellState;
    contactsBootstrap: ContactsBootstrap;
  }>
> {
  const conversations = Object.values(chatShell.conversationLookup);
  if (
    !conversations.some(
      conversation =>
        conversation.type === 'group' ||
        conversation.conversationType === 'group'
    )
  ) {
    return { chatShell, contactsBootstrap };
  }

  try {
    const enrichedConversations = await enrichGroupConversations({
      allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
      cdnUrl: getDefaultCdnUrl(),
      chat,
      conversations,
      linkedPayload,
      storageUrl: productionConfig.storageUrl,
    });
    const enrichedById = new Map(
      enrichedConversations.map(conversation => [conversation.id, conversation])
    );
    const mergeConversation = (conversation: WebConversation) => {
      const enriched = enrichedById.get(conversation.id);
      return enriched ? { ...conversation, ...enriched } : conversation;
    };

    return {
      chatShell: {
        ...chatShell,
        conversationLookup: Object.fromEntries(
          Object.entries(chatShell.conversationLookup).map(
            ([conversationId, conversation]) => [
              conversationId,
              mergeConversation(conversation),
            ]
          )
        ),
      },
      contactsBootstrap: {
        ...contactsBootstrap,
        pinned: contactsBootstrap.pinned.map(mergeConversation),
        conversations: contactsBootstrap.conversations.map(mergeConversation),
        archived: contactsBootstrap.archived.map(mergeConversation),
      },
    };
  } catch (error) {
    console.warn(
      'enrichBackupImportGroups: failed to hydrate group conversations',
      error
    );
    return { chatShell, contactsBootstrap };
  }
}

function flushProtocolState(streamSession: MessageStreamSession): void {
  if (streamSession.protocolStateEmitTimer) {
    clearTimeout(streamSession.protocolStateEmitTimer);
    streamSession.protocolStateEmitTimer = undefined;
  }
  const protocol = streamSession.pendingProtocolState;
  const protocolRevision = streamSession.pendingProtocolStateRevision;
  if (!protocol || !streamSession.writeEvent) {
    return;
  }
  streamSession.pendingProtocolState = undefined;
  streamSession.pendingProtocolStateRevision = undefined;
  streamSession.writeEvent({
    type: 'protocol-state',
    protocol,
    protocolRevision:
      protocolRevision ?? streamSession.protocolStateRevision ?? 0,
    sessionId: streamSession.sessionId,
  });
}

function emitProtocolState(
  streamSession: MessageStreamSession,
  options: Readonly<{ immediate?: boolean }> = {}
): void {
  if (!streamSession.linkedPayload || !streamSession.writeEvent) {
    return;
  }
  const protocol = exportProtocolState(streamSession.linkedPayload);
  const protocolRevision = (streamSession.protocolStateRevision ?? 0) + 1;
  streamSession.linkedPayload = {
    ...streamSession.linkedPayload,
    protocol,
  };
  streamSession.protocolStateRevision = protocolRevision;
  streamSession.pendingProtocolState = protocol;
  streamSession.pendingProtocolStateRevision = protocolRevision;

  if (options.immediate || PROTOCOL_STATE_EMIT_DEBOUNCE_MS <= 0) {
    flushProtocolState(streamSession);
    return;
  }

  if (streamSession.protocolStateEmitTimer) {
    return;
  }

  streamSession.protocolStateEmitTimer = setTimeout(() => {
    flushProtocolState(streamSession);
  }, PROTOCOL_STATE_EMIT_DEBOUNCE_MS);
}

function sendCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.has('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>
): void {
  sendCors(req, res);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendText(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  body: string
): void {
  sendCors(req, res);
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendBytes(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  body: Uint8Array,
  contentType: string
): void {
  sendCors(req, res);
  res.writeHead(statusCode, {
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Length': String(body.byteLength),
    'Content-Type': contentType,
  });
  res.end(body);
}

function sendAttachmentBytes({
  body,
  contentType,
  fileName,
  req,
  res,
}: Readonly<{
  body: Uint8Array;
  contentType: string;
  fileName: string | null;
  req: IncomingMessage;
  res: ServerResponse;
}>): void {
  sendCors(req, res);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(body.byteLength),
    ...(fileName
      ? {
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        }
      : null),
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(body);
}

async function decryptAttachmentV2ToBuffer(
  options: Parameters<typeof decryptAttachmentV2ToSink>[0]
): Promise<Buffer> {
  const chunks = new Array<Buffer>();
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  await decryptAttachmentV2ToSink(options, sink);
  return Buffer.concat(chunks);
}

function toArrayBufferUint8Array(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(new ArrayBuffer(data.byteLength));
  result.set(data);
  return result;
}

function verifyOptionalResourceDigest({
  data,
  digest,
  resourceName,
}: Readonly<{
  data: Uint8Array;
  digest: string;
  resourceName: string;
}>): void {
  const actualDigest = createHash('sha512').update(data).digest('base64');
  if (actualDigest !== digest) {
    throw new Error(`${resourceName}: digest mismatch`);
  }
}

async function getEmojiSheetProto(
  sheet: string
): Promise<Uint8Array<ArrayBuffer>> {
  const resourceName = `emoji-sheet-${sheet}.proto`;
  const resource = optionalResources[resourceName];
  if (!resource) {
    throw new Error(`${resourceName}: optional resource not found`);
  }

  mkdirSync(WEB_EMOJI_CACHE_DIR, { recursive: true });
  const localPath = resolve(WEB_EMOJI_CACHE_DIR, resourceName);
  if (existsSync(localPath)) {
    const cached = readFileSync(localPath);
    try {
      verifyOptionalResourceDigest({
        data: cached,
        digest: resource.digest,
        resourceName,
      });
      return toArrayBufferUint8Array(cached);
    } catch {
      await rm(localPath, { force: true });
    }
  }

  const response = await nodeFetch(resource.url);
  if (!response.ok) {
    throw new Error(
      `${resourceName}: fetch failed with status ${response.status}`
    );
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength !== resource.size) {
    throw new Error(`${resourceName}: size mismatch`);
  }
  verifyOptionalResourceDigest({
    data,
    digest: resource.digest,
    resourceName,
  });
  writeFileSync(localPath, data);
  return toArrayBufferUint8Array(data);
}

async function getEmojiSheetImages(
  sheet: string
): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const cached = emojiSheetCache.get(sheet);
  if (cached) {
    emojiSheetCache.delete(sheet);
    emojiSheetCache.set(sheet, cached);
    return cached;
  }

  const proto = await getEmojiSheetProto(sheet);
  const pack = Proto.JumbomojiPack.decode(proto);
  const imageMap = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const item of pack.items) {
    const key = item.name != null ? utf16ToEmoji(item.name) : '';
    const image =
      item.image != null
        ? toArrayBufferUint8Array(item.image)
        : new Uint8Array(new ArrayBuffer(0));
    imageMap.set(key, image);
  }
  emojiSheetCache.set(sheet, imageMap);
  while (emojiSheetCache.size > WEB_EMOJI_MEMORY_CACHE_MAX_SHEETS) {
    const oldestSheet = emojiSheetCache.keys().next().value;
    if (oldestSheet == null) {
      break;
    }
    emojiSheetCache.delete(oldestSheet);
  }
  return imageMap;
}

async function handleEmojiJumbo(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const rawEmoji = url.searchParams.get('emoji');
  if (rawEmoji == null || !Emoji.isEmoji(rawEmoji)) {
    sendText(req, res, 400, 'Invalid emoji');
    return;
  }

  const emoji = Emoji.ignorePreferredSkinTone(rawEmoji);
  const sheet = emojiToSheet.get(emoji);
  if (!sheet) {
    sendText(req, res, 404, 'Emoji not found');
    return;
  }

  const imageMap = await getEmojiSheetImages(sheet);
  const image = imageMap.get(emoji);
  if (!image || image.byteLength === 0) {
    sendText(req, res, 404, 'Emoji image not found');
    return;
  }

  sendBytes(req, res, 200, image, 'image/webp');
}

function getSessionResponse(session: ProvisioningSession): JsonRecord {
  return {
    sessionId: session.sessionId,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    url: session.url,
    error: session.error,
    events: session.events,
    hasLinkedPayload: Boolean(session.linkedPayload),
    linkedAccount: session.linkedPayload
      ? {
          aci: session.linkedPayload.account.aci,
          pni: session.linkedPayload.account.pni,
          number: session.linkedPayload.account.number,
          deviceId: session.linkedPayload.credentials.deviceId,
          hasBackupDownloadPath: Boolean(
            session.linkedPayload.backupDownloadPath
          ),
          hasMediaRootBackupKey: Boolean(
            session.linkedPayload.mediaRootBackupKeyBase64
          ),
          hasAciRegistrationId:
            typeof session.linkedPayload.aciRegistrationId === 'number',
        }
      : undefined,
  };
}

async function readJson(req: IncomingMessage): Promise<JsonRecord> {
  const chunks = new Array<Buffer>();
  let byteCount = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += buffer.byteLength;
    if (byteCount > MAX_JSON_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord;
}

function isReadyMessageStreamSession(
  streamSession: MessageStreamSession | undefined
): streamSession is ReadyMessageStreamSession {
  return Boolean(streamSession?.connection && streamSession.linkedPayload);
}

function isJsonRequest(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type'];
  return (
    typeof contentType === 'string' &&
    contentType.toLowerCase().split(';')[0] === 'application/json'
  );
}

function getRequiredQueryNumber(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value == null || value.length === 0) {
    return undefined;
  }
  const numberValue = Number(value);
  if (
    !Number.isSafeInteger(numberValue) ||
    numberValue < 0 ||
    String(numberValue) !== value
  ) {
    return undefined;
  }
  return numberValue;
}

function createSizeCheckedStream(
  input: Readable,
  expectedSize: number
): Readable {
  let byteCount = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += buffer.byteLength;
      if (byteCount > expectedSize) {
        callback(new Error('Attachment size exceeds declared size'));
        return;
      }
      callback(null, buffer);
    },
    flush(callback) {
      if (byteCount !== expectedSize) {
        callback(new Error('Attachment size does not match request body'));
        return;
      }
      callback();
    },
  });
  input.pipe(transform);
  return transform;
}

function getBodyString(body: unknown): string {
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString('utf8');
  }
  if (typeof body === 'string') {
    return body;
  }
  return '';
}

type AttachmentUploadForm = Readonly<{
  cdn: number;
  key: string;
  headers: Record<string, string>;
  signedUploadLocation: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function parseWebAttachments(value: unknown): ReadonlyArray<WebAttachment> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map(item => {
    const thumbnail = isRecord(item.thumbnail)
      ? parseWebAttachments([item.thumbnail])[0]
      : undefined;
    return {
      id: getOptionalString(item.id),
      kind:
        item.kind === 'file' || item.kind === 'image' || item.kind === 'video'
          ? item.kind
          : undefined,
      cdnId: getOptionalString(item.cdnId),
      cdnKey: getOptionalString(item.cdnKey),
      cdnNumber: getOptionalNumber(item.cdnNumber),
      keyBase64: getOptionalString(item.keyBase64),
      digestBase64: getOptionalString(item.digestBase64),
      incrementalMacBase64: getOptionalString(item.incrementalMacBase64),
      key: getOptionalString(item.key),
      digest: getOptionalString(item.digest),
      incrementalMac: getOptionalString(item.incrementalMac),
      chunkSize: getOptionalNumber(item.chunkSize),
      size: getOptionalNumber(item.size),
      contentType: getOptionalString(item.contentType),
      fileName: getOptionalString(item.fileName),
      flags: getOptionalNumber(item.flags),
      width: getOptionalNumber(item.width),
      height: getOptionalNumber(item.height),
      duration: getOptionalNumber(item.duration),
      caption: getOptionalString(item.caption),
      blurHash: getOptionalString(item.blurHash),
      uploadTimestamp: getOptionalNumber(item.uploadTimestamp),
      clientUuid: getOptionalString(item.clientUuid),
      plaintextHash: getOptionalString(item.plaintextHash),
      downloadPath: getOptionalString(item.downloadPath),
      backupCdnNumber: getOptionalNumber(item.backupCdnNumber),
      localKey: getOptionalString(item.localKey),
      downloadUrl: getOptionalString(item.downloadUrl),
      previewUrl: getOptionalString(item.previewUrl),
      thumbnail,
      thumbnailUrl: getOptionalString(item.thumbnailUrl),
      localBlobKey: getOptionalString(item.localBlobKey),
      url: getOptionalString(item.url),
      dataBase64: getOptionalString(item.dataBase64),
      status:
        item.status === 'pending' ||
        item.status === 'uploading' ||
        item.status === 'ready' ||
        item.status === 'failed' ||
        item.status === 'sent'
          ? item.status
          : undefined,
      error: getOptionalString(item.error),
    };
  });
}

function parseWebQuote(value: unknown): WebMessage['quote'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const authorAci = getOptionalString(value.authorAci);
  if (!authorAci) {
    return undefined;
  }

  const attachments = Array.isArray(value.attachments)
    ? value.attachments.filter(isRecord).map(attachment => {
        const thumbnail = isRecord(attachment.thumbnail)
          ? parseWebAttachments([attachment.thumbnail])[0]
          : undefined;
        return {
          contentType:
            getOptionalString(attachment.contentType) ??
            'application/octet-stream',
          fileName: getOptionalString(attachment.fileName),
          thumbnail,
        };
      })
    : [];

  return {
    id: typeof value.id === 'number' ? value.id : null,
    authorAci,
    attachments,
    bodyRanges: Array.isArray(value.bodyRanges) ? value.bodyRanges : [],
    isGiftBadge: value.isGiftBadge === true,
    isPoll: value.isPoll === true,
    isViewOnce: value.isViewOnce === true,
    referencedMessageNotFound: value.referencedMessageNotFound === true,
    text: getOptionalString(value.text),
    type: getOptionalNumber(value.type),
  } as unknown as WebMessage['quote'];
}

function parseWebPinMessage(value: unknown): WebPinMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const targetAuthorAci = getOptionalString(value.targetAuthorAci);
  const targetSentTimestamp = getOptionalNumber(value.targetSentTimestamp);
  const pinDurationSeconds =
    value.pinDurationSeconds === null
      ? null
      : getOptionalNumber(value.pinDurationSeconds);

  if (
    !targetAuthorAci ||
    targetSentTimestamp == null ||
    pinDurationSeconds === undefined
  ) {
    return undefined;
  }

  return {
    targetAuthorAci,
    targetSentTimestamp,
    pinDurationSeconds,
  };
}

function parseWebUnpinMessage(value: unknown): WebUnpinMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const targetAuthorAci = getOptionalString(value.targetAuthorAci);
  const targetSentTimestamp = getOptionalNumber(value.targetSentTimestamp);

  if (!targetAuthorAci || targetSentTimestamp == null) {
    return undefined;
  }

  return {
    targetAuthorAci,
    targetSentTimestamp,
  };
}

function parseWebDeleteForEveryone(
  value: unknown
): WebDeleteForEveryone | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.targetAuthorAci !== 'string' ||
    typeof record.targetSentTimestamp !== 'number'
  ) {
    return undefined;
  }
  return {
    targetAuthorAci: record.targetAuthorAci,
    targetSentTimestamp: record.targetSentTimestamp,
    isAdminDelete:
      typeof record.isAdminDelete === 'boolean'
        ? record.isAdminDelete
        : undefined,
  };
}

function errorToLogString(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause;
  const causeText =
    cause instanceof Error
      ? (cause.stack ?? cause.message)
      : cause != null
        ? String(cause)
        : undefined;
  return causeText
    ? `${error.stack ?? error.message}\nCause: ${causeText}`
    : (error.stack ?? error.message);
}

type WebHttpErrorInfo = Readonly<{
  body: unknown;
  headers?: Record<string, string>;
  status: number;
}>;

function getNumericErrorProperty(
  error: Error,
  key: string
): number | undefined {
  const value = (error as Error & Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function getSendErrorInfo(error: unknown): WebHttpErrorInfo | undefined {
  let current: unknown = error;
  for (let index = 0; index < 6; index += 1) {
    if (!(current instanceof Error)) {
      return undefined;
    }

    const status = getNumericErrorProperty(current, 'status');
    const retryAfterMs = getNumericErrorProperty(current, 'retryAfterMs');
    if (status) {
      return {
        body: {
          error: current.message,
          retryAfterMs,
          status,
        },
        headers:
          status === 429 && retryAfterMs
            ? { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) }
            : undefined,
        status,
      };
    }

    if (current instanceof LibSignalErrorBase) {
      if (current.code === LibSignalErrorCode.RateLimitChallengeError) {
        const challenge = current as LibSignalErrorBase & {
          options?: ReadonlyArray<string>;
          retryAfterSecs?: number;
          token?: string;
        };
        const retryAfterMs =
          typeof challenge.retryAfterSecs === 'number'
            ? challenge.retryAfterSecs * 1000
            : undefined;
        return {
          body: {
            error: current.message,
            options: Array.isArray(challenge.options)
              ? [...challenge.options]
              : undefined,
            retryAfterMs,
            status: 428,
            token: challenge.token,
          },
          headers: retryAfterMs
            ? { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) }
            : undefined,
          status: 428,
        };
      }
      if (current.code === LibSignalErrorCode.RateLimitedError) {
        const rateLimited = current as LibSignalErrorBase & {
          retryAfterSecs?: number;
        };
        const retryAfterMs =
          typeof rateLimited.retryAfterSecs === 'number'
            ? rateLimited.retryAfterSecs * 1000
            : SEND_RATE_LIMIT_DEFAULT_RETRY_AFTER_MS;
        return {
          body: {
            error: current.message,
            retryAfterMs,
            status: 429,
          },
          headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
          status: 429,
        };
      }
      if (current.code === LibSignalErrorCode.RequestUnauthorized) {
        return {
          body: {
            error: current.message,
            status: 401,
          },
          status: 401,
        };
      }
    }

    current = current.cause;
  }

  return undefined;
}

function rememberSendFailure(
  streamSession: MessageStreamSession,
  error: unknown
): void {
  const info = getSendErrorInfo(error);
  if (!info || (info.status !== 428 && info.status !== 429)) {
    return;
  }
  const body =
    info.body && typeof info.body === 'object' && !Array.isArray(info.body)
      ? (info.body as Record<string, unknown>)
      : {};
  const retryAfterMs =
    typeof body.retryAfterMs === 'number'
      ? body.retryAfterMs
      : SEND_RATE_LIMIT_DEFAULT_RETRY_AFTER_MS;
  streamSession.sendBlockedUntil = now() + retryAfterMs;
  streamSession.sendBlockedStatus = info.status;
  streamSession.sendBlockedReason =
    typeof body.error === 'string' ? body.error : undefined;
  if (info.status === 428) {
    streamSession.sendChallenge = {
      token: typeof body.token === 'string' ? body.token : undefined,
      options: Array.isArray(body.options)
        ? body.options.filter(
            (item): item is string => typeof item === 'string'
          )
        : undefined,
    };
  }
}

function rememberSendSuccess(streamSession: MessageStreamSession): void {
  streamSession.lastSendError = undefined;
  streamSession.sendBlockedUntil = undefined;
  streamSession.sendBlockedStatus = undefined;
  streamSession.sendBlockedReason = undefined;
  streamSession.sendChallenge = undefined;
}

function assertSendAllowed(streamSession: MessageStreamSession): void {
  if (
    !streamSession.sendBlockedUntil ||
    streamSession.sendBlockedUntil <= now()
  ) {
    streamSession.sendBlockedUntil = undefined;
    streamSession.sendBlockedStatus = undefined;
    streamSession.sendBlockedReason = undefined;
    streamSession.sendChallenge = undefined;
    return;
  }

  const retryAfterMs = streamSession.sendBlockedUntil - now();
  throw Object.assign(
    new Error(streamSession.sendBlockedReason ?? 'Send is rate limited'),
    {
      retryAfterMs,
      status: streamSession.sendBlockedStatus ?? 429,
    }
  );
}

function getProtocolStateFromStreamBody(
  body: JsonRecord
): ProtocolState | undefined {
  const protocol = body.protocol;
  if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) {
    return undefined;
  }
  const value = protocol as JsonRecord;
  if (
    !value.registrationIds ||
    typeof value.registrationIds !== 'object' ||
    Array.isArray(value.registrationIds) ||
    !value.identityKeys ||
    typeof value.identityKeys !== 'object' ||
    Array.isArray(value.identityKeys) ||
    !Array.isArray(value.identityRecords) ||
    !Array.isArray(value.preKeys) ||
    !Array.isArray(value.signedPreKeys) ||
    !Array.isArray(value.kyberPreKeys) ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.senderKeys)
  ) {
    return undefined;
  }
  return protocol as ProtocolState;
}

function getLinkedPayloadFromStreamBody(
  body: JsonRecord
): LinkedPayloadWithProtocol | undefined {
  const value = body.linkedPayload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const linkedPayload = value as LinkedPayloadWithProtocol;
  const protocol = getProtocolStateFromStreamBody(body);
  const registrationIds = protocol?.registrationIds;
  if (
    !registrationIds ||
    typeof registrationIds !== 'object' ||
    Array.isArray(registrationIds)
  ) {
    return linkedPayload;
  }
  const aciRegistrationId = (registrationIds as JsonRecord).aci;
  const pniRegistrationId = (registrationIds as JsonRecord).pni;
  return {
    ...linkedPayload,
    aciRegistrationId:
      typeof aciRegistrationId === 'number'
        ? aciRegistrationId
        : linkedPayload.aciRegistrationId,
    pniRegistrationId:
      typeof pniRegistrationId === 'number'
        ? pniRegistrationId
        : linkedPayload.pniRegistrationId,
    protocol,
  };
}

async function loadSignalModules() {
  const [
    libsignal,
    chatModule,
    provisioningCipherModule,
    curve,
    crypto,
    bytes,
    protobuf,
    serviceId,
  ] = await Promise.all([
    import('@signalapp/libsignal-client'),
    import('@signalapp/libsignal-client/dist/net/Chat.js'),
    import('../../textsecure/ProvisioningCipher.node.ts'),
    import('../../Curve.node.ts'),
    import('../../Crypto.node.ts'),
    import('../../Bytes.std.ts'),
    import('../../protobuf/index.std.ts'),
    import('../../types/ServiceId.std.ts'),
  ]);

  return {
    Net: libsignal.Net,
    Chat: chatModule,
    ProvisioningCipher: provisioningCipherModule.default,
    Curve: curve,
    Crypto: crypto,
    Bytes: bytes,
    Proto: protobuf.SignalService,
    ServiceId: serviceId,
  };
}

async function getSignalModules() {
  signalModulesPromise ??= loadSignalModules();
  return signalModulesPromise;
}

function createNet(Net: Awaited<ReturnType<typeof getSignalModules>>['Net']) {
  libsignalNetInstance ??= new Net.Net({
    env:
      process.env.SIGNAL_WEB_SERVER_ENV === 'staging'
        ? Net.Environment.Staging
        : Net.Environment.Production,
    userAgent: `Signal-Desktop/${packageJson.version} Web`,
  });
  return libsignalNetInstance;
}

async function registerLinkedDeviceCapabilities(
  connection: AuthenticatedChatConnection
): Promise<void> {
  const body = Buffer.from(
    JSON.stringify({
      attachmentBackfill: true,
      spqr: true,
      usernameChangeSyncMessage: true,
    }),
    'utf8'
  );
  const response = await connection.fetch({
    verb: 'PUT',
    path: '/v1/devices/capabilities',
    headers: [['content-type', 'application/json']],
    body,
    timeoutMillis: 30_000,
  });
  if (response.status < 200 || response.status >= 300) {
    const responseBody = Buffer.from(
      response.body ?? new Uint8Array()
    ).toString('utf8');
    throw new Error(
      responseBody
        ? `register capabilities failed with status ${response.status}: ${responseBody}`
        : `register capabilities failed with status ${response.status}`
    );
  }
}

function buildLinkDeviceUrl({
  uuid,
  pubKey,
}: {
  uuid: string;
  pubKey: string;
}): string {
  const params = new URLSearchParams({
    uuid,
    pub_key: pubKey,
    capabilities: LINK_AND_SYNC ? 'backup5' : '',
  });
  return `sgnl://linkdevice?${params.toString()}`;
}

function serializeSignedPreKey(
  Bytes: Awaited<ReturnType<typeof getSignalModules>>['Bytes'],
  preKey:
    | {
        keyId: number;
        publicKey: { serialize: () => Uint8Array<ArrayBuffer> };
        signature: Uint8Array<ArrayBuffer>;
      }
    | undefined
) {
  if (!preKey) {
    return undefined;
  }
  return {
    keyId: preKey.keyId,
    publicKey: Bytes.toBase64(preKey.publicKey.serialize()),
    signature: Bytes.toBase64(preKey.signature),
  };
}

function createSignedPreKeyRecord({
  keyId,
  keyPair,
  signature,
}: {
  keyId: number;
  keyPair: {
    publicKey: PublicKey;
    privateKey: PrivateKey;
  };
  signature: Uint8Array<ArrayBuffer>;
}) {
  return SignedPreKeyRecord.new(
    keyId,
    Date.now(),
    keyPair.publicKey,
    keyPair.privateKey,
    signature
  );
}

function encryptDeviceNameBase64({
  Crypto,
  Proto,
  Bytes,
  deviceName,
  identityPublic,
}: {
  Crypto: Awaited<ReturnType<typeof getSignalModules>>['Crypto'];
  Proto: Awaited<ReturnType<typeof getSignalModules>>['Proto'];
  Bytes: Awaited<ReturnType<typeof getSignalModules>>['Bytes'];
  deviceName: string;
  identityPublic: PublicKey;
}): string | undefined {
  const normalizedDeviceName = deviceName.trim().slice(0, 50);
  if (!normalizedDeviceName) {
    return undefined;
  }
  const encrypted = Crypto.encryptDeviceName(
    normalizedDeviceName,
    identityPublic
  );
  return Bytes.toBase64(
    Proto.DeviceName.encode({
      ephemeralPublic: encrypted.ephemeralPublic.serialize(),
      syntheticIv: encrypted.syntheticIv,
      ciphertext: encrypted.ciphertext,
    })
  );
}

function getNextKeyId(
  Crypto: Awaited<ReturnType<typeof getSignalModules>>['Crypto']
): number {
  return Buffer.from(Crypto.getRandomBytes(4)).readUint32LE(0) & 0xffffff;
}

async function linkDeviceFromEnvelope({
  session,
  envelope,
}: {
  session: ProvisioningSession;
  envelope: ProvisionDecryptResult;
}): Promise<LinkedPayload> {
  const { Net, Curve, Crypto, Bytes, Proto } = await getSignalModules();

  if (!envelope.number) {
    throw new Error('Missing provisioning number');
  }
  if (!envelope.provisioningCode) {
    throw new Error('Missing provisioning code');
  }
  if (!envelope.pniKeyPair) {
    throw new Error('Missing PNI identity key pair');
  }
  if (!envelope.profileKey?.length) {
    throw new Error('Missing profile key');
  }
  if (!envelope.masterKey?.length && !envelope.accountEntropyPool) {
    throw new Error('Missing master key or account entropy pool');
  }

  const passwordWithPadding = Bytes.toBase64(Crypto.getRandomBytes(16));
  const password = passwordWithPadding.substring(
    0,
    passwordWithPadding.length - 2
  );
  const registrationId = Crypto.generateRegistrationId();
  const pniRegistrationId = Crypto.generateRegistrationId();
  const aciSignedPreKey = Curve.generateSignedPreKey(
    envelope.aciKeyPair,
    getNextKeyId(Crypto)
  );
  const pniSignedPreKey = Curve.generateSignedPreKey(
    envelope.pniKeyPair,
    getNextKeyId(Crypto)
  );
  const aciPqLastResortPreKey = Curve.generateKyberPreKey(
    envelope.aciKeyPair,
    getNextKeyId(Crypto)
  );
  const pniPqLastResortPreKey = Curve.generateKyberPreKey(
    envelope.pniKeyPair,
    getNextKeyId(Crypto)
  );

  const jsonData = {
    verificationCode: envelope.provisioningCode,
    accountAttributes: {
      fetchesMessages: true,
      name: encryptDeviceNameBase64({
        Crypto,
        Proto,
        Bytes,
        deviceName: session.deviceName,
        identityPublic: envelope.aciKeyPair.publicKey,
      }),
      registrationId,
      pniRegistrationId,
      capabilities: {
        attachmentBackfill: true,
        spqr: true,
        usernameChangeSyncMessage: true,
      },
    },
    aciSignedPreKey: serializeSignedPreKey(Bytes, {
      keyId: aciSignedPreKey.keyId,
      publicKey: aciSignedPreKey.keyPair.publicKey,
      signature: aciSignedPreKey.signature,
    }),
    pniSignedPreKey: serializeSignedPreKey(Bytes, {
      keyId: pniSignedPreKey.keyId,
      publicKey: pniSignedPreKey.keyPair.publicKey,
      signature: pniSignedPreKey.signature,
    }),
    aciPqLastResortPreKey: serializeSignedPreKey(Bytes, {
      keyId: aciPqLastResortPreKey.id(),
      publicKey: aciPqLastResortPreKey.publicKey(),
      signature: aciPqLastResortPreKey.signature(),
    }),
    pniPqLastResortPreKey: serializeSignedPreKey(Bytes, {
      keyId: pniPqLastResortPreKey.id(),
      publicKey: pniPqLastResortPreKey.publicKey(),
      signature: pniPqLastResortPreKey.signature(),
    }),
  };

  const net = createNet(Net);
  recordSessionEvent(session, 'link-request-start');
  const chat = await net.connectUnauthenticatedChat(
    {
      onConnectionInterrupted() {},
    },
    { languages: ['zh-CN', 'en-US'] }
  );

  try {
    const response = await chat.fetch({
      verb: 'PUT',
      path: '/v1/devices/link',
      headers: [
        ['content-type', 'application/json'],
        [
          'authorization',
          `Basic ${Buffer.from(`${envelope.number}:${password}`).toString('base64')}`,
        ],
      ],
      body: Buffer.from(JSON.stringify(jsonData), 'utf8'),
      timeoutMillis: 60_000,
    });

    const responseBody = getBodyString(response.body);
    recordSessionEvent(session, 'link-response', String(response.status));
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        responseBody
          ? `linkDevice failed with status ${response.status}: ${responseBody}`
          : `linkDevice failed with status ${response.status}`
      );
    }

    const parsed = JSON.parse(responseBody) as {
      uuid: string;
      pni: string;
      deviceId: number;
    };

    const masterKey =
      envelope.masterKey ??
      Crypto.deriveMasterKey(envelope.accountEntropyPool as string);
    const storageServiceKey = Crypto.deriveStorageServiceKey(masterKey);
    const linkedAci = parsed.uuid;
    const linkedPni = parsed.pni.startsWith('PNI:')
      ? parsed.pni
      : `PNI:${parsed.pni}`;

    return {
      account: {
        aci: linkedAci,
        pni: linkedPni,
        number: envelope.number,
        phoneNumber: envelope.number,
        title: envelope.number,
      },
      credentials: {
        username: `${linkedAci}.${parsed.deviceId}`,
        password,
        deviceId: parsed.deviceId,
        aci: linkedAci,
        pni: linkedPni,
        number: envelope.number,
      },
      storageServiceKey: Bytes.toBase64(storageServiceKey),
      profileKeyBase64: Bytes.toBase64(envelope.profileKey),
      masterKeyBase64: Bytes.toBase64(masterKey),
      accountEntropyPool: envelope.accountEntropyPool,
      ephemeralBackupKeyBase64: envelope.ephemeralBackupKey
        ? Bytes.toBase64(envelope.ephemeralBackupKey)
        : undefined,
      mediaRootBackupKeyBase64: envelope.mediaRootBackupKey
        ? Bytes.toBase64(envelope.mediaRootBackupKey)
        : undefined,
      backupDownloadPath:
        LINK_AND_SYNC && envelope.ephemeralBackupKey
          ? `web-backup-${session.sessionId}`
          : undefined,
      aciIdentityKeyPublic: Bytes.toBase64(
        envelope.aciKeyPair.publicKey.serialize()
      ),
      aciIdentityKeyPrivate: Bytes.toBase64(
        envelope.aciKeyPair.privateKey.serialize()
      ),
      pniIdentityKeyPublic: Bytes.toBase64(
        envelope.pniKeyPair.publicKey.serialize()
      ),
      pniIdentityKeyPrivate: Bytes.toBase64(
        envelope.pniKeyPair.privateKey.serialize()
      ),
      aciRegistrationId: registrationId,
      pniRegistrationId,
      aciSignedPreKeyRecordBase64: Bytes.toBase64(
        createSignedPreKeyRecord(aciSignedPreKey).serialize()
      ),
      pniSignedPreKeyRecordBase64: Bytes.toBase64(
        createSignedPreKeyRecord(pniSignedPreKey).serialize()
      ),
      aciPqLastResortPreKeyRecordBase64: Bytes.toBase64(
        aciPqLastResortPreKey.serialize()
      ),
      pniPqLastResortPreKeyRecordBase64: Bytes.toBase64(
        pniPqLastResortPreKey.serialize()
      ),
      protocolPersistenceVersion: 1,
    };
  } finally {
    await chat.disconnect().catch(() => undefined);
  }
}

async function startProvisioningSession(
  deviceName: string
): Promise<ProvisioningSession> {
  const { Net, ProvisioningCipher, Bytes, Proto } = await getSignalModules();
  const session: ProvisioningSession = {
    sessionId: randomUUID(),
    status: 'starting',
    deviceName: deviceName.trim() || 'Signal Web',
    createdAt: now(),
    updatedAt: now(),
    events: [],
  };
  sessions.set(session.sessionId, session);
  recordSessionEvent(session, 'starting');

  const net = createNet(Net);
  const cipher = new ProvisioningCipher();
  const abortController = new AbortController();
  let connection:
    | {
        disconnect: () => Promise<void>;
      }
    | undefined;

  session.disconnect = async () => {
    abortController.abort();
    await connection?.disconnect();
  };

  net
    .connectProvisioning(
      {
        onReceivedAddress(address, ack) {
          session.url = buildLinkDeviceUrl({
            uuid: address,
            pubKey: Bytes.toBase64(cipher.getPublicKey().serialize()),
          });
          session.status = 'qr-ready';
          touch(session);
          recordSessionEvent(session, 'qr-ready');
          ack.send(200);
        },
        onReceivedEnvelope(body, ack) {
          session.status = 'linking';
          touch(session);
          recordSessionEvent(session, 'envelope-received');
          try {
            const provisionEnvelope = Proto.ProvisionEnvelope.decode(body);
            const envelope = cipher.decrypt(provisionEnvelope);
            ack.send(200);
            recordSessionEvent(session, 'envelope-decrypted');
            void linkDeviceFromEnvelope({ session, envelope })
              .then(linkedPayload => {
                session.linkedPayload = linkedPayload;
                session.status = 'ready';
                touch(session);
                recordSessionEvent(session, 'link-ready');
              })
              .catch(error => {
                session.status = 'error';
                session.error =
                  error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error);
                touch(session);
                recordSessionEvent(
                  session,
                  'link-error',
                  error instanceof Error ? error.message : String(error)
                );
              });
          } catch (error) {
            ack.send(500);
            session.status = 'error';
            session.error =
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error);
            touch(session);
            recordSessionEvent(
              session,
              'envelope-error',
              error instanceof Error ? error.message : String(error)
            );
          }
        },
        onConnectionInterrupted(cause) {
          recordSessionEvent(
            session,
            'provisioning-connection-interrupted',
            cause ? String(cause) : undefined
          );
          if (
            session.status === 'ready' ||
            session.status === 'error' ||
            session.status === 'linking'
          ) {
            return;
          }
          session.status = session.url ? 'closed' : 'error';
          session.error = cause ? String(cause) : session.error;
          touch(session);
        },
      },
      { abortSignal: abortController.signal }
    )
    .then(result => {
      connection = result;
    })
    .catch(error => {
      if (abortController.signal.aborted) {
        return;
      }
      session.status = 'error';
      session.error =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      touch(session);
      recordSessionEvent(
        session,
        'provisioning-start-error',
        error instanceof Error ? error.message : String(error)
      );
    });

  return session;
}

async function proxyToUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (!UPSTREAM_API_BASE_URL) {
    return false;
  }

  const target = new URL(`${url.pathname}${url.search}`, UPSTREAM_API_BASE_URL);
  const chunks = new Array<Buffer>();
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const response = await fetch(target, {
    method: req.method,
    headers: {
      'content-type': req.headers['content-type'] ?? 'application/json',
    },
    body:
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : Buffer.concat(chunks),
  });

  sendCors(req, res);
  res.writeHead(response.status, {
    'Content-Type':
      response.headers.get('content-type') ?? 'application/octet-stream',
  });
  if (response.body) {
    for await (const chunk of response.body) {
      res.write(chunk);
    }
  }
  res.end();
  return true;
}

async function getTransferArchive(
  chat: ChatConnection,
  abortSignal: AbortSignal,
  cooldownKey: string
): Promise<
  | { cdn: number; key: string }
  | { error: 'RELINK_REQUESTED' | 'CONTINUE_WITHOUT_UPLOAD' | 'RATE_LIMITED' }
  | undefined
> {
  const cooldownUntil = transferArchiveCooldownUntilByAccount.get(cooldownKey);
  if (cooldownUntil != null && cooldownUntil > now()) {
    return { error: 'RATE_LIMITED' };
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (abortSignal.aborted) {
      return undefined;
    }
    // eslint-disable-next-line no-await-in-loop
    const response = await chat.fetch({
      verb: 'GET',
      path: '/v1/devices/transfer_archive?timeout=10',
      headers: [],
      timeoutMillis: 25_000,
    });
    if (response.status === 204) {
      continue;
    }
    const responseBody = getBodyString(response.body);
    if (response.status === 429) {
      transferArchiveCooldownUntilByAccount.set(
        cooldownKey,
        now() + 10 * 60 * 1000
      );
      return { error: 'RATE_LIMITED' };
    }
    if (response.status !== 200) {
      throw new Error(
        responseBody
          ? `transfer_archive failed with status ${response.status}: ${responseBody}`
          : `transfer_archive failed with status ${response.status}`
      );
    }
    const parsed = JSON.parse(responseBody) as
      | { cdn: number; key: string }
      | {
          error:
            | 'RELINK_REQUESTED'
            | 'CONTINUE_WITHOUT_UPLOAD'
            | 'RATE_LIMITED';
        };
    return parsed;
  }
  return undefined;
}

async function downloadEphemeralBackup({
  archive,
  abortSignal,
}: {
  archive: { cdn: number; key: string };
  abortSignal: AbortSignal;
}): Promise<Buffer> {
  const baseUrl =
    productionConfig.cdn[String(archive.cdn)] ?? productionConfig.cdn['0'];
  if (!baseUrl) {
    throw new Error(`CDN ${archive.cdn} is not configured`);
  }
  const url = new URL(
    `/attachments/${encodeURIComponent(archive.key)}`,
    baseUrl
  );
  try {
    const response = await fetch(url, { signal: abortSignal });
    if (!response.ok) {
      throw new Error(
        `ephemeral backup download failed with status ${response.status}: ${await response.text()}`
      );
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (!ALLOW_INSECURE_CDN_TLS) {
      throw error;
    }
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false }, response => {
      const chunks = new Array<Buffer>();
      response.on('data', chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(
            new Error(
              `ephemeral backup download failed with status ${statusCode}: ${body.toString('utf8')}`
            )
          );
          return;
        }
        resolve(body);
      });
    });
    request.on('error', reject);
    abortSignal.addEventListener(
      'abort',
      () => {
        request.destroy(new Error('Aborted'));
      },
      { once: true }
    );
  });
}

const BACKUP_CDN_READ_CREDENTIALS_VALID_MS = 12 * 60 * 60 * 1000;
const BACKUP_MEDIA_AES_KEY_LEN = 32;
const BACKUP_MEDIA_MAC_KEY_LEN = 32;
const ATTACHMENT_SESSION_READY_TIMEOUT_MS = 10_000;
const ATTACHMENT_SESSION_READY_POLL_MS = 100;

type BackupCredentialsResponseBody = Readonly<{
  credentials?: Readonly<{
    media?: ReadonlyArray<
      Readonly<{
        credential?: string;
        redemptionTime?: number;
      }>
    >;
  }>;
}>;

type BackupInfoResponseBody = Readonly<{
  backupDir?: string;
  mediaDir?: string;
}>;

type BackupListMediaResponseBody = Readonly<{
  backupDir?: string;
  mediaDir?: string;
  cursor?: string | null;
  storedMediaObjects?: ReadonlyArray<
    Readonly<{
      cdn?: number;
      mediaId?: string;
      objectLength?: number;
    }>
  >;
}>;

type BackupCdnCredentialsResponseBody = Readonly<{
  headers?: Record<string, string>;
}>;

type RemoteConfigResponseBody = Readonly<{
  config?: Record<string, string>;
}>;

type ProfileWriteRequestBody = Readonly<{
  aboutEmoji?: string;
  aboutText?: string;
  avatarBase64?: string;
  familyName?: string;
  firstName: string;
  hasOtherDevices?: boolean;
  phoneNumberSharing: boolean;
  removeAvatar?: boolean;
  sessionId?: string;
  timestamp?: number;
}>;

type PhoneNumberDiscoverabilityRequestBody = Readonly<{
  discoverable: boolean;
  sessionId?: string;
}>;

type ProfileRequestData = Readonly<{
  about: string | null;
  aboutEmoji: string | null;
  avatar: boolean;
  badgeIds: ReadonlyArray<string>;
  commitment: string;
  name: string;
  paymentAddress: string | null;
  phoneNumberSharing: string;
  sameAvatar: boolean;
  version: string;
}>;

type ProfileResponseBody = Readonly<{
  about?: string;
  aboutEmoji?: string;
  avatar?: string;
  name?: string;
  paymentAddress?: string;
  phoneNumberSharing?: string;
}>;

type ProfileAvatarUploadHeaders = Readonly<{
  acl: string;
  algorithm: string;
  credential: string;
  date: string;
  key: string;
  policy: string;
  signature: string;
}>;

function getBasicAuthorization(
  credentials: LinkedPayload['credentials']
): string {
  return `Basic ${Buffer.from(
    `${credentials.username}:${credentials.password}`
  ).toString('base64')}`;
}

async function fetchSignalJson<T>({
  authenticatedCredentials,
  body,
  chat,
  headers,
  method = 'GET',
  path,
}: Readonly<{
  authenticatedCredentials?: LinkedPayload['credentials'];
  body?: unknown;
  chat?: ChatConnection;
  headers?: Record<string, string>;
  method?: 'DELETE' | 'GET' | 'PUT';
  path: string;
}>): Promise<T> {
  const bodyBytes =
    body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const requestHeaders = {
    ...(bodyBytes
      ? {
          'content-type': 'application/json',
        }
      : null),
    ...headers,
  };
  if (chat) {
    const response = await chat.fetch({
      verb: method,
      path,
      headers: Object.entries(requestHeaders),
      body: bodyBytes,
      timeoutMillis: 30_000,
    });
    const responseBody = getBodyString(response.body);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        responseBody
          ? `${path} failed with status ${response.status}: ${responseBody}`
          : `${path} failed with status ${response.status}`
      );
    }
    return (responseBody ? JSON.parse(responseBody) : undefined) as T;
  }

  const url = new URL(path, productionConfig.serverUrl);
  const response = await nodeFetch(url, {
    headers: {
      'User-Agent': getUserAgent(packageJson.version),
      'X-Signal-Agent': 'OWD',
      ...requestHeaders,
      ...(authenticatedCredentials
        ? {
            Authorization: getBasicAuthorization(authenticatedCredentials),
          }
        : null),
    },
    body: bodyBytes,
    method,
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      responseBody
        ? `${path} failed with status ${response.status}: ${responseBody}`
        : `${path} failed with status ${response.status}`
    );
  }
  return (responseBody ? JSON.parse(responseBody) : undefined) as T;
}

function getProfileRequestData({
  aboutEmoji,
  aboutText,
  avatarData,
  familyName,
  firstName,
  linkedPayload,
  paymentAddress,
  phoneNumberSharing,
  removeAvatar,
}: Readonly<{
  aboutEmoji?: string;
  aboutText?: string;
  avatarData?: Uint8Array<ArrayBuffer>;
  familyName?: string;
  firstName: string;
  linkedPayload: LinkedPayload;
  paymentAddress?: string | null;
  phoneNumberSharing: boolean;
  removeAvatar?: boolean;
}>): ProfileRequestData {
  const profileKey = linkedPayload.profileKeyBase64;
  const serviceId = linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
  if (!profileKey) {
    throw new Error('writeProfile: missing profileKeyBase64');
  }
  if (!serviceId) {
    throw new Error('writeProfile: missing ACI');
  }

  const keyBuffer = Bytes.fromBase64(profileKey);
  const fullName = [firstName, familyName].filter(Boolean).join('\0');
  const encryptedName = encryptProfileItemWithPadding(
    Bytes.fromString(fullName),
    keyBuffer,
    PaddedLengths.Name
  );
  const encryptedAbout = aboutText
    ? encryptProfileItemWithPadding(
        Bytes.fromString(aboutText),
        keyBuffer,
        PaddedLengths.About
      )
    : undefined;
  const encryptedAboutEmoji = aboutEmoji
    ? encryptProfileItemWithPadding(
        Bytes.fromString(aboutEmoji),
        keyBuffer,
        PaddedLengths.AboutEmoji
      )
    : undefined;
  const encryptedPhoneNumberSharing = encryptProfile(
    new Uint8Array([phoneNumberSharing ? 1 : 0]),
    keyBuffer
  );
  const isUpdatingAvatar = Boolean(avatarData) || removeAvatar === true;

  return {
    about: encryptedAbout ? Bytes.toBase64(encryptedAbout) : null,
    aboutEmoji: encryptedAboutEmoji
      ? Bytes.toBase64(encryptedAboutEmoji)
      : null,
    avatar: Boolean(avatarData),
    badgeIds: [],
    commitment: deriveProfileKeyCommitment(
      profileKey,
      serviceId as ServiceIdString
    ),
    name: Bytes.toBase64(encryptedName),
    paymentAddress: paymentAddress ?? null,
    phoneNumberSharing: Bytes.toBase64(encryptedPhoneNumberSharing),
    sameAvatar: !isUpdatingAvatar,
    version: deriveProfileKeyVersion(profileKey, serviceId as ServiceIdString),
  };
}

async function fetchCurrentProfileForWrite(
  chat: ChatConnection,
  linkedPayload: LinkedPayload
): Promise<ProfileResponseBody> {
  const profileKey = linkedPayload.profileKeyBase64;
  const serviceId = linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
  if (!profileKey) {
    throw new Error('writeProfile: missing profileKeyBase64');
  }
  if (!serviceId) {
    throw new Error('writeProfile: missing ACI');
  }

  const profileKeyVersion = deriveProfileKeyVersion(
    profileKey,
    serviceId as ServiceIdString
  );
  return fetchSignalJson<ProfileResponseBody>({
    chat,
    path: `/v1/profile/${serviceId}/${profileKeyVersion}`,
  });
}

function getProfileAvatarUploadBody(
  {
    acl,
    algorithm,
    credential,
    date,
    key,
    policy,
    signature,
  }: ProfileAvatarUploadHeaders,
  encryptedAvatarData: Uint8Array<ArrayBuffer>
): Readonly<{ body: Uint8Array<ArrayBuffer>; contentType: string }> {
  const boundaryString = `----------------${randomUUID().replace(/-/g, '')}`;
  const CRLF = '\r\n';
  const getSection = (name: string, value: string) =>
    [
      `--${boundaryString}`,
      `Content-Disposition: form-data; name="${name}"${CRLF}`,
      value,
    ].join(CRLF);

  const start = [
    getSection('key', key),
    getSection('x-amz-credential', credential),
    getSection('acl', acl),
    getSection('x-amz-algorithm', algorithm),
    getSection('x-amz-date', date),
    getSection('policy', policy),
    getSection('x-amz-signature', signature),
    getSection('Content-Type', 'application/octet-stream'),
    `--${boundaryString}`,
    'Content-Disposition: form-data; name="file"',
    `Content-Type: application/octet-stream${CRLF}${CRLF}`,
  ].join(CRLF);
  const end = `${CRLF}--${boundaryString}--${CRLF}`;

  return {
    body: Bytes.concatenate([
      Bytes.fromString(start),
      encryptedAvatarData,
      Bytes.fromString(end),
    ]),
    contentType: `multipart/form-data; boundary=${boundaryString}`,
  };
}

function isProfileAvatarUploadHeaders(
  value: unknown
): value is ProfileAvatarUploadHeaders {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<
    Record<keyof ProfileAvatarUploadHeaders, unknown>
  >;
  return (
    typeof record.acl === 'string' &&
    typeof record.algorithm === 'string' &&
    typeof record.credential === 'string' &&
    typeof record.date === 'string' &&
    typeof record.key === 'string' &&
    typeof record.policy === 'string' &&
    typeof record.signature === 'string'
  );
}

async function uploadProfileAvatar(
  uploadHeaders: ProfileAvatarUploadHeaders,
  encryptedAvatarData: Uint8Array<ArrayBuffer>
): Promise<string> {
  const { body, contentType } = getProfileAvatarUploadBody(
    uploadHeaders,
    encryptedAvatarData
  );
  const uploadFetch = ALLOW_INSECURE_CDN_TLS ? insecureNodeFetch : nodeFetch;
  const response = await uploadFetch(getDefaultCdnUrl(), {
    body: Buffer.from(body),
    headers: {
      'Content-Length': body.byteLength.toString(),
      'Content-Type': contentType,
      'User-Agent': getUserAgent(packageJson.version),
    },
    method: 'POST',
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      responseBody
        ? `profile avatar upload failed with status ${response.status}: ${responseBody}`
        : `profile avatar upload failed with status ${response.status}`
    );
  }

  return uploadHeaders.key;
}

function getProfileAccountUpdate({
  aboutEmoji,
  aboutText,
  avatarUrlPath,
  familyName,
  firstName,
  linkedPayload,
  removeAvatar,
  timestamp,
}: Readonly<{
  aboutEmoji?: string;
  aboutText?: string;
  avatarUrlPath?: string;
  familyName?: string;
  firstName: string;
  linkedPayload: LinkedPayload;
  removeAvatar?: boolean;
  timestamp: number;
}>): WebAccount {
  const title = [firstName, familyName].filter(Boolean).join(' ').trim();
  return {
    ...linkedPayload.account,
    about: aboutText,
    aboutEmoji:
      aboutEmoji == null
        ? undefined
        : Emoji.unsafeCastMaybeInvalidStringToVariant(aboutEmoji),
    ...(avatarUrlPath
      ? {
          avatarUrlPath,
        }
      : null),
    ...(removeAvatar === true
      ? {
          avatarUrl: undefined,
          avatarUrlPath: undefined,
        }
      : null),
    familyName,
    firstName,
    localProfileUpdatedAt: timestamp,
    profileFamilyName: familyName,
    profileName: firstName,
    title: title || linkedPayload.account.title,
  };
}

function getLatestAttachmentStreamSession(): MessageStreamSession | undefined {
  return [...streamSessions.values()]
    .filter(session => session.status === 'open' && session.linkedPayload)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function getAttachmentStreamSession(
  sessionId: string | null
): MessageStreamSession | undefined {
  if (sessionId) {
    return streamSessions.get(sessionId);
  }
  return getLatestAttachmentStreamSession();
}

function getAttachmentTmpDir(streamSession: MessageStreamSession): string {
  return resolve(WEB_ATTACHMENT_TMP_DIR, streamSession.sessionId);
}

async function cleanupAttachmentTmpDir(
  streamSession: MessageStreamSession
): Promise<void> {
  await rm(getAttachmentTmpDir(streamSession), {
    force: true,
    recursive: true,
  });
}

async function cleanupExpiredAttachmentTmpDirs(): Promise<void> {
  if (!Number.isFinite(WEB_ATTACHMENT_TMP_MAX_AGE_MS)) {
    return;
  }
  let entries;
  try {
    entries = await readdir(WEB_ATTACHMENT_TMP_DIR, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error != null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }

  const expiresBefore = now() - WEB_ATTACHMENT_TMP_MAX_AGE_MS;
  await Promise.all(
    entries.map(async entry => {
      if (!entry.isDirectory()) {
        return;
      }
      const absolutePath = resolve(WEB_ATTACHMENT_TMP_DIR, entry.name);
      const stats = await stat(absolutePath);
      if (stats.mtimeMs < expiresBefore) {
        await rm(absolutePath, { force: true, recursive: true });
      }
    })
  );
}

async function waitForAttachmentStreamSession(
  sessionId: string | null
): Promise<MessageStreamSession | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ATTACHMENT_SESSION_READY_TIMEOUT_MS) {
    const streamSession = getAttachmentStreamSession(sessionId);
    if (!streamSession) {
      return undefined;
    }
    if (streamSession.connection && streamSession.linkedPayload) {
      return streamSession;
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, ATTACHMENT_SESSION_READY_POLL_MS);
    });
  }
  return getAttachmentStreamSession(sessionId);
}

async function getBackupUnauthConnection(
  streamSession: MessageStreamSession
): Promise<UnauthenticatedChatConnection> {
  if (streamSession.backupUnauthConnection) {
    return streamSession.backupUnauthConnection;
  }
  const { Net } = await getSignalModules();
  const net = createNet(Net);
  const connection = await net.connectUnauthenticatedChat(
    {
      onConnectionInterrupted() {
        streamSession.backupUnauthKeepalive?.stop();
        streamSession.backupUnauthKeepalive = undefined;
        streamSession.backupUnauthConnection = undefined;
      },
    },
    { languages: ['zh-CN', 'en-US'] }
  );
  streamSession.backupUnauthConnection = connection;
  streamSession.backupUnauthKeepalive?.stop();
  streamSession.backupUnauthKeepalive = startSignalChatKeepalive({
    connection,
    logId: `WebMessageStream(${streamSession.sessionId}).backupUnauthKeepalive`,
    onFailure: ({ error, responseMs, status }) => {
      streamSession.backupUnauthKeepaliveFailureCount =
        (streamSession.backupUnauthKeepaliveFailureCount ?? 0) + 1;
      streamSession.lastBackupUnauthKeepaliveError = error;
      streamSession.lastBackupUnauthKeepaliveResponseMs = responseMs;
      streamSession.lastBackupUnauthKeepaliveStatus = status;
      streamSession.updatedAt = now();
      streamSession.backupUnauthConnection = undefined;
      streamSession.backupUnauthKeepalive = undefined;
      void connection.disconnect().catch(() => undefined);
    },
    onSuccess: ({ responseMs, status, timestamp }) => {
      streamSession.backupUnauthKeepaliveCount =
        (streamSession.backupUnauthKeepaliveCount ?? 0) + 1;
      streamSession.lastBackupUnauthKeepaliveAt = timestamp;
      streamSession.lastBackupUnauthKeepaliveError = undefined;
      streamSession.lastBackupUnauthKeepaliveResponseMs = responseMs;
      streamSession.lastBackupUnauthKeepaliveStatus = status;
      streamSession.updatedAt = now();
    },
  });
  return connection;
}

function getMediaRootBackupKey(linkedPayload: LinkedPayload): BackupKey {
  const mediaRootBackupKeyBase64 = linkedPayload.mediaRootBackupKeyBase64;
  if (!mediaRootBackupKeyBase64) {
    throw new Error('Linked payload is missing mediaRootBackupKeyBase64');
  }
  return new BackupKey(Bytes.fromBase64(mediaRootBackupKeyBase64));
}

function getBackupMediaId({
  keyBase64,
  mediaRootKey,
  plaintextHash,
}: Readonly<{
  keyBase64: string;
  mediaRootKey: BackupKey;
  plaintextHash: string;
}>): { bytes: Uint8Array<ArrayBuffer>; string: string } {
  const mediaName = Bytes.toHex(
    Bytes.concatenate([
      Bytes.fromHex(plaintextHash),
      Bytes.fromBase64(keyBase64),
    ])
  );
  const mediaIdBytes = mediaRootKey.deriveMediaId(mediaName);
  return {
    bytes: mediaIdBytes,
    string: Bytes.toBase64url(mediaIdBytes),
  };
}

function deriveBackupMediaOuterEncryptionKeyMaterial(
  mediaRootKey: BackupKey,
  mediaId: Uint8Array<ArrayBuffer>
): {
  aesKey: Uint8Array<ArrayBuffer>;
  macKey: Uint8Array<ArrayBuffer>;
} {
  const material = mediaRootKey.deriveMediaEncryptionKey(mediaId);
  return {
    macKey: material.subarray(0, BACKUP_MEDIA_MAC_KEY_LEN),
    aesKey: material.subarray(
      BACKUP_MEDIA_MAC_KEY_LEN,
      BACKUP_MEDIA_MAC_KEY_LEN + BACKUP_MEDIA_AES_KEY_LEN
    ),
  };
}

async function getBackupPresentationHeaders(
  streamSession: MessageStreamSession,
  linkedPayload: LinkedPayload
): Promise<Record<string, string>> {
  if (
    streamSession.backupPresentationHeaders &&
    streamSession.backupPresentationHeaders.retrievedAtMs > Date.now() - DAY
  ) {
    return streamSession.backupPresentationHeaders.headers;
  }

  const mediaRootKey = getMediaRootBackupKey(linkedPayload);
  if (!streamSession.connection) {
    throw new Error('Message runtime session is missing chat connection');
  }
  const aci = normalizeAci(
    linkedPayload.credentials.aci,
    'getBackupPresentationHeaders.aci'
  ) as AciString;
  const requestContext = BackupAuthCredentialRequestContext.create(
    mediaRootKey.serialize(),
    aci
  );
  const startDayInMs = toDayMillis(Date.now());
  const endDayInMs = toDayMillis(Date.now() + 6 * DAY);
  const response = await fetchSignalJson<BackupCredentialsResponseBody>({
    authenticatedCredentials: linkedPayload.credentials,
    chat: streamSession.connection,
    path:
      `/v1/archives/auth?redemptionStartSeconds=${startDayInMs / 1000}` +
      `&redemptionEndSeconds=${endDayInMs / 1000}`,
  });
  const rawCredential = response.credentials?.media?.find(
    credential =>
      credential.redemptionTime != null &&
      credential.redemptionTime * 1000 === startDayInMs
  );
  if (!rawCredential?.credential || rawCredential.redemptionTime == null) {
    throw new Error('Backup media credentials do not include today');
  }

  const serverPublicParams = new GenericServerPublicParams(
    Bytes.fromBase64(productionConfig.backupServerPublicParams)
  );
  const credential = requestContext.receive(
    new BackupAuthCredentialResponse(
      Bytes.fromBase64(rawCredential.credential)
    ),
    DurationInSeconds.fromSeconds(rawCredential.redemptionTime),
    serverPublicParams
  );
  const presentation = credential.present(serverPublicParams).serialize();
  const signatureKey = mediaRootKey.deriveEcKey(toAciObject(aci));
  const signature = signatureKey.sign(presentation);
  const headers = {
    'X-Signal-ZK-Auth': Bytes.toBase64(presentation),
    'X-Signal-ZK-Auth-Signature': Bytes.toBase64(signature),
  };
  if (!streamSession.backupMediaSignatureKeyUploaded) {
    const unauthConnection = await getBackupUnauthConnection(streamSession);
    await fetchSignalJson<void>({
      body: {
        backupIdPublicKey: Bytes.toBase64(
          signatureKey.getPublicKey().serialize()
        ),
      },
      chat: unauthConnection,
      headers,
      method: 'PUT',
      path: '/v1/archives/keys',
    });
    streamSession.backupMediaSignatureKeyUploaded = true;
  }
  streamSession.backupPresentationHeaders = {
    headers,
    retrievedAtMs: Date.now(),
  };
  return headers;
}

async function getBackupArchiveInfo(
  streamSession: MessageStreamSession,
  linkedPayload: LinkedPayload
): Promise<BackupArchiveInfo> {
  if (streamSession.backupArchiveInfo) {
    return streamSession.backupArchiveInfo;
  }
  const headers = await getBackupPresentationHeaders(
    streamSession,
    linkedPayload
  );
  const unauthConnection = await getBackupUnauthConnection(streamSession);
  const response = await fetchSignalJson<BackupInfoResponseBody>({
    chat: unauthConnection,
    headers,
    path: '/v1/archives',
  });
  if (!response.backupDir || !response.mediaDir) {
    throw new Error('/v1/archives response is missing backupDir or mediaDir');
  }
  streamSession.backupArchiveInfo = {
    backupDir: response.backupDir,
    mediaDir: response.mediaDir,
  };
  return streamSession.backupArchiveInfo;
}

async function findBackupMediaLocation({
  linkedPayload,
  mediaId,
  streamSession,
}: Readonly<{
  linkedPayload: LinkedPayload;
  mediaId: string;
  streamSession: MessageStreamSession;
}>): Promise<BackupMediaLocation | undefined> {
  const headers = await getBackupPresentationHeaders(
    streamSession,
    linkedPayload
  );
  const unauthConnection = await getBackupUnauthConnection(streamSession);
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ limit: '1000' });
    if (cursor) {
      params.set('cursor', cursor);
    }
    // eslint-disable-next-line no-await-in-loop
    const response = await fetchSignalJson<BackupListMediaResponseBody>({
      chat: unauthConnection,
      headers,
      path: `/v1/archives/media?${params.toString()}`,
    });
    if (response.backupDir && response.mediaDir) {
      streamSession.backupArchiveInfo = {
        backupDir: response.backupDir,
        mediaDir: response.mediaDir,
      };
    }
    const storedObject = response.storedMediaObjects?.find(
      item => item.mediaId === mediaId
    );
    if (storedObject?.cdn != null && response.backupDir && response.mediaDir) {
      return {
        backupDir: response.backupDir,
        mediaDir: response.mediaDir,
        cdnNumber: storedObject.cdn,
      };
    }
    cursor = response.cursor ?? undefined;
  } while (cursor);
  return undefined;
}

async function getBackupCdnReadHeaders({
  cdnNumber,
  linkedPayload,
  streamSession,
}: Readonly<{
  cdnNumber: number;
  linkedPayload: LinkedPayload;
  streamSession: MessageStreamSession;
}>): Promise<Record<string, string>> {
  const cached = streamSession.backupCdnReadCredentials?.[cdnNumber];
  if (
    cached &&
    cached.retrievedAtMs > Date.now() - BACKUP_CDN_READ_CREDENTIALS_VALID_MS
  ) {
    return cached.headers;
  }

  const headers = await getBackupPresentationHeaders(
    streamSession,
    linkedPayload
  );
  const unauthConnection = await getBackupUnauthConnection(streamSession);
  const response = await fetchSignalJson<BackupCdnCredentialsResponseBody>({
    chat: unauthConnection,
    headers,
    path: `/v1/archives/auth/read?cdn=${cdnNumber}`,
  });
  if (!response.headers) {
    throw new Error('/v1/archives/auth/read response is missing headers');
  }
  streamSession.backupCdnReadCredentials = {
    ...streamSession.backupCdnReadCredentials,
    [cdnNumber]: {
      headers: response.headers,
      retrievedAtMs: Date.now(),
    },
  };
  return response.headers;
}

async function getRemoteConfigValue({
  key,
  streamSession,
}: Readonly<{
  key: string;
  streamSession: MessageStreamSession;
}>): Promise<string | undefined> {
  if (
    !streamSession.remoteConfig ||
    streamSession.remoteConfig.retrievedAtMs < Date.now() - 2 * 60 * 60 * 1000
  ) {
    if (!streamSession.connection) {
      throw new Error('Message runtime session is missing chat connection');
    }
    const response = await fetchSignalJson<RemoteConfigResponseBody>({
      chat: streamSession.connection,
      path: '/v2/config',
    });
    streamSession.remoteConfig = {
      values: response.config ?? {},
      retrievedAtMs: Date.now(),
    };
  }
  return streamSession.remoteConfig.values[key];
}

async function getFallbackBackupCdnNumber(
  streamSession: MessageStreamSession
): Promise<number> {
  const rawValue = await getRemoteConfigValue({
    key: 'global.backups.mediaTierFallbackCdnNumber',
    streamSession,
  });
  const cdnNumber = rawValue == null ? NaN : Number.parseInt(rawValue, 10);
  if (!Number.isInteger(cdnNumber)) {
    throw new Error('global.backups.mediaTierFallbackCdnNumber must be set');
  }
  return cdnNumber;
}

async function fetchBackupMediaStream({
  backupDir,
  cdnNumber,
  headers,
  mediaDir,
  mediaId,
}: Readonly<{
  backupDir: string;
  cdnNumber: number;
  headers: Record<string, string>;
  mediaDir: string;
  mediaId: string;
}>): Promise<Readable> {
  const baseUrl =
    productionConfig.cdn[String(cdnNumber)] ?? productionConfig.cdn['0'];
  if (!baseUrl) {
    throw new Error(`CDN ${cdnNumber} is not configured`);
  }
  const url = new URL(
    `/backups/${encodeURIComponent(backupDir)}/${encodeURIComponent(
      mediaDir
    )}/${encodeURIComponent(mediaId)}`,
    baseUrl
  );
  const response = await nodeFetch(url, {
    headers,
    method: 'GET',
  });
  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      responseBody
        ? `backup media download failed with status ${response.status}: ${responseBody}`
        : `backup media download failed with status ${response.status}`
    );
  }
  if (!response.body) {
    throw new Error('backup media download response is missing body');
  }
  return response.body as unknown as Readable;
}

async function importBackupForMessageStream({
  abortSignal,
  chat,
  cooldownKey,
  linkedPayload,
  streamSession,
  writeEvent,
}: {
  abortSignal: AbortSignal;
  chat: ChatConnection;
  cooldownKey: string;
  linkedPayload: LinkedPayload | undefined;
  streamSession: MessageStreamSession;
  writeEvent: (event: unknown) => void;
}): Promise<void> {
  if (!linkedPayload?.ephemeralBackupKeyBase64) {
    streamSession.backupImportStatus = 'missing';
    streamSession.backupImportError =
      'Linked payload does not include ephemeral backup key';
    streamSession.updatedAt = now();
    writeEvent({
      type: 'error',
      error: streamSession.backupImportError,
    });
    return;
  }

  try {
    streamSession.backupImportStatus = 'waiting-for-archive';
    streamSession.updatedAt = now();
    writeEvent({ type: 'backup-import-status', status: 'waiting-for-archive' });

    const archive = await getTransferArchive(chat, abortSignal, cooldownKey);
    if (!archive) {
      streamSession.backupImportStatus = 'missing';
      streamSession.backupImportError =
        'Timed out waiting for transfer archive';
      streamSession.updatedAt = now();
      writeEvent({
        type: 'backup-import-status',
        status: 'missing',
        error: streamSession.backupImportError,
      });
      return;
    }
    if ('error' in archive) {
      streamSession.backupImportStatus = 'missing';
      streamSession.backupImportError =
        archive.error === 'RATE_LIMITED'
          ? 'transfer_archive is rate limited'
          : archive.error;
      streamSession.updatedAt = now();
      writeEvent({
        type: 'backup-import-status',
        status: 'missing',
        error: streamSession.backupImportError,
      });
      return;
    }

    streamSession.backupImportStatus = 'downloading';
    streamSession.updatedAt = now();
    writeEvent({ type: 'backup-import-status', status: 'downloading' });
    const backupBytes = await downloadEphemeralBackup({ archive, abortSignal });

    streamSession.backupImportStatus = 'importing';
    streamSession.updatedAt = now();
    writeEvent({
      type: 'backup-import-status',
      status: 'importing',
      bytes: backupBytes.byteLength,
    });
    const result = await importEphemeralBackup({
      createBackupStream: () => Readable.from(backupBytes),
      linkedPayload,
    });
    if (result.mediaRootBackupKeyBase64) {
      streamSession.linkedPayload = {
        ...linkedPayload,
        mediaRootBackupKeyBase64: result.mediaRootBackupKeyBase64,
      };
      const provisioningSession = [...sessions.values()].find(session => {
        const sessionAci =
          session.linkedPayload?.credentials.aci ??
          session.linkedPayload?.account.aci;
        const streamAci =
          streamSession.linkedPayload?.credentials.aci ??
          streamSession.linkedPayload?.account.aci;
        return streamAci != null && sessionAci === streamAci;
      });
      if (provisioningSession) {
        provisioningSession.linkedPayload = streamSession.linkedPayload;
        touch(provisioningSession);
      }
      writeEvent({
        type: 'linked-session-updated',
        linkedPayload: streamSession.linkedPayload,
      });
    }

    streamSession.backupImportStatus = 'done';
    streamSession.backupImportStats = result.stats;
    streamSession.updatedAt = now();
    let chatShell = result.chatShell;
    let contactsBootstrap = result.contactsBootstrap;
    if (streamSession.connection) {
      ({ chatShell, contactsBootstrap } = await enrichBackupImportGroups({
        chat: streamSession.connection,
        chatShell,
        contactsBootstrap,
        linkedPayload,
      }));
    }
    mergeStreamConversations(streamSession, [
      ...contactsBootstrap.conversations,
      ...contactsBootstrap.archived,
      ...contactsBootstrap.pinned,
      ...Object.values(chatShell.conversationLookup),
    ]);
    writeEvent({ type: 'contacts-bootstrap', data: contactsBootstrap });
    writeEvent({ type: 'chat-shell', state: chatShell });
    writeEvent({
      type: 'backup-import-status',
      status: 'done',
      stats: result.stats,
    });
  } catch (error) {
    if (abortSignal.aborted) {
      return;
    }
    streamSession.backupImportStatus = 'error';
    streamSession.backupImportError = errorToLogString(error);
    streamSession.updatedAt = now();
    writeEvent({
      type: 'backup-import-status',
      status: 'error',
      error: streamSession.backupImportError,
    });
  }
}

function createGroupConversationFromMessage(
  message: WebMessage
): WebConversation | undefined {
  const { groupV2 } = message;
  if (!groupV2) {
    return undefined;
  }
  const timestamp = message.receivedAt ?? message.timestamp;
  return {
    acceptedMessageRequest: true,
    conversationType: 'group',
    groupId: groupV2.id,
    hasMessages: true,
    id: message.conversationId,
    lastUpdated: timestamp,
    masterKey: groupV2.masterKey,
    profileSharing: true,
    publicParams: groupV2.publicParams,
    revision: groupV2.revision,
    secretParams: groupV2.secretParams,
    timestamp,
    type: 'group',
  };
}

async function enrichConversationForGroupMessage({
  connection,
  linkedPayload,
  message,
}: Readonly<{
  connection: AuthenticatedChatConnection;
  linkedPayload: LinkedPayload;
  message: WebMessage;
}>): Promise<WebConversation | undefined> {
  const conversation = createGroupConversationFromMessage(message);
  if (!conversation) {
    return undefined;
  }

  return fetchLatestGroupStateConversation({
    allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
    cdnUrl: getDefaultCdnUrl(),
    chat: connection,
    conversation,
    linkedPayload,
    storageUrl: productionConfig.storageUrl,
  });
}

function maybeConvertInitialGroupMessageToChange({
  conversation,
  linkedPayload,
  message,
}: Readonly<{
  conversation: WebConversation | undefined;
  linkedPayload: LinkedPayload;
  message: WebMessage;
}>): WebMessage {
  if (
    message.groupV2Change ||
    !message.groupV2 ||
    message.body ||
    (message.attachments?.length ?? 0) > 0 ||
    !conversation?.membersV2
  ) {
    return message;
  }

  const ourAci = linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
  if (
    !ourAci ||
    !conversation.membersV2.some(member => member.aci === ourAci)
  ) {
    return message;
  }

  return {
    ...message,
    body: undefined,
    desktopType: 'group-v2-change',
    groupV2Change: {
      from: message.sourceServiceId as ServiceIdString | undefined,
      details: [
        {
          type: 'member-add',
          aci: ourAci as AciString,
        },
      ],
    },
  };
}

async function handleMessageStream(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const username =
    typeof body.username === 'string' ? body.username : undefined;
  const password =
    typeof body.password === 'string' ? body.password : undefined;
  const linkedPayload = getLinkedPayloadFromStreamBody(body);
  const importBackup = body.importBackup !== false;
  if (!username || !password) {
    sendText(req, res, 401, 'Linked Signal credentials are required');
    return;
  }

  const sessionId = randomUUID();
  const abortController = new AbortController();
  let connection: AuthenticatedChatConnection | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let didCloseStream = false;
  const streamAci =
    linkedPayload?.credentials?.aci ?? linkedPayload?.account.aci;

  for (const [existingSessionId, existingSession] of streamSessions) {
    if (existingSession.username === username) {
      existingSession.status = 'closed';
      existingSession.updatedAt = now();
      disposeStreamSession(existingSessionId, existingSession);
    }
  }

  const streamSession: MessageStreamSession = {
    sessionId,
    createdAt: now(),
    updatedAt: now(),
    username,
    status: 'connecting',
    lastStreamStartedAt: now(),
    lastTransportStatusAt: now(),
    backupImportStatus: 'idle',
    incomingEnvelopeCount: 0,
    decodedMessageCount: 0,
    ignoredEnvelopeCount: 0,
    queueEmptyCount: 0,
    sendAttemptCount: 0,
    linkedPayload,
    closeStream: () => {
      if (didCloseStream) {
        return;
      }
      didCloseStream = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      streamSession.signalKeepalive?.stop();
      streamSession.signalKeepalive = undefined;
      streamSession.backupUnauthKeepalive?.stop();
      streamSession.backupUnauthKeepalive = undefined;
      flushProtocolState(streamSession);
      streamSession.lastStreamEndedAt = now();
      streamSession.streamCloseCount =
        (streamSession.streamCloseCount ?? 0) + 1;
      rememberRecentlyClosedStreamAci(streamSession);
      abortController.abort();
      void connection?.disconnect().catch(() => undefined);
      void streamSession.backupUnauthConnection
        ?.disconnect()
        .catch(() => undefined);
      void cleanupAttachmentTmpDir(streamSession).catch(() => undefined);
      streamSessions.delete(sessionId);
      sessionOperationQueues.delete(sessionId);
      sessionOperationQueueSizes.delete(sessionId);
      cleanupRuntimeState('stream-close');
      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    },
    disconnect: async () => {
      abortController.abort();
      await connection?.disconnect();
    },
  };
  streamSessions.set(sessionId, streamSession);

  sendCors(req, res);
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const writeEvent = (event: unknown) => {
    res.write(`${JSON.stringify(event)}\n`);
    if (
      event &&
      typeof event === 'object' &&
      'type' in event &&
      event.type === 'contacts-bootstrap' &&
      'data' in event
    ) {
      res.write(
        `${JSON.stringify({ type: 'contacts', contacts: event.data })}\n`
      );
    }
  };
  streamSession.writeEvent = writeEvent;
  const streamEventAccountKey = getStreamEventAccountKey(
    linkedPayload,
    username
  );
  const writePersistedEvent = (event: MessageStreamEvent) => {
    writeEvent(persistStreamEvent(streamEventAccountKey, event));
  };

  writeEvent({ type: 'session', sessionId });
  writeEvent({ type: 'ready', sessionId });
  writeEvent({ type: 'transport-status', status: 'connecting' });
  heartbeat = setInterval(() => {
    writeEvent({ type: 'heartbeat' });
  }, 25_000);

  const aci = typeof body.aci === 'string' ? body.aci : undefined;
  const number = typeof body.number === 'string' ? body.number : undefined;
  if (aci || number) {
    writeEvent({
      type: 'contacts-bootstrap',
      data: {
        version: 1,
        generatedAt: now(),
        account: {
          aci,
          phoneNumber: number,
          title: number,
        },
        selectedConversationId: aci ?? 'note-to-self',
        storyDistributionLists: [
          {
            id: MY_STORY_ID,
            name: '我的动态',
            allowsReplies: true,
            isBlockList: true,
            memberServiceIds: [],
          },
        ],
        pinned: [],
        conversations: [],
        archived: [],
      },
    });
  }
  replayPersistedStreamEvents(streamEventAccountKey, writeEvent);

  try {
    const { Net } = await getSignalModules();
    const net = createNet(Net);
    connection = await net.connectAuthenticatedChat(
      username,
      password,
      false,
      {
        onIncomingMessage(envelope, timestamp, ack) {
          streamSession.incomingEnvelopeCount += 1;
          streamSession.updatedAt = now();
          let didAck = false;
          const sendAck = (statusCode: number) => {
            if (didAck) {
              return;
            }
            didAck = true;
            ack.send(statusCode);
          };
          const previousReceive =
            streamSession.receiveChain ?? Promise.resolve();
          const currentReceive = previousReceive
            .catch(() => undefined)
            .then(async () => {
              const writePersistedEnvelopeEvent = (
                event: MessageStreamEvent
              ) => {
                const persistedEvent = persistStreamEvent(
                  streamEventAccountKey,
                  event
                );
                writeEvent(persistedEvent);
              };
              const activeLinkedPayload = streamSession.linkedPayload;
              if (!activeLinkedPayload) {
                streamSession.lastReceiveError =
                  'decryptIncomingSignalEnvelope: missing linked payload';
                writeEvent({
                  type: 'error',
                  error: streamSession.lastReceiveError,
                  timestamp,
                  envelopeSize: envelope.byteLength,
                });
                sendAck(500);
                return;
              }
              await decryptIncomingSignalEnvelope({
                chat: connection,
                envelopeBytes: envelope,
                getDirectSendAuth: async serviceId => {
                  const conversation =
                    streamSession.conversationLookup?.[serviceId];
                  const accessKey = conversation
                    ? getDirectSendAccessKey(conversation)
                    : undefined;
                  return {
                    accessKey,
                    unauthChat: accessKey
                      ? await getBackupUnauthConnection(streamSession)
                      : undefined,
                  };
                },
                linkedPayload: activeLinkedPayload,
              })
                .then(
                  async ({
                    contentSummary,
                    ignoredReason,
                    message,
                    pinMessage,
                    reaction,
                    editMessage,
                    deleteMessage,
                    unpinMessage,
                    attachmentBackfill,
                    receipt,
                    typing,
                    pollVote,
                    pollTerminate,
                    retryRequest,
                    storageManifestFetchLatest,
                  }) => {
                    streamSession.lastReceiveError = undefined;
                    streamSession.updatedAt = now();
                    emitProtocolState(streamSession);
                    if (retryRequest) {
                      streamSession.retryRequestCount =
                        (streamSession.retryRequestCount ?? 0) + 1;
                      if (retryRequest.resent) {
                        streamSession.retryRequestResentCount =
                          (streamSession.retryRequestResentCount ?? 0) + 1;
                      }
                      streamSession.lastRetryRequestSummary = retryRequest;
                      streamSession.lastRetryRequestError = retryRequest.error;
                      emitProtocolState(streamSession);
                    }
                    let conversation: WebConversation | undefined;
                    let outputMessage = message;
                    if (message?.groupV2 && connection) {
                      try {
                        conversation = await enrichConversationForGroupMessage({
                          connection,
                          linkedPayload: activeLinkedPayload,
                          message,
                        });
                        outputMessage = maybeConvertInitialGroupMessageToChange(
                          {
                            conversation,
                            linkedPayload: activeLinkedPayload,
                            message,
                          }
                        );
                      } catch (error) {
                        console.warn(
                          'message stream failed to enrich group conversation',
                          error
                        );
                      }
                    }
                    if (outputMessage) {
                      streamSession.decodedMessageCount += 1;
                      streamSession.lastDecodedMessageSummary = {
                        id: outputMessage.id,
                        conversationId: outputMessage.conversationId,
                        direction: outputMessage.direction,
                        timestamp: outputMessage.timestamp,
                        bodyLength: outputMessage.body?.length ?? 0,
                        sourceServiceId: outputMessage.sourceServiceId,
                      };
                      if (conversation) {
                        writePersistedEnvelopeEvent({
                          type: 'conversation',
                          conversation,
                        });
                      }
                      writePersistedEnvelopeEvent({
                        type: 'message',
                        message: outputMessage,
                      });
                    }
                    if (pinMessage) {
                      writePersistedEnvelopeEvent(pinMessage);
                    }
                    if (reaction) {
                      writePersistedEnvelopeEvent(reaction);
                    }
                    if (editMessage) {
                      writePersistedEnvelopeEvent(editMessage);
                    }
                    if (deleteMessage) {
                      writePersistedEnvelopeEvent(deleteMessage);
                    }
                    if (unpinMessage) {
                      writePersistedEnvelopeEvent(unpinMessage);
                    }
                    if (attachmentBackfill) {
                      streamSession.attachmentBackfillEventCount =
                        (streamSession.attachmentBackfillEventCount ?? 0) + 1;
                      streamSession.lastAttachmentBackfillSummary = {
                        conversationId: attachmentBackfill.conversationId,
                        targetAuthorAci: attachmentBackfill.targetAuthorAci,
                        targetSentTimestamp:
                          attachmentBackfill.targetSentTimestamp,
                        attachmentCount:
                          attachmentBackfill.attachments?.length ?? 0,
                        attachmentStates: attachmentBackfill.attachments?.map(
                          item => {
                            if ('status' in item) {
                              return { status: item.status };
                            }
                            return {
                              contentType: item.attachment.contentType,
                              cdnId: item.attachment.cdnId,
                              cdnKey: item.attachment.cdnKey,
                              cdnNumber: item.attachment.cdnNumber,
                              size: item.attachment.size,
                              flags: item.attachment.flags,
                            };
                          }
                        ),
                        error: attachmentBackfill.error,
                        timestamp: attachmentBackfill.timestamp,
                      };
                      writePersistedEnvelopeEvent(attachmentBackfill);
                    }
                    if (receipt) {
                      writePersistedEnvelopeEvent(receipt);
                    }
                    if (typing) {
                      writePersistedEnvelopeEvent(typing);
                    }
                    if (pollVote) {
                      writePersistedEnvelopeEvent(pollVote);
                    }
                    if (pollTerminate) {
                      writePersistedEnvelopeEvent(pollTerminate);
                    }
                    if (storageManifestFetchLatest && connection) {
                      void syncStorageContacts({
                        allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
                        chat: connection,
                        cdnUrl: getDefaultCdnUrl(),
                        linkedPayload: activeLinkedPayload,
                        storageUrl: productionConfig.storageUrl,
                      })
                        .then(syncResult => {
                          streamSession.updatedAt = now();
                          mergeStreamConversations(streamSession, [
                            ...syncResult.contactsBootstrap.conversations,
                            ...syncResult.contactsBootstrap.archived,
                            ...syncResult.contactsBootstrap.pinned,
                          ]);
                          writePersistedEvent({
                            type: 'contacts-bootstrap',
                            data: syncResult.contactsBootstrap,
                          });
                          void kickOffProfileFetches({
                            streamSession,
                            syncResult,
                            writeEvent: writePersistedEvent,
                          });
                        })
                        .catch(error => {
                          streamSession.lastReceiveError =
                            errorToLogString(error);
                          streamSession.updatedAt = now();
                          writeEvent({
                            type: 'error',
                            error: streamSession.lastReceiveError,
                            timestamp,
                            envelopeSize: envelope.byteLength,
                          });
                        });
                    }
                    const hasModifierEvent = Boolean(
                      pinMessage ||
                      reaction ||
                      editMessage ||
                      deleteMessage ||
                      unpinMessage ||
                      attachmentBackfill ||
                      receipt ||
                      typing ||
                      pollVote ||
                      pollTerminate ||
                      retryRequest ||
                      storageManifestFetchLatest
                    );
                    if (!message && !hasModifierEvent) {
                      streamSession.ignoredEnvelopeCount += 1;
                      streamSession.lastIgnoredEnvelopeReason =
                        ignoredReason ??
                        'Decrypted content did not contain a supported message, edit, delete, pin, reaction, receipt, typing, or sent sync message';
                      streamSession.lastIgnoredContentSummary = contentSummary;
                    } else {
                      streamSession.decodedMessageCount +=
                        hasModifierEvent && !message ? 1 : 0;
                    }
                    sendAck(200);
                  }
                )
                .catch(async error => {
                  if (
                    LibSignalErrorBase.is(
                      error,
                      LibSignalErrorCode.DuplicatedMessage
                    )
                  ) {
                    streamSession.ignoredEnvelopeCount += 1;
                    streamSession.lastIgnoredEnvelopeReason =
                      errorToLogString(error);
                    streamSession.updatedAt = now();
                    sendAck(200);
                    return;
                  }
                  streamSession.lastReceiveError = errorToLogString(error);
                  streamSession.updatedAt = now();
                  queueDecryptionErrorRetry({
                    activeLinkedPayload,
                    connection,
                    envelope,
                    sendAck,
                    streamSession,
                    timestamp,
                    writeEvent,
                  });
                });
            });
          const nextReceiveChain = currentReceive.finally(() => {
            if (streamSession.receiveChain === nextReceiveChain) {
              streamSession.receiveChain = undefined;
            }
          });
          streamSession.receiveChain = nextReceiveChain;
          void streamSession.receiveChain;
        },
        onQueueEmpty() {
          streamSession.queueEmptyCount += 1;
          streamSession.updatedAt = now();
          writeEvent({ type: 'queue-empty' });
        },
        onReceivedAlerts(alerts) {
          streamSession.receivedAlertCount =
            (streamSession.receivedAlertCount ?? 0) + alerts.length;
          streamSession.lastReceivedAlerts = alerts;
          streamSession.lastReceivedAlertsAt = now();
          streamSession.updatedAt = now();
          console.warn('Message stream received Signal server alerts', alerts);
        },
        onConnectionInterrupted(cause) {
          streamSession.status = cause ? 'error' : 'closed';
          streamSession.error = cause ? String(cause) : undefined;
          streamSession.lastStreamInterruptedAt = now();
          streamSession.lastTransportError = cause ? String(cause) : undefined;
          streamSession.lastTransportStatusAt = now();
          streamSession.transportReconnectHintCount =
            (streamSession.transportReconnectHintCount ?? 0) + 1;
          streamSession.updatedAt = now();
          flushProtocolState(streamSession);
          writeEvent({
            type: 'transport-status',
            status: cause ? 'error' : 'closed',
            error: cause ? String(cause) : undefined,
          });
          streamSession.closeStream?.();
        },
      },
      {
        abortSignal: abortController.signal,
        languages: ['zh-CN', 'en-US'],
      }
    );
    streamSession.connection = connection;
    streamSession.signalKeepalive?.stop();
    streamSession.signalKeepalive = startSignalChatKeepalive({
      connection,
      logId: `WebMessageStream(${sessionId}).authenticatedKeepalive`,
      onFailure: ({ error, responseMs, status }) => {
        if (didCloseStream) {
          return;
        }
        streamSession.signalKeepaliveFailureCount =
          (streamSession.signalKeepaliveFailureCount ?? 0) + 1;
        streamSession.lastSignalKeepaliveError = error;
        streamSession.lastSignalKeepaliveResponseMs = responseMs;
        streamSession.lastSignalKeepaliveStatus = status;
        streamSession.lastTransportError = error;
        streamSession.lastTransportStatusAt = now();
        streamSession.status = 'error';
        streamSession.transportReconnectHintCount =
          (streamSession.transportReconnectHintCount ?? 0) + 1;
        streamSession.updatedAt = now();
        flushProtocolState(streamSession);
        if (!res.destroyed && !res.writableEnded) {
          writeEvent({
            type: 'transport-status',
            status: 'error',
            error,
          });
        }
        void connection?.disconnect().catch(() => undefined);
        streamSession.closeStream?.();
      },
      onSuccess: ({ responseMs, status, timestamp }) => {
        streamSession.signalKeepaliveCount =
          (streamSession.signalKeepaliveCount ?? 0) + 1;
        streamSession.lastSignalKeepaliveAt = timestamp;
        streamSession.lastSignalKeepaliveError = undefined;
        streamSession.lastSignalKeepaliveResponseMs = responseMs;
        streamSession.lastSignalKeepaliveStatus = status;
        streamSession.updatedAt = now();
      },
    });
    streamSession.status = 'open';
    streamSession.lastStreamOpenedAt = now();
    streamSession.lastTransportStatusAt = now();
    streamSession.streamOpenCount = (streamSession.streamOpenCount ?? 0) + 1;
    streamSession.updatedAt = now();
    writeEvent({ type: 'transport-status', status: 'open' });
    void registerLinkedDeviceCapabilities(connection).catch(error => {
      console.warn(
        'handleMessageStream: failed to register linked device capabilities',
        errorToLogString(error)
      );
    });
    if (linkedPayload) {
      void maybeUpdateWebPreKeys({
        chat: connection,
        linkedPayload,
      })
        .then(updated => {
          if (updated) {
            emitProtocolState(streamSession);
          }
        })
        .catch(error => {
          console.warn(
            'handleMessageStream: failed to update web prekeys',
            errorToLogString(error)
          );
        });
    }
    if (importBackup) {
      const readyConnection = connection;
      void limitBackupImport(() =>
        importBackupForMessageStream({
          abortSignal: abortController.signal,
          chat: readyConnection,
          cooldownKey: streamAci ?? username,
          linkedPayload,
          streamSession,
          writeEvent,
        })
      );
    } else {
      streamSession.backupImportStatus = 'skipped';
      streamSession.backupImportError = undefined;
      streamSession.updatedAt = now();
      writeEvent({ type: 'backup-import-status', status: 'skipped' });
    }
  } catch (error) {
    streamSession.status = 'error';
    streamSession.error =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    streamSession.updatedAt = now();
    writeEvent({
      type: 'transport-status',
      status: 'error',
      error: streamSession.error,
    });
    streamSession.closeStream?.();
    throw error;
  }

  const closeStream = () => {
    streamSession.closeStream?.();
  };
  req.on('aborted', closeStream);
  req.on('close', closeStream);
  res.on('close', closeStream);
  res.on('error', closeStream);
}

async function handleMessageStreamAck(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const eventId = typeof body.eventId === 'string' ? body.eventId : undefined;
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const aci = typeof body.aci === 'string' ? body.aci : undefined;
  if (!eventId) {
    sendText(req, res, 400, 'Missing eventId');
    return;
  }

  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  const accountKey = streamSession
    ? getStreamEventAccountKey(
        streamSession.linkedPayload,
        streamSession.username
      )
    : aci;
  if (!accountKey) {
    sendText(req, res, 400, 'Missing account key');
    return;
  }

  acknowledgePersistedStreamEvent(accountKey, eventId);
  sendJson(req, res, 200, { ok: true });
}

async function handleNetworkChange(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  libsignalNetInstance?.onNetworkChange();

  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (streamSession) {
    streamSession.status = 'closed';
    streamSession.lastTransportStatusAt = now();
    streamSession.transportReconnectHintCount =
      (streamSession.transportReconnectHintCount ?? 0) + 1;
    streamSession.updatedAt = now();
    flushProtocolState(streamSession);
    streamSession.writeEvent?.({
      type: 'transport-status',
      status: 'closed',
    });
    streamSession.closeStream?.();
  }

  sendJson(req, res, 200, {
    ok: true,
    closedStreamSession: Boolean(streamSession),
  });
}

async function handleSendMessage(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const destinationServiceId =
    typeof body.destinationServiceId === 'string'
      ? body.destinationServiceId
      : undefined;
  const accessKey = normalizeDirectAccessKey(body.accessKey);
  const messageBody = typeof body.body === 'string' ? body.body : undefined;
  const attachments = parseWebAttachments(body.attachments);
  const deleteForEveryone = parseWebDeleteForEveryone(body.deleteForEveryone);
  const pinMessage = parseWebPinMessage(body.pinMessage);
  const unpinMessage = parseWebUnpinMessage(body.unpinMessage);
  const quote = parseWebQuote(body.quote);
  const isViewOnce = body.isViewOnce === true;
  const timestamp = typeof body.timestamp === 'number' ? body.timestamp : now();
  streamSession.sendAttemptCount += 1;
  streamSession.lastSendAttemptAt = now();
  streamSession.updatedAt = now();
  if (!destinationServiceId) {
    sendText(req, res, 400, 'Missing destinationServiceId');
    return;
  }
  const checkedDestinationServiceId = destinationServiceId;
  if (body.unpinMessage !== undefined && !unpinMessage) {
    sendJson(req, res, 400, {
      error: 'Invalid unpinMessage',
      receivedKeys: Object.keys(body),
    });
    return;
  }
  if (
    !messageBody?.trim() &&
    attachments.length === 0 &&
    !pinMessage &&
    !unpinMessage &&
    !deleteForEveryone
  ) {
    sendText(req, res, 400, 'Missing body');
    return;
  }

  try {
    await runSessionOperation(
      streamSession,
      'handleSendMessage',
      async () => {
        assertSendAllowed(streamSession);
        const resolvedAttachments = await resolveInlineAttachments({
          attachments,
          streamSession,
        });
        const message = await sendDirectTextMessage({
          accessKey,
          attachments: resolvedAttachments,
          body: messageBody ?? '',
          chat: streamSession.connection,
          deleteForEveryone,
          destinationServiceId: checkedDestinationServiceId,
          isViewOnce,
          linkedPayload: streamSession.linkedPayload,
          pinMessage,
          quote,
          timestamp,
          unauthChat: accessKey
            ? await getBackupUnauthConnection(streamSession)
            : undefined,
          unpinMessage,
        });
        rememberSendSuccess(streamSession);
        streamSession.updatedAt = now();
        emitProtocolState(streamSession, { immediate: true });
        sendJson(req, res, 200, message);
      },
      `direct:${checkedDestinationServiceId}`
    );
  } catch (error) {
    rememberSendFailure(streamSession, error);
    streamSession.lastSendError = errorToLogString(error);
    streamSession.updatedAt = now();
    throw error;
  }
}

async function handleSubmitMessageChallenge(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const type = typeof body.type === 'string' ? body.type : undefined;
  const token = typeof body.token === 'string' ? body.token : undefined;
  const captcha = typeof body.captcha === 'string' ? body.captcha : undefined;
  if (type !== 'captcha') {
    sendText(req, res, 400, 'Missing type');
    return;
  }
  if (!token) {
    sendText(req, res, 400, 'Missing token');
    return;
  }
  if (!captcha) {
    sendText(req, res, 400, 'Missing captcha');
    return;
  }

  await runSessionOperation(
    streamSession,
    'handleSubmitMessageChallenge',
    async () => {
      const response = await streamSession.connection.fetch({
        verb: 'PUT',
        path: '/v1/challenge',
        headers: [['content-type', 'application/json']],
        body: Buffer.from(JSON.stringify({ type, token, captcha }), 'utf8'),
        timeoutMillis: 30_000,
      });
      if (response.status < 200 || response.status >= 300) {
        const responseBody = Buffer.from(
          response.body ?? new Uint8Array()
        ).toString('utf8');
        throw Object.assign(
          new Error(
            responseBody
              ? `challenge failed with status ${response.status}: ${responseBody}`
              : `challenge failed with status ${response.status}`
          ),
          { status: response.status }
        );
      }
      rememberSendSuccess(streamSession);
      streamSession.updatedAt = now();
      sendJson(req, res, 200, { ok: true });
    },
    'account:challenge'
  );
}

async function handleSendExpirationTimer(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const destinationServiceId =
    typeof body.destinationServiceId === 'string'
      ? body.destinationServiceId
      : undefined;
  const accessKey = normalizeDirectAccessKey(body.accessKey);
  const expireTimer =
    typeof body.expireTimer === 'number' && body.expireTimer > 0
      ? body.expireTimer
      : undefined;
  const expireTimerVersion =
    typeof body.expireTimerVersion === 'number'
      ? body.expireTimerVersion
      : undefined;
  const timestamp = typeof body.timestamp === 'number' ? body.timestamp : now();

  streamSession.sendAttemptCount += 1;
  streamSession.lastSendAttemptAt = now();
  streamSession.updatedAt = now();

  if (!destinationServiceId) {
    sendText(req, res, 400, 'Missing destinationServiceId');
    return;
  }
  if (expireTimerVersion == null) {
    sendText(req, res, 400, 'Missing expireTimerVersion');
    return;
  }

  try {
    await runSessionOperation(
      streamSession,
      'handleSendExpirationTimer',
      async () => {
        assertSendAllowed(streamSession);
        const message = await sendDirectExpirationTimerUpdate({
          accessKey,
          chat: streamSession.connection,
          destinationServiceId,
          expireTimer,
          expireTimerVersion,
          linkedPayload: streamSession.linkedPayload,
          timestamp,
          unauthChat: accessKey
            ? await getBackupUnauthConnection(streamSession)
            : undefined,
        });
        rememberSendSuccess(streamSession);
        streamSession.updatedAt = now();
        emitProtocolState(streamSession, { immediate: true });
        sendJson(req, res, 200, message);
      },
      `direct:${destinationServiceId}`
    );
  } catch (error) {
    rememberSendFailure(streamSession, error);
    streamSession.lastSendError = errorToLogString(error);
    streamSession.updatedAt = now();
    throw error;
  }
}

async function getAttachmentUploadForm(
  chat: AuthenticatedChatConnection,
  uploadSize: number
): Promise<AttachmentUploadForm> {
  const raw = await chat.getUploadForm({
    uploadSize: BigInt(uploadSize),
  });

  return {
    cdn: raw.cdn,
    key: raw.key,
    headers: Object.fromEntries(raw.headers.entries()),
    signedUploadLocation: raw.signedUploadUrl.toString(),
  };
}

async function putEncryptedAttachmentStream(
  encryptedStream: Readable,
  encryptedSize: number,
  uploadForm: AttachmentUploadForm
): Promise<void> {
  if (uploadForm.cdn === 3) {
    let caughtTusError: Error | undefined;
    const done = await _tusCreateWithUploadRequest({
      endpoint: uploadForm.signedUploadLocation,
      headers: uploadForm.headers,
      fileName: uploadForm.key,
      fileSize: encryptedSize,
      readable: encryptedStream,
      onCaughtError(error) {
        caughtTusError = error;
      },
      ...(ALLOW_INSECURE_CDN_TLS
        ? {
            fetchFn: insecureNodeFetch,
          }
        : null),
    });
    if (!done) {
      throw new Error('putEncryptedAttachmentStream TUS upload interrupted', {
        cause: caughtTusError,
      });
    }
    return;
  }

  const createResponse = await fetch(uploadForm.signedUploadLocation, {
    method: 'POST',
    headers: uploadForm.headers,
  });
  if (!createResponse.ok) {
    throw new Error(
      `putEncryptedAttachment create failed with status ${createResponse.status}: ${await createResponse.text()}`
    );
  }

  const uploadLocation = createResponse.headers.get('location');
  if (!uploadLocation) {
    throw new Error('putEncryptedAttachment create response missing location');
  }

  const putResponse = await fetch(uploadLocation, {
    method: 'PUT',
    headers: {
      'Content-Range': `bytes 0-*/${encryptedSize}`,
    },
    // oxlint-disable-next-line typescript/no-explicit-any
    body: encryptedStream as any,
    // @ts-expect-error Node fetch requires duplex for streaming request bodies.
    duplex: 'half',
  });
  if (!putResponse.ok) {
    throw new Error(
      `putEncryptedAttachment upload failed with status ${putResponse.status}: ${await putResponse.text()}`
    );
  }
}

async function handleUploadAttachment(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  let attachment: WebAttachment;
  let sessionId: string | undefined;

  if (isJsonRequest(req)) {
    const body = await readJson(req);
    const dataBase64 = getOptionalString(body.dataBase64);
    const contentType =
      getOptionalString(body.contentType) ?? 'application/octet-stream';
    const fileName = getOptionalString(body.fileName);
    const declaredSize = getOptionalNumber(body.size);
    sessionId = getOptionalString(body.sessionId);
    if (!sessionId) {
      sendText(req, res, 400, 'Missing sessionId');
      return;
    }
    const streamSession = streamSessions.get(sessionId);

    if (!streamSession?.connection) {
      sendText(req, res, 404, 'Message runtime session not found');
      return;
    }
    if (!dataBase64) {
      sendText(req, res, 400, 'Missing dataBase64');
      return;
    }

    const plaintext = Buffer.from(dataBase64, 'base64');
    if (declaredSize != null && declaredSize !== plaintext.byteLength) {
      sendText(req, res, 400, 'Attachment size does not match dataBase64');
      return;
    }

    attachment = await limitAttachmentUpload(() =>
      uploadAttachmentBytes({
        contentType,
        fileName,
        plaintext: { data: new Uint8Array(plaintext) },
        plaintextSize: plaintext.byteLength,
        streamSession,
      })
    );
    sendJson(req, res, 200, attachment);
    return;
  }

  const contentType =
    getOptionalString(url.searchParams.get('contentType')) ??
    'application/octet-stream';
  const fileName = getOptionalString(url.searchParams.get('fileName'));
  const declaredSize = getRequiredQueryNumber(url, 'size');
  sessionId = getOptionalString(url.searchParams.get('sessionId'));
  if (!sessionId) {
    sendText(req, res, 400, 'Missing sessionId');
    return;
  }
  if (declaredSize == null) {
    sendText(req, res, 400, 'Missing size');
    return;
  }
  const streamSession = streamSessions.get(sessionId);

  if (!streamSession?.connection) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  attachment = await limitAttachmentUpload(() =>
    uploadAttachmentBytes({
      contentType,
      fileName,
      plaintext: {
        stream: createSizeCheckedStream(req, declaredSize),
        size: declaredSize,
      },
      plaintextSize: declaredSize,
      streamSession,
    })
  );
  sendJson(req, res, 200, attachment);
}

async function uploadAttachmentBytes({
  attachment,
  contentType,
  fileName,
  plaintext,
  plaintextSize,
  streamSession,
}: Readonly<{
  attachment?: WebAttachment;
  contentType: string;
  fileName?: string;
  plaintext: PlaintextSourceType;
  plaintextSize: number;
  streamSession: MessageStreamSession;
}>): Promise<WebAttachment> {
  const { connection } = streamSession;
  if (!connection) {
    throw new Error('Message runtime session not found');
  }
  const keys = randomBytes(64);
  const ciphertextSize = getAttachmentCiphertextSize({
    mediaTier: MediaTier.STANDARD,
    unpaddedPlaintextSize: plaintextSize,
  });
  const uploadForm = await getAttachmentUploadForm(connection, ciphertextSize);
  const encryptedStream = new PassThrough();
  const uploadPromise = putEncryptedAttachmentStream(
    encryptedStream,
    ciphertextSize,
    uploadForm
  );

  let encrypted;
  try {
    encrypted = await encryptAttachmentV2({
      keys,
      needIncrementalMac: supportsIncrementalMac(contentType as MIMEType),
      plaintext,
      sink: encryptedStream,
    });
  } catch (error) {
    encryptedStream.destroy(error instanceof Error ? error : undefined);
    await uploadPromise.catch(() => undefined);
    throw error;
  }

  await uploadPromise;

  return {
    ...attachment,
    id: attachment?.id ?? randomUUID(),
    dataBase64: undefined,
    path: undefined,
    url: undefined,
    cdnKey: uploadForm.key,
    cdnNumber: uploadForm.cdn,
    keyBase64: Bytes.toBase64(keys),
    digestBase64: Bytes.toBase64(encrypted.digest),
    incrementalMacBase64: encrypted.incrementalMac
      ? Bytes.toBase64(encrypted.incrementalMac)
      : undefined,
    chunkSize: encrypted.chunkSize,
    size: attachment?.size ?? plaintextSize,
    contentType,
    fileName,
    status: 'ready',
  };
}

async function resolveInlineAttachments({
  attachments,
  streamSession,
}: Readonly<{
  attachments: ReadonlyArray<WebAttachment>;
  streamSession: MessageStreamSession;
}>): Promise<ReadonlyArray<WebAttachment>> {
  return Promise.all(
    attachments.map(async attachment => {
      const [thumbnail] = await resolveInlineAttachments({
        attachments: attachment.thumbnail ? [attachment.thumbnail] : [],
        streamSession,
      });
      const attachmentWithThumbnail = thumbnail
        ? {
            ...attachment,
            thumbnail,
          }
        : attachment;
      if (!attachmentWithThumbnail.dataBase64) {
        return attachmentWithThumbnail;
      }
      const plaintext = Buffer.from(
        attachmentWithThumbnail.dataBase64,
        'base64'
      );
      if (
        attachmentWithThumbnail.size != null &&
        attachmentWithThumbnail.size !== plaintext.byteLength
      ) {
        throw new Error('Inline attachment size does not match dataBase64');
      }
      return limitAttachmentUpload(() =>
        uploadAttachmentBytes({
          attachment: attachmentWithThumbnail,
          contentType:
            attachmentWithThumbnail.contentType ?? 'application/octet-stream',
          fileName: attachmentWithThumbnail.fileName,
          plaintext: { data: new Uint8Array(plaintext) },
          plaintextSize: plaintext.byteLength,
          streamSession,
        })
      );
    })
  );
}

function getStreamSessionForProvisioningSession(
  session: ProvisioningSession
): MessageStreamSession | undefined {
  const sessionAci =
    session.linkedPayload?.credentials.aci ??
    session.linkedPayload?.account.aci;
  const sessionUsername = session.linkedPayload?.credentials.username;
  return [...streamSessions.values()]
    .filter(streamSession => {
      if (streamSession.status !== 'open' || !streamSession.connection) {
        return false;
      }
      const streamAci =
        streamSession.linkedPayload?.credentials.aci ??
        streamSession.linkedPayload?.account.aci;
      return (
        (sessionUsername != null &&
          streamSession.username === sessionUsername) ||
        (sessionAci != null && streamAci === sessionAci)
      );
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

async function handleImportTransfer(
  req: IncomingMessage,
  res: ServerResponse,
  session: ProvisioningSession
): Promise<void> {
  const streamSession = getStreamSessionForProvisioningSession(session);
  if (!streamSession?.connection) {
    sendText(req, res, 409, 'Message runtime session is not connected');
    return;
  }
  if (!streamSession.linkedPayload) {
    sendText(req, res, 409, 'Linked session is not ready');
    return;
  }

  await importBackupForMessageStream({
    abortSignal: new AbortController().signal,
    chat: streamSession.connection,
    cooldownKey:
      streamSession.linkedPayload.credentials.aci ??
      streamSession.linkedPayload.account.aci ??
      streamSession.username,
    linkedPayload: streamSession.linkedPayload,
    streamSession,
    writeEvent:
      streamSession.writeEvent ??
      (() => {
        return undefined;
      }),
  });

  if (streamSession.linkedPayload) {
    session.linkedPayload = streamSession.linkedPayload;
    touch(session);
  }

  sendJson(req, res, 200, {
    sessionId: session.sessionId,
    messageStreamSessionStatus: streamSession.status,
    backupImportStatus: streamSession.backupImportStatus,
    backupImportError: streamSession.backupImportError,
    backupImportStats: streamSession.backupImportStats,
    hasMediaRootBackupKey: Boolean(
      streamSession.linkedPayload?.mediaRootBackupKeyBase64
    ),
  });
}

async function runImportTransferForStreamSession(
  streamSession: MessageStreamSession
): Promise<void> {
  if (!streamSession.connection) {
    throw new Error('Message runtime session is not connected');
  }
  if (!streamSession.linkedPayload) {
    throw new Error('Linked session is not ready');
  }

  await importBackupForMessageStream({
    abortSignal: new AbortController().signal,
    chat: streamSession.connection,
    cooldownKey:
      streamSession.linkedPayload.credentials.aci ??
      streamSession.linkedPayload.account.aci ??
      streamSession.username,
    linkedPayload: streamSession.linkedPayload,
    streamSession,
    writeEvent:
      streamSession.writeEvent ??
      (() => {
        return undefined;
      }),
  });
}

async function handleMessageImportTransfer(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = await waitForAttachmentStreamSession(sessionId ?? null);
  if (!streamSession) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  try {
    await limitBackupImport(() =>
      runImportTransferForStreamSession(streamSession)
    );
  } catch (error) {
    sendText(
      req,
      res,
      409,
      error instanceof Error ? error.message : String(error)
    );
    return;
  }

  sendJson(req, res, 200, {
    status: streamSession.status,
    backupImportStatus: streamSession.backupImportStatus,
    backupImportError: streamSession.backupImportError,
    backupImportStats: streamSession.backupImportStats,
    hasMediaRootBackupKey: Boolean(
      streamSession.linkedPayload?.mediaRootBackupKeyBase64
    ),
  });
}

async function handleSendReaction(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const destinationServiceId =
    typeof body.destinationServiceId === 'string'
      ? body.destinationServiceId
      : undefined;
  const accessKey = normalizeDirectAccessKey(body.accessKey);
  const groupId = typeof body.groupId === 'string' ? body.groupId : undefined;
  const rawGroupV2 =
    body.groupV2 && typeof body.groupV2 === 'object'
      ? (body.groupV2 as { masterKey?: unknown; revision?: unknown })
      : undefined;
  const groupV2 =
    rawGroupV2 &&
    typeof rawGroupV2.masterKey === 'string' &&
    typeof rawGroupV2.revision === 'number'
      ? {
          masterKey: rawGroupV2.masterKey,
          revision: rawGroupV2.revision,
        }
      : undefined;
  const groupSendEndorsements = parseWebGroupSendEndorsements(
    body.groupSendEndorsements
  );
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.filter(
        (recipient: unknown): recipient is string =>
          typeof recipient === 'string'
      )
    : [];
  const emoji = typeof body.emoji === 'string' ? body.emoji : undefined;
  const remove = body.remove === true;
  const targetAuthorAci =
    typeof body.targetAuthorAci === 'string' ? body.targetAuthorAci : undefined;
  const targetTimestamp =
    typeof body.targetTimestamp === 'number' ? body.targetTimestamp : undefined;
  const timestamp = typeof body.timestamp === 'number' ? body.timestamp : now();
  streamSession.sendAttemptCount += 1;
  streamSession.lastSendAttemptAt = now();
  streamSession.updatedAt = now();

  if (!destinationServiceId && !groupId) {
    sendText(req, res, 400, 'Missing destinationServiceId or groupId');
    return;
  }
  if (groupId && !groupV2) {
    sendText(req, res, 400, 'Missing groupV2');
    return;
  }
  if (groupId && recipients.length === 0) {
    sendText(req, res, 400, 'Missing recipients');
    return;
  }
  if (!targetAuthorAci) {
    sendText(req, res, 400, 'Missing targetAuthorAci');
    return;
  }
  if (typeof targetTimestamp !== 'number') {
    sendText(req, res, 400, 'Missing targetTimestamp');
    return;
  }
  if (!remove && typeof emoji !== 'string') {
    sendText(req, res, 400, 'Missing emoji');
    return;
  }

  try {
    await runSessionOperation(
      streamSession,
      'handleSendReaction',
      async () => {
        assertSendAllowed(streamSession);
        if (groupId && groupV2) {
          const unauthChat = groupSendEndorsements
            ? await getBackupUnauthConnection(streamSession)
            : undefined;
          await sendGroupReaction({
            chat: streamSession.connection,
            emoji,
            groupId,
            groupV2,
            groupSendEndorsements,
            linkedPayload: streamSession.linkedPayload,
            recipients,
            remove,
            targetAuthorAci,
            targetTimestamp,
            timestamp,
            unauthChat,
          });
        } else if (destinationServiceId) {
          await sendDirectReaction({
            accessKey,
            chat: streamSession.connection,
            destinationServiceId,
            emoji,
            linkedPayload: streamSession.linkedPayload,
            remove,
            targetAuthorAci,
            targetTimestamp,
            timestamp,
            unauthChat: accessKey
              ? await getBackupUnauthConnection(streamSession)
              : undefined,
          });
        }
        rememberSendSuccess(streamSession);
        streamSession.updatedAt = now();
        emitProtocolState(streamSession, { immediate: true });
        sendJson(req, res, 200, { ok: true, timestamp });
      },
      groupId ? `group:${groupId}` : `direct:${destinationServiceId}`
    );
  } catch (error) {
    rememberSendFailure(streamSession, error);
    streamSession.lastSendError = errorToLogString(error);
    streamSession.updatedAt = now();
    throw error;
  }
}

async function handleLookupUsername(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const username =
    typeof body.username === 'string' ? body.username.trim() : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!streamSession?.linkedPayload) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }
  if (!username) {
    sendText(req, res, 400, 'Missing username');
    return;
  }

  const normalizedUsername = username.startsWith('@')
    ? username.slice(1)
    : username;
  const connection = await getBackupUnauthConnection(streamSession);
  const aci = await connection.lookUpUsernameHash({
    hash: usernames.hash(normalizedUsername),
  });

  sendJson(req, res, 200, {
    aci: aci ? fromAciObject(aci) : null,
    username: normalizedUsername,
  });
}

async function fetchCdsiAuth(
  streamSession: MessageStreamSession
): Promise<ServiceAuth> {
  if (!streamSession.connection) {
    throw new Error(
      'fetchCdsiAuth: message stream session is missing connection'
    );
  }

  if (
    streamSession.cdsiAuth &&
    now() - streamSession.cdsiAuth.timestamp < CACHED_CDSI_AUTH_TTL_MS
  ) {
    return streamSession.cdsiAuth.auth;
  }

  const response = await streamSession.connection.fetch({
    verb: 'GET',
    path: '/v2/directory/auth',
    headers: [],
    timeoutMillis: 30_000,
  });
  const responseBody = Buffer.from(response.body ?? new Uint8Array()).toString(
    'utf8'
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      responseBody
        ? `directoryAuthV2 failed with status ${response.status}: ${responseBody}`
        : `directoryAuthV2 failed with status ${response.status}`
    );
  }

  const auth = JSON.parse(responseBody) as Partial<ServiceAuth>;
  if (typeof auth.username !== 'string' || typeof auth.password !== 'string') {
    throw new Error('directoryAuthV2 response is missing username or password');
  }

  streamSession.cdsiAuth = {
    timestamp: now(),
    auth: {
      username: auth.username,
      password: auth.password,
    },
  };
  return streamSession.cdsiAuth.auth;
}

async function cdsiLookupWithTimeout(
  net: ReturnType<typeof createNet>,
  auth: ServiceAuth,
  options: Readonly<{
    acisAndAccessKeys: ReadonlyArray<{ aci: string; accessKey: string }>;
    e164s: ReadonlyArray<string>;
  }>
) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, CDSI_LOOKUP_TIMEOUT_MS);
  try {
    return await net.cdsiLookup(auth, {
      ...options,
      abortSignal: abortController.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function handleLookupPhoneNumbers(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }
  const e164s = Array.isArray(body.e164s)
    ? body.e164s.filter(
        (value: unknown): value is string => typeof value === 'string'
      )
    : [];
  const acisAndAccessKeys = Array.isArray(body.acisAndAccessKeys)
    ? body.acisAndAccessKeys
        .map((value: unknown) => {
          const record =
            value && typeof value === 'object'
              ? (value as Record<string, unknown>)
              : undefined;
          if (
            record &&
            typeof record.aci === 'string' &&
            typeof record.accessKey === 'string'
          ) {
            return {
              aci: record.aci,
              accessKey: record.accessKey,
            };
          }
          return undefined;
        })
        .filter(
          (value): value is { aci: string; accessKey: string } => value != null
        )
    : [];
  if (e164s.length === 0) {
    sendText(req, res, 400, 'Missing e164s');
    return;
  }

  const { Net } = await getSignalModules();
  const net = createNet(Net);
  const auth = await fetchCdsiAuth(streamSession);
  const result = await cdsiLookupWithTimeout(net, auth, {
    e164s,
    acisAndAccessKeys,
  });

  sendJson(req, res, 200, {
    debugPermitsUsed: result.debugPermitsUsed,
    entries: Array.from(result.entries.entries()),
  });
}

async function handleAttachmentBackfillRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const conversationId =
    typeof body.conversationId === 'string' ? body.conversationId : undefined;
  const conversationType =
    body.conversationType === 'group' || body.conversationType === 'direct'
      ? body.conversationType
      : undefined;
  const targetAuthorAci =
    typeof body.targetAuthorAci === 'string' ? body.targetAuthorAci : undefined;
  const targetSentTimestamp =
    typeof body.targetSentTimestamp === 'number'
      ? body.targetSentTimestamp
      : undefined;
  const timestamp = typeof body.timestamp === 'number' ? body.timestamp : now();

  if (!conversationId) {
    sendText(req, res, 400, 'Missing conversationId');
    return;
  }
  if (!conversationType) {
    sendText(req, res, 400, 'Missing conversationType');
    return;
  }
  if (!targetAuthorAci) {
    sendText(req, res, 400, 'Missing targetAuthorAci');
    return;
  }
  if (typeof targetSentTimestamp !== 'number') {
    sendText(req, res, 400, 'Missing targetSentTimestamp');
    return;
  }

  try {
    await runSessionOperation(
      streamSession,
      'handleAttachmentBackfillRequest',
      async () => {
        assertSendAllowed(streamSession);
        const result = await sendAttachmentBackfillRequestSync({
          chat: streamSession.connection,
          conversationId,
          conversationType,
          linkedPayload: streamSession.linkedPayload,
          targetAuthorAci,
          targetSentTimestamp,
          timestamp,
        });
        rememberSendSuccess(streamSession);
        streamSession.updatedAt = now();
        emitProtocolState(streamSession, { immediate: true });
        sendJson(req, res, 200, result);
      },
      `${conversationType}:${conversationId}`
    );
  } catch (error) {
    rememberSendFailure(streamSession, error);
    streamSession.lastSendError = errorToLogString(error);
    streamSession.updatedAt = now();
    throw error;
  }
}

async function handleSendEdit(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const destinationServiceId =
    typeof body.destinationServiceId === 'string'
      ? body.destinationServiceId
      : undefined;
  const accessKey = normalizeDirectAccessKey(body.accessKey);
  const messageBody = typeof body.body === 'string' ? body.body : undefined;
  const targetTimestamp =
    typeof body.targetTimestamp === 'number' ? body.targetTimestamp : undefined;
  const timestamp = typeof body.timestamp === 'number' ? body.timestamp : now();
  streamSession.sendAttemptCount += 1;
  streamSession.lastSendAttemptAt = now();
  streamSession.updatedAt = now();

  if (!destinationServiceId) {
    sendText(req, res, 400, 'Missing destinationServiceId');
    return;
  }
  if (!messageBody?.trim()) {
    sendText(req, res, 400, 'Missing body');
    return;
  }
  if (typeof targetTimestamp !== 'number') {
    sendText(req, res, 400, 'Missing targetTimestamp');
    return;
  }

  try {
    await runSessionOperation(
      streamSession,
      'handleSendEdit',
      async () => {
        assertSendAllowed(streamSession);
        const result = await sendDirectEditMessage({
          accessKey,
          body: messageBody,
          chat: streamSession.connection,
          destinationServiceId,
          linkedPayload: streamSession.linkedPayload,
          targetTimestamp,
          timestamp,
          unauthChat: accessKey
            ? await getBackupUnauthConnection(streamSession)
            : undefined,
        });
        rememberSendSuccess(streamSession);
        streamSession.updatedAt = now();
        emitProtocolState(streamSession, { immediate: true });
        sendJson(req, res, 200, result);
      },
      `direct:${destinationServiceId}`
    );
  } catch (error) {
    rememberSendFailure(streamSession, error);
    streamSession.lastSendError = errorToLogString(error);
    streamSession.updatedAt = now();
    throw error;
  }
}

async function handleSendGroupMessage(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const groupId = typeof body.groupId === 'string' ? body.groupId : undefined;
  const messageBody = typeof body.body === 'string' ? body.body : undefined;
  const attachments = parseWebAttachments(body.attachments);
  const deleteForEveryone = parseWebDeleteForEveryone(body.deleteForEveryone);
  const pinMessage = parseWebPinMessage(body.pinMessage);
  const quote = parseWebQuote(body.quote);
  const unpinMessage = parseWebUnpinMessage(body.unpinMessage);
  const isViewOnce = body.isViewOnce === true;
  const rawGroupV2 =
    body.groupV2 && typeof body.groupV2 === 'object'
      ? (body.groupV2 as { masterKey?: unknown; revision?: unknown })
      : undefined;
  const groupV2 =
    rawGroupV2 &&
    typeof rawGroupV2.masterKey === 'string' &&
    typeof rawGroupV2.revision === 'number'
      ? {
          masterKey: rawGroupV2.masterKey,
          revision: rawGroupV2.revision,
        }
      : undefined;
  const groupSendEndorsements = parseWebGroupSendEndorsements(
    body.groupSendEndorsements
  );
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.filter(
        (recipient: unknown): recipient is string =>
          typeof recipient === 'string'
      )
    : [];
  const timestamp = typeof body.timestamp === 'number' ? body.timestamp : now();
  streamSession.sendAttemptCount += 1;
  streamSession.lastSendAttemptAt = now();
  streamSession.updatedAt = now();

  if (!groupId) {
    sendText(req, res, 400, 'Missing groupId');
    return;
  }
  if (!groupV2) {
    sendText(req, res, 400, 'Missing groupV2');
    return;
  }
  if (
    !messageBody?.trim() &&
    attachments.length === 0 &&
    !deleteForEveryone &&
    !pinMessage &&
    !unpinMessage
  ) {
    sendText(req, res, 400, 'Missing body');
    return;
  }
  if (recipients.length === 0) {
    sendText(req, res, 400, 'Missing recipients');
    return;
  }

  try {
    await runSessionOperation(
      streamSession,
      'handleSendGroupMessage',
      async () => {
        assertSendAllowed(streamSession);
        const resolvedAttachments = await resolveInlineAttachments({
          attachments,
          streamSession,
        });
        const unauthChat = groupSendEndorsements
          ? await getBackupUnauthConnection(streamSession)
          : undefined;
        const message = await sendGroupTextMessage({
          attachments: resolvedAttachments,
          body: messageBody ?? '',
          chat: streamSession.connection,
          deleteForEveryone,
          groupId,
          groupV2,
          groupSendEndorsements,
          isViewOnce,
          linkedPayload: streamSession.linkedPayload,
          pinMessage,
          quote,
          recipients,
          timestamp,
          unpinMessage,
          unauthChat,
        });
        rememberSendSuccess(streamSession);
        streamSession.updatedAt = now();
        emitProtocolState(streamSession, { immediate: true });
        sendJson(req, res, 200, message);
      },
      `group:${groupId}`
    );
  } catch (error) {
    rememberSendFailure(streamSession, error);
    streamSession.lastSendError = errorToLogString(error);
    streamSession.updatedAt = now();
    throw error;
  }
}

function parseWebGroupMemberModifyAction(
  value: unknown
): WebGroupMemberModifyAction | undefined {
  if (
    value === 'add' ||
    value === 'make-admin' ||
    value === 'make-member' ||
    value === 'remove'
  ) {
    return value;
  }
  return undefined;
}

function parseWebGroupSettingsModifyAction(
  value: unknown
): WebGroupSettingsModifyAction | undefined {
  if (
    value === 'access-control-add-from-invite-link' ||
    value === 'access-control-attributes' ||
    value === 'access-control-members' ||
    value === 'access-control-member-label' ||
    value === 'announcements-only' ||
    value === 'description' ||
    value === 'title'
  ) {
    return value;
  }
  return undefined;
}

function parseWebGroupConversation(
  value: unknown
): WebConversation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.masterKey !== 'string' ||
    typeof record.publicParams !== 'string' ||
    typeof record.secretParams !== 'string'
  ) {
    return undefined;
  }
  return record as WebConversation;
}

function parseWebConversation(value: unknown): WebConversation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string') {
    return undefined;
  }
  return record as WebConversation;
}

function parseWebGroupSendEndorsements(
  value: unknown
): WebGroupSendEndorsements | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const combined =
    record.combinedEndorsement &&
    typeof record.combinedEndorsement === 'object' &&
    !Array.isArray(record.combinedEndorsement)
      ? (record.combinedEndorsement as Record<string, unknown>)
      : undefined;
  if (
    !combined ||
    typeof combined.expiration !== 'number' ||
    typeof combined.endorsementBase64 !== 'string' ||
    !Array.isArray(record.memberEndorsements)
  ) {
    return undefined;
  }

  const memberEndorsements = record.memberEndorsements
    .map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return undefined;
      }
      const endorsement = item as Record<string, unknown>;
      if (
        typeof endorsement.memberAci !== 'string' ||
        typeof endorsement.expiration !== 'number' ||
        typeof endorsement.endorsementBase64 !== 'string'
      ) {
        return undefined;
      }
      return {
        memberAci: endorsement.memberAci,
        expiration: endorsement.expiration,
        endorsementBase64: endorsement.endorsementBase64,
      };
    })
    .filter(
      (
        item
      ): item is {
        endorsementBase64: string;
        expiration: number;
        memberAci: string;
      } => item != null
    );

  if (memberEndorsements.length !== record.memberEndorsements.length) {
    return undefined;
  }

  return {
    combinedEndorsement: {
      expiration: combined.expiration,
      endorsementBase64: combined.endorsementBase64,
    },
    memberEndorsements,
  };
}

function parseWebConversationRecord(
  value: unknown
): Record<string, WebConversation> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, WebConversation> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const conversation = parseWebConversation(item);
    if (conversation) {
      result[key] = conversation;
    }
  }
  return result;
}

function getGroupUpdateRecipients(
  conversation: WebConversation,
  linkedPayload: LinkedPayloadWithProtocol
): ReadonlyArray<string> {
  const ourAci = linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
  return Array.from(
    new Set([
      ...(conversation.membersV2 ?? []).map(member => member.aci),
      ...(conversation.pendingMembersV2 ?? []).map(member => member.serviceId),
    ])
  ).filter(recipient => recipient !== ourAci);
}

async function handleCreateGroup(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  const conversationIds = Array.isArray(body.conversationIds)
    ? body.conversationIds.filter(
        (conversationId: unknown): conversationId is string =>
          typeof conversationId === 'string'
      )
    : [];
  const conversations = parseWebConversationRecord(body.conversations);
  const expireTimer =
    typeof body.expireTimer === 'number' ? body.expireTimer : undefined;
  const avatar = typeof body.avatar === 'string' ? body.avatar : undefined;

  if (!name) {
    sendText(req, res, 400, 'Missing name');
    return;
  }
  if (conversationIds.length === 0) {
    sendText(req, res, 400, 'Missing conversationIds');
    return;
  }

  streamSession.sendAttemptCount += 1;
  streamSession.lastSendAttemptAt = now();
  streamSession.updatedAt = now();

  try {
    await runSessionOperation(
      streamSession,
      'handleCreateGroup',
      async () => {
        assertSendAllowed(streamSession);
        const group = await createGroupConversation({
          allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
          avatar,
          cdnUrl: getDefaultCdnUrl(),
          chat: streamSession.connection,
          conversationIds,
          conversations,
          expireTimer,
          linkedPayload: streamSession.linkedPayload,
          name,
          storageUrl: productionConfig.storageUrl,
        });

        const recipients = getGroupUpdateRecipients(
          group,
          streamSession.linkedPayload
        );
        if (group.masterKey && recipients.length > 0) {
          try {
            const unauthChat = group.groupSendEndorsements
              ? await getBackupUnauthConnection(streamSession)
              : undefined;
            await sendGroupUpdateMessage({
              chat: streamSession.connection,
              groupSendEndorsements: group.groupSendEndorsements,
              groupId: String(group.groupId ?? group.id),
              groupV2: {
                masterKey: group.masterKey,
                revision: group.revision ?? 0,
              },
              linkedPayload: streamSession.linkedPayload,
              recipients,
              timestamp: now(),
              unauthChat,
            });
          } catch (error) {
            if (getSendErrorInfo(error)) {
              throw error;
            }
            console.warn(
              'handleCreateGroup: group created, but failed to send group update message',
              errorToLogString(error)
            );
          }
        }

        rememberSendSuccess(streamSession);
        streamSession.updatedAt = now();
        emitProtocolState(streamSession, { immediate: true });
        sendJson(req, res, 200, group);
      },
      `group-create:${conversationIds.join(',')}`
    );
  } catch (error) {
    rememberSendFailure(streamSession, error);
    streamSession.lastSendError = errorToLogString(error);
    streamSession.updatedAt = now();
    throw error;
  }
}

async function handleModifyGroupMember(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const action = parseWebGroupMemberModifyAction(body.action);
  const conversation = parseWebGroupConversation(body.conversation);
  const targetConversation = parseWebConversation(body.targetConversation);
  const targetServiceId =
    typeof body.targetServiceId === 'string' ? body.targetServiceId : undefined;
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.filter(
        (recipient: unknown): recipient is string =>
          typeof recipient === 'string'
      )
    : [];

  if (!action) {
    sendText(req, res, 400, 'Missing action');
    return;
  }
  if (!conversation) {
    sendText(req, res, 400, 'Missing conversation');
    return;
  }
  if (typeof conversation.revision !== 'number') {
    sendText(req, res, 400, 'Missing conversation revision');
    return;
  }
  if (!targetServiceId) {
    sendText(req, res, 400, 'Missing targetServiceId');
    return;
  }
  if (action === 'add' && !targetConversation) {
    sendText(req, res, 400, 'Missing targetConversation');
    return;
  }
  if (recipients.length === 0) {
    sendText(req, res, 400, 'Missing recipients');
    return;
  }
  const { masterKey } = conversation;
  if (!masterKey) {
    sendText(req, res, 400, 'Missing conversation masterKey');
    return;
  }

  streamSession.sendAttemptCount += 1;
  streamSession.lastSendAttemptAt = now();
  streamSession.updatedAt = now();

  try {
    await runSessionOperation(
      streamSession,
      'handleModifyGroupMember',
      async () => {
        assertSendAllowed(streamSession);
        const result = await modifyGroupMember({
          action,
          allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
          chat: streamSession.connection,
          conversation,
          linkedPayload: streamSession.linkedPayload,
          storageUrl: productionConfig.storageUrl,
          targetConversation,
          targetServiceId: targetServiceId as ServiceIdString,
        });
        try {
          const unauthChat = conversation.groupSendEndorsements
            ? await getBackupUnauthConnection(streamSession)
            : undefined;
          await sendGroupUpdateMessage({
            chat: streamSession.connection,
            groupSendEndorsements: conversation.groupSendEndorsements,
            groupChangeBase64: result.groupChangeBase64,
            groupId: String(conversation.groupId ?? conversation.id),
            groupV2: {
              masterKey,
              revision: result.revision,
            },
            linkedPayload: streamSession.linkedPayload,
            recipients,
            timestamp: now(),
            unauthChat,
          });
        } catch (error) {
          if (getSendErrorInfo(error)) {
            throw error;
          }
          console.warn(
            'handleGroupMember: group state updated, but failed to send group update message',
            errorToLogString(error)
          );
        }
        rememberSendSuccess(streamSession);
        streamSession.updatedAt = now();
        emitProtocolState(streamSession, { immediate: true });
        sendJson(req, res, 200, result);
      },
      `group:${conversation.id}`
    );
  } catch (error) {
    if (
      action === 'add' &&
      error instanceof Error &&
      error.message.includes('adding member already in group')
    ) {
      rememberSendSuccess(streamSession);
      streamSession.updatedAt = now();
      sendJson(req, res, 200, {
        groupChangeBase64: '',
        revision: conversation.revision,
      });
      return;
    }
    rememberSendFailure(streamSession, error);
    streamSession.lastSendError = errorToLogString(error);
    streamSession.updatedAt = now();
    throw error;
  }
}

async function handleModifyGroupSettings(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const action = parseWebGroupSettingsModifyAction(body.action);
  const conversation = parseWebGroupConversation(body.conversation);
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.filter(
        (recipient: unknown): recipient is string =>
          typeof recipient === 'string'
      )
    : [];
  const { value } = body;

  if (!action) {
    sendText(req, res, 400, 'Missing action');
    return;
  }
  if (!conversation) {
    sendText(req, res, 400, 'Missing conversation');
    return;
  }
  if (typeof conversation.revision !== 'number') {
    sendText(req, res, 400, 'Missing conversation revision');
    return;
  }
  if (
    typeof value !== 'boolean' &&
    typeof value !== 'number' &&
    typeof value !== 'string'
  ) {
    sendText(req, res, 400, 'Missing value');
    return;
  }
  if (recipients.length === 0) {
    sendText(req, res, 400, 'Missing recipients');
    return;
  }
  const { masterKey } = conversation;
  if (!masterKey) {
    sendText(req, res, 400, 'Missing conversation masterKey');
    return;
  }

  streamSession.sendAttemptCount += 1;
  streamSession.lastSendAttemptAt = now();
  streamSession.updatedAt = now();

  try {
    await runSessionOperation(
      streamSession,
      'handleModifyGroupSettings',
      async () => {
        assertSendAllowed(streamSession);
        const result = await modifyGroupSettings({
          action,
          allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
          chat: streamSession.connection,
          conversation,
          linkedPayload: streamSession.linkedPayload,
          storageUrl: productionConfig.storageUrl,
          value,
        });
        try {
          const unauthChat = conversation.groupSendEndorsements
            ? await getBackupUnauthConnection(streamSession)
            : undefined;
          await sendGroupUpdateMessage({
            chat: streamSession.connection,
            groupSendEndorsements: conversation.groupSendEndorsements,
            groupChangeBase64: result.groupChangeBase64,
            groupId: String(conversation.groupId ?? conversation.id),
            groupV2: {
              masterKey,
              revision: result.revision,
            },
            linkedPayload: streamSession.linkedPayload,
            recipients,
            timestamp: now(),
            unauthChat,
          });
        } catch (error) {
          if (getSendErrorInfo(error)) {
            throw error;
          }
          console.warn(
            'handleGroupSettings: group state updated, but failed to send group update message',
            errorToLogString(error)
          );
        }
        rememberSendSuccess(streamSession);
        streamSession.updatedAt = now();
        emitProtocolState(streamSession, { immediate: true });
        sendJson(req, res, 200, result);
      },
      `group:${conversation.id}`
    );
  } catch (error) {
    rememberSendFailure(streamSession, error);
    streamSession.lastSendError = errorToLogString(error);
    streamSession.updatedAt = now();
    throw error;
  }
}

async function handleMessageRequestResponse(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const threadAci =
    typeof body.threadAci === 'string' ? body.threadAci : undefined;
  const responseType = typeof body.type === 'number' ? body.type : undefined;
  const timestamp = typeof body.timestamp === 'number' ? body.timestamp : now();
  streamSession.sendAttemptCount += 1;
  streamSession.lastSendAttemptAt = now();
  streamSession.updatedAt = now();
  if (!threadAci) {
    sendText(req, res, 400, 'Missing threadAci');
    return;
  }
  if (typeof responseType !== 'number') {
    sendText(req, res, 400, 'Missing type');
    return;
  }

  try {
    await runSessionOperation(
      streamSession,
      'handleMessageRequestResponse',
      async () => {
        assertSendAllowed(streamSession);
        const storageResult = await updateStorageMessageRequestResponse({
          allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
          chat: streamSession.connection,
          conversationId: threadAci,
          linkedPayload: streamSession.linkedPayload,
          responseType,
          storageUrl: productionConfig.storageUrl,
        });
        await sendFetchStorageManifestSync({
          chat: streamSession.connection,
          linkedPayload: streamSession.linkedPayload,
          timestamp,
        });
        const result = await sendMessageRequestResponseSync({
          chat: streamSession.connection,
          linkedPayload: streamSession.linkedPayload,
          threadAci,
          timestamp,
          type: responseType,
        });
        rememberSendSuccess(streamSession);
        streamSession.updatedAt = now();
        emitProtocolState(streamSession, { immediate: true });
        sendJson(req, res, 200, {
          ...result,
          storageVersion: storageResult.version,
        });
      },
      `direct:${threadAci}`
    );
  } catch (error) {
    rememberSendFailure(streamSession, error);
    streamSession.lastSendError = errorToLogString(error);
    streamSession.updatedAt = now();
    console.warn(
      'handleMessageRequestResponse: local response applied, but sync failed',
      error
    );
    sendJson(req, res, 200, {
      threadAci,
      timestamp,
      type: responseType,
      syncError: errorToLogString(error),
    });
  }
}

async function handleWriteProfile(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = (await readJson(req)) as Partial<ProfileWriteRequestBody>;
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  const firstName =
    typeof body.firstName === 'string' ? body.firstName : undefined;
  if (!firstName) {
    sendText(req, res, 400, 'Missing firstName');
    return;
  }

  if (typeof body.phoneNumberSharing !== 'boolean') {
    sendText(req, res, 400, 'Missing phoneNumberSharing');
    return;
  }
  const phoneNumberSharing = body.phoneNumberSharing;

  const familyName =
    typeof body.familyName === 'string' ? body.familyName : undefined;
  const aboutText =
    typeof body.aboutText === 'string' ? body.aboutText : undefined;
  const aboutEmoji =
    typeof body.aboutEmoji === 'string' ? body.aboutEmoji : undefined;
  const timestamp = typeof body.timestamp === 'number' ? body.timestamp : now();
  const avatarData =
    typeof body.avatarBase64 === 'string'
      ? Bytes.fromBase64(body.avatarBase64)
      : undefined;
  const profileKey = streamSession.linkedPayload.profileKeyBase64;
  if (avatarData && !profileKey) {
    throw new Error('writeProfile: missing profileKeyBase64');
  }
  const encryptedAvatarData =
    avatarData && profileKey
      ? encryptProfile(avatarData, Bytes.fromBase64(profileKey))
      : undefined;

  await runSessionOperation(
    streamSession,
    'handleWriteProfile',
    async () => {
      const currentProfile = await fetchCurrentProfileForWrite(
        streamSession.connection,
        streamSession.linkedPayload
      );

      const profileData = getProfileRequestData({
        aboutEmoji,
        aboutText,
        avatarData,
        familyName,
        firstName,
        linkedPayload: streamSession.linkedPayload,
        paymentAddress: currentProfile.paymentAddress ?? null,
        phoneNumberSharing,
        removeAvatar: body.removeAvatar,
      });

      const avatarUploadHeaders = await fetchSignalJson<unknown>({
        body: profileData,
        chat: streamSession.connection,
        method: 'PUT',
        path: '/v1/profile',
      });
      let avatarUrlPath: string | undefined;
      if (encryptedAvatarData) {
        if (!isProfileAvatarUploadHeaders(avatarUploadHeaders)) {
          throw new Error('writeProfile: missing avatar upload headers');
        }
        avatarUrlPath = await uploadProfileAvatar(
          avatarUploadHeaders,
          encryptedAvatarData
        );
      }

      try {
        await updateStorageAccountProfile({
          allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
          avatarUrlPath,
          chat: streamSession.connection,
          familyName,
          firstName,
          linkedPayload: streamSession.linkedPayload,
          phoneNumberSharing,
          removeAvatar: body.removeAvatar,
          storageUrl: productionConfig.storageUrl,
        });
        await sendFetchStorageManifestSync({
          chat: streamSession.connection,
          linkedPayload: streamSession.linkedPayload,
          timestamp,
        });
      } catch (error) {
        console.warn(
          'handleWriteProfile: profile updated, but storage service sync failed',
          error
        );
      }

      if (body.hasOtherDevices === true) {
        await sendFetchLocalProfileSync({
          chat: streamSession.connection,
          linkedPayload: streamSession.linkedPayload,
          timestamp,
        });
      }

      const account = getProfileAccountUpdate({
        aboutEmoji,
        aboutText,
        avatarUrlPath,
        familyName,
        firstName,
        linkedPayload: streamSession.linkedPayload,
        removeAvatar: body.removeAvatar,
        timestamp,
      });
      streamSession.linkedPayload = {
        ...streamSession.linkedPayload,
        account: {
          ...streamSession.linkedPayload.account,
          ...account,
        },
        protocol: exportProtocolState(streamSession.linkedPayload),
      } as LinkedPayloadWithProtocol;
      streamSession.updatedAt = now();

      sendJson(req, res, 200, {
        account,
        protocol: streamSession.linkedPayload.protocol,
        timestamp,
      });
    },
    'account:profile'
  );
}

async function handlePhoneNumberDiscoverability(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = (await readJson(
    req
  )) as Partial<PhoneNumberDiscoverabilityRequestBody>;
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }

  if (typeof body.discoverable !== 'boolean') {
    sendText(req, res, 400, 'Missing discoverable');
    return;
  }
  const { discoverable } = body;

  await runSessionOperation(
    streamSession,
    'handlePhoneNumberDiscoverability',
    async () => {
      await fetchSignalJson<void>({
        body: {
          discoverableByPhoneNumber: discoverable,
        },
        chat: streamSession.connection,
        method: 'PUT',
        path: '/v2/accounts/phone_number_discoverability',
      });

      sendJson(req, res, 200, { ok: true });
    },
    'account:phoneNumberDiscoverability'
  );
}

function getRuntimeSessionForRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: JsonRecord
): MessageStreamSession | undefined {
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  if (sessionId) {
    const streamSession = streamSessions.get(sessionId);
    if (!isReadyMessageStreamSession(streamSession)) {
      sendText(req, res, 404, 'Message runtime session not found');
      return undefined;
    }
    return streamSession;
  }

  const openSessions = [...streamSessions.values()].filter(
    streamSession =>
      streamSession.status === 'open' &&
      streamSession.connection &&
      streamSession.linkedPayload
  );
  if (openSessions.length === 1) {
    return openSessions[0];
  }

  if (openSessions.length > 1) {
    sendText(req, res, 409, 'Message runtime session id is required');
    return undefined;
  }

  sendText(req, res, 404, 'Message runtime session not found');
  return undefined;
}

async function fetchSignalUsernameJson<T>({
  body,
  chat,
  method,
  path,
  req,
  res,
}: Readonly<{
  body?: unknown;
  chat: AuthenticatedChatConnection;
  method: 'DELETE' | 'PUT';
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
}>): Promise<T | undefined> {
  const bodyBytes =
    body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
  const response = await chat.fetch({
    verb: method,
    path,
    headers: bodyBytes ? [['content-type', 'application/json']] : [],
    body: bodyBytes,
    timeoutMillis: 30_000,
  });
  const responseBody = getBodyString(response.body);
  if (response.status < 200 || response.status >= 300) {
    sendText(
      req,
      res,
      response.status,
      responseBody || `${path} failed with status ${response.status}`
    );
    return undefined;
  }

  return (responseBody ? JSON.parse(responseBody) : undefined) as T;
}

async function handleReserveUsername(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const streamSession = getRuntimeSessionForRequest(req, res, body);
  if (!streamSession?.connection) {
    return;
  }
  const { connection } = streamSession;

  const usernameHashes = body.usernameHashes;
  if (
    !Array.isArray(usernameHashes) ||
    usernameHashes.some(value => typeof value !== 'string')
  ) {
    sendText(req, res, 400, 'Missing usernameHashes');
    return;
  }

  const result = await fetchSignalUsernameJson<{ usernameHash: string }>({
    body: { usernameHashes },
    chat: connection,
    method: 'PUT',
    path: '/v1/accounts/username_hash/reserve',
    req,
    res,
  });
  if (!result) {
    return;
  }
  sendJson(req, res, 200, result);
}

function getReserveUsernameErrorFromLibSignal(
  error: unknown
): ReserveUsernameError | undefined {
  if (
    LibSignalErrorBase.is(error, LibSignalErrorCode.NicknameCannotBeEmpty) ||
    LibSignalErrorBase.is(error, LibSignalErrorCode.NicknameTooShort)
  ) {
    return ReserveUsernameError.NotEnoughCharacters;
  }
  if (LibSignalErrorBase.is(error, LibSignalErrorCode.NicknameTooLong)) {
    return ReserveUsernameError.TooManyCharacters;
  }
  if (LibSignalErrorBase.is(error, LibSignalErrorCode.CannotStartWithDigit)) {
    return ReserveUsernameError.CheckStartingCharacter;
  }
  if (LibSignalErrorBase.is(error, LibSignalErrorCode.BadNicknameCharacter)) {
    return ReserveUsernameError.CheckCharacters;
  }
  if (
    LibSignalErrorBase.is(error, LibSignalErrorCode.DiscriminatorCannotBeZero)
  ) {
    return ReserveUsernameError.AllZeroDiscriminator;
  }
  if (
    LibSignalErrorBase.is(
      error,
      LibSignalErrorCode.DiscriminatorCannotHaveLeadingZeros
    )
  ) {
    return ReserveUsernameError.LeadingZeroDiscriminator;
  }
  if (
    LibSignalErrorBase.is(
      error,
      LibSignalErrorCode.DiscriminatorCannotBeEmpty
    ) ||
    LibSignalErrorBase.is(
      error,
      LibSignalErrorCode.DiscriminatorCannotBeSingleDigit
    ) ||
    LibSignalErrorBase.is(error, LibSignalErrorCode.DiscriminatorTooLarge)
  ) {
    return ReserveUsernameError.NotEnoughDiscriminator;
  }

  return undefined;
}

async function handleReserveUsernameByNickname(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const streamSession = getRuntimeSessionForRequest(req, res, body);
  if (!streamSession?.connection) {
    return;
  }

  const nickname =
    typeof body.nickname === 'string' ? body.nickname : undefined;
  const customDiscriminator =
    typeof body.customDiscriminator === 'string'
      ? body.customDiscriminator
      : undefined;
  const previousUsername =
    typeof body.previousUsername === 'string'
      ? body.previousUsername
      : undefined;
  const minNicknameLength =
    typeof body.minNicknameLength === 'number'
      ? body.minNicknameLength
      : undefined;
  const maxNicknameLength =
    typeof body.maxNicknameLength === 'number'
      ? body.maxNicknameLength
      : undefined;

  if (!nickname || minNicknameLength == null || maxNicknameLength == null) {
    sendText(req, res, 400, 'Missing username reservation body');
    return;
  }

  let generatedUsernames: ReadonlyArray<string>;
  try {
    if (previousUsername !== undefined && !customDiscriminator) {
      const previousNickname = getNickname(previousUsername);
      if (
        previousNickname !== undefined &&
        nickname.toLowerCase() === previousNickname.toLowerCase()
      ) {
        const previousDiscriminator = getDiscriminator(previousUsername);
        if (!previousDiscriminator) {
          sendText(req, res, 400, 'Missing previous username discriminator');
          return;
        }
        generatedUsernames = [`${nickname}.${previousDiscriminator}`];
      } else {
        generatedUsernames = usernames.generateCandidates(
          nickname,
          minNicknameLength,
          maxNicknameLength
        );
      }
    } else if (customDiscriminator) {
      generatedUsernames = [
        usernames.fromParts(
          nickname,
          customDiscriminator,
          minNicknameLength,
          maxNicknameLength
        ).username,
      ];
    } else {
      generatedUsernames = usernames.generateCandidates(
        nickname,
        minNicknameLength,
        maxNicknameLength
      );
    }
  } catch (error) {
    const reserveError = getReserveUsernameErrorFromLibSignal(error);
    if (reserveError) {
      sendText(req, res, 400, `ReserveUsernameError:${reserveError}`);
      return;
    }
    throw error;
  }

  const hashes = generatedUsernames.map(username => usernames.hash(username));
  const result = await fetchSignalUsernameJson<{ usernameHash: string }>({
    body: {
      usernameHashes: hashes.map(hash => toWebSafeBase64(Bytes.toBase64(hash))),
    },
    chat: streamSession.connection,
    method: 'PUT',
    path: '/v1/accounts/username_hash/reserve',
    req,
    res,
  });
  if (!result) {
    return;
  }

  const usernameHash = Bytes.fromBase64(fromWebSafeBase64(result.usernameHash));
  const index = hashes.findIndex(hash => Bytes.areEqual(hash, usernameHash));
  if (index === -1) {
    sendText(req, res, 422, 'Reserved username hash was not requested');
    return;
  }

  sendJson(req, res, 200, {
    hashBase64: Bytes.toBase64(usernameHash),
    username: generatedUsernames[index],
  });
}

async function handleConfirmUsername(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const streamSession = getRuntimeSessionForRequest(req, res, body);
  if (!streamSession?.connection) {
    return;
  }
  const { connection } = streamSession;

  const usernameHash =
    typeof body.usernameHash === 'string' ? body.usernameHash : undefined;
  const zkProof = typeof body.zkProof === 'string' ? body.zkProof : undefined;
  const encryptedUsername =
    typeof body.encryptedUsername === 'string'
      ? body.encryptedUsername
      : undefined;
  if (!usernameHash || !zkProof || !encryptedUsername) {
    sendText(req, res, 400, 'Missing username confirmation body');
    return;
  }

  const result = await fetchSignalUsernameJson<{ usernameLinkHandle: string }>({
    body: {
      encryptedUsername,
      usernameHash,
      zkProof,
    },
    chat: connection,
    method: 'PUT',
    path: '/v1/accounts/username_hash/confirm',
    req,
    res,
  });
  if (!result) {
    return;
  }
  sendJson(req, res, 200, result);
}

async function handleConfirmUsernameReservation(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const streamSession = getRuntimeSessionForRequest(req, res, body);
  if (!streamSession?.connection) {
    return;
  }

  const username =
    typeof body.username === 'string' ? body.username : undefined;
  const hashBase64 =
    typeof body.hashBase64 === 'string' ? body.hashBase64 : undefined;
  const previousLinkEntropyBase64 =
    typeof body.previousLinkEntropyBase64 === 'string'
      ? body.previousLinkEntropyBase64
      : undefined;
  if (!username || !hashBase64) {
    sendText(req, res, 400, 'Missing username confirmation body');
    return;
  }

  const hash = Bytes.fromBase64(hashBase64);
  if (!Bytes.areEqual(usernames.hash(username), hash)) {
    sendText(req, res, 422, 'username hash mismatch');
    return;
  }

  let entropy: Uint8Array<ArrayBuffer>;
  let result: { usernameLinkHandle: string } | undefined;
  if (previousLinkEntropyBase64) {
    const updatedLink = usernames.createUsernameLink(
      username,
      Bytes.fromBase64(previousLinkEntropyBase64)
    );
    entropy = updatedLink.entropy;
    result = await fetchSignalUsernameJson<{ usernameLinkHandle: string }>({
      body: {
        keepLinkHandle: true,
        usernameLinkEncryptedValue: toWebSafeBase64(
          Bytes.toBase64(updatedLink.encryptedUsername)
        ),
      },
      chat: streamSession.connection,
      method: 'PUT',
      path: '/v1/accounts/username_link',
      req,
      res,
    });
  } else {
    const newLink = usernames.createUsernameLink(username);
    entropy = newLink.entropy;
    result = await fetchSignalUsernameJson<{ usernameLinkHandle: string }>({
      body: {
        encryptedUsername: toWebSafeBase64(
          Bytes.toBase64(newLink.encryptedUsername)
        ),
        usernameHash: toWebSafeBase64(Bytes.toBase64(hash)),
        zkProof: toWebSafeBase64(
          Bytes.toBase64(usernames.generateProof(username))
        ),
      },
      chat: streamSession.connection,
      method: 'PUT',
      path: '/v1/accounts/username_hash/confirm',
      req,
      res,
    });
  }
  if (!result) {
    return;
  }

  sendJson(req, res, 200, {
    entropyBase64: Bytes.toBase64(entropy),
    usernameLinkHandle: result.usernameLinkHandle,
  });
}

async function handleDeleteUsername(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const streamSession = getRuntimeSessionForRequest(req, res, body);
  if (!streamSession?.connection) {
    return;
  }
  const { connection } = streamSession;

  const result = await fetchSignalUsernameJson<void>({
    chat: connection,
    method: 'DELETE',
    path: '/v1/accounts/username_hash',
    req,
    res,
  });
  if (result === undefined && res.headersSent) {
    return;
  }
  sendJson(req, res, 200, { ok: true });
}

async function handleReplaceUsernameLink(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const streamSession = getRuntimeSessionForRequest(req, res, body);
  if (!streamSession?.connection) {
    return;
  }
  const { connection } = streamSession;

  const usernameLinkEncryptedValue =
    typeof body.usernameLinkEncryptedValue === 'string'
      ? body.usernameLinkEncryptedValue
      : undefined;
  if (!usernameLinkEncryptedValue || typeof body.keepLinkHandle !== 'boolean') {
    sendText(req, res, 400, 'Missing username link body');
    return;
  }

  const result = await fetchSignalUsernameJson<{ usernameLinkHandle: string }>({
    body: {
      keepLinkHandle: body.keepLinkHandle,
      usernameLinkEncryptedValue,
    },
    chat: connection,
    method: 'PUT',
    path: '/v1/accounts/username_link',
    req,
    res,
  });
  if (!result) {
    return;
  }
  sendJson(req, res, 200, result);
}

async function handleResetUsernameLink(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const streamSession = getRuntimeSessionForRequest(req, res, body);
  if (!streamSession?.connection) {
    return;
  }

  const username =
    typeof body.username === 'string' ? body.username : undefined;
  if (!username) {
    sendText(req, res, 400, 'Missing username');
    return;
  }

  const { encryptedUsername, entropy } = usernames.createUsernameLink(username);
  const result = await fetchSignalUsernameJson<{ usernameLinkHandle: string }>({
    body: {
      keepLinkHandle: false,
      usernameLinkEncryptedValue: toWebSafeBase64(
        Bytes.toBase64(encryptedUsername)
      ),
    },
    chat: streamSession.connection,
    method: 'PUT',
    path: '/v1/accounts/username_link',
    req,
    res,
  });
  if (!result) {
    return;
  }

  sendJson(req, res, 200, {
    entropyBase64: Bytes.toBase64(entropy),
    usernameLinkHandle: result.usernameLinkHandle,
  });
}

async function handleSyncUsernameProfile(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const streamSession = getRuntimeSessionForRequest(req, res, body);
  if (!isReadyMessageStreamSession(streamSession)) {
    return;
  }

  const username =
    typeof body.username === 'string' ? body.username : undefined;
  const timestamp = typeof body.timestamp === 'number' ? body.timestamp : now();

  await runSessionOperation(
    streamSession,
    'handleSyncUsernameProfile',
    async () => {
      const { connection, linkedPayload } = streamSession;
      const account: WebAccount = {
        ...linkedPayload.account,
        username,
      };
      const nextLinkedPayload = {
        ...linkedPayload,
        account,
        protocol: exportProtocolState(linkedPayload),
      } as LinkedPayloadWithProtocol;

      streamSession.linkedPayload = nextLinkedPayload;
      streamSession.updatedAt = now();

      let syncError: string | undefined;
      try {
        await sendFetchLocalProfileSync({
          chat: connection,
          linkedPayload: nextLinkedPayload,
          timestamp,
        });
      } catch (error) {
        syncError = errorToLogString(error);
        console.warn(
          'handleSyncUsernameProfile: local username updated, but sync failed',
          error
        );
      }

      sendJson(req, res, 200, {
        account,
        protocol: nextLinkedPayload.protocol,
        syncError,
        timestamp,
      });
    },
    'account:username-profile'
  );
}

async function handleContactsSync(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (isReadyMessageStreamSession(streamSession)) {
    await runSessionOperation(
      streamSession,
      'handleContactsSync',
      async () => {
        const syncResult = await syncStorageContacts({
          allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
          chat: streamSession.connection,
          cdnUrl: getDefaultCdnUrl(),
          linkedPayload: streamSession.linkedPayload,
          storageUrl: productionConfig.storageUrl,
        });
        sendJson(req, res, 200, syncResult.contactsBootstrap);
        if (streamSession.writeEvent) {
          void kickOffProfileFetches({
            streamSession,
            syncResult,
            writeEvent: streamSession.writeEvent,
          });
        }
      },
      'account:contacts-sync'
    );
    return;
  }

  const username =
    typeof body.username === 'string' ? body.username : undefined;
  const password =
    typeof body.password === 'string' ? body.password : undefined;
  const storageServiceKey =
    typeof body.storageServiceKey === 'string'
      ? body.storageServiceKey
      : undefined;
  const aci = typeof body.aci === 'string' ? body.aci : undefined;
  const pni = typeof body.pni === 'string' ? body.pni : undefined;
  const number = typeof body.number === 'string' ? body.number : undefined;
  if (!username || !password || !storageServiceKey || !aci || !number) {
    sendText(
      req,
      res,
      404,
      'Message runtime session not found, and direct credentials are incomplete'
    );
    return;
  }
  const deviceId = Number(username.split('.')[1]);
  if (!Number.isInteger(deviceId)) {
    sendText(req, res, 400, 'Invalid username device id');
    return;
  }

  const { Net } = await getSignalModules();
  const net = createNet(Net);
  let connection: AuthenticatedChatConnection | undefined;
  try {
    connection = await net.connectAuthenticatedChat(
      username,
      password,
      false,
      {
        onIncomingMessage(_envelope, _timestamp, ack) {
          ack.send(200);
        },
        onQueueEmpty() {},
        onConnectionInterrupted() {},
      },
      {
        languages: ['zh-CN', 'en-US'],
      }
    );
    const syncResult = await syncStorageContacts({
      allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
      chat: connection,
      cdnUrl: getDefaultCdnUrl(),
      linkedPayload: {
        account: {
          aci,
          pni,
          number,
          phoneNumber: number,
          title: number,
        },
        credentials: {
          username,
          password,
          deviceId,
          aci,
          pni,
          number,
        },
        storageServiceKey,
      },
      storageUrl: productionConfig.storageUrl,
    });
    sendJson(req, res, 200, syncResult.contactsBootstrap);
  } finally {
    await connection?.disconnect();
  }
}

async function handleConversationArchive(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const conversationId =
    typeof body.conversationId === 'string' ? body.conversationId : undefined;
  const isArchived =
    typeof body.isArchived === 'boolean' ? body.isArchived : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }
  if (!conversationId || isArchived == null) {
    sendText(req, res, 400, 'Missing conversationId or isArchived');
    return;
  }

  await runSessionOperation(
    streamSession,
    'handleConversationArchive',
    async () => {
      const result = await updateStorageConversationArchive({
        allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
        chat: streamSession.connection,
        conversationId,
        isArchived,
        linkedPayload: streamSession.linkedPayload,
        storageUrl: productionConfig.storageUrl,
      });
      await sendFetchStorageManifestSync({
        chat: streamSession.connection,
        linkedPayload: streamSession.linkedPayload,
        timestamp: now(),
      });
      sendJson(req, res, 200, result);
    },
    `conversation:${conversationId}`
  );
}

async function handleConversationMute(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const conversationId =
    typeof body.conversationId === 'string' ? body.conversationId : undefined;
  const muteExpiresAt =
    typeof body.muteExpiresAt === 'number' ? body.muteExpiresAt : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }
  if (!conversationId || muteExpiresAt == null) {
    sendText(req, res, 400, 'Missing conversationId or muteExpiresAt');
    return;
  }

  await runSessionOperation(
    streamSession,
    'handleConversationMute',
    async () => {
      const result = await updateStorageConversationMute({
        allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
        chat: streamSession.connection,
        conversationId,
        linkedPayload: streamSession.linkedPayload,
        muteExpiresAt,
        storageUrl: productionConfig.storageUrl,
      });
      await sendFetchStorageManifestSync({
        chat: streamSession.connection,
        linkedPayload: streamSession.linkedPayload,
        timestamp: now(),
      });
      sendJson(req, res, 200, result);
    },
    `conversation:${conversationId}`
  );
}

async function handleConversationMarkedUnread(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const conversationId =
    typeof body.conversationId === 'string' ? body.conversationId : undefined;
  const markedUnread =
    typeof body.markedUnread === 'boolean' ? body.markedUnread : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }
  if (!conversationId || markedUnread == null) {
    sendText(req, res, 400, 'Missing conversationId or markedUnread');
    return;
  }

  await runSessionOperation(
    streamSession,
    'handleConversationMarkedUnread',
    async () => {
      const result = await updateStorageConversationMarkedUnread({
        allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
        chat: streamSession.connection,
        conversationId,
        linkedPayload: streamSession.linkedPayload,
        markedUnread,
        storageUrl: productionConfig.storageUrl,
      });
      await sendFetchStorageManifestSync({
        chat: streamSession.connection,
        linkedPayload: streamSession.linkedPayload,
        timestamp: now(),
      });
      sendJson(req, res, 200, result);
    },
    `conversation:${conversationId}`
  );
}

async function handleConversationPin(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJson(req);
  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const conversationId =
    typeof body.conversationId === 'string' ? body.conversationId : undefined;
  const isPinned =
    typeof body.isPinned === 'boolean' ? body.isPinned : undefined;
  const streamSession = sessionId ? streamSessions.get(sessionId) : undefined;
  if (!isReadyMessageStreamSession(streamSession)) {
    sendText(req, res, 404, 'Message runtime session not found');
    return;
  }
  if (!conversationId || isPinned == null) {
    sendText(req, res, 400, 'Missing conversationId or isPinned');
    return;
  }

  await runSessionOperation(
    streamSession,
    'handleConversationPin',
    async () => {
      const result = await updateStoragePinnedConversations({
        allowInsecureTls: ALLOW_INSECURE_STORAGE_TLS,
        chat: streamSession.connection,
        conversationId,
        isPinned,
        linkedPayload: streamSession.linkedPayload,
        storageUrl: productionConfig.storageUrl,
      });
      await sendFetchStorageManifestSync({
        chat: streamSession.connection,
        linkedPayload: streamSession.linkedPayload,
        timestamp: now(),
      });
      sendJson(req, res, 200, result);
    },
    `conversation:${conversationId}`
  );
}

async function handleAttachment(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const cdnKey = url.searchParams.get('cdnKey');
  const cdnId = url.searchParams.get('cdnId');
  const transitKey = cdnKey ?? cdnId;
  const cdnNumber = url.searchParams.get('cdnNumber') ?? '0';
  const contentType =
    url.searchParams.get('contentType') ?? 'application/octet-stream';
  const fileName = url.searchParams.get('fileName');
  const keyBase64 = url.searchParams.get('keyBase64');
  const digestBase64 = url.searchParams.get('digestBase64');
  const plaintextHash = url.searchParams.get('plaintextHash');
  const incrementalMacBase64 = url.searchParams.get('incrementalMacBase64');
  const chunkSizeParam = url.searchParams.get('chunkSize');
  const chunkSize = chunkSizeParam != null ? Number(chunkSizeParam) : undefined;
  const sizeParam = url.searchParams.get('size');
  const size = sizeParam != null ? Number(sizeParam) : undefined;
  const backupCdnNumberParam = url.searchParams.get('backupCdnNumber');
  const backupCdnNumber =
    backupCdnNumberParam != null ? Number(backupCdnNumberParam) : undefined;
  const sessionId = url.searchParams.get('sessionId');
  const backupFields =
    keyBase64 && plaintextHash && size != null
      ? {
          keyBase64,
          plaintextHash,
          size,
        }
      : undefined;
  async function writeBackupTierAttachment(): Promise<void> {
    if (!backupFields) {
      sendText(
        req,
        res,
        400,
        'Missing cdnKey or cdnId and backup media fields'
      );
      return;
    }
    const streamSession = await waitForAttachmentStreamSession(sessionId);
    if (!streamSession?.linkedPayload) {
      if (transitKey) {
        throw new Error('Message runtime session not found');
      }
      sendText(req, res, 404, 'Message runtime session not found');
      return;
    }
    if (!streamSession.connection) {
      if (transitKey) {
        throw new Error('Message runtime session is not connected');
      }
      sendText(req, res, 503, 'Message runtime session is not connected');
      return;
    }

    const mediaRootKey = getMediaRootBackupKey(streamSession.linkedPayload);
    const mediaId = getBackupMediaId({
      keyBase64: backupFields.keyBase64,
      mediaRootKey,
      plaintextHash: backupFields.plaintextHash,
    });
    const archiveInfo = await getBackupArchiveInfo(
      streamSession,
      streamSession.linkedPayload
    );
    const location =
      backupCdnNumber != null
        ? {
            ...archiveInfo,
            cdnNumber: backupCdnNumber,
          }
        : await findBackupMediaLocation({
            linkedPayload: streamSession.linkedPayload,
            mediaId: mediaId.string,
            streamSession,
          });
    const resolvedLocation = location ?? {
      ...archiveInfo,
      cdnNumber: await getFallbackBackupCdnNumber(streamSession),
    };

    const backupReadHeaders = await getBackupCdnReadHeaders({
      cdnNumber: resolvedLocation.cdnNumber,
      linkedPayload: streamSession.linkedPayload,
      streamSession,
    });
    const backupMediaStream = await fetchBackupMediaStream({
      backupDir: resolvedLocation.backupDir,
      cdnNumber: resolvedLocation.cdnNumber,
      headers: backupReadHeaders,
      mediaDir: resolvedLocation.mediaDir,
      mediaId: mediaId.string,
    });

    const decrypted = await limitAttachmentDownload(() =>
      decryptAttachmentV2ToBuffer({
        ciphertextStream: backupMediaStream,
        idForLogging: mediaId.string,
        integrityCheck: {
          type: 'plaintext',
          plaintextHash: Bytes.fromHex(backupFields.plaintextHash),
        },
        keysBase64: backupFields.keyBase64,
        outerEncryption: deriveBackupMediaOuterEncryptionKeyMaterial(
          mediaRootKey,
          mediaId.bytes
        ),
        size: backupFields.size,
        theirChunkSize: chunkSize,
        theirIncrementalMac: incrementalMacBase64
          ? Bytes.fromBase64(incrementalMacBase64)
          : undefined,
        type: 'standard',
      })
    );
    sendAttachmentBytes({
      body: decrypted,
      contentType,
      fileName,
      req,
      res,
    });
    return;
  }

  async function writeTransitTierAttachment(): Promise<void> {
    if (!transitKey) {
      sendText(
        req,
        res,
        400,
        'Missing cdnKey or cdnId and backup media fields'
      );
      return;
    }

    const baseUrl =
      CDN_BASE_URL ??
      productionConfig.cdn[cdnNumber] ??
      productionConfig.cdn['0'];
    if (!baseUrl) {
      sendText(req, res, 501, 'CDN base URL is not configured');
      return;
    }

    const attachmentUrl = new URL(
      `/attachments/${encodeURIComponent(transitKey)}`,
      baseUrl
    );
    const response = await fetch(attachmentUrl);
    if (!response.ok) {
      sendText(req, res, response.status, await response.text());
      return;
    }

    if (!response.body) {
      sendAttachmentBytes({
        body: Buffer.alloc(0),
        contentType,
        fileName,
        req,
        res,
      });
      return;
    }

    if (keyBase64 && (digestBase64 || plaintextHash) && size != null) {
      const decrypted = await limitAttachmentDownload(() =>
        decryptAttachmentV2ToBuffer({
          ciphertextStream: Readable.fromWeb(response.body as never),
          idForLogging: transitKey,
          integrityCheck: digestBase64
            ? {
                type: 'encrypted',
                digest: Bytes.fromBase64(digestBase64),
              }
            : {
                type: 'plaintext',
                plaintextHash: Bytes.fromHex(plaintextHash ?? ''),
              },
          keysBase64: keyBase64,
          size,
          theirChunkSize: chunkSize,
          theirIncrementalMac: incrementalMacBase64
            ? Bytes.fromBase64(incrementalMacBase64)
            : undefined,
          type: 'standard',
        })
      );
      sendAttachmentBytes({
        body: decrypted,
        contentType,
        fileName,
        req,
        res,
      });
      return;
    }

    sendCors(req, res);
    res.writeHead(200, {
      'Content-Type': contentType,
      ...(size != null
        ? {
            'Content-Length': String(size),
          }
        : null),
      ...(fileName
        ? {
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          }
        : null),
      'Cache-Control': 'public, max-age=3600',
    });
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      res.write(chunk);
    }
    res.end();
  }

  if (backupFields && sessionId) {
    try {
      await writeBackupTierAttachment();
      return;
    } catch (error) {
      console.warn(
        'handleAttachment: backup tier download failed, trying transit tier',
        errorToLogString(error)
      );
      if (!transitKey) {
        throw error;
      }
    }
  }
  if (backupFields && !sessionId && !transitKey) {
    sendText(req, res, 400, 'Missing sessionId');
    return;
  }

  await writeTransitTierAttachment();
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  sendCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? '127.0.0.1'}`
  );

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(req, res, 200, {
      host: HOST,
      ok: true,
      port: PORT,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/emoji/jumbo') {
    await handleEmojiJumbo(req, res, url);
    return;
  }

  if (
    url.pathname.startsWith('/messages/') &&
    url.pathname !== '/messages/attachment/upload' &&
    UPSTREAM_API_BASE_URL
  ) {
    if (await proxyToUpstream(req, res, url)) {
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/provisioning/sessions') {
    const body = await readJson(req);
    const deviceName =
      typeof body.deviceName === 'string' ? body.deviceName : 'Signal Web';
    const session = await startProvisioningSession(deviceName);
    sendJson(req, res, 200, getSessionResponse(session));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/provisioning/sessions') {
    sendJson(
      req,
      res,
      200,
      [...sessions.values()]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(getSessionResponse)
    );
    return;
  }

  const provisioningImportTransferMatch =
    /^\/provisioning\/sessions\/([^/]+)\/import-transfer$/.exec(url.pathname);
  if (req.method === 'POST' && provisioningImportTransferMatch) {
    const matchedSessionId = provisioningImportTransferMatch[1];
    if (!matchedSessionId) {
      sendText(req, res, 404, 'Provisioning session not found');
      return;
    }
    const session = sessions.get(matchedSessionId);
    if (!session) {
      sendText(req, res, 404, 'Provisioning session not found');
      return;
    }
    await handleImportTransfer(req, res, session);
    return;
  }

  const provisioningMatch =
    /^\/provisioning\/sessions\/([^/]+)(?:\/linked-session)?$/.exec(
      url.pathname
    );
  if (req.method === 'GET' && provisioningMatch) {
    const matchedSessionId = provisioningMatch[1];
    if (!matchedSessionId) {
      sendText(req, res, 404, 'Provisioning session not found');
      return;
    }
    const session = sessions.get(matchedSessionId);
    if (!session) {
      sendText(req, res, 404, 'Provisioning session not found');
      return;
    }
    if (url.pathname.endsWith('/linked-session')) {
      if (!session.linkedPayload) {
        sendText(req, res, 409, 'Linked session is not ready');
        return;
      }
      sendJson(req, res, 200, session.linkedPayload);
      return;
    }
    sendJson(req, res, 200, getSessionResponse(session));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages/stream') {
    await handleMessageStream(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages/stream/ack') {
    await handleMessageStreamAck(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/network/change') {
    await handleNetworkChange(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/messages/sessions') {
    sendJson(
      req,
      res,
      200,
      [...streamSessions.entries()].map(([sessionId, session]) => ({
        sessionId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: session.status,
        error: session.error,
        lastReceiveError: session.lastReceiveError,
        lastSendError: session.lastSendError,
        sendBlockedUntil: session.sendBlockedUntil,
        sendBlockedStatus: session.sendBlockedStatus,
        sendBlockedReason: session.sendBlockedReason,
        sendChallenge: session.sendChallenge,
        backupImportStatus: session.backupImportStatus,
        backupImportError: session.backupImportError,
        backupImportStats: session.backupImportStats,
        incomingEnvelopeCount: session.incomingEnvelopeCount,
        decodedMessageCount: session.decodedMessageCount,
        lastDecodedMessageSummary: session.lastDecodedMessageSummary,
        receivedAlertCount: session.receivedAlertCount,
        lastReceivedAlerts: session.lastReceivedAlerts,
        lastReceivedAlertsAt: session.lastReceivedAlertsAt,
        attachmentBackfillEventCount: session.attachmentBackfillEventCount,
        lastAttachmentBackfillSummary: session.lastAttachmentBackfillSummary,
        ignoredEnvelopeCount: session.ignoredEnvelopeCount,
        lastIgnoredEnvelopeReason: session.lastIgnoredEnvelopeReason,
        lastIgnoredContentSummary: session.lastIgnoredContentSummary,
        retryRequestCount: session.retryRequestCount,
        retryRequestResentCount: session.retryRequestResentCount,
        lastRetryRequestSummary: session.lastRetryRequestSummary,
        lastRetryRequestError: session.lastRetryRequestError,
        lastDecryptionErrorRetry: session.lastDecryptionErrorRetry,
        lastDecryptionErrorRetryError: session.lastDecryptionErrorRetryError,
        lastStreamEndedAt: session.lastStreamEndedAt,
        lastStreamInterruptedAt: session.lastStreamInterruptedAt,
        lastStreamOpenedAt: session.lastStreamOpenedAt,
        lastStreamStartedAt: session.lastStreamStartedAt,
        lastTransportError: session.lastTransportError,
        lastTransportStatusAt: session.lastTransportStatusAt,
        signalKeepaliveCount: session.signalKeepaliveCount,
        signalKeepaliveFailureCount: session.signalKeepaliveFailureCount,
        lastSignalKeepaliveAt: session.lastSignalKeepaliveAt,
        lastSignalKeepaliveError: session.lastSignalKeepaliveError,
        lastSignalKeepaliveResponseMs: session.lastSignalKeepaliveResponseMs,
        lastSignalKeepaliveStatus: session.lastSignalKeepaliveStatus,
        backupUnauthKeepaliveCount: session.backupUnauthKeepaliveCount,
        backupUnauthKeepaliveFailureCount:
          session.backupUnauthKeepaliveFailureCount,
        lastBackupUnauthKeepaliveAt: session.lastBackupUnauthKeepaliveAt,
        lastBackupUnauthKeepaliveError: session.lastBackupUnauthKeepaliveError,
        lastBackupUnauthKeepaliveResponseMs:
          session.lastBackupUnauthKeepaliveResponseMs,
        lastBackupUnauthKeepaliveStatus:
          session.lastBackupUnauthKeepaliveStatus,
        queueEmptyCount: session.queueEmptyCount,
        persistedStreamEvents: getPersistedStreamEventDiagnostics(
          getStreamEventAccountKey(session.linkedPayload, session.username)
        ),
        sessionOperationQueueSize:
          sessionOperationQueueSizes.get(sessionId) ?? 0,
        signalSendDiagnostics: getWebSignalSendDiagnostics(),
        sendAttemptCount: session.sendAttemptCount,
        lastSendAttemptAt: session.lastSendAttemptAt,
        streamCloseCount: session.streamCloseCount,
        streamOpenCount: session.streamOpenCount,
        targetOperationStats: getTargetOperationDiagnostics(session),
        transportReconnectHintCount: session.transportReconnectHintCount,
        protocolKeyIds: getLinkedPayloadProtocolKeyIds(session.linkedPayload),
        hasMediaRootBackupKey: Boolean(
          session.linkedPayload?.mediaRootBackupKeyBase64
        ),
        hasAciRegistrationId:
          typeof session.linkedPayload?.aciRegistrationId === 'number',
      }))
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages/import-transfer') {
    await handleMessageImportTransfer(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages/send') {
    await handleSendMessage(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages/challenge') {
    await handleSubmitMessageChallenge(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages/expiration-timer') {
    await handleSendExpirationTimer(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages/attachment/upload') {
    await handleUploadAttachment(req, res);
    return;
  }

  if (
    req.method === 'POST' &&
    url.pathname === '/messages/attachment/backfill'
  ) {
    await handleAttachmentBackfillRequest(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages/reaction') {
    await handleSendReaction(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages/edit') {
    await handleSendEdit(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages/send-group') {
    await handleSendGroupMessage(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/contacts/lookup-username') {
    await handleLookupUsername(req, res);
    return;
  }

  if (
    req.method === 'POST' &&
    url.pathname === '/contacts/lookup-phone-numbers'
  ) {
    await handleLookupPhoneNumbers(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/groups/create') {
    await handleCreateGroup(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/groups/member') {
    await handleModifyGroupMember(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/groups/settings') {
    await handleModifyGroupSettings(req, res);
    return;
  }

  if (
    req.method === 'POST' &&
    url.pathname === '/messages/message-request-response'
  ) {
    await handleMessageRequestResponse(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/contacts/sync') {
    await handleContactsSync(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/conversations/archive') {
    await handleConversationArchive(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/conversations/mute') {
    await handleConversationMute(req, res);
    return;
  }

  if (
    req.method === 'POST' &&
    url.pathname === '/conversations/marked-unread'
  ) {
    await handleConversationMarkedUnread(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/conversations/pin') {
    await handleConversationPin(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/profile/write') {
    await handleWriteProfile(req, res);
    return;
  }

  if (
    req.method === 'POST' &&
    url.pathname === '/profile/phone-number-discoverability'
  ) {
    await handlePhoneNumberDiscoverability(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/username/reserve') {
    await handleReserveUsername(req, res);
    return;
  }

  if (
    req.method === 'POST' &&
    url.pathname === '/username/reserve-by-nickname'
  ) {
    await handleReserveUsernameByNickname(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/username/confirm') {
    await handleConfirmUsername(req, res);
    return;
  }

  if (
    req.method === 'POST' &&
    url.pathname === '/username/confirm-reservation'
  ) {
    await handleConfirmUsernameReservation(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/username/delete') {
    await handleDeleteUsername(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/username/link') {
    await handleReplaceUsernameLink(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/username/reset-link') {
    await handleResetUsernameLink(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/username/sync-profile') {
    await handleSyncUsernameProfile(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/messages/attachment') {
    await handleAttachment(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  sendText(req, res, 404, 'Not found');
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) {
      if (error instanceof RequestBodyTooLargeError) {
        sendText(req, res, 413, error.message);
        return;
      }
      const sendErrorInfo = getSendErrorInfo(error);
      if (sendErrorInfo) {
        sendJson(
          req,
          res,
          sendErrorInfo.status,
          sendErrorInfo.body,
          sendErrorInfo.headers
        );
        return;
      }
      sendText(
        req,
        res,
        500,
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      );
    } else {
      res.end();
    }
  });
});

let isShuttingDown = false;
function shutdownWebBridge(signal: NodeJS.Signals): void {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`Signal Web bridge received ${signal}, closing streams`);
  for (const [sessionId, streamSession] of streamSessions) {
    disposeStreamSession(sessionId, streamSession);
  }
  server.close(error => {
    if (error) {
      console.error('Signal Web bridge failed to close HTTP server', error);
      process.exit(1);
      return;
    }
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('Signal Web bridge shutdown timed out');
    process.exit(1);
  }, 5_000).unref();
}

process.once('SIGTERM', shutdownWebBridge);
process.once('SIGINT', shutdownWebBridge);

void cleanupExpiredAttachmentTmpDirs().catch(error => {
  console.warn(
    'Failed to clean expired Signal Web attachment temp files',
    error
  );
});

if (
  Number.isFinite(RUNTIME_CLEANUP_INTERVAL_MS) &&
  RUNTIME_CLEANUP_INTERVAL_MS > 0
) {
  const runtimeCleanupInterval = setInterval(() => {
    cleanupRuntimeState('interval');
    void cleanupExpiredAttachmentTmpDirs().catch(error => {
      console.warn(
        'Failed to clean expired Signal Web attachment temp files',
        error
      );
    });
  }, RUNTIME_CLEANUP_INTERVAL_MS);
  runtimeCleanupInterval.unref?.();
}

server.listen(PORT, HOST, () => {
  console.log(`Signal Web bridge listening on http://${HOST}:${PORT}`);
});
