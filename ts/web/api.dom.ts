// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { getRenderApiBaseUrl } from './renderConfig.dom.ts';
import type {
  LinkedPayload,
  LinkedSessionRecord,
  MessageStreamEvent,
  ContactsBootstrap,
  ProvisioningSession,
  WebAttachment,
  WebDeleteForEveryone,
  WebPinMessage,
  WebUnpinMessage,
  WebMessage,
  WebConversation,
} from './types.std.ts';
import { getWebAttachmentContentType } from './attachmentMime.std.ts';

function apiUrl(path: string): URL {
  return new URL(path, getRenderApiBaseUrl());
}

let currentMessageRuntimeSessionId: string | undefined;

function getLinkedSessionRequestBody(
  linkedSession: LinkedSessionRecord,
  includeProtocol = false
): Record<string, unknown> {
  return {
    username: linkedSession.credentials?.username,
    password: linkedSession.credentials?.password,
    deviceId: linkedSession.credentials?.deviceId,
    aci: linkedSession.credentials?.aci,
    pni: linkedSession.credentials?.pni,
    number: linkedSession.credentials?.number,
    storageServiceKey: linkedSession.storageServiceKey,
    linkedPayload: linkedSession.linkedPayload,
    protocol: includeProtocol ? linkedSession.protocol : undefined,
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      details
        ? `Request failed with status ${response.status}: ${details}`
        : `Request failed with status ${response.status}`
    );
  }
  return response.json() as Promise<T>;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isLinkedPayload(value: unknown): value is LinkedPayload {
  if (!isRecord(value)) {
    return false;
  }

  return isRecord(value.account) && isRecord(value.credentials);
}

function getLinkedPayloadFromProvisioningResponse(
  raw: Record<string, unknown>
): LinkedPayload | undefined {
  if (isLinkedPayload(raw.linkedPayload)) {
    return raw.linkedPayload;
  }
  if (isLinkedPayload(raw)) {
    return raw;
  }
  return undefined;
}

function normalizeProvisioningSession(raw: unknown): ProvisioningSession {
  if (!isRecord(raw)) {
    throw new Error('Provisioning session response is not an object');
  }

  const sessionId = getOptionalString(raw.sessionId) ?? getOptionalString(raw.id);
  if (!sessionId) {
    throw new Error('Provisioning session response is missing session id');
  }

  const createdAt = getOptionalNumber(raw.createdAt) ?? Date.now();

  return {
    sessionId,
    status: getOptionalString(raw.status) ?? getOptionalString(raw.state) ?? 'pending',
    url: getOptionalString(raw.url) ?? getOptionalString(raw.provisioningUrl),
    error: getOptionalString(raw.error),
    createdAt,
    updatedAt: getOptionalNumber(raw.updatedAt) ?? createdAt,
    linkedPayload: getLinkedPayloadFromProvisioningResponse(raw),
  };
}

export async function startProvisioningSession(
  deviceName: string
): Promise<ProvisioningSession> {
  const response = await fetch(apiUrl('/provisioning/sessions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ deviceName }),
  });
  return normalizeProvisioningSession(await parseJsonResponse(response));
}

export async function getProvisioningSession(
  sessionId: string
): Promise<ProvisioningSession> {
  const response = await fetch(apiUrl(`/provisioning/sessions/${sessionId}`));
  return normalizeProvisioningSession(await parseJsonResponse(response));
}

export async function getProvisioningLinkedSession(
  sessionId: string
): Promise<LinkedPayload> {
  const response = await fetch(
    apiUrl(`/provisioning/sessions/${sessionId}/linked-session`)
  );
  if (response.ok) {
    return parseJsonResponse(response);
  }

  if (response.status === 404) {
    const session = await getProvisioningSession(sessionId);
    if (session.linkedPayload) {
      return session.linkedPayload;
    }
  }

  return parseJsonResponse(response);
}

export async function consumeMessageTransportStream({
  importBackup = true,
  linkedSession,
  includeProtocol = false,
  signal,
  onEvent,
}: Readonly<{
  importBackup?: boolean;
  linkedSession: LinkedSessionRecord;
  includeProtocol?: boolean;
  signal: AbortSignal;
  onEvent: (event: MessageStreamEvent) => void;
}>): Promise<void> {
  const response = await fetch(apiUrl('/messages/stream'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      {
        ...getLinkedSessionRequestBody(linkedSession, includeProtocol),
        importBackup,
      }
    ),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to open message stream: ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Message stream did not return a readable body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let runtimeSessionId: string | undefined;
  const handleStreamEvent = (event: MessageStreamEvent) => {
    onEvent(event);
    if (event.type === 'session') {
      runtimeSessionId = event.sessionId;
      currentMessageRuntimeSessionId = event.sessionId;
    }
    if (event.streamEventId) {
      void acknowledgeMessageStreamEvent({
        aci: linkedSession.credentials?.aci ?? linkedSession.account.aci,
        eventId: event.streamEventId,
        runtimeSessionId,
      });
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        handleStreamEvent(JSON.parse(trimmed) as MessageStreamEvent);
      }
    }
  }
  const remaining = buffer.trim();
  if (remaining) {
    handleStreamEvent(JSON.parse(remaining) as MessageStreamEvent);
  }
}

