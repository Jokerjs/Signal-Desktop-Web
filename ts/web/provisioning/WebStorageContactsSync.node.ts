// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { Buffer } from 'node:buffer';
import https from 'node:https';
import type { AuthenticatedChatConnection } from '@signalapp/libsignal-client/dist/net.js';

import * as Bytes from '../../Bytes.std.ts';
import {
  decryptProfile,
  deriveStorageItemKey,
  deriveStorageManifestKey,
} from '../../Crypto.node.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import type { ServiceIdString } from '../../types/ServiceId.std.ts';
import {
  fromAciUuidBytesOrString,
  fromPniUuidBytesOrUntaggedString,
} from '../../util/ServiceId.node.ts';
import {
  deriveGroupID,
  deriveGroupPublicParams,
  deriveGroupSecretParams,
  deriveProfileKeyVersion,
} from '../../util/zkgroup.node.ts';
import { MY_STORY_ID } from '../../types/Stories.std.ts';
import type {
  ContactsBootstrap,
  LinkedPayload,
  WebConversation,
} from '../types.std.ts';
import { enrichGroupConversations } from './WebGroupStateSync.node.ts';

type StorageCredentials = Readonly<{
  username: string;
  password: string;
}>;

type SyncStorageContactsOptions = Readonly<{
  allowInsecureTls?: boolean;
  chat: AuthenticatedChatConnection;
  cdnUrl: string;
  linkedPayload: LinkedPayload;
  storageUrl: string;
}>;

const MAX_READ_KEYS = 100;
const MAX_PROFILE_AVATAR_FETCHES_PER_BATCH = 8;

type ProfileResponse = Readonly<{
  avatar?: string;
}>;

function toNumber(value: bigint | number | null | undefined): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return undefined;
}

function fromAvatarColor(
  color: (
    | Proto.ContactRecord
    | Proto.GroupV2Record
    | Proto.AccountRecord
  )['avatarColor'] | undefined
): string | undefined {
  switch (color) {
    case Proto.AvatarColor.A100:
      return 'A100';
    case Proto.AvatarColor.A110:
      return 'A110';
    case Proto.AvatarColor.A120:
      return 'A120';
    case Proto.AvatarColor.A130:
      return 'A130';
    case Proto.AvatarColor.A140:
      return 'A140';
    case Proto.AvatarColor.A150:
      return 'A150';
    case Proto.AvatarColor.A160:
      return 'A160';
    case Proto.AvatarColor.A170:
      return 'A170';
    case Proto.AvatarColor.A180:
      return 'A180';
    case Proto.AvatarColor.A190:
      return 'A190';
    case Proto.AvatarColor.A200:
      return 'A200';
    case Proto.AvatarColor.A210:
      return 'A210';
    case undefined:
    case null:
      return undefined;
    default:
      return 'A100';
  }
}

function getContactTitle(contact: Proto.ContactRecord, fallback: string): string {
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
  const profileName = [contact.givenName, contact.familyName]
    .filter(Boolean)
    .join(' ')
    .trim();

  return nickname || systemName || profileName || contact.username || fallback;
}

function getContactConversation(contact: Proto.ContactRecord): WebConversation | undefined {
  const aci = fromAciUuidBytesOrString(
    contact.aciBinary,
    contact.aci,
    'webStorage.contact.aci'
  );
  const pni = fromPniUuidBytesOrUntaggedString(
    contact.pniBinary,
    contact.pni,
    'webStorage.contact.pni'
  );
  const id = aci ?? pni ?? contact.e164;
  if (!id) {
    return undefined;
  }

  const title = getContactTitle(contact, contact.e164 || id);
  const profileSharing = Boolean(contact.whitelisted);
  return {
    acceptedMessageRequest: !contact.hidden && profileSharing,
    color: fromAvatarColor(contact.avatarColor),
    conversationType: 'direct',
    e164: contact.e164 || undefined,
    hasMessages: false,
    id,
    isArchived: Boolean(contact.archived),
    isBlocked: Boolean(contact.blocked),
    markedUnread: Boolean(contact.markedUnread),
    phoneNumber: contact.e164 || undefined,
    profileKey: contact.profileKey?.byteLength
      ? Bytes.toBase64(contact.profileKey)
      : undefined,
    profileFamilyName: contact.familyName || undefined,
    profileName: contact.givenName || undefined,
    profileSharing,
    removalStage: contact.hidden ? 'justNotification' : undefined,
    searchableTitle: title,
    serviceId: aci,
    title,
    titleNoDefault: title,
    type: 'direct',
    username: contact.username || undefined,
  };
}