export async function acknowledgeMessageStreamEvent({
  aci,
  eventId,
  runtimeSessionId,
}: Readonly<{
  aci?: string;
  eventId: string;
  runtimeSessionId?: string;
}>): Promise<void> {
  await fetch(apiUrl('/messages/stream/ack'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      aci,
      eventId,
      sessionId: runtimeSessionId,
    }),
  });
}

export async function sendDirectTextMessage({
  runtimeSessionId,
  destinationServiceId,
  body,
  timestamp,
  attachments,
  isViewOnce,
  pinMessage,
  unpinMessage,
  quote,
}: Readonly<{
  runtimeSessionId?: string;
  destinationServiceId: string;
  body: string;
  timestamp: number;
  attachments?: ReadonlyArray<WebAttachment>;
  isViewOnce?: boolean;
  pinMessage?: WebPinMessage;
  unpinMessage?: WebUnpinMessage;
  quote?: WebMessage['quote'];
}>): Promise<WebMessage & { attachments?: ReadonlyArray<WebAttachment> }> {
  const response = await fetch(apiUrl('/messages/send'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: runtimeSessionId,
      destinationServiceId,
      body,
      timestamp,
      attachments,
      isViewOnce,
      pinMessage,
      unpinMessage,
      quote,
    }),
  });
  return parseJsonResponse(response);
}

export async function sendDirectDeleteForEveryone({
  runtimeSessionId,
  destinationServiceId,
  deleteForEveryone,
  timestamp,
}: Readonly<{
  runtimeSessionId?: string;
  destinationServiceId: string;
  deleteForEveryone: WebDeleteForEveryone;
  timestamp: number;
}>): Promise<void> {
  const response = await fetch(apiUrl('/messages/send'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: runtimeSessionId,
      destinationServiceId,
      body: '',
      timestamp,
      deleteForEveryone,
    }),
  });
  await parseJsonResponse(response);
}

export async function sendDirectUnpinMessage({
  runtimeSessionId,
  destinationServiceId,
  unpinMessage,
  timestamp,
}: Readonly<{
  runtimeSessionId?: string;
  destinationServiceId: string;
  unpinMessage: WebUnpinMessage;
  timestamp: number;
}>): Promise<WebMessage> {
  const response = await fetch(apiUrl('/messages/send'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: runtimeSessionId,
      destinationServiceId,
      body: '',
      timestamp,
      unpinMessage,
    }),
  });
  return parseJsonResponse(response);
}

function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

async function getImageMetadata(file: File): Promise<Partial<WebAttachment>> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Failed to load image metadata'));
    });
    image.src = objectUrl;
    await loaded;
    return {
      width: image.naturalWidth || undefined,
      height: image.naturalHeight || undefined,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function getVideoMetadata(file: File): Promise<Partial<WebAttachment>> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.playsInline = true;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Failed to load video metadata'));
      video.src = objectUrl;
    });

    const width = video.videoWidth || undefined;
    const height = video.videoHeight || undefined;
    const duration =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : undefined;

    let thumbnailUrl: string | undefined;
    if (width && height) {
      try {
        if (duration && duration > 0.2) {
          await new Promise<void>((resolve, reject) => {
            video.onseeked = () => resolve();
            video.onerror = () => reject(new Error('Failed to seek video'));
            video.currentTime = 0.1;
          });
        } else {
          await new Promise<void>(resolve => {
            if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              resolve();
              return;
            }
            video.onloadeddata = () => resolve();
          });
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.drawImage(video, 0, 0, width, height);
        thumbnailUrl = canvas.toDataURL('image/jpeg', 0.82);
      } catch {
        thumbnailUrl = undefined;
      }
    }

    video.removeAttribute('src');
    video.load();

    return {
      width,
      height,
      duration,
      thumbnailUrl,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function getLocalAttachmentMetadata(
  file: File
): Promise<Partial<WebAttachment>> {
  const contentType = getWebAttachmentContentType(file);
  if (contentType.startsWith('image/')) {
    return getImageMetadata(file);
  }
  if (contentType.startsWith('video/')) {
    return getVideoMetadata(file);
  }
  return {};
}

export async function uploadMessageAttachment({
  file,
  runtimeSessionId,
}: Readonly<{
  file: File;
  runtimeSessionId?: string;
}>): Promise<WebAttachment> {
  const contentType = getWebAttachmentContentType(file);
  const metadata = await getLocalAttachmentMetadata(file);
  const response = await fetch(apiUrl('/messages/attachment/upload'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contentType,
      dataBase64: arrayBufferToBase64(await file.arrayBuffer()),
      fileName:
        contentType.startsWith('image/') || contentType.startsWith('video/')
          ? undefined
          : file.name,
      sessionId: runtimeSessionId,
      size: file.size,
    }),
  });
  return {
    ...(await parseJsonResponse(response)),
    contentType,
    fileName:
      contentType.startsWith('image/') || contentType.startsWith('video/')
        ? undefined
        : file.name,
    ...metadata,
  };
}

export async function sendDirectReaction({
  runtimeSessionId,
  destinationServiceId,
  emoji,
  remove,
  targetAuthorAci,
  targetTimestamp,
  timestamp,
}: Readonly<{
  runtimeSessionId?: string;
  destinationServiceId: string;
  emoji?: string;
  remove: boolean;
  targetAuthorAci: string;
  targetTimestamp: number;
  timestamp: number;
}>): Promise<{ ok: true; timestamp: number }> {
  const response = await fetch(apiUrl('/messages/reaction'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: runtimeSessionId,
      destinationServiceId,
      emoji,
      remove,
      targetAuthorAci,
      targetTimestamp,
      timestamp,
    }),
  });
  return parseJsonResponse(response);
}

export async function sendGroupReaction({
  runtimeSessionId,
  emoji,
  groupId,
  groupV2,
  recipients,
  remove,
  targetAuthorAci,
  targetTimestamp,
  timestamp,
}: Readonly<{
  runtimeSessionId?: string;
  emoji?: string;
  groupId: string;
  groupV2?: Readonly<{
    masterKey: string;
    revision: number;
  }>;
  recipients?: ReadonlyArray<string>;
  remove: boolean;
  targetAuthorAci: string;
  targetTimestamp: number;
  timestamp: number;
}>): Promise<{ ok: true; timestamp: number }> {
  const response = await fetch(apiUrl('/messages/reaction'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: runtimeSessionId,
      emoji,
      groupId,
      groupV2,
      recipients,
      remove,
      targetAuthorAci,
      targetTimestamp,
      timestamp,
    }),
  });
  return parseJsonResponse(response);
}

export async function sendDirectEditMessage({
  runtimeSessionId,
  destinationServiceId,
  body,
  targetTimestamp,
  timestamp,
}: Readonly<{
  runtimeSessionId?: string;
  destinationServiceId: string;
  body: string;
  targetTimestamp: number;
  timestamp: number;
}>): Promise<{ ok: true; timestamp: number }> {
  const response = await fetch(apiUrl('/messages/edit'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: runtimeSessionId,
      destinationServiceId,
      body,
      targetTimestamp,
      timestamp,
    }),
  });
  return parseJsonResponse(response);
}

export async function sendGroupTextMessage({
  runtimeSessionId,
  groupId,
  body,
  timestamp,
  attachments,
  deleteForEveryone,
  groupV2,
  isViewOnce,
  pinMessage,
  quote,
  recipients,
  unpinMessage,
}: Readonly<{
  runtimeSessionId?: string;
  groupId: string;
  body: string;
  timestamp: number;
  attachments?: ReadonlyArray<WebAttachment>;
  deleteForEveryone?: WebDeleteForEveryone;
  groupV2?: Readonly<{
    masterKey: string;
    revision: number;
  }>;
  isViewOnce?: boolean;
  pinMessage?: WebPinMessage;
  quote?: WebMessage['quote'];
  recipients?: ReadonlyArray<string>;
  unpinMessage?: WebUnpinMessage;
}>): Promise<WebMessage & { attachments?: ReadonlyArray<WebAttachment> }> {
  const response = await fetch(apiUrl('/messages/send-group'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: runtimeSessionId,
      groupId,
      body,
      timestamp,
      attachments,
      deleteForEveryone,
      groupV2,
      isViewOnce,
      pinMessage,
      quote,
      recipients,
      unpinMessage,
    }),
  });
  return parseJsonResponse(response);
}

export async function modifyGroupMember({
  action,
  conversation,
  recipients,
  runtimeSessionId,
  targetConversation,
  targetServiceId,
}: Readonly<{
  action: 'add' | 'make-admin' | 'make-member' | 'remove';
  conversation: WebConversation;
  recipients: ReadonlyArray<string>;
  runtimeSessionId?: string;
  targetConversation?: WebConversation;
  targetServiceId: string;
}>): Promise<{
  groupChangeBase64: string;
  revision: number;
}> {
  const response = await fetch(apiUrl('/groups/member'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action,
      conversation,
      recipients,
      sessionId: runtimeSessionId,
      targetConversation,
      targetServiceId,
    }),
  });
  return parseJsonResponse(response);
}