function getImageContentType(
  data: Uint8Array<ArrayBuffer>
): string | undefined {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

function fetchProfileAvatarBytesAllowingInsecureTls({
  avatarPath,
  url,
}: Readonly<{
  avatarPath: string;
  url: URL;
}>): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { rejectUnauthorized: false },
      response => {
        const chunks = new Array<Buffer>();
        response.on('data', chunk => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                `profile avatar ${avatarPath} failed with status ${statusCode}: ${bytes.toString('utf8')}`
              )
            );
            return;
          }
          resolve(new Uint8Array(bytes) as Uint8Array<ArrayBuffer>);
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

async function fetchProfileAvatarBytes({
  allowInsecureTls,
  avatarPath,
  cdnUrl,
}: Readonly<{
  allowInsecureTls?: boolean;
  avatarPath: string;
  cdnUrl: string;
}>): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL(`${cdnUrl.replace(/\/$/, '')}/${avatarPath}`);
  try {
    const response = await fetch(url);
    const bytes = new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>;
    if (!response.ok) {
      throw new Error(
        `profile avatar ${avatarPath} failed with status ${response.status}: ${Buffer.from(bytes).toString('utf8')}`
      );
    }
    return bytes;
  } catch (error) {
    if (!allowInsecureTls) {
      throw error;
    }
  }

  return fetchProfileAvatarBytesAllowingInsecureTls({ avatarPath, url });
}

async function fetchContactProfileAvatarUrl({
  allowInsecureTls,
  cdnUrl,
  chat,
  conversation,
}: Readonly<{
  allowInsecureTls?: boolean;
  cdnUrl: string;
  chat: AuthenticatedChatConnection;
  conversation: WebConversation;
}>): Promise<string | undefined> {
  const { profileKey, serviceId } = conversation;
  if (!profileKey || !serviceId) {
    return undefined;
  }

  const profileKeyVersion = deriveProfileKeyVersion(
    profileKey,
    serviceId as ServiceIdString
  );
  const response = await chat.fetch({
    verb: 'GET',
    path: `/v1/profile/${serviceId}/${profileKeyVersion}`,
    headers: [],
    timeoutMillis: 30_000,
  });
  const responseBody = Buffer.from(response.body ?? new Uint8Array()).toString(
    'utf8'
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      responseBody
        ? `profile ${serviceId} failed with status ${response.status}: ${responseBody}`
        : `profile ${serviceId} failed with status ${response.status}`
    );
  }

  const profile = JSON.parse(responseBody) as ProfileResponse;
  if (!profile.avatar) {
    return undefined;
  }

  const encryptedAvatar = await fetchProfileAvatarBytes({
    allowInsecureTls,
    avatarPath: profile.avatar,
    cdnUrl,
  });
  const decryptedAvatar = decryptProfile(
    encryptedAvatar,
    Bytes.fromBase64(profileKey)
  );
  const contentType = getImageContentType(decryptedAvatar);
  if (!contentType) {
    return undefined;
  }

  return `data:${contentType};base64,${Buffer.from(decryptedAvatar).toString(
    'base64'
  )}`;
}

async function addProfileAvatars({
  allowInsecureTls,
  cdnUrl,
  chat,
  conversations,
}: Readonly<{
  allowInsecureTls?: boolean;
  cdnUrl: string;
  chat: AuthenticatedChatConnection;
  conversations: ReadonlyArray<WebConversation>;
}>): Promise<Array<WebConversation>> {
  const result = [...conversations];
  for (
    let index = 0;
    index < result.length;
    index += MAX_PROFILE_AVATAR_FETCHES_PER_BATCH
  ) {
    const batch = result.slice(index, index + MAX_PROFILE_AVATAR_FETCHES_PER_BATCH);
    // eslint-disable-next-line no-await-in-loop
    const avatars = await Promise.all(
      batch.map(async conversation => {
        try {
          return await fetchContactProfileAvatarUrl({
            allowInsecureTls,
            cdnUrl,
            chat,
            conversation,
          });
        } catch {
          return undefined;
        }
      })
    );
    avatars.forEach((avatarUrl, batchIndex) => {
      if (!avatarUrl) {
        return;
      }
      const conversation = batch[batchIndex];
      if (!conversation) {
        return;
      }
      const resultIndex = index + batchIndex;
      result[resultIndex] = {
        ...conversation,
        avatarUrl,
        hasAvatar: true,
      };
    });
  }
  return result;
}