export async function modifyGroupSettings({
  action,
  conversation,
  runtimeSessionId,
  recipients,
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
  conversation: WebConversation;
  recipients: ReadonlyArray<string>;
  runtimeSessionId?: string;
  value: boolean | number | string;
}>): Promise<{
  groupChangeBase64: string;
  revision: number;
}> {
  const response = await fetch(apiUrl('/groups/settings'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action,
      conversation,
      recipients,
      sessionId: runtimeSessionId,
      value,
    }),
  });
  return parseJsonResponse(response);
}

export async function sendMessageRequestResponseSync({
  runtimeSessionId,
  threadAci,
  timestamp,
  type,
}: Readonly<{
  runtimeSessionId?: string;
  threadAci: string;
  timestamp: number;
  type: number;
}>): Promise<{
  threadAci: string;
  timestamp: number;
  type: number;
}> {
  const response = await fetch(apiUrl('/messages/message-request-response'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: runtimeSessionId,
      threadAci,
      timestamp,
      type,
    }),
  });
  return parseJsonResponse(response);
}

export async function syncContacts({
  runtimeSessionId,
}: Readonly<{
  runtimeSessionId?: string;
}>): Promise<ContactsBootstrap> {
  const response = await fetch(apiUrl('/contacts/sync'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: runtimeSessionId,
    }),
  });
  return parseJsonResponse(response);
}

export async function requestAttachmentBackfill({
  conversationId,
  conversationType,
  runtimeSessionId,
  targetAuthorAci,
  targetSentTimestamp,
}: Readonly<{
  conversationId: string;
  conversationType: 'direct' | 'group';
  runtimeSessionId?: string;
  targetAuthorAci: string;
  targetSentTimestamp: number;
}>): Promise<{
  conversationId: string;
  targetAuthorAci: string;
  targetSentTimestamp: number;
  timestamp: number;
}> {
  const response = await fetch(apiUrl('/messages/attachment/backfill'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: runtimeSessionId,
      conversationId,
      conversationType,
      targetAuthorAci,
      targetSentTimestamp,
      timestamp: Date.now(),
    }),
  });
  return parseJsonResponse(response);
}

export function buildAttachmentAccessUrl(attachment: WebAttachment): string {
  if (attachment.downloadUrl) {
    return attachment.downloadUrl;
  }
  if (attachment.url) {
    return attachment.url;
  }
  if (attachment.dataBase64 && attachment.contentType) {
    return `data:${attachment.contentType};base64,${attachment.dataBase64}`;
  }
  const keyBase64 = attachment.keyBase64 ?? attachment.key;
  const hasBackupMediaTierFields =
    Boolean(attachment.plaintextHash) &&
    Boolean(keyBase64);
  if (!attachment.cdnId && !attachment.cdnKey && !hasBackupMediaTierFields) {
    return '';
  }

  const params = new URLSearchParams();
  if (attachment.cdnId) {
    params.set('cdnId', attachment.cdnId);
  }
  if (attachment.cdnKey) {
    params.set('cdnKey', attachment.cdnKey);
  }
  const digestBase64 = attachment.digestBase64 ?? attachment.digest;
  const incrementalMacBase64 =
    attachment.incrementalMacBase64 ?? attachment.incrementalMac;

  if (keyBase64) {
    params.set('keyBase64', keyBase64);
  }
  if (attachment.size != null) {
    params.set('size', String(attachment.size));
  }
  if (attachment.cdnNumber != null) {
    params.set('cdnNumber', String(attachment.cdnNumber));
  }
  if (attachment.backupCdnNumber != null) {
    params.set('backupCdnNumber', String(attachment.backupCdnNumber));
  }
  if (currentMessageRuntimeSessionId) {
    params.set('sessionId', currentMessageRuntimeSessionId);
  }
  if (digestBase64) {
    params.set('digestBase64', digestBase64);
  }
  if (attachment.plaintextHash) {
    params.set('plaintextHash', attachment.plaintextHash);
  }
  if (incrementalMacBase64) {
    params.set('incrementalMacBase64', incrementalMacBase64);
  }
  if (attachment.chunkSize != null) {
    params.set('chunkSize', String(attachment.chunkSize));
  }
  if (attachment.contentType) {
    params.set('contentType', attachment.contentType);
  }
  if (attachment.fileName) {
    params.set('fileName', attachment.fileName);
  }

  return apiUrl(`/messages/attachment?${params.toString()}`).toString();
}