function getGroupConversation(group: Proto.GroupV2Record): WebConversation | undefined {
  if (!group.masterKey || group.masterKey.byteLength === 0) {
    return undefined;
  }
  const secretParams = deriveGroupSecretParams(group.masterKey);
  const publicParams = deriveGroupPublicParams(secretParams);
  const groupId = Bytes.toBase64(deriveGroupID(secretParams));
  return {
    acceptedMessageRequest: Boolean(group.whitelisted),
    color: fromAvatarColor(group.avatarColor),
    conversationType: 'group',
    groupId,
    hasMessages: false,
    id: groupId,
    isArchived: Boolean(group.archived),
    markedUnread: Boolean(group.markedUnread),
    masterKey: Bytes.toBase64(group.masterKey),
    publicParams: Bytes.toBase64(publicParams),
    revision: 0,
    secretParams: Bytes.toBase64(secretParams),
    profileSharing: Boolean(group.whitelisted),
    type: 'group',
  };
}

function getPinnedConversationId(
  pinned: Proto.AccountRecord.PinnedConversation
): string | undefined {
  const identifier = pinned.identifier;
  const contact = identifier?.contact;
  if (contact) {
    return (
      fromAciUuidBytesOrString(
        contact.serviceIdBinary,
        contact.serviceId,
        'webStorage.pinned.contact'
      ) ??
      contact.e164 ??
      undefined
    );
  }
  const groupMasterKey = identifier?.groupMasterKey;
  if (groupMasterKey && groupMasterKey.byteLength > 0) {
    const secretParams = deriveGroupSecretParams(groupMasterKey);
    return Bytes.toBase64(deriveGroupID(secretParams));
  }
  return undefined;
}

async function getStorageCredentials(
  chat: AuthenticatedChatConnection
): Promise<StorageCredentials> {
  const response = await chat.fetch({
    verb: 'GET',
    path: '/v1/storage/auth',
    headers: [],
    timeoutMillis: 30_000,
  });
  const responseBody = Buffer.from(response.body ?? new Uint8Array()).toString(
    'utf8'
  );
  if (response.status !== 200) {
    throw new Error(
      responseBody
        ? `getStorageCredentials failed with status ${response.status}: ${responseBody}`
        : `getStorageCredentials failed with status ${response.status}`
    );
  }
  return JSON.parse(responseBody) as StorageCredentials;
}

async function fetchStorageBytes({
  allowInsecureTls,
  body,
  credentials,
  method,
  path,
  storageUrl,
}: Readonly<{
  allowInsecureTls?: boolean;
  body?: Uint8Array<ArrayBuffer>;
  credentials: StorageCredentials;
  method: 'GET' | 'PUT';
  path: string;
  storageUrl: string;
}>): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL(path, storageUrl);
  const headers = {
    authorization: `Basic ${Buffer.from(
      `${credentials.username}:${credentials.password}`
    ).toString('base64')}`,
    'content-type': 'application/x-protobuf',
  };
  let response: Response;
  try {
    response = await fetch(url, {
      body,
      headers,
      method,
    });
  } catch (error) {
    if (!allowInsecureTls) {
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? `: ${error.cause.message}`
          : '';
      throw new Error(`${path} fetch failed${cause}`, { cause: error });
    }
    return fetchStorageBytesAllowingInsecureTls({
      body,
      headers,
      method,
      path,
      url,
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>;
  if (!response.ok) {
    const responseBody = Buffer.from(bytes).toString('utf8');
    throw new Error(
      responseBody
        ? `${path} failed with status ${response.status}: ${responseBody}`
        : `${path} failed with status ${response.status}`
    );
  }
  return bytes;
}

function fetchStorageBytesAllowingInsecureTls({
  body,
  headers,
  method,
  path,
  url,
}: Readonly<{
  body?: Uint8Array<ArrayBuffer>;
  headers: Record<string, string>;
  method: 'GET' | 'PUT';
  path: string;
  url: URL;
}>): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        headers,
        method,
        rejectUnauthorized: false,
      },
      response => {
        const chunks = new Array<Buffer>();
        response.on('data', chunk => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                `${path} failed with status ${statusCode}: ${bytes.toString('utf8')}`
              )
            );
            return;
          }
          resolve(new Uint8Array(bytes) as Uint8Array<ArrayBuffer>);
        });
      }
    );
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function chunk<T>(items: ReadonlyArray<T>, size: number): Array<Array<T>> {
  const result = new Array<Array<T>>();
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function fetchStorageRecords({
  allowInsecureTls,
  credentials,
  identifiers,
  storageUrl,
}: Readonly<{
  allowInsecureTls?: boolean;
  credentials: StorageCredentials;
  identifiers: ReadonlyArray<Proto.ManifestRecord.Identifier>;
  storageUrl: string;
}>): Promise<ReadonlyArray<Proto.StorageItem>> {
  const items = new Array<Proto.StorageItem>();
  for (const batch of chunk(identifiers, MAX_READ_KEYS)) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetchStorageBytes({
      allowInsecureTls,
      body: Proto.ReadOperation.encode({
        readKey: batch.map(identifier => identifier.raw),
      }),
      credentials,
      method: 'PUT',
      path: '/v1/storage/read',
      storageUrl,
    });
    items.push(...Proto.StorageItems.decode(response).items);
  }
  return items;
}

export async function syncStorageContacts({
  allowInsecureTls,
  chat,
  cdnUrl,
  linkedPayload,
  storageUrl,
}: SyncStorageContactsOptions): Promise<ContactsBootstrap & {
  source: 'storage';
  storageVersion?: number;
}> {
  const storageServiceKeyBase64 = linkedPayload.storageServiceKey;
  if (!storageServiceKeyBase64) {
    throw new Error('syncStorageContacts: missing storageServiceKey');
  }

  const storageServiceKey = Bytes.fromBase64(storageServiceKeyBase64);
  const credentials = await getStorageCredentials(chat);
  const manifestBytes = await fetchStorageBytes({
    allowInsecureTls,
    credentials,
    method: 'GET',
    path: '/v1/storage/manifest',
    storageUrl,
  });
  const encryptedManifest = Proto.StorageManifest.decode(manifestBytes);
  const manifestKey = deriveStorageManifestKey(
    storageServiceKey,
    encryptedManifest.version
  );
  const manifest = Proto.ManifestRecord.decode(
    decryptProfile(encryptedManifest.value, manifestKey)
  );
  const storageVersion = toNumber(manifest.version);
  const recordIkm = manifest.recordIkm?.byteLength
    ? manifest.recordIkm
    : undefined;
  const records = await fetchStorageRecords({
    allowInsecureTls,
    credentials,
    identifiers: manifest.identifiers,
    storageUrl,
  });

  let accountRecord: Proto.AccountRecord | undefined;
  const conversationsById = new Map<string, WebConversation>();

  for (const item of records) {
    const itemKey = deriveStorageItemKey({
      storageServiceKey,
      recordIkm,
      key: item.key,
    });
    const storageRecord = Proto.StorageRecord.decode(
      decryptProfile(item.value, itemKey)
    );
    const record = storageRecord.record;
    if (record?.account) {
      accountRecord = record.account;
      continue;
    }
    const conversation = record?.contact
      ? getContactConversation(record.contact)
      : record?.groupV2
        ? getGroupConversation(record.groupV2)
        : undefined;
    if (conversation) {
      conversationsById.set(conversation.id, conversation);
    }
  }

  const pinnedIds = new Set(
    (accountRecord?.pinnedConversations ?? [])
      .map(getPinnedConversationId)
      .filter(id => id != null)
  );
  const accountTitle = [
    accountRecord?.givenName,
    accountRecord?.familyName,
  ].filter(Boolean).join(' ').trim();
  const account = {
    ...linkedPayload.account,
    avatarUrlPath: accountRecord?.avatarUrlPath || undefined,
    color: fromAvatarColor(accountRecord?.avatarColor),
    noteToSelfArchived: accountRecord?.noteToSelfArchived,
    noteToSelfMarkedUnread: accountRecord?.noteToSelfMarkedUnread,
    noteToSelfPinned: false,
    profileFamilyName: accountRecord?.familyName || undefined,
    profileName: accountRecord?.givenName || undefined,
    title: accountTitle || linkedPayload.account.title,
    username: accountRecord?.username || undefined,
  };
  const generatedAt = Date.now();
  const enrichedConversations = await enrichGroupConversations({
    allowInsecureTls,
    chat,
    conversations: [...conversationsById.values()],
    linkedPayload,
    storageUrl,
  });
  const conversations = await addProfileAvatars({
    allowInsecureTls,
    cdnUrl,
    chat,
    conversations: enrichedConversations.map(conversation => ({
      ...conversation,
      isPinned: pinnedIds.has(conversation.id),
    })),
  });
  const active = conversations
    .filter(conversation => !conversation.isArchived && conversation.activeAt)
    .sort((left, right) => (right.activeAt ?? 0) - (left.activeAt ?? 0));

  return {
    source: 'storage',
    version: 1,
    storageVersion,
    generatedAt,
    account,
    selectedConversationId: active[0]?.id,
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
  };
}
