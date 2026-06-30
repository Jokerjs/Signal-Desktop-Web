// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  CiphertextMessageType,
  Direction,
  ErrorCode,
  IdentityChange,
  IdentityKeyPair,
  IdentityKeyStore,
  KEMPublicKey,
  KyberPreKeyRecord,
  KyberPreKeyStore,
  PreKeyBundle,
  PreKeySignalMessage,
  PreKeyStore,
  PrivateKey,
  ProtocolAddress,
  PublicKey,
  SenderKeyDistributionMessage,
  SenderKeyRecord,
  SenderKeyStore,
  SessionRecord,
  SessionStore,
  ServiceId,
  SignalMessage,
  SignedPreKeyRecord,
  SignedPreKeyStore,
  groupDecrypt,
  PlaintextContent,
  processSenderKeyDistributionMessage,
  processPreKeyBundle,
  sealedSenderDecryptToUsmc,
  signalDecrypt,
  signalDecryptPreKey,
  signalEncrypt,
} from '@signalapp/libsignal-client';
import type { CiphertextMessage, Uuid } from '@signalapp/libsignal-client';
import type { AuthenticatedChatConnection } from '@signalapp/libsignal-client/dist/net.js';
import type { SingleOutboundUnsealedMessage } from '@signalapp/libsignal-client/dist/net/chat/SingleOutboundMessage.js';

import * as Bytes from '../../Bytes.std.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import {
  fromAciUuidBytes,
  fromAciUuidBytesOrString,
  fromServiceIdBinaryOrString,
  toAciObject,
} from '../../util/ServiceId.node.ts';
import {
  fromServiceIdObject,
  type ServiceIdString,
} from '../../types/ServiceId.std.ts';
import {
  decryptAci,
  decryptGroupBlob,
  decryptServiceId,
  deriveGroupID,
  deriveGroupPublicParams,
  deriveGroupSecretParams,
  getClientZkGroupCipher,
} from '../../util/zkgroup.node.ts';
import { bytesToUuid, uuidToBytes } from '../../util/uuidToBytes.std.ts';
import { DurationInSeconds } from '../../util/durations/duration-in-seconds.std.ts';
import type { AciString } from '../../types/ServiceId.std.ts';
import type {
  WebAttachment,
  WebAttachmentBackfillData,
  WebAttachmentBackfillEvent,
  WebDeleteForEveryone,
  WebDeleteMessageEvent,
  WebEditMessageEvent,
  WebMessage,
  WebPinMessage,
  WebPinMessageEvent,
  WebPollTerminateEvent,
  WebPollVoteEvent,
  WebReceiptEvent,
  WebReactionEvent,
  WebTypingEvent,
  WebUnpinMessage,
  WebUnpinMessageEvent,
} from '../types.std.ts';

export type WebSendLinkedPayload = Readonly<{
  account: Readonly<{
    aci?: string;
    pni?: string;
  }>;
  credentials?: Readonly<{
    aci: string;
    pni?: string;
    deviceId: number;
  }>;
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

type ServerKeys = Readonly<{
  devices: ReadonlyArray<
    Readonly<{
      deviceId: number;
      registrationId: number;
      preKey?: Readonly<{
        keyId: number;
        publicKey: string;
      }>;
      signedPreKey?: Readonly<{
        keyId: number;
        publicKey: string;
        signature: string;
      }>;
      pqPreKey?: Readonly<{
        keyId: number;
        publicKey: string;
        signature: string;
      }>;
    }>
  >;
  identityKey: string;
}>;

type DirectTextSendOptions = Readonly<{
  body: string;
  chat: AuthenticatedChatConnection;
  destinationServiceId: string;
  linkedPayload: WebSendLinkedPayload;
  timestamp: number;
  attachments?: ReadonlyArray<WebAttachment>;
  deleteForEveryone?: WebDeleteForEveryone;
  isViewOnce?: boolean;
  pinMessage?: WebPinMessage;
  unpinMessage?: WebUnpinMessage;
  quote?: WebMessage['quote'];
}>;

type GroupTextSendOptions = Readonly<{
  body: string;
  chat: AuthenticatedChatConnection;
  groupId: string;
  groupV2: Readonly<{
    masterKey: string;
    revision: number;
  }>;
  linkedPayload: WebSendLinkedPayload;
  recipients: ReadonlyArray<string>;
  timestamp: number;
  attachments?: ReadonlyArray<WebAttachment>;
  deleteForEveryone?: WebDeleteForEveryone;
  isViewOnce?: boolean;
  pinMessage?: WebPinMessage;
  quote?: WebMessage['quote'];
  unpinMessage?: WebUnpinMessage;
}>;

type GroupUpdateSendOptions = Readonly<{
  chat: AuthenticatedChatConnection;
  groupChangeBase64: string;
  groupId: string;
  groupV2: GroupTextSendOptions['groupV2'];
  linkedPayload: WebSendLinkedPayload;
  recipients: ReadonlyArray<string>;
  timestamp: number;
}>;

type DirectReactionSendOptions = Readonly<{
  chat: AuthenticatedChatConnection;
  destinationServiceId: string;
  emoji?: string;
  linkedPayload: WebSendLinkedPayload;
  remove: boolean;
  targetAuthorAci: string;
  targetTimestamp: number;
  timestamp: number;
}>;

type AttachmentBackfillRequestOptions = Readonly<{
  chat: AuthenticatedChatConnection;
  conversationId: string;
  conversationType: 'direct' | 'group';
  linkedPayload: WebSendLinkedPayload;
  targetAuthorAci: string;
  targetSentTimestamp: number;
  timestamp: number;
}>;

type GroupReactionSendOptions = Readonly<{
  chat: AuthenticatedChatConnection;
  emoji?: string;
  groupId: string;
  groupV2: GroupTextSendOptions['groupV2'];
  linkedPayload: WebSendLinkedPayload;
  recipients: ReadonlyArray<string>;
  remove: boolean;
  targetAuthorAci: string;
  targetTimestamp: number;
  timestamp: number;
}>;

type DirectEditSendOptions = Readonly<{
  body: string;
  chat: AuthenticatedChatConnection;
  destinationServiceId: string;
  linkedPayload: WebSendLinkedPayload;
  targetTimestamp: number;
  timestamp: number;
}>;

type MessageRequestResponseSyncOptions = Readonly<{
  chat: AuthenticatedChatConnection;
  linkedPayload: WebSendLinkedPayload;
  threadAci: string;
  timestamp: number;
  type: number;
}>;

type PersistedProtocolSessions = {
  sessions?: Record<string, Record<string, string>>;
  senderKeys?: Record<string, Record<string, string>>;
};

const PROTOCOL_STORE_PATH = resolve(
  process.env.SIGNAL_WEB_PROTOCOL_STORE_PATH ??
    '.signal-web/protocol-sessions.json'
);

function readPersistedProtocolSessions(): PersistedProtocolSessions {
  if (!existsSync(PROTOCOL_STORE_PATH)) {
    return {};
  }
  return JSON.parse(readFileSync(PROTOCOL_STORE_PATH, 'utf8')) as PersistedProtocolSessions;
}

function writePersistedProtocolSessions(data: PersistedProtocolSessions): void {
  mkdirSync(dirname(PROTOCOL_STORE_PATH), { recursive: true });
  writeFileSync(PROTOCOL_STORE_PATH, `${JSON.stringify(data, null, 2)}\n`);
}

function loadPersistedSessions(namespace: string): Map<string, SessionRecord> {
  const persisted = readPersistedProtocolSessions().sessions?.[namespace] ?? {};
  return new Map(
    Object.entries(persisted).map(([addressKey, serialized]) => [
      addressKey,
      SessionRecord.deserialize(Bytes.fromBase64(serialized)),
    ])
  );
}

function persistSessionRecord(
  namespace: string,
  addressKey: string,
  record: SessionRecord
): void {
  const data = readPersistedProtocolSessions();
  data.sessions ??= {};
  data.sessions[namespace] ??= {};
  data.sessions[namespace][addressKey] = Bytes.toBase64(record.serialize());
  writePersistedProtocolSessions(data);
}

function removePersistedSessionRecord(namespace: string, addressKey: string): void {
  const data = readPersistedProtocolSessions();
  if (!data.sessions?.[namespace]) {
    return;
  }
  delete data.sessions[namespace][addressKey];
  writePersistedProtocolSessions(data);
}

function getSenderKeyPersistenceKey(
  sender: ProtocolAddress,
  distributionId: Uuid
): string {
  return `${getProtocolAddressKey(sender)}:${distributionId}`;
}

function loadPersistedSenderKeys(namespace: string): Map<string, SenderKeyRecord> {
  const persisted = readPersistedProtocolSessions().senderKeys?.[namespace] ?? {};
  return new Map(
    Object.entries(persisted).map(([senderKey, serialized]) => [
      senderKey,
      SenderKeyRecord.deserialize(Bytes.fromBase64(serialized)),
    ])
  );
}

function persistSenderKeyRecord(
  namespace: string,
  senderKey: string,
  record: SenderKeyRecord
): void {
  const data = readPersistedProtocolSessions();
  data.senderKeys ??= {};
  data.senderKeys[namespace] ??= {};
  data.senderKeys[namespace][senderKey] = Bytes.toBase64(record.serialize());
  writePersistedProtocolSessions(data);
}

class WebSessionStore extends SessionStore {
  readonly #namespace: string;
  readonly #sessions = new Map<string, SessionRecord>();

  public constructor(namespace: string) {
    super();
    this.#namespace = namespace;
    this.#sessions = loadPersistedSessions(namespace);
  }

  override async saveSession(
    address: ProtocolAddress,
    record: SessionRecord
  ): Promise<void> {
    const addressKey = getProtocolAddressKey(address);
    this.#sessions.set(addressKey, record);
    persistSessionRecord(this.#namespace, addressKey, record);
  }

  override async getSession(address: ProtocolAddress): Promise<SessionRecord | null> {
    return this.#sessions.get(getProtocolAddressKey(address)) ?? null;
  }

  override async getExistingSessions(
    addresses: Array<ProtocolAddress>
  ): Promise<Array<SessionRecord>> {
    return addresses
      .map(address => this.#sessions.get(getProtocolAddressKey(address)))
      .filter(record => record != null);
  }

  public getKnownSessionsForServiceId(
    serviceId: string,
    localDeviceId: number
  ): Array<Readonly<{ address: ProtocolAddress; record: SessionRecord }>> {
    const result = new Array<
      Readonly<{ address: ProtocolAddress; record: SessionRecord }>
    >();
    const prefix = `${serviceId}.`;
    for (const [addressKey, record] of this.#sessions) {
      if (!addressKey.startsWith(prefix)) {
        continue;
      }
      const deviceIdText = addressKey.slice(prefix.length);
      const deviceId = Number(deviceIdText);
      if (!Number.isInteger(deviceId) || deviceId === localDeviceId) {
        continue;
      }
      result.push({
        address: ProtocolAddress.new(serviceId, deviceId),
        record,
      });
    }
    return result;
  }

  public removeSessionsForServiceId(
    serviceId: string,
    deviceIds: ReadonlyArray<number>
  ): void {
    for (const deviceId of deviceIds) {
      const addressKey = `${serviceId}.${deviceId}`;
      this.#sessions.delete(addressKey);
      removePersistedSessionRecord(this.#namespace, addressKey);
    }
  }

  public removeAllKnownSessionsForServiceId(
    serviceId: string,
    localDeviceId: number
  ): void {
    for (const { address } of this.getKnownSessionsForServiceId(
      serviceId,
      localDeviceId
    )) {
      const addressKey = getProtocolAddressKey(address);
      this.#sessions.delete(addressKey);
      removePersistedSessionRecord(this.#namespace, addressKey);
    }
  }
}

class WebSenderKeyStore extends SenderKeyStore {
  readonly #namespace: string;
  readonly #senderKeys = new Map<string, SenderKeyRecord>();

  public constructor(namespace: string) {
    super();
    this.#namespace = namespace;
    this.#senderKeys = loadPersistedSenderKeys(namespace);
  }

  override async saveSenderKey(
    sender: ProtocolAddress,
    distributionId: Uuid,
    record: SenderKeyRecord
  ): Promise<void> {
    const senderKey = getSenderKeyPersistenceKey(sender, distributionId);
    this.#senderKeys.set(senderKey, record);
    persistSenderKeyRecord(this.#namespace, senderKey, record);
  }

  override async getSenderKey(
    sender: ProtocolAddress,
    distributionId: Uuid
  ): Promise<SenderKeyRecord | null> {
    return this.#senderKeys.get(getSenderKeyPersistenceKey(sender, distributionId)) ?? null;
  }
}

class EmptyWebPreKeyStore extends PreKeyStore {
  override async savePreKey(): Promise<void> {
    throw new Error('EmptyWebPreKeyStore.savePreKey should not be called');
  }

  override async getPreKey(id: number): Promise<never> {
    throw new Error(`EmptyWebPreKeyStore.getPreKey: PreKey ${id} not found`);
  }

  override async removePreKey(): Promise<void> {
    return undefined;
  }
}

class WebSignedPreKeyStore extends SignedPreKeyStore {
  readonly #records = new Map<number, SignedPreKeyRecord>();

  public constructor(records: ReadonlyArray<SignedPreKeyRecord>) {
    super();
    for (const record of records) {
      this.#records.set(record.id(), record);
    }
  }

  override async saveSignedPreKey(): Promise<void> {
    throw new Error('WebSignedPreKeyStore.saveSignedPreKey should not be called');
  }

  override async getSignedPreKey(id: number): Promise<SignedPreKeyRecord> {
    const record = this.#records.get(id);
    if (!record) {
      throw new Error(`WebSignedPreKeyStore.getSignedPreKey: ${id} not found`);
    }
    return record;
  }
}

class WebKyberPreKeyStore extends KyberPreKeyStore {
  readonly #records = new Map<number, KyberPreKeyRecord>();

  public constructor(records: ReadonlyArray<KyberPreKeyRecord>) {
    super();
    for (const record of records) {
      this.#records.set(record.id(), record);
    }
  }

  override async saveKyberPreKey(): Promise<void> {
    throw new Error('WebKyberPreKeyStore.saveKyberPreKey should not be called');
  }

  override async getKyberPreKey(id: number): Promise<KyberPreKeyRecord> {
    const record = this.#records.get(id);
    if (!record) {
      throw new Error(`WebKyberPreKeyStore.getKyberPreKey: ${id} not found`);
    }
    return record;
  }

  override async markKyberPreKeyUsed(): Promise<void> {
    return undefined;
  }
}

class WebIdentityKeyStore extends IdentityKeyStore {
  readonly #identityKeyPair: IdentityKeyPair;
  readonly #registrationId: number;
  readonly #remoteIdentities = new Map<string, PublicKey>();

  public constructor({
    identityKeyPair,
    registrationId,
  }: Readonly<{
    identityKeyPair: IdentityKeyPair;
    registrationId: number;
  }>) {
    super();
    this.#identityKeyPair = identityKeyPair;
    this.#registrationId = registrationId;
  }

  override async getIdentityKey(): Promise<PrivateKey> {
    return this.#identityKeyPair.privateKey;
  }

  override async getIdentityKeyPair(): Promise<IdentityKeyPair> {
    return this.#identityKeyPair;
  }

  override async getLocalRegistrationId(): Promise<number> {
    return this.#registrationId;
  }

  override async saveIdentity(
    address: ProtocolAddress,
    key: PublicKey
  ): Promise<IdentityChange> {
    const addressKey = getProtocolAddressKey(address);
    const existing = this.#remoteIdentities.get(addressKey);
    this.#remoteIdentities.set(addressKey, key);
    return existing && !existing.equals(key)
      ? IdentityChange.ReplacedExisting
      : IdentityChange.NewOrUnchanged;
  }

  override async isTrustedIdentity(
    _address: ProtocolAddress,
    _key: PublicKey,
    _direction: Direction
  ): Promise<boolean> {
    return true;
  }

  override async getIdentity(address: ProtocolAddress): Promise<PublicKey | null> {
    return this.#remoteIdentities.get(getProtocolAddressKey(address)) ?? null;
  }
}

type WebProtocolStore = Readonly<{
  localServiceId: string;
  identityStore: WebIdentityKeyStore;
  kyberPreKeyStore: WebKyberPreKeyStore;
  preKeyStore: EmptyWebPreKeyStore;
  senderKeyStore: WebSenderKeyStore;
  sessionStore: WebSessionStore;
  signedPreKeyStore: WebSignedPreKeyStore;
}>;

const protocolStores = new Map<string, WebProtocolStore>();

function getProtocolAddressKey(address: ProtocolAddress): string {
  return `${address.name()}.${address.deviceId()}`;
}

function getLinkedAci(linkedPayload: WebSendLinkedPayload): string {
  const aci = linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
  if (!aci) {
    throw new Error('sendDirectTextMessage: missing linked ACI');
  }
  return aci;
}

function getLinkedPni(linkedPayload: WebSendLinkedPayload): string | undefined {
  return linkedPayload.credentials?.pni ?? linkedPayload.account.pni;
}

function getErrorSummary(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      value: String(error),
    };
  }

  const extra = error as Error & {
    code?: unknown;
    responseBody?: unknown;
    status?: unknown;
  };

  return {
    name: error.name,
    message: error.message,
    code: extra.code,
    status: extra.status,
    responseBody: extra.responseBody,
  };
}

function deserializeSignedPreKeyRecord(base64: string): SignedPreKeyRecord {
  return SignedPreKeyRecord.deserialize(Bytes.fromBase64(base64));
}

function deserializeKyberPreKeyRecord(base64: string): KyberPreKeyRecord {
  return KyberPreKeyRecord.deserialize(Bytes.fromBase64(base64));
}

export function getLinkedPayloadProtocolKeyIds(
  linkedPayload: WebSendLinkedPayload | undefined
): Record<string, unknown> | undefined {
  if (!linkedPayload) {
    return undefined;
  }

  const result: Record<string, unknown> = {
    protocolPersistenceVersion: linkedPayload.protocolPersistenceVersion,
  };
  if (linkedPayload.aciSignedPreKeyRecordBase64) {
    result.aciSignedPreKeyId = deserializeSignedPreKeyRecord(
      linkedPayload.aciSignedPreKeyRecordBase64
    ).id();
  }
  if (linkedPayload.pniSignedPreKeyRecordBase64) {
    result.pniSignedPreKeyId = deserializeSignedPreKeyRecord(
      linkedPayload.pniSignedPreKeyRecordBase64
    ).id();
  }
  if (linkedPayload.aciPqLastResortPreKeyRecordBase64) {
    result.aciPqLastResortPreKeyId = deserializeKyberPreKeyRecord(
      linkedPayload.aciPqLastResortPreKeyRecordBase64
    ).id();
  }
  if (linkedPayload.pniPqLastResortPreKeyRecordBase64) {
    result.pniPqLastResortPreKeyId = deserializeKyberPreKeyRecord(
      linkedPayload.pniPqLastResortPreKeyRecordBase64
    ).id();
  }
  return result;
}

function getProtocolStoreForServiceId(
  linkedPayload: WebSendLinkedPayload,
  serviceId: string | undefined
): WebProtocolStore {
  const aci = getLinkedAci(linkedPayload);
  const pni = getLinkedPni(linkedPayload);
  const usePni = Boolean(serviceId && pni && serviceId === pni);
  const localServiceId = usePni && pni ? pni : aci;

  const publicKeyBase64 = usePni
    ? linkedPayload.pniIdentityKeyPublic
    : linkedPayload.aciIdentityKeyPublic;
  const privateKeyBase64 = usePni
    ? linkedPayload.pniIdentityKeyPrivate
    : linkedPayload.aciIdentityKeyPrivate;
  const registrationId = usePni
    ? linkedPayload.pniRegistrationId
    : linkedPayload.aciRegistrationId;
  const signedPreKeyRecordBase64 = usePni
    ? linkedPayload.pniSignedPreKeyRecordBase64
    : linkedPayload.aciSignedPreKeyRecordBase64;
  const pqLastResortPreKeyRecordBase64 = usePni
    ? linkedPayload.pniPqLastResortPreKeyRecordBase64
    : linkedPayload.aciPqLastResortPreKeyRecordBase64;
  if (!publicKeyBase64 || !privateKeyBase64) {
    throw new Error(
      `Web protocol store: missing ${usePni ? 'PNI' : 'ACI'} identity key pair`
    );
  }
  if (typeof registrationId !== 'number') {
    throw new Error(
      `Web protocol store: missing ${usePni ? 'PNI' : 'ACI'} registration id`
    );
  }
  if (!signedPreKeyRecordBase64 || !pqLastResortPreKeyRecordBase64) {
    throw new Error(
      `Web protocol store: missing ${usePni ? 'PNI' : 'ACI'} prekey records`
    );
  }
  const signedPreKeyRecord = deserializeSignedPreKeyRecord(
    signedPreKeyRecordBase64
  );
  const pqLastResortPreKeyRecord = deserializeKyberPreKeyRecord(
    pqLastResortPreKeyRecordBase64
  );
  const storeKey = [
    aci,
    usePni ? 'pni' : 'aci',
    localServiceId,
    linkedPayload.credentials?.deviceId,
    registrationId,
    signedPreKeyRecord.id(),
    pqLastResortPreKeyRecord.id(),
  ].join(':');
  const existing = protocolStores.get(storeKey);
  if (existing) {
    return existing;
  }

  const identityKeyPair = new IdentityKeyPair(
    PublicKey.deserialize(Bytes.fromBase64(publicKeyBase64)),
    PrivateKey.deserialize(Bytes.fromBase64(privateKeyBase64))
  );

  const store: WebProtocolStore = {
    localServiceId,
    identityStore: new WebIdentityKeyStore({
      identityKeyPair,
      registrationId,
    }),
    kyberPreKeyStore: new WebKyberPreKeyStore([pqLastResortPreKeyRecord]),
    preKeyStore: new EmptyWebPreKeyStore(),
    senderKeyStore: new WebSenderKeyStore(storeKey),
    sessionStore: new WebSessionStore(storeKey),
    signedPreKeyStore: new WebSignedPreKeyStore([signedPreKeyRecord]),
  };
  protocolStores.set(storeKey, store);
  return store;
}

function getProtocolStore(linkedPayload: WebSendLinkedPayload): WebProtocolStore {
  return getProtocolStoreForServiceId(linkedPayload, getLinkedAci(linkedPayload));
}

function createAttachmentPointer(
  attachment: WebAttachment
): Proto.AttachmentPointer.Params {
  const keyBase64 = attachment.keyBase64 ?? attachment.key;
  const digestBase64 = attachment.digestBase64 ?? attachment.digest;
  const incrementalMacBase64 =
    attachment.incrementalMacBase64 ?? attachment.incrementalMac;

  if ((!attachment.cdnKey && !attachment.cdnId) || !keyBase64 || !digestBase64) {
    throw new Error(
      'createAttachmentPointer: attachment is missing cdnKey or cdnId, keyBase64, or digestBase64'
    );
  }

  return {
    attachmentIdentifier: attachment.cdnKey
      ? {
          cdnKey: attachment.cdnKey,
        }
      : {
          cdnId: BigInt(attachment.cdnId ?? 0),
        },
    cdnNumber: attachment.cdnNumber ?? 0,
    key: Bytes.fromBase64(keyBase64),
    size: attachment.size ?? 0,
    digest: Bytes.fromBase64(digestBase64),
    incrementalMac: incrementalMacBase64
      ? Bytes.fromBase64(incrementalMacBase64)
      : null,
    chunkSize: attachment.chunkSize ?? null,
    uploadTimestamp: null,
    contentType: attachment.contentType ?? 'application/octet-stream',
    fileName: attachment.fileName ?? null,
    flags: attachment.flags ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    caption: attachment.caption ?? null,
    blurHash: attachment.blurHash ?? null,
    clientUuid: attachment.clientUuid ? uuidToBytes(attachment.clientUuid) : null,
    thumbnail: null,
  };
}

function maybeCreateAttachmentPointer(
  attachment: WebAttachment | undefined
): Proto.AttachmentPointer.Params | null {
  if (!attachment) {
    return null;
  }
  try {
    return createAttachmentPointer(attachment);
  } catch {
    return null;
  }
}

function createPinMessage(
  pinMessage: WebPinMessage | undefined
): Proto.DataMessage.PinMessage.Params | null {
  if (!pinMessage) {
    return null;
  }

  return {
    targetAuthorAciBinary: toAciObject(
      pinMessage.targetAuthorAci as AciString
    ).getRawUuidBytes(),
    targetSentTimestamp: BigInt(pinMessage.targetSentTimestamp),
    pinDuration:
      pinMessage.pinDurationSeconds != null
        ? {
            pinDurationSeconds: pinMessage.pinDurationSeconds,
          }
        : {
            pinDurationForever: true,
          },
  };
}

function createUnpinMessage(
  unpinMessage: WebUnpinMessage | undefined
): Proto.DataMessage.UnpinMessage.Params | null {
  if (!unpinMessage) {
    return null;
  }

  return {
    targetAuthorAciBinary: toAciObject(
      unpinMessage.targetAuthorAci as AciString
    ).getRawUuidBytes(),
    targetSentTimestamp: BigInt(unpinMessage.targetSentTimestamp),
  };
}

function createDeleteForEveryoneMessage(
  deleteForEveryone: WebDeleteForEveryone | undefined
): Pick<Proto.DataMessage.Params, 'adminDelete' | 'delete'> {
  if (!deleteForEveryone) {
    return {
      adminDelete: null,
      delete: null,
    };
  }

  if (deleteForEveryone.isAdminDelete) {
    return {
      adminDelete: {
        targetAuthorAciBinary: toAciObject(
          deleteForEveryone.targetAuthorAci as AciString
        ).getRawUuidBytes(),
        targetSentTimestamp: BigInt(deleteForEveryone.targetSentTimestamp),
      },
      delete: null,
    };
  }

  return {
    adminDelete: null,
    delete: {
      targetSentTimestamp: BigInt(deleteForEveryone.targetSentTimestamp),
    },
  };
}

function createQuote(
  quote: WebMessage['quote'] | undefined
): Proto.DataMessage.Quote.Params | null {
  if (!quote || typeof quote.authorAci !== 'string') {
    return null;
  }

  return {
    id: typeof quote.id === 'number' ? BigInt(quote.id) : null,
    authorAci: null,
    authorAciBinary: toAciObject(quote.authorAci as AciString).getRawUuidBytes(),
    text: typeof quote.text === 'string' ? quote.text : null,
    attachments: (quote.attachments ?? []).slice(0, 1).map(attachment => ({
      contentType: attachment.contentType ?? null,
      fileName: attachment.fileName ?? null,
      thumbnail: maybeCreateAttachmentPointer(
        attachment.thumbnail as WebAttachment | undefined
      ),
    })),
    bodyRanges: null,
    type:
      typeof quote.type === 'number'
        ? quote.type
        : Proto.DataMessage.Quote.Type.NORMAL,
  };
}

function createDataMessage({
  attachments = [],
  body,
  deleteForEveryone,
  groupV2,
  isViewOnce = false,
  pinMessage,
  quote,
  timestamp,
  unpinMessage,
}: Readonly<{
  attachments?: ReadonlyArray<WebAttachment>;
  body: string;
  deleteForEveryone?: WebDeleteForEveryone;
  groupV2?: Proto.GroupContextV2.Params;
  isViewOnce?: boolean;
  pinMessage?: WebPinMessage;
  quote?: WebMessage['quote'];
  timestamp: number;
  unpinMessage?: WebUnpinMessage;
}>): Proto.DataMessage.Params {
  const deleteMessages = createDeleteForEveryoneMessage(deleteForEveryone);
  return {
    timestamp: BigInt(timestamp),
    attachments: attachments.map(createAttachmentPointer),
    flags: 0,
    body: body.length > 0 ? body : null,
    bodyRanges: null,
    groupV2: groupV2 ?? null,
    sticker: null,
    reaction: null,
    preview: null,
    contact: null,
    quote: createQuote(quote),
    adminDelete: deleteMessages.adminDelete,
    delete: deleteMessages.delete,
    groupCallUpdate: null,
    storyContext: null,
    pollCreate: null,
    pinMessage: createPinMessage(pinMessage),
    unpinMessage: createUnpinMessage(unpinMessage),
    pollVote: null,
    pollTerminate: null,
    expireTimer: null,
    expireTimerVersion: null,
    profileKey: null,
    isViewOnce,
    requiredProtocolVersion: 0,
    payment: null,
    giftBadge: null,
  };
}

function createReactionDataMessage({
  emoji,
  groupV2,
  remove,
  targetAuthorAci,
  targetTimestamp,
  timestamp,
}: Readonly<{
  emoji?: string;
  groupV2?: Proto.GroupContextV2.Params;
  remove: boolean;
  targetAuthorAci: string;
  targetTimestamp: number;
  timestamp: number;
}>): Proto.DataMessage.Params {
  return {
    ...createDataMessage({ body: '', groupV2, timestamp }),
    body: null,
    reaction: {
      emoji: emoji ?? null,
      remove,
      targetAuthorAci: null,
      targetAuthorAciBinary: toAciObject(targetAuthorAci as AciString).getRawUuidBytes(),
      targetSentTimestamp: BigInt(targetTimestamp),
    },
  };
}

function createTextContent(
  body: string,
  timestamp: number,
  attachments: ReadonlyArray<WebAttachment> = [],
  pinMessage?: WebPinMessage,
  deleteForEveryone?: WebDeleteForEveryone,
  quote?: WebMessage['quote'],
  unpinMessage?: WebUnpinMessage,
  isViewOnce?: boolean,
  groupV2?: Proto.GroupContextV2.Params
): Uint8Array<ArrayBuffer> {
  return padMessage(Proto.Content.encode({
    content: {
      dataMessage: createDataMessage({
        attachments,
        body,
        deleteForEveryone,
        groupV2,
        isViewOnce,
        pinMessage,
        quote,
        timestamp,
        unpinMessage,
      }),
    },
    pniSignatureMessage: null,
    senderKeyDistributionMessage: null,
  }));
}

function createReactionContent(
  options: Readonly<{
    emoji?: string;
    groupV2?: Proto.GroupContextV2.Params;
    remove: boolean;
    targetAuthorAci: string;
    targetTimestamp: number;
    timestamp: number;
  }>
): Uint8Array<ArrayBuffer> {
  return padMessage(Proto.Content.encode({
    content: {
      dataMessage: createReactionDataMessage(options),
    },
    pniSignatureMessage: null,
    senderKeyDistributionMessage: null,
  }));
}

function createEditContent({
  body,
  targetTimestamp,
  timestamp,
}: Readonly<{
  body: string;
  targetTimestamp: number;
  timestamp: number;
}>): Uint8Array<ArrayBuffer> {
  return padMessage(Proto.Content.encode({
    content: {
      editMessage: {
        dataMessage: createDataMessage({ body, timestamp }),
        targetSentTimestamp: BigInt(targetTimestamp),
      },
    },
    pniSignatureMessage: null,
    senderKeyDistributionMessage: null,
  }));
}

function createSentSyncContent({
  attachments = [],
  body,
  deleteForEveryone,
  destinationServiceId,
  groupV2,
  isViewOnce = false,
  pinMessage,
  quote,
  timestamp,
  unpinMessage,
}: Readonly<{
  attachments?: ReadonlyArray<WebAttachment>;
  body: string;
  deleteForEveryone?: WebDeleteForEveryone;
  destinationServiceId?: string;
  groupV2?: Proto.GroupContextV2.Params;
  isViewOnce?: boolean;
  pinMessage?: WebPinMessage;
  quote?: WebMessage['quote'];
  timestamp: number;
  unpinMessage?: WebUnpinMessage;
}>): Uint8Array<ArrayBuffer> {
  return padMessage(Proto.Content.encode({
    content: {
      syncMessage: {
        content: {
          sent: {
            destinationE164: null,
            destinationServiceId: destinationServiceId ?? null,
            destinationServiceIdBinary: null,
            editMessage: null,
            expirationStartTimestamp: null,
            isRecipientUpdate: false,
            message: createDataMessage({
              attachments,
              body,
              deleteForEveryone,
              groupV2,
              isViewOnce,
              pinMessage,
              quote,
              timestamp,
              unpinMessage,
            }),
            storyMessage: null,
            storyMessageRecipients: [],
            timestamp: BigInt(timestamp),
            unidentifiedStatus: [],
          },
        },
        padding: null,
        read: [],
        stickerPackOperation: [],
        viewed: [],
      },
    },
    pniSignatureMessage: null,
    senderKeyDistributionMessage: null,
  }));
}

function createSentReactionSyncContent({
  destinationServiceId,
  emoji,
  groupV2,
  remove,
  targetAuthorAci,
  targetTimestamp,
  timestamp,
}: Readonly<{
  destinationServiceId?: string;
  emoji?: string;
  groupV2?: Proto.GroupContextV2.Params;
  remove: boolean;
  targetAuthorAci: string;
  targetTimestamp: number;
  timestamp: number;
}>): Uint8Array<ArrayBuffer> {
  return padMessage(Proto.Content.encode({
    content: {
      syncMessage: {
        content: {
          sent: {
            destinationE164: null,
            destinationServiceId: destinationServiceId ?? null,
            destinationServiceIdBinary: null,
            editMessage: null,
            expirationStartTimestamp: null,
            isRecipientUpdate: false,
            message: createReactionDataMessage({
              emoji,
              groupV2,
              remove,
              targetAuthorAci,
              targetTimestamp,
              timestamp,
            }),
            storyMessage: null,
            storyMessageRecipients: [],
            timestamp: BigInt(timestamp),
            unidentifiedStatus: [],
          },
        },
        padding: null,
        read: [],
        stickerPackOperation: [],
        viewed: [],
      },
    },
    pniSignatureMessage: null,
    senderKeyDistributionMessage: null,
  }));
}

function createSentEditSyncContent({
  body,
  destinationServiceId,
  targetTimestamp,
  timestamp,
}: Readonly<{
  body: string;
  destinationServiceId: string;
  targetTimestamp: number;
  timestamp: number;
}>): Uint8Array<ArrayBuffer> {
  return padMessage(Proto.Content.encode({
    content: {
      syncMessage: {
        content: {
          sent: {
            destinationE164: null,
            destinationServiceId,
            destinationServiceIdBinary: null,
            editMessage: {
              dataMessage: createDataMessage({ body, timestamp }),
              targetSentTimestamp: BigInt(targetTimestamp),
            },
            expirationStartTimestamp: null,
            isRecipientUpdate: false,
            message: null,
            storyMessage: null,
            storyMessageRecipients: [],
            timestamp: BigInt(timestamp),
            unidentifiedStatus: [],
          },
        },
        padding: null,
        read: [],
        stickerPackOperation: [],
        viewed: [],
      },
    },
    pniSignatureMessage: null,
    senderKeyDistributionMessage: null,
  }));
}

function createMessageRequestResponseSyncContent({
  threadAci,
  type,
}: Readonly<{
  threadAci: string;
  type: number;
}>): Uint8Array<ArrayBuffer> {
  return padMessage(Proto.Content.encode({
    content: {
      syncMessage: {
        content: {
          messageRequestResponse: {
            groupId: null,
            threadAci: null,
            threadAciBinary: toAciObject(threadAci as AciString).getRawUuidBytes(),
            type,
          },
        },
        padding: null,
        read: [],
        stickerPackOperation: [],
        viewed: [],
      },
    },
    pniSignatureMessage: null,
    senderKeyDistributionMessage: null,
  }));
}

function createAttachmentBackfillRequestSyncContent({
  conversationId,
  conversationType,
  targetAuthorAci,
  targetSentTimestamp,
}: Readonly<{
  conversationId: string;
  conversationType: 'direct' | 'group';
  targetAuthorAci: string;
  targetSentTimestamp: number;
}>): Uint8Array<ArrayBuffer> {
  const targetConversation: Proto.ConversationIdentifier.Params =
    conversationType === 'group'
      ? {
          identifier: {
            threadGroupId: Bytes.fromBase64(conversationId),
          },
        }
      : {
          identifier: {
            threadServiceId: conversationId,
          },
        };

  return padMessage(Proto.Content.encode({
    content: {
      syncMessage: {
        content: {
          attachmentBackfillRequest: {
            targetConversation,
            targetMessage: {
              author: {
                authorServiceId: targetAuthorAci,
              },
              sentTimestamp: BigInt(targetSentTimestamp),
            },
          },
        },
        padding: null,
        read: [],
        stickerPackOperation: [],
        viewed: [],
      },
    },
    pniSignatureMessage: null,
    senderKeyDistributionMessage: null,
  }));
}

function padMessage(messageBuffer: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const paddingBlock = 80;
  const messageLengthWithTerminator = messageBuffer.byteLength + 1;
  const paddedLength =
    Math.ceil(messageLengthWithTerminator / paddingBlock) * paddingBlock;
  const plaintext = new Uint8Array(paddedLength - 1);
  plaintext.set(messageBuffer);
  plaintext[messageBuffer.byteLength] = 0x80;
  return plaintext;
}

function toNumber(value: bigint | number | null | undefined): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return undefined;
}

function isWebAttachment(
  attachment: WebAttachment | undefined
): attachment is WebAttachment {
  return attachment != null;
}

function bytesToBase64(
  value: Uint8Array<ArrayBuffer> | null | undefined
): string | undefined {
  if (!value || value.byteLength === 0) {
    return undefined;
  }

  return Bytes.toBase64(value);
}

function convertAttachmentPointer(
  attachment: Proto.AttachmentPointer | null | undefined
): WebAttachment | undefined {
  if (!attachment) {
    return undefined;
  }

  const size = toNumber(attachment.size);

  const { attachmentIdentifier } = attachment;
  const cdnId =
    attachmentIdentifier && 'cdnId' in attachmentIdentifier
      ? attachmentIdentifier.cdnId
      : undefined;
  const cdnKey =
    attachmentIdentifier && 'cdnKey' in attachmentIdentifier
      ? attachmentIdentifier.cdnKey
      : undefined;

  return {
    blurHash: attachment.blurHash ?? undefined,
    caption: attachment.caption ?? undefined,
    cdnId: cdnId && cdnId !== 0n ? cdnId.toString() : undefined,
    cdnKey,
    cdnNumber: attachment.cdnNumber ?? undefined,
    chunkSize: attachment.chunkSize ?? undefined,
    clientUuid:
      attachment.clientUuid && attachment.clientUuid.byteLength > 0
        ? bytesToUuid(attachment.clientUuid)
        : undefined,
    contentType: attachment.contentType ?? 'application/octet-stream',
    digest: bytesToBase64(attachment.digest),
    fileName: attachment.fileName ?? undefined,
    flags: attachment.flags ?? undefined,
    height: attachment.height ?? undefined,
    incrementalMac: bytesToBase64(attachment.incrementalMac),
    key: bytesToBase64(attachment.key),
    size,
    uploadTimestamp: toNumber(attachment.uploadTimestamp),
    width: attachment.width ?? undefined,
    status: 'ready',
  };
}

function convertBodyRange(
  bodyRange: Proto.BodyRange
): Record<string, unknown> | undefined {
  if (bodyRange.associatedValue == null) {
    return undefined;
  }
  if (bodyRange.associatedValue.style) {
    return {
      start: bodyRange.start ?? 0,
      length: bodyRange.length ?? 0,
      style: bodyRange.associatedValue.style,
    };
  }

  const mentionAci = fromAciUuidBytesOrString(
    bodyRange.associatedValue.mentionAciBinary,
    bodyRange.associatedValue.mentionAci,
    'BodyRange.mentionAci'
  );
  if (!mentionAci) {
    return undefined;
  }

  return {
    start: bodyRange.start ?? 0,
    length: bodyRange.length ?? 0,
    mentionAci,
  };
}

function convertQuote(
  quote: Proto.DataMessage.Quote | null | undefined
): WebMessage['quote'] {
  if (!quote) {
    return undefined;
  }

  return {
    id: toNumber(quote.id) ?? 0,
    authorAci: fromAciUuidBytesOrString(
      quote.authorAciBinary,
      quote.authorAci,
      'Quote.authorAci'
    ),
    text: quote.text ?? '',
    attachments: (quote.attachments ?? []).slice(0, 1).map(attachment => ({
      contentType: attachment.contentType ?? 'application/octet-stream',
      fileName: attachment.fileName ?? '',
      thumbnail: convertAttachmentPointer(attachment.thumbnail),
    })),
    bodyRanges: quote.bodyRanges.map(convertBodyRange).filter(item => item != null),
    type: quote.type ?? Proto.DataMessage.Quote.Type.NORMAL,
  } as unknown as WebMessage['quote'];
}

function convertContact(
  contact: ReadonlyArray<Proto.DataMessage.Contact> | null | undefined
): WebMessage['contact'] {
  return contact?.slice(0, 1).map(item => ({
    ...item,
    avatar: item.avatar
      ? {
          avatar: convertAttachmentPointer(item.avatar.avatar),
          isProfile: Boolean(item.avatar.isProfile),
        }
      : undefined,
  })) as WebMessage['contact'];
}

function convertPreview(
  preview: ReadonlyArray<Proto.Preview> | null | undefined
): WebMessage['preview'] {
  return preview?.slice(0, 1).map(item => ({
    url: item.url ?? '',
    title: item.title ?? '',
    image: convertAttachmentPointer(item.image),
    description: item.description ?? '',
    date: toNumber(item.date),
  })) as WebMessage['preview'];
}

function convertSticker(
  sticker: Proto.DataMessage.Sticker | null | undefined
): WebMessage['sticker'] {
  if (!sticker) {
    return undefined;
  }

  return {
    packId: sticker.packId ? Bytes.toHex(sticker.packId) : undefined,
    packKey: sticker.packKey ? Bytes.toBase64(sticker.packKey) : undefined,
    stickerId: sticker.stickerId ?? 0,
    emoji: sticker.emoji ?? undefined,
    data: convertAttachmentPointer(sticker.data),
  } as WebMessage['sticker'];
}

function convertGroupV2(
  groupV2: Proto.GroupContextV2 | null | undefined
): WebMessage['groupV2'] {
  if (!groupV2?.masterKey) {
    return undefined;
  }

  const secretParams = deriveGroupSecretParams(groupV2.masterKey);
  const publicParams = deriveGroupPublicParams(secretParams);
  const id = deriveGroupID(secretParams);
  return {
    masterKey: Bytes.toBase64(groupV2.masterKey),
    revision: groupV2.revision ?? 0,
    groupChange: groupV2.groupChange
      ? Bytes.toBase64(groupV2.groupChange)
      : undefined,
    id: Bytes.toBase64(id),
    secretParams: Bytes.toBase64(secretParams),
    publicParams: Bytes.toBase64(publicParams),
  } as WebMessage['groupV2'];
}

function convertGroupV2Change({
  groupV2,
  sourceServiceId,
}: Readonly<{
  groupV2: Proto.GroupContextV2 | null | undefined;
  sourceServiceId: string | undefined;
}>): WebMessage['groupV2Change'] {
  if (!groupV2?.masterKey || !groupV2.groupChange) {
    return undefined;
  }

  const secretParams = deriveGroupSecretParams(groupV2.masterKey);
  const clientZkGroupCipher = getClientZkGroupCipher(Bytes.toBase64(secretParams));

  try {
    const groupChange = Proto.GroupChange.decode(groupV2.groupChange);
    const actions = Proto.GroupChange.Actions.decode(
      groupChange.actions || new Uint8Array(0)
    );
    const details = new Array<
      NonNullable<WebMessage['groupV2Change']>['details'][number]
    >();
    let from = sourceServiceId;

    if (Bytes.isNotEmpty(actions.sourceUserId)) {
      try {
        from = decryptServiceId(clientZkGroupCipher, actions.sourceUserId);
      } catch (error) {
        console.warn('convertGroupV2Change: failed to decrypt sourceUserId', error);
      }
    }

    const decryptActionAci = (
      value: Uint8Array<ArrayBuffer> | null | undefined,
      label: string
    ): AciString | undefined => {
      if (!Bytes.isNotEmpty(value)) {
        return undefined;
      }
      try {
        return decryptAci(clientZkGroupCipher, value);
      } catch (error) {
        console.warn(`convertGroupV2Change: failed to decrypt ${label}`, error);
        return undefined;
      }
    };

    const decryptActionServiceId = (
      value: Uint8Array<ArrayBuffer> | null | undefined,
      label: string
    ): ServiceIdString | undefined => {
      if (!Bytes.isNotEmpty(value)) {
        return undefined;
      }
      try {
        return decryptServiceId(clientZkGroupCipher, value);
      } catch (error) {
        console.warn(`convertGroupV2Change: failed to decrypt ${label}`, error);
        return undefined;
      }
    };

    for (const addMember of actions.addMembers ?? []) {
      const aci = decryptActionAci(addMember.added?.userId, 'addMembers.userId');
      if (!aci) {
        continue;
      }
      details.push({
        type: addMember.joinFromInviteLink
          ? 'member-add-from-link'
          : 'member-add',
        aci,
      });
    }

    for (const deleteMember of actions.deleteMembers ?? []) {
      const aci = decryptActionAci(
        deleteMember.deletedUserId,
        'deleteMembers.deletedUserId'
      );
      if (!aci) {
        continue;
      }
      details.push({
        type: 'member-remove',
        aci,
      });
    }

    for (const modifyMemberRole of actions.modifyMemberRoles ?? []) {
      const aci = decryptActionAci(
        modifyMemberRole.userId,
        'modifyMemberRoles.userId'
      );
      if (!aci) {
        continue;
      }
      details.push({
        type: 'member-privilege',
        aci,
        newPrivilege: modifyMemberRole.role,
      });
    }

    const pendingAddDetailsStart = details.length;
    for (const pendingMember of actions.addMembersPendingProfileKey ?? []) {
      const serviceId = decryptActionServiceId(
        pendingMember.added?.member?.userId,
        'addMembersPendingProfileKey.member.userId'
      );
      if (!serviceId) {
        continue;
      }
      details.push({
        type: 'pending-add-one',
        serviceId,
      });
    }

    if (details.length - pendingAddDetailsStart > 1) {
      const count = details.length - pendingAddDetailsStart;
      details.splice(pendingAddDetailsStart, count, {
        type: 'pending-add-many',
        count,
      });
    }

    const pendingRemoveDetailsStart = details.length;
    for (const pendingMember of actions.deleteMembersPendingProfileKey ?? []) {
      const serviceId = decryptActionServiceId(
        pendingMember.deletedUserId,
        'deleteMembersPendingProfileKey.deletedUserId'
      );
      if (!serviceId) {
        continue;
      }
      details.push({
        type: 'pending-remove-one',
        serviceId,
      });
    }
    if ((actions.deleteMembersPendingProfileKey ?? []).length > 1) {
      details.splice(
        pendingRemoveDetailsStart,
        details.length - pendingRemoveDetailsStart,
        {
          type: 'pending-remove-many',
          count: actions.deleteMembersPendingProfileKey?.length ?? 0,
        }
      );
    }

    for (const pendingMember of actions.promoteMembersPendingProfileKey ?? []) {
      const aci = decryptActionAci(
        pendingMember.userId,
        'promoteMembersPendingProfileKey.userId'
      );
      if (!aci) {
        continue;
      }
      details.push({
        type: 'member-add-from-invite',
        aci,
      });
    }

    for (const pendingMember of actions.promoteMembersPendingPniAciProfileKey ?? []) {
      const aci = decryptActionAci(
        pendingMember.userId,
        'promoteMembersPendingPniAciProfileKey.userId'
      );
      if (!aci) {
        continue;
      }
      details.push({
        type: 'member-add-from-invite',
        aci,
      });
    }

    for (const pendingMember of actions.addMembersPendingAdminApproval ?? []) {
      const aci = decryptActionAci(
        pendingMember.added?.userId,
        'addMembersPendingAdminApproval.userId'
      );
      if (!aci) {
        continue;
      }
      details.push({
        type: 'admin-approval-add-one',
        aci,
      });
    }

    for (const pendingMember of actions.deleteMembersPendingAdminApproval ?? []) {
      const aci = decryptActionAci(
        pendingMember.deletedUserId,
        'deleteMembersPendingAdminApproval.deletedUserId'
      );
      if (!aci) {
        continue;
      }
      details.push({
        type: 'admin-approval-remove-one',
        aci,
      });
    }

    for (const pendingMember of actions.promoteMembersPendingAdminApproval ?? []) {
      const aci = decryptActionAci(
        pendingMember.userId,
        'promoteMembersPendingAdminApproval.userId'
      );
      if (!aci) {
        continue;
      }
      details.push({
        type: 'member-add-from-admin-approval',
        aci,
      });
    }

    if (actions.modifyTitle) {
      const { title } = actions.modifyTitle;
      if (Bytes.isNotEmpty(title)) {
        const decrypted = Proto.GroupAttributeBlob.decode(
          decryptGroupBlob(clientZkGroupCipher, title)
        );
        details.push({
          type: 'title',
          newTitle: decrypted.content?.title?.trim() || undefined,
        });
      } else {
        details.push({
          type: 'title',
        });
      }
    }

    if (actions.modifyAvatar) {
      details.push({
        type: 'avatar',
        removed: !actions.modifyAvatar.avatar,
      });
    }

    if (actions.modifyAttributesAccess) {
      details.push({
        type: 'access-attributes',
        newPrivilege: actions.modifyAttributesAccess.attributesAccess,
      });
    }

    if (actions.modifyMemberAccess) {
      details.push({
        type: 'access-members',
        newPrivilege: actions.modifyMemberAccess.membersAccess,
      });
    }

    if (actions.modifyAddFromInviteLinkAccess) {
      details.push({
        type: 'access-invite-link',
        newPrivilege: actions.modifyAddFromInviteLinkAccess.addFromInviteLinkAccess,
      });
    }

    if (actions.modifyMemberLabelAccess) {
      details.push({
        type: 'access-member-label',
        newPrivilege: actions.modifyMemberLabelAccess.memberLabelAccess,
      });
    }

    if (actions.modifyInviteLinkPassword) {
      details.push({
        type: 'group-link-reset',
      });
    }

    if (actions.modifyDescription) {
      const { description } = actions.modifyDescription;
      if (Bytes.isNotEmpty(description)) {
        const decrypted = Proto.GroupAttributeBlob.decode(
          decryptGroupBlob(clientZkGroupCipher, description)
        );
        const descriptionText =
          decrypted.content?.descriptionText?.trim() || undefined;
        details.push({
          type: 'description',
          removed: !descriptionText,
          description: descriptionText,
        });
      } else {
        details.push({
          type: 'description',
          removed: true,
        });
      }
    }

    if (actions.modifyAnnouncementsOnly) {
      details.push({
        type: 'announcements-only',
        announcementsOnly: Boolean(actions.modifyAnnouncementsOnly.announcementsOnly),
      });
    }

    if (actions.terminateGroup) {
      details.push({
        type: 'terminated',
      });
    }

    if (details.length === 0) {
      details.push({ type: 'summary' });
    }

    return {
      from,
      details,
    } as WebMessage['groupV2Change'];
  } catch (error) {
    console.warn('convertGroupV2Change: failed to convert group change', error);
    return undefined;
  }
}

function getDataMessageConversationId(
  dataMessage: Proto.DataMessage,
  fallbackConversationId: string
): string {
  return convertGroupV2(dataMessage.groupV2)?.id ?? fallbackConversationId;
}

function getSentDataMessageConversationId({
  dataMessage,
  logContext,
  sent,
}: Readonly<{
  dataMessage: Proto.DataMessage;
  logContext: string;
  sent: Proto.SyncMessage.Sent;
}>): string | undefined {
  const groupConversationId = convertGroupV2(dataMessage.groupV2)?.id;
  if (groupConversationId) {
    return groupConversationId;
  }

  return fromServiceIdBinaryOrString(
    sent.destinationServiceIdBinary,
    sent.destinationServiceId,
    logContext
  );
}

function convertStoryContext(
  storyContext: Proto.DataMessage.StoryContext | null | undefined
): WebMessage['storyContext'] {
  if (!storyContext) {
    return undefined;
  }

  return {
    authorAci: fromAciUuidBytesOrString(
      storyContext.authorAciBinary,
      storyContext.authorAci,
      'StoryContext.authorAci'
    ),
    sentTimestamp: toNumber(storyContext.sentTimestamp) ?? 0,
  } as WebMessage['storyContext'];
}

function convertPollCreate(
  pollCreate: Proto.DataMessage.PollCreate | null | undefined
): WebMessage['pollCreate'] {
  if (!pollCreate) {
    return undefined;
  }

  return {
    question: pollCreate.question ?? '',
    options: pollCreate.options?.filter(item => item != null) ?? [],
    allowMultiple: Boolean(pollCreate.allowMultiple),
  };
}

function convertDataMessageToWebMessage({
  conversationId,
  dataMessage,
  direction,
  id,
  receivedAt,
  sourceServiceId,
  status,
}: Readonly<{
  conversationId: string;
  dataMessage: Proto.DataMessage;
  direction: WebMessage['direction'];
  id: string;
  receivedAt: number;
  sourceServiceId: string | undefined;
  status: WebMessage['status'];
}>): WebMessage {
  const timestamp = toNumber(dataMessage.timestamp) ?? receivedAt;
  const attachments = (dataMessage.attachments ?? [])
    .map(convertAttachmentPointer)
    .filter(isWebAttachment);
  const groupV2 = convertGroupV2(dataMessage.groupV2);
  const groupV2Change = convertGroupV2Change({
    groupV2: dataMessage.groupV2,
    sourceServiceId,
  });

  return {
    id,
    conversationId: groupV2?.id ?? conversationId,
    body: groupV2Change ? undefined : (dataMessage.body ?? ''),
    timestamp,
    receivedAt,
    direction,
    desktopType: groupV2Change ? 'group-v2-change' : undefined,
    status,
    attachments,
    bodyRanges: dataMessage.bodyRanges.map(convertBodyRange).filter(item => item != null),
    contact: convertContact(dataMessage.contact),
    expireTimer: DurationInSeconds.fromSeconds(dataMessage.expireTimer ?? 0),
    expireTimerVersion: dataMessage.expireTimerVersion ?? 0,
    flags: dataMessage.flags ?? 0,
    groupCallUpdate: dataMessage.groupCallUpdate ?? undefined,
    groupV2Change,
    groupV2,
    isViewOnce: Boolean(dataMessage.isViewOnce),
    pollCreate: convertPollCreate(dataMessage.pollCreate),
    preview: convertPreview(dataMessage.preview),
    profileKey: dataMessage.profileKey
      ? Bytes.toBase64(dataMessage.profileKey)
      : undefined,
    quote: convertQuote(dataMessage.quote),
    requiredProtocolVersion: dataMessage.requiredProtocolVersion ?? 0,
    sourceServiceId,
    sticker: convertSticker(dataMessage.sticker),
    storyContext: convertStoryContext(dataMessage.storyContext),
  } as unknown as WebMessage;
}

function unpad(paddedPlaintext: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  for (let index = paddedPlaintext.length - 1; index >= 0; index -= 1) {
    const value = paddedPlaintext[index];
    if (value === 0x80) {
      return new Uint8Array(paddedPlaintext.subarray(0, index));
    }
    if (value !== 0x00) {
      throw new Error('Invalid Signal message padding');
    }
  }
  throw new Error('Invalid Signal message padding');
}

function getEnvelopeType(decoded: Proto.Envelope): Proto.Envelope.Type {
  return decoded.type ?? Proto.Envelope.Type.UNKNOWN;
}

async function decryptEnvelopeContent({
  envelopeBytes,
  linkedPayload,
}: Readonly<{
  envelopeBytes: Uint8Array<ArrayBuffer>;
  linkedPayload: WebSendLinkedPayload;
}>): Promise<{
  content: Proto.Content;
  protocolStore: WebProtocolStore;
  sourceDevice: number;
  sourceServiceId: string;
  timestamp: number;
}> {
  const decoded = Proto.Envelope.decode(envelopeBytes);
  const type = getEnvelopeType(decoded);
  const linkedAci = getLinkedAci(linkedPayload);
  const ourDeviceId = linkedPayload.credentials?.deviceId;
  if (typeof ourDeviceId !== 'number') {
    throw new Error('decryptIncomingSignalEnvelope: missing linked device id');
  }

  const explicitDestinationServiceId =
    fromServiceIdBinaryOrString(
      decoded.destinationServiceIdBinary,
      decoded.destinationServiceId,
      'decryptIncomingSignalEnvelope.destinationServiceId'
    );
  let destinationServiceId = explicitDestinationServiceId ?? linkedAci;
  let sourceServiceId: string | undefined = fromServiceIdBinaryOrString(
    decoded.sourceServiceIdBinary,
    decoded.sourceServiceId,
    'decryptIncomingSignalEnvelope.sourceServiceId'
  );
  let sourceDevice = decoded.sourceDeviceId ?? 1;
  let ciphertext = decoded.content ?? new Uint8Array();
  let plaintext: Uint8Array<ArrayBuffer>;
  let protocolStore = getProtocolStoreForServiceId(
    linkedPayload,
    destinationServiceId
  );

  if (type === Proto.Envelope.Type.UNIDENTIFIED_SENDER) {
    let messageContent;
    try {
      messageContent = await sealedSenderDecryptToUsmc(
        ciphertext,
        protocolStore.identityStore
      );
    } catch (error) {
      const linkedPni = getLinkedPni(linkedPayload);
      if (explicitDestinationServiceId || !linkedPni || destinationServiceId === linkedPni) {
        throw error;
      }
      const pniProtocolStore = getProtocolStoreForServiceId(linkedPayload, linkedPni);
      messageContent = await sealedSenderDecryptToUsmc(
        ciphertext,
        pniProtocolStore.identityStore
      );
      protocolStore = pniProtocolStore;
      destinationServiceId = pniProtocolStore.localServiceId;
    }
    const certificate = messageContent.senderCertificate();
    sourceServiceId = certificate.senderUuid();
    if (!sourceServiceId) {
      throw new Error('decryptIncomingSignalEnvelope: missing sealed sender source service id');
    }
    sourceDevice = certificate.senderDeviceId();
    ciphertext = messageContent.contents();
    const messageType = messageContent.msgType();
    if (messageType === CiphertextMessageType.Plaintext) {
      plaintext = PlaintextContent.deserialize(ciphertext).body();
    } else if (messageType === CiphertextMessageType.PreKey) {
      plaintext = await signalDecryptPreKey(
        PreKeySignalMessage.deserialize(ciphertext),
        ProtocolAddress.new(sourceServiceId, sourceDevice),
        ProtocolAddress.new(destinationServiceId, ourDeviceId),
        protocolStore.sessionStore,
        protocolStore.identityStore,
        protocolStore.preKeyStore,
        protocolStore.signedPreKeyStore,
        protocolStore.kyberPreKeyStore
      );
    } else if (messageType === CiphertextMessageType.Whisper) {
      plaintext = await signalDecrypt(
        SignalMessage.deserialize(ciphertext),
        ProtocolAddress.new(sourceServiceId, sourceDevice),
        ProtocolAddress.new(destinationServiceId, ourDeviceId),
        protocolStore.sessionStore,
        protocolStore.identityStore
      );
    } else if (messageType === CiphertextMessageType.SenderKey) {
      plaintext = await groupDecrypt(
        ProtocolAddress.new(sourceServiceId, sourceDevice),
        protocolStore.senderKeyStore,
        ciphertext
      );
    } else {
      throw new Error(
        `decryptIncomingSignalEnvelope: unsupported sealed sender message type ${messageType}`
      );
    }
  } else {
    if (!sourceServiceId) {
      throw new Error('decryptIncomingSignalEnvelope: missing source service id');
    }
    if (type === Proto.Envelope.Type.PLAINTEXT_CONTENT) {
      plaintext = PlaintextContent.deserialize(ciphertext).body();
    } else if (type === Proto.Envelope.Type.PREKEY_MESSAGE) {
      plaintext = await signalDecryptPreKey(
        PreKeySignalMessage.deserialize(ciphertext),
        ProtocolAddress.new(sourceServiceId, sourceDevice),
        ProtocolAddress.new(destinationServiceId, ourDeviceId),
        protocolStore.sessionStore,
        protocolStore.identityStore,
        protocolStore.preKeyStore,
        protocolStore.signedPreKeyStore,
        protocolStore.kyberPreKeyStore
      );
    } else if (type === Proto.Envelope.Type.DOUBLE_RATCHET) {
      plaintext = await signalDecrypt(
        SignalMessage.deserialize(ciphertext),
        ProtocolAddress.new(sourceServiceId, sourceDevice),
        ProtocolAddress.new(destinationServiceId, ourDeviceId),
        protocolStore.sessionStore,
        protocolStore.identityStore
      );
    } else {
      throw new Error(
        `decryptIncomingSignalEnvelope: unsupported envelope type ${type}`
      );
    }
  }

  if (!sourceServiceId) {
    throw new Error('decryptIncomingSignalEnvelope: missing unsealed source service id');
  }

  return {
    content: Proto.Content.decode(unpad(plaintext)),
    protocolStore,
    sourceDevice,
    sourceServiceId,
    timestamp: toNumber(decoded.clientTimestamp) ?? Date.now(),
  };
}

async function maybeProcessSenderKeyDistributionMessage({
  content,
  protocolStore,
  sourceDevice,
  sourceServiceId,
}: Readonly<{
  content: Proto.Content;
  protocolStore: WebProtocolStore;
  sourceDevice: number;
  sourceServiceId: string;
}>): Promise<boolean> {
  const distributionMessage = content.senderKeyDistributionMessage;
  if (!distributionMessage || distributionMessage.length === 0) {
    return false;
  }

  await processSenderKeyDistributionMessage(
    ProtocolAddress.new(sourceServiceId, sourceDevice),
    SenderKeyDistributionMessage.deserialize(distributionMessage),
    protocolStore.senderKeyStore
  );
  return true;
}

function isProfileKeyUpdateDataMessage(dataMessage: Proto.DataMessage): boolean {
  return Boolean(
    // eslint-disable-next-line no-bitwise
    (dataMessage.flags ?? 0) & Proto.DataMessage.Flags.PROFILE_KEY_UPDATE
  );
}

function convertContentToWebMessage({
  content,
  linkedPayload,
  sourceServiceId,
  timestamp,
}: Readonly<{
  content: Proto.Content;
  linkedPayload: WebSendLinkedPayload;
  sourceServiceId: string;
  timestamp: number;
}>): WebMessage | undefined {
  const dataMessage = content.content?.dataMessage;
  if (dataMessage) {
    if (isProfileKeyUpdateDataMessage(dataMessage)) {
      return undefined;
    }
    if (
      dataMessage.reaction ||
      dataMessage.pinMessage ||
      dataMessage.unpinMessage ||
      dataMessage.delete ||
      dataMessage.adminDelete ||
      dataMessage.pollVote ||
      dataMessage.pollTerminate
    ) {
      return undefined;
    }
    const dataMessageTimestamp = toNumber(dataMessage.timestamp) ?? timestamp;
    return convertDataMessageToWebMessage({
      id: `incoming:${sourceServiceId}:${dataMessageTimestamp}`,
      conversationId: sourceServiceId,
      dataMessage,
      direction: 'incoming',
      receivedAt: Date.now(),
      sourceServiceId,
      status: 'delivered',
    });
  }

  const sent = content.content?.syncMessage?.content?.sent;
  const sentMessage = sent?.message;
  if (sent && sentMessage) {
    if (isProfileKeyUpdateDataMessage(sentMessage)) {
      return undefined;
    }
    if (
      sentMessage.reaction ||
      sentMessage.pinMessage ||
      sentMessage.unpinMessage ||
      sentMessage.delete ||
      sentMessage.adminDelete ||
      sentMessage.pollVote ||
      sentMessage.pollTerminate
    ) {
      return undefined;
    }
    const sentConversationId = getSentDataMessageConversationId({
      dataMessage: sentMessage,
      logContext: 'convertContentToWebMessage.sent.destinationServiceId',
      sent,
    });
    const sentTimestamp =
      toNumber(sentMessage.timestamp) ?? toNumber(sent.timestamp) ?? timestamp;
    const conversationId = sentConversationId ?? sourceServiceId;
    return convertDataMessageToWebMessage({
      id: `sent-sync:${conversationId}:${sentTimestamp}`,
      conversationId,
      dataMessage: sentMessage,
      direction: 'outgoing',
      receivedAt: Date.now(),
      sourceServiceId: linkedPayload.credentials?.aci ?? linkedPayload.account.aci,
      status: 'sent',
    });
  }

  return undefined;
}

function getPinDurationSeconds(
  pinMessage: Proto.DataMessage.PinMessage
): number | null | undefined {
  if (pinMessage.pinDuration?.pinDurationForever) {
    return null;
  }

  return pinMessage.pinDuration?.pinDurationSeconds;
}

function convertDataMessagePinToWebEvent({
  conversationId,
  dataMessage,
  receivedAt,
  senderAci,
  timestamp,
}: Readonly<{
  conversationId: string;
  dataMessage: Proto.DataMessage;
  receivedAt: number;
  senderAci: string;
  timestamp: number;
}>): WebPinMessageEvent | undefined {
  const pinMessage = dataMessage.pinMessage;
  if (!pinMessage) {
    return undefined;
  }

  const targetAuthorAci = fromAciUuidBytes(pinMessage.targetAuthorAciBinary);
  const targetSentTimestamp = toNumber(pinMessage.targetSentTimestamp);
  const pinDurationSeconds = getPinDurationSeconds(pinMessage);
  if (
    !targetAuthorAci ||
    targetSentTimestamp == null ||
    pinDurationSeconds === undefined
  ) {
    return undefined;
  }

  return {
    type: 'pin-message',
    conversationId,
    targetAuthorAci,
    targetSentTimestamp,
    pinDurationSeconds,
    senderAci,
    timestamp: toNumber(dataMessage.timestamp) ?? timestamp,
    receivedAt,
  };
}

function convertContentToWebPinMessageEvent({
  content,
  linkedPayload,
  sourceServiceId,
  timestamp,
}: Readonly<{
  content: Proto.Content;
  linkedPayload: WebSendLinkedPayload;
  sourceServiceId: string;
  timestamp: number;
}>): WebPinMessageEvent | undefined {
  const dataMessage = content.content?.dataMessage;
  if (dataMessage?.pinMessage) {
    return convertDataMessagePinToWebEvent({
      conversationId: getDataMessageConversationId(
        dataMessage,
        sourceServiceId
      ),
      dataMessage,
      receivedAt: Date.now(),
      senderAci: sourceServiceId,
      timestamp,
    });
  }

  const sent = content.content?.syncMessage?.content?.sent;
  const sentMessage = sent?.message;
  if (sent && sentMessage?.pinMessage) {
    const conversationId = getSentDataMessageConversationId({
      dataMessage: sentMessage,
      logContext: 'convertContentToWebPinMessageEvent.sent.destinationServiceId',
      sent,
    });
    const senderAci =
      linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
    if (!conversationId || !senderAci) {
      return undefined;
    }

    return convertDataMessagePinToWebEvent({
      conversationId,
      dataMessage: sentMessage,
      receivedAt: Date.now(),
      senderAci,
      timestamp: toNumber(sent.timestamp) ?? timestamp,
    });
  }

  return undefined;
}

function convertDataMessageReactionToWebEvent({
  conversationId,
  dataMessage,
  senderAci,
  timestamp,
}: Readonly<{
  conversationId: string;
  dataMessage: Proto.DataMessage;
  senderAci: string;
  timestamp: number;
}>): WebReactionEvent | undefined {
  const reaction = dataMessage.reaction;
  if (!reaction) {
    return undefined;
  }

  const targetAuthorAci = fromAciUuidBytesOrString(
    reaction.targetAuthorAciBinary,
    reaction.targetAuthorAci,
    'webSignal.reaction.targetAuthorAci'
  );
  const targetTimestamp = toNumber(reaction.targetSentTimestamp);
  if (!targetAuthorAci || targetTimestamp == null) {
    return undefined;
  }

  return {
    type: 'reaction',
    conversationId,
    targetAuthorAci,
    targetTimestamp,
    senderAci,
    timestamp: toNumber(dataMessage.timestamp) ?? timestamp,
    emoji: reaction.emoji ?? undefined,
    remove: Boolean(reaction.remove),
  };
}

function convertContentToWebReactionEvent({
  content,
  linkedPayload,
  sourceServiceId,
  timestamp,
}: Readonly<{
  content: Proto.Content;
  linkedPayload: WebSendLinkedPayload;
  sourceServiceId: string;
  timestamp: number;
}>): WebReactionEvent | undefined {
  const dataMessage = content.content?.dataMessage;
  if (dataMessage?.reaction) {
    return convertDataMessageReactionToWebEvent({
      conversationId: getDataMessageConversationId(
        dataMessage,
        sourceServiceId
      ),
      dataMessage,
      senderAci: sourceServiceId,
      timestamp,
    });
  }

  const sent = content.content?.syncMessage?.content?.sent;
  const sentMessage = sent?.message;
  if (sent && sentMessage?.reaction) {
    const conversationId = getSentDataMessageConversationId({
      dataMessage: sentMessage,
      logContext:
        'convertContentToWebReactionEvent.sent.destinationServiceId',
      sent,
    });
    const senderAci =
      linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
    if (!conversationId || !senderAci) {
      return undefined;
    }

    return convertDataMessageReactionToWebEvent({
      conversationId,
      dataMessage: sentMessage,
      senderAci,
      timestamp: toNumber(sent.timestamp) ?? timestamp,
    });
  }

  return undefined;
}

function convertEditMessageToWebEvent({
  conversationId,
  direction,
  editMessage,
  senderAci,
  sourceServiceId,
  timestamp,
}: Readonly<{
  conversationId: string;
  direction: WebMessage['direction'];
  editMessage: Proto.EditMessage;
  senderAci: string;
  sourceServiceId: string | undefined;
  timestamp: number;
}>): WebEditMessageEvent | undefined {
  const targetTimestamp = toNumber(editMessage.targetSentTimestamp);
  const dataMessage = editMessage.dataMessage;
  if (targetTimestamp == null || !dataMessage) {
    return undefined;
  }

  const editTimestamp = toNumber(dataMessage.timestamp) ?? timestamp;
  const editWebMessage = convertDataMessageToWebMessage({
    id: `edit:${conversationId}:${targetTimestamp}:${editTimestamp}`,
    conversationId,
    dataMessage,
    direction,
    receivedAt: Date.now(),
    sourceServiceId,
    status: direction === 'outgoing' ? 'sent' : 'delivered',
  });
  const finalConversationId = editWebMessage.conversationId;
  return {
    type: 'edit-message',
    conversationId: finalConversationId,
    targetTimestamp,
    senderAci,
    timestamp: editTimestamp,
    message: editWebMessage,
  };
}

function convertContentToWebEditEvent({
  content,
  linkedPayload,
  sourceServiceId,
  timestamp,
}: Readonly<{
  content: Proto.Content;
  linkedPayload: WebSendLinkedPayload;
  sourceServiceId: string;
  timestamp: number;
}>): WebEditMessageEvent | undefined {
  const editMessage = content.content?.editMessage;
  if (editMessage) {
    return convertEditMessageToWebEvent({
      conversationId: sourceServiceId,
      direction: 'incoming',
      editMessage,
      senderAci: sourceServiceId,
      sourceServiceId,
      timestamp,
    });
  }

  const sent = content.content?.syncMessage?.content?.sent;
  const sentEditMessage = sent?.editMessage;
  if (sent && sentEditMessage?.dataMessage) {
    const conversationId = getSentDataMessageConversationId({
      dataMessage: sentEditMessage.dataMessage,
      logContext: 'convertContentToWebEditEvent.sent.destinationServiceId',
      sent,
    });
    const senderAci =
      linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
    if (!conversationId || !senderAci) {
      return undefined;
    }

    return convertEditMessageToWebEvent({
      conversationId,
      direction: 'outgoing',
      editMessage: sentEditMessage,
      senderAci,
      sourceServiceId: senderAci,
      timestamp: toNumber(sent.timestamp) ?? timestamp,
    });
  }

  return undefined;
}

function convertDataMessageDeleteToWebEvent({
  conversationId,
  dataMessage,
  senderAci,
  timestamp,
}: Readonly<{
  conversationId: string;
  dataMessage: Proto.DataMessage;
  senderAci: string;
  timestamp: number;
}>): WebDeleteMessageEvent | undefined {
  if (dataMessage.adminDelete) {
    const targetSentTimestamp = toNumber(
      dataMessage.adminDelete.targetSentTimestamp
    );
    const targetAuthorAci = fromAciUuidBytes(
      dataMessage.adminDelete.targetAuthorAciBinary
    );
    if (targetSentTimestamp == null || !targetAuthorAci) {
      return undefined;
    }
    return {
      type: 'delete-message',
      conversationId,
      targetAuthorAci,
      targetSentTimestamp,
      senderAci,
      timestamp: toNumber(dataMessage.timestamp) ?? timestamp,
      isAdminDelete: true,
    };
  }

  if (dataMessage.delete) {
    const targetSentTimestamp = toNumber(
      dataMessage.delete.targetSentTimestamp
    );
    if (targetSentTimestamp == null) {
      return undefined;
    }
    return {
      type: 'delete-message',
      conversationId,
      targetAuthorAci: senderAci,
      targetSentTimestamp,
      senderAci,
      timestamp: toNumber(dataMessage.timestamp) ?? timestamp,
      isAdminDelete: false,
    };
  }

  return undefined;
}

function convertDataMessageUnpinToWebEvent({
  conversationId,
  dataMessage,
  receivedAt,
}: Readonly<{
  conversationId: string;
  dataMessage: Proto.DataMessage;
  receivedAt: number;
}>): WebUnpinMessageEvent | undefined {
  const unpinMessage = dataMessage.unpinMessage;
  if (!unpinMessage) {
    return undefined;
  }

  const targetAuthorAci = fromAciUuidBytes(unpinMessage.targetAuthorAciBinary);
  const targetSentTimestamp = toNumber(unpinMessage.targetSentTimestamp);
  if (!targetAuthorAci || targetSentTimestamp == null) {
    return undefined;
  }

  return {
    type: 'unpin-message',
    conversationId,
    targetAuthorAci,
    targetSentTimestamp,
    timestamp: toNumber(dataMessage.timestamp) ?? receivedAt,
    receivedAt,
  };
}

function convertContentToWebDeleteEvent({
  content,
  linkedPayload,
  sourceServiceId,
  timestamp,
}: Readonly<{
  content: Proto.Content;
  linkedPayload: WebSendLinkedPayload;
  sourceServiceId: string;
  timestamp: number;
}>): WebDeleteMessageEvent | undefined {
  const dataMessage = content.content?.dataMessage;
  if (dataMessage?.delete || dataMessage?.adminDelete) {
    return convertDataMessageDeleteToWebEvent({
      conversationId: convertGroupV2(dataMessage.groupV2)?.id ?? sourceServiceId,
      dataMessage,
      senderAci: sourceServiceId,
      timestamp,
    });
  }

  const sent = content.content?.syncMessage?.content?.sent;
  const sentMessage = sent?.message;
  if (sent && (sentMessage?.delete || sentMessage?.adminDelete)) {
    const conversationId = getSentDataMessageConversationId({
      dataMessage: sentMessage,
      logContext: 'convertContentToWebDeleteEvent.sent.destinationServiceId',
      sent,
    });
    const senderAci =
      linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
    if (!conversationId || !senderAci) {
      return undefined;
    }
    return convertDataMessageDeleteToWebEvent({
      conversationId,
      dataMessage: sentMessage,
      senderAci,
      timestamp: toNumber(sent.timestamp) ?? timestamp,
    });
  }

  return undefined;
}

function convertContentToWebUnpinEvent({
  content,
  sourceServiceId,
  timestamp,
}: Readonly<{
  content: Proto.Content;
  sourceServiceId: string;
  timestamp: number;
}>): WebUnpinMessageEvent | undefined {
  const dataMessage = content.content?.dataMessage;
  if (dataMessage?.unpinMessage) {
    return convertDataMessageUnpinToWebEvent({
      conversationId: getDataMessageConversationId(
        dataMessage,
        sourceServiceId
      ),
      dataMessage,
      receivedAt: timestamp,
    });
  }

  const sent = content.content?.syncMessage?.content?.sent;
  const sentMessage = sent?.message;
  if (sent && sentMessage?.unpinMessage) {
    const conversationId = getSentDataMessageConversationId({
      dataMessage: sentMessage,
      logContext: 'convertContentToWebUnpinEvent.sent.destinationServiceId',
      sent,
    });
    if (!conversationId) {
      return undefined;
    }
    return convertDataMessageUnpinToWebEvent({
      conversationId,
      dataMessage: sentMessage,
      receivedAt: toNumber(sent.timestamp) ?? timestamp,
    });
  }

  return undefined;
}

function convertContentToWebReceiptEvent({
  content,
  sourceServiceId,
}: Readonly<{
  content: Proto.Content;
  sourceServiceId: string;
}>): WebReceiptEvent | undefined {
  const receiptMessage = content.content?.receiptMessage;
  if (!receiptMessage) {
    return undefined;
  }

  return {
    type: 'receipt',
    conversationId: sourceServiceId,
    senderAci: sourceServiceId,
    receiptType: receiptMessage.type,
    timestamps: receiptMessage.timestamp
      .map(item => toNumber(item))
      .filter((item): item is number => item != null),
  };
}

function convertContentToWebTypingEvent({
  content,
  sourceDevice,
  sourceServiceId,
}: Readonly<{
  content: Proto.Content;
  sourceDevice?: number;
  sourceServiceId: string;
}>): WebTypingEvent | undefined {
  const typingMessage = content.content?.typingMessage;
  if (!typingMessage) {
    return undefined;
  }

  return {
    type: 'typing',
    conversationId: typingMessage.groupId?.byteLength
      ? Bytes.toBase64(typingMessage.groupId)
      : sourceServiceId,
    senderAci: sourceServiceId,
    sourceDevice,
    timestamp: toNumber(typingMessage.timestamp),
    action: typingMessage.action,
  };
}

function convertAddressableMessage(
  target: Proto.AddressableMessage | null | undefined
): Readonly<{
  authorAci?: string;
  sentAt: number;
}> | undefined {
  if (!target?.author) {
    return undefined;
  }

  const sentAt = toNumber(target.sentTimestamp);
  if (sentAt == null) {
    return undefined;
  }

  const authorServiceId = fromServiceIdBinaryOrString(
    target.author.authorServiceIdBinary,
    target.author.authorServiceId,
    'convertAddressableMessage.authorServiceId'
  );

  if (authorServiceId) {
    return {
      authorAci: authorServiceId,
      sentAt,
    };
  }

  return {
    sentAt,
  };
}

function convertConversationIdentifier(
  target: Proto.ConversationIdentifier | null | undefined
): string | undefined {
  if (!target?.identifier) {
    return undefined;
  }

  const serviceId = fromServiceIdBinaryOrString(
    target.identifier.threadServiceIdBinary,
    target.identifier.threadServiceId,
    'convertConversationIdentifier.threadServiceId'
  );
  if (serviceId) {
    return serviceId;
  }

  if (target.identifier.threadGroupId) {
    return Bytes.toBase64(target.identifier.threadGroupId);
  }

  return undefined;
}

function convertAttachmentBackfillData(
  data: Proto.SyncMessage.AttachmentBackfillResponse.AttachmentData
): WebAttachmentBackfillData | undefined {
  if (data.data?.status != null) {
    return {
      status: data.data.status,
    };
  }

  const attachment = convertAttachmentPointer(data.data?.attachment);
  if (!attachment) {
    return undefined;
  }

  return {
    attachment,
  };
}

function convertContentToWebAttachmentBackfillEvent({
  content,
  timestamp,
}: Readonly<{
  content: Proto.Content;
  timestamp: number;
}>): WebAttachmentBackfillEvent | undefined {
  const response =
    content.content?.syncMessage?.content?.attachmentBackfillResponse;
  if (!response) {
    return undefined;
  }

  const targetMessage = convertAddressableMessage(response.targetMessage);
  const conversationId = convertConversationIdentifier(
    response.targetConversation
  );
  if (!targetMessage || !conversationId) {
    return undefined;
  }

  if (response.data?.error != null) {
    return {
      type: 'attachment-backfill',
      conversationId,
      targetAuthorAci: targetMessage.authorAci,
      targetSentTimestamp: targetMessage.sentAt,
      error: response.data.error,
      timestamp,
    };
  }

  const attachments = response.data?.attachments;
  if (!attachments) {
    return undefined;
  }

  return {
    type: 'attachment-backfill',
    conversationId,
    targetAuthorAci: targetMessage.authorAci,
    targetSentTimestamp: targetMessage.sentAt,
    attachments: attachments.attachments
      .map(convertAttachmentBackfillData)
      .filter((item): item is WebAttachmentBackfillData => item != null),
    longText:
      attachments.longText == null
        ? undefined
        : convertAttachmentBackfillData(attachments.longText),
    timestamp,
  };
}

function convertDataMessagePollVoteToWebEvent({
  conversationId,
  dataMessage,
  senderAci,
  timestamp,
}: Readonly<{
  conversationId: string;
  dataMessage: Proto.DataMessage;
  senderAci: string;
  timestamp: number;
}>): WebPollVoteEvent | undefined {
  if (!dataMessage.pollVote) {
    return undefined;
  }

  const dataMessageTimestamp = toNumber(dataMessage.timestamp) ?? timestamp;
  const pollVote = dataMessage.pollVote;
  const targetAuthorAci = fromAciUuidBytesOrString(
    pollVote.targetAuthorAciBinary,
    undefined,
    'PollVote.targetAuthorAci'
  );
  const targetTimestamp = toNumber(pollVote.targetSentTimestamp);
  if (
    !targetAuthorAci ||
    targetTimestamp == null ||
    !pollVote.optionIndexes
  ) {
    return undefined;
  }

  return {
    type: 'poll-vote',
    conversationId: convertGroupV2(dataMessage.groupV2)?.id ?? conversationId,
    targetAuthorAci,
    targetTimestamp,
    senderAci,
    timestamp: dataMessageTimestamp,
    optionIndexes: pollVote.optionIndexes,
    voteCount: pollVote.voteCount ?? pollVote.optionIndexes.length,
  };
}

function convertDataMessagePollTerminateToWebEvent({
  conversationId,
  dataMessage,
  senderAci,
  timestamp,
}: Readonly<{
  conversationId: string;
  dataMessage: Proto.DataMessage;
  senderAci: string;
  timestamp: number;
}>): WebPollTerminateEvent | undefined {
  if (!dataMessage.pollTerminate) {
    return undefined;
  }

  const dataMessageTimestamp = toNumber(dataMessage.timestamp) ?? timestamp;
  const targetTimestamp = toNumber(dataMessage.pollTerminate.targetSentTimestamp);
  if (targetTimestamp == null) {
    return undefined;
  }

  return {
    type: 'poll-terminate',
    conversationId: convertGroupV2(dataMessage.groupV2)?.id ?? conversationId,
    targetAuthorAci: senderAci,
    targetTimestamp,
    senderAci,
    timestamp: dataMessageTimestamp,
  };
}

function convertContentToWebPollVoteEvent({
  content,
  linkedPayload,
  sourceServiceId,
  timestamp,
}: Readonly<{
  content: Proto.Content;
  linkedPayload: WebSendLinkedPayload;
  sourceServiceId: string;
  timestamp: number;
}>): WebPollVoteEvent | undefined {
  const dataMessage = content.content?.dataMessage;
  if (dataMessage?.pollVote) {
    return convertDataMessagePollVoteToWebEvent({
      conversationId: sourceServiceId,
      dataMessage,
      senderAci: sourceServiceId,
      timestamp,
    });
  }

  const sent = content.content?.syncMessage?.content?.sent;
  const sentMessage = sent?.message;
  if (sent && sentMessage?.pollVote) {
    const conversationId = getSentDataMessageConversationId({
      dataMessage: sentMessage,
      logContext: 'convertContentToWebPollVoteEvent.sent.destinationServiceId',
      sent,
    });
    const senderAci =
      linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
    if (!conversationId || !senderAci) {
      return undefined;
    }
    return convertDataMessagePollVoteToWebEvent({
      conversationId,
      dataMessage: sentMessage,
      senderAci,
      timestamp: toNumber(sent.timestamp) ?? timestamp,
    });
  }

  return undefined;
}

function convertContentToWebPollTerminateEvent({
  content,
  linkedPayload,
  sourceServiceId,
  timestamp,
}: Readonly<{
  content: Proto.Content;
  linkedPayload: WebSendLinkedPayload;
  sourceServiceId: string;
  timestamp: number;
}>): WebPollTerminateEvent | undefined {
  const dataMessage = content.content?.dataMessage;
  if (dataMessage?.pollTerminate) {
    return convertDataMessagePollTerminateToWebEvent({
      conversationId: sourceServiceId,
      dataMessage,
      senderAci: sourceServiceId,
      timestamp,
    });
  }

  const sent = content.content?.syncMessage?.content?.sent;
  const sentMessage = sent?.message;
  if (sent && sentMessage?.pollTerminate) {
    const conversationId = getSentDataMessageConversationId({
      dataMessage: sentMessage,
      logContext:
        'convertContentToWebPollTerminateEvent.sent.destinationServiceId',
      sent,
    });
    const senderAci =
      linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
    if (!conversationId || !senderAci) {
      return undefined;
    }
    return convertDataMessagePollTerminateToWebEvent({
      conversationId,
      dataMessage: sentMessage,
      senderAci,
      timestamp: toNumber(sent.timestamp) ?? timestamp,
    });
  }

  return undefined;
}

function getPresentKeys(value: unknown): Array<string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value)
    .filter(([key, entry]) => {
      if (key === '$unknown') {
        return false;
      }
      if (entry == null) {
        return false;
      }
      if (Array.isArray(entry) && entry.length === 0) {
        return false;
      }
      return true;
    })
    .map(([key]) => key);
}

function describeDecryptedContent(content: Proto.Content): string {
  const root = content.content;
  const syncMessage = root?.syncMessage;
  const dataMessage = root?.dataMessage;
  const receiptMessage = root?.receiptMessage;
  const typingMessage = root?.typingMessage;
  const summary = {
    contentKeys: getPresentKeys(root),
    dataMessageKeys: getPresentKeys(dataMessage),
    syncMessageKeys: getPresentKeys(syncMessage),
    syncContentKeys: getPresentKeys(syncMessage?.content),
    receiptMessageKeys: getPresentKeys(receiptMessage),
    typingMessageKeys: getPresentKeys(typingMessage),
  };
  return JSON.stringify(summary);
}

function isStorageManifestFetchLatest(content: Proto.Content): boolean {
  const fetchLatest = content.content?.syncMessage?.content?.fetchLatest;
  return (
    fetchLatest?.type ===
    Proto.SyncMessage.FetchLatest.Type.STORAGE_MANIFEST
  );
}

export async function decryptIncomingSignalEnvelope({
  envelopeBytes,
  linkedPayload,
}: Readonly<{
  envelopeBytes: Uint8Array<ArrayBuffer>;
  linkedPayload: WebSendLinkedPayload;
}>): Promise<{
  contentSummary: string;
  ignoredReason?: string;
  message?: WebMessage;
  pinMessage?: WebPinMessageEvent;
  reaction?: WebReactionEvent;
  editMessage?: WebEditMessageEvent;
  deleteMessage?: WebDeleteMessageEvent;
  unpinMessage?: WebUnpinMessageEvent;
  attachmentBackfill?: WebAttachmentBackfillEvent;
  receipt?: WebReceiptEvent;
  typing?: WebTypingEvent;
  pollVote?: WebPollVoteEvent;
  pollTerminate?: WebPollTerminateEvent;
  storageManifestFetchLatest?: boolean;
}> {
  const envelope = Proto.Envelope.decode(envelopeBytes);
  if (getEnvelopeType(envelope) === Proto.Envelope.Type.SERVER_DELIVERY_RECEIPT) {
    return {
      contentSummary: JSON.stringify({
        envelopeType: 'SERVER_DELIVERY_RECEIPT',
      }),
      ignoredReason: 'SERVER_DELIVERY_RECEIPT',
    };
  }

  const decrypted = await decryptEnvelopeContent({ envelopeBytes, linkedPayload });
  const processedSenderKeyDistributionMessage =
    await maybeProcessSenderKeyDistributionMessage({
      content: decrypted.content,
      protocolStore: decrypted.protocolStore,
      sourceDevice: decrypted.sourceDevice,
      sourceServiceId: decrypted.sourceServiceId,
    });
  return {
    contentSummary: describeDecryptedContent(decrypted.content),
    ignoredReason: processedSenderKeyDistributionMessage
      ? 'senderKeyDistributionMessage'
      : undefined,
    message: convertContentToWebMessage({
      content: decrypted.content,
      linkedPayload,
      sourceServiceId: decrypted.sourceServiceId,
      timestamp: decrypted.timestamp,
    }),
    pinMessage: convertContentToWebPinMessageEvent({
      content: decrypted.content,
      linkedPayload,
      sourceServiceId: decrypted.sourceServiceId,
      timestamp: decrypted.timestamp,
    }),
    reaction: convertContentToWebReactionEvent({
      content: decrypted.content,
      linkedPayload,
      sourceServiceId: decrypted.sourceServiceId,
      timestamp: decrypted.timestamp,
    }),
    editMessage: convertContentToWebEditEvent({
      content: decrypted.content,
      linkedPayload,
      sourceServiceId: decrypted.sourceServiceId,
      timestamp: decrypted.timestamp,
    }),
    deleteMessage: convertContentToWebDeleteEvent({
      content: decrypted.content,
      linkedPayload,
      sourceServiceId: decrypted.sourceServiceId,
      timestamp: decrypted.timestamp,
    }),
    unpinMessage: convertContentToWebUnpinEvent({
      content: decrypted.content,
      sourceServiceId: decrypted.sourceServiceId,
      timestamp: decrypted.timestamp,
    }),
    attachmentBackfill: convertContentToWebAttachmentBackfillEvent({
      content: decrypted.content,
      timestamp: decrypted.timestamp,
    }),
    receipt: convertContentToWebReceiptEvent({
      content: decrypted.content,
      sourceServiceId: decrypted.sourceServiceId,
    }),
    typing: convertContentToWebTypingEvent({
      content: decrypted.content,
      sourceDevice: decrypted.sourceDevice,
      sourceServiceId: decrypted.sourceServiceId,
    }),
    pollVote: convertContentToWebPollVoteEvent({
      content: decrypted.content,
      linkedPayload,
      sourceServiceId: decrypted.sourceServiceId,
      timestamp: decrypted.timestamp,
    }),
    pollTerminate: convertContentToWebPollTerminateEvent({
      content: decrypted.content,
      linkedPayload,
      sourceServiceId: decrypted.sourceServiceId,
      timestamp: decrypted.timestamp,
    }),
    storageManifestFetchLatest: isStorageManifestFetchLatest(decrypted.content),
  };
}

async function fetchServerKeys(
  chat: AuthenticatedChatConnection,
  destinationServiceId: string
): Promise<ServerKeys> {
  const response = await chat.fetch({
    verb: 'GET',
    path: `/v2/keys/${destinationServiceId}/*`,
    headers: [],
    timeoutMillis: 30_000,
  });
  const responseBody = Buffer.from(response.body ?? new Uint8Array()).toString(
    'utf8'
  );
  if (response.status !== 200) {
    throw new Error(
      responseBody
        ? `getKeysForServiceId failed with status ${response.status}: ${responseBody}`
        : `getKeysForServiceId failed with status ${response.status}`
    );
  }
  return JSON.parse(responseBody) as ServerKeys;
}

async function createSessionsFromServerKeys({
  chat,
  destinationServiceId,
  deviceIds,
  linkedPayload,
}: Readonly<{
  chat: AuthenticatedChatConnection;
  destinationServiceId: string;
  deviceIds: ReadonlyArray<number> | null;
  linkedPayload: WebSendLinkedPayload;
}>): Promise<void> {
  const aci = getLinkedAci(linkedPayload);
  const ourDeviceId = linkedPayload.credentials?.deviceId;
  if (typeof ourDeviceId !== 'number') {
    throw new Error('createSessionsFromServerKeys: missing linked device id');
  }

  const { identityStore, sessionStore } = getProtocolStore(linkedPayload);
  const localAddress = ProtocolAddress.new(aci, ourDeviceId);
  const serverKeys = await fetchServerKeys(chat, destinationServiceId);
  const identityKey = PublicKey.deserialize(Bytes.fromBase64(serverKeys.identityKey));
  const allowedDeviceIds = deviceIds == null ? null : new Set(deviceIds);

  for (const device of serverKeys.devices) {
    if (destinationServiceId === aci && device.deviceId === ourDeviceId) {
      continue;
    }
    if (allowedDeviceIds && !allowedDeviceIds.has(device.deviceId)) {
      continue;
    }

    const signedPreKey = device.signedPreKey;
    const pqPreKey = device.pqPreKey;
    if (!signedPreKey) {
      throw new Error(
        `getKeysForServiceId/${destinationServiceId}: Missing signed prekey for deviceId ${device.deviceId}`
      );
    }
    if (!pqPreKey) {
      throw new Error(
        `getKeysForServiceId/${destinationServiceId}: Missing signed PQ prekey for deviceId ${device.deviceId}`
      );
    }

    const destinationAddress = ProtocolAddress.new(
      destinationServiceId,
      device.deviceId
    );
    const preKeyBundle = PreKeyBundle.new(
      device.registrationId,
      device.deviceId,
      device.preKey?.keyId ?? null,
      device.preKey ? PublicKey.deserialize(Bytes.fromBase64(device.preKey.publicKey)) : null,
      signedPreKey.keyId,
      PublicKey.deserialize(Bytes.fromBase64(signedPreKey.publicKey)),
      Bytes.fromBase64(signedPreKey.signature),
      identityKey,
      pqPreKey.keyId,
      KEMPublicKey.deserialize(Bytes.fromBase64(pqPreKey.publicKey)),
      Bytes.fromBase64(pqPreKey.signature)
    );
    await processPreKeyBundle(
      preKeyBundle,
      destinationAddress,
      localAddress,
      sessionStore,
      identityStore
    );
  }
}

async function encryptForDestination({
  chat,
  destinationServiceId,
  linkedPayload,
  plaintext,
}: Readonly<{
  chat: AuthenticatedChatConnection;
  destinationServiceId: string;
  linkedPayload: WebSendLinkedPayload;
  plaintext: Uint8Array<ArrayBuffer>;
}>): Promise<ReadonlyArray<SingleOutboundUnsealedMessage>> {
  const aci = getLinkedAci(linkedPayload);
  const ourDeviceId = linkedPayload.credentials?.deviceId;
  if (typeof ourDeviceId !== 'number') {
    throw new Error('sendDirectTextMessage: missing linked device id');
  }

  const { identityStore, sessionStore } = getProtocolStore(linkedPayload);
  const localAddress = ProtocolAddress.new(aci, ourDeviceId);
  let knownSessions = sessionStore.getKnownSessionsForServiceId(
    destinationServiceId,
    destinationServiceId === aci ? ourDeviceId : -1
  );
  if (knownSessions.length === 0) {
    await createSessionsFromServerKeys({
      chat,
      destinationServiceId,
      deviceIds: null,
      linkedPayload,
    });
    knownSessions = sessionStore.getKnownSessionsForServiceId(
      destinationServiceId,
      destinationServiceId === aci ? ourDeviceId : -1
    );
  }

  const encrypted = new Array<SingleOutboundUnsealedMessage>();
  for (const { address: destinationAddress, record } of knownSessions) {
    const ciphertext: CiphertextMessage = await signalEncrypt(
      plaintext,
      destinationAddress,
      localAddress,
      sessionStore,
      identityStore
    );
    encrypted.push({
      deviceId: destinationAddress.deviceId(),
      registrationId: record.remoteRegistrationId(),
      contents: ciphertext,
    });
  }

  if (encrypted.length === 0) {
    throw new Error('sendDirectTextMessage: no destination devices to send');
  }
  return encrypted;
}

type WebMismatchedDevicesEntry = Readonly<{
  serviceId: ServiceIdString;
  missingDevices: ReadonlyArray<number>;
  extraDevices: ReadonlyArray<number>;
  staleDevices: ReadonlyArray<number>;
}>;

type WebMismatchedDevicesErrorValue = Readonly<{
  code?: unknown;
  entries?: ReadonlyArray<{
    account?: ServiceId;
    missingDevices?: ReadonlyArray<number>;
    extraDevices?: ReadonlyArray<number>;
    staleDevices?: ReadonlyArray<number>;
  }>;
  is?: (code: ErrorCode) => boolean;
  name?: unknown;
}>;

function getMismatchedDevicesErrorValue(
  error: unknown
): WebMismatchedDevicesErrorValue | undefined {
  let current = error;

  for (let index = 0; index < 4; index += 1) {
    const value = current as
      | (WebMismatchedDevicesErrorValue & { cause?: unknown })
      | undefined;
    const isMismatch =
      value?.code === ErrorCode.MismatchedDevices ||
      value?.name === 'MismatchedDevices' ||
      value?.is?.(ErrorCode.MismatchedDevices) === true;
    if (isMismatch) {
      return value;
    }
    if (value?.cause == null) {
      return undefined;
    }
    current = value.cause;
  }

  return undefined;
}

function getMismatchedDevicesEntries(
  error: unknown,
  destinationServiceId: string
): ReadonlyArray<WebMismatchedDevicesEntry> | undefined {
  const value = getMismatchedDevicesErrorValue(error);
  if (!value) {
    return undefined;
  }

  if (!Array.isArray(value?.entries) || value.entries.length === 0) {
    return [
      {
        serviceId: destinationServiceId as ServiceIdString,
        missingDevices: [],
        extraDevices: [],
        staleDevices: [],
      },
    ];
  }

  return value.entries.map(entry => ({
    serviceId: entry.account
      ? fromServiceIdObject(entry.account)
      : (destinationServiceId as ServiceIdString),
    missingDevices: entry.missingDevices ?? [],
    extraDevices: entry.extraDevices ?? [],
    staleDevices: entry.staleDevices ?? [],
  }));
}

async function handleWebMismatchedDevices({
  chat,
  entries,
  linkedPayload,
}: Readonly<{
  chat: AuthenticatedChatConnection;
  entries: ReadonlyArray<WebMismatchedDevicesEntry>;
  linkedPayload: WebSendLinkedPayload;
}>): Promise<void> {
  const ourDeviceId = linkedPayload.credentials?.deviceId;
  if (typeof ourDeviceId !== 'number') {
    throw new Error('handleWebMismatchedDevices: missing linked device id');
  }

  for (const entry of entries) {
    const { sessionStore } = getProtocolStoreForServiceId(
      linkedPayload,
      entry.serviceId
    );
    const shouldFetchAll =
      entry.missingDevices.length === 0 &&
      entry.extraDevices.length === 0 &&
      entry.staleDevices.length === 0;

    if (shouldFetchAll) {
      sessionStore.removeAllKnownSessionsForServiceId(
        entry.serviceId,
        entry.serviceId === getLinkedAci(linkedPayload) ? ourDeviceId : -1
      );
    }
    if (entry.extraDevices.length > 0) {
      sessionStore.removeSessionsForServiceId(entry.serviceId, entry.extraDevices);
    }
    if (entry.staleDevices.length > 0) {
      sessionStore.removeSessionsForServiceId(entry.serviceId, entry.staleDevices);
    }

    if (shouldFetchAll) {
      await createSessionsFromServerKeys({
        chat,
        destinationServiceId: entry.serviceId,
        deviceIds: null,
        linkedPayload,
      });
    }
    if (entry.missingDevices.length > 0) {
      await createSessionsFromServerKeys({
        chat,
        destinationServiceId: entry.serviceId,
        deviceIds: entry.missingDevices,
        linkedPayload,
      });
    }
    if (entry.staleDevices.length > 0) {
      await createSessionsFromServerKeys({
        chat,
        destinationServiceId: entry.serviceId,
        deviceIds: entry.staleDevices,
        linkedPayload,
      });
    }
  }
}

export async function sendDirectTextMessage({
  attachments = [],
  body,
  chat,
  deleteForEveryone,
  destinationServiceId,
  isViewOnce,
  linkedPayload,
  pinMessage,
  quote,
  timestamp,
  unpinMessage,
}: DirectTextSendOptions): Promise<WebMessage & { attachments?: ReadonlyArray<WebAttachment> }> {
  const ourAci = getLinkedAci(linkedPayload);
  const plaintext = createTextContent(
    body,
    timestamp,
    attachments,
    pinMessage,
    deleteForEveryone,
    quote,
    unpinMessage,
    isViewOnce
  );
  let messages = await encryptForDestination({
    chat,
    destinationServiceId,
    linkedPayload,
    plaintext,
  });

  if (destinationServiceId === ourAci) {
    try {
      await chat.sendSyncMessage({
        contents: messages,
        timestamp,
        urgent: true,
      });
    } catch (error) {
      const sendSummary = {
        destinationServiceId,
        devices: messages.map(message => ({
          deviceId: message.deviceId,
          registrationId: message.registrationId,
          type: message.contents.type(),
          contentLength: message.contents.serialize().byteLength,
        })),
        cause: getErrorSummary(error),
      };
      throw new Error(
        `sendDirectTextMessage sync-to-self failed: ${JSON.stringify(sendSummary)}`,
        { cause: error }
      );
    }
  } else {
    try {
      await chat.sendMessage({
        destination: ServiceId.parseFromServiceIdString(destinationServiceId),
        contents: messages,
        timestamp,
        onlineOnly: false,
        urgent: true,
      });
    } catch (error) {
      const mismatchedEntries = getMismatchedDevicesEntries(
        error,
        destinationServiceId
      );
      if (mismatchedEntries) {
        await handleWebMismatchedDevices({
          chat,
          entries: mismatchedEntries,
          linkedPayload,
        });
        messages = await encryptForDestination({
          chat,
          destinationServiceId,
          linkedPayload,
          plaintext,
        });
        await chat.sendMessage({
          destination: ServiceId.parseFromServiceIdString(destinationServiceId),
          contents: messages,
          timestamp,
          onlineOnly: false,
          urgent: true,
        });
      } else {
        const sendSummary = {
          destinationServiceId,
          devices: messages.map(message => ({
            deviceId: message.deviceId,
            registrationId: message.registrationId,
            type: message.contents.type(),
            contentLength: message.contents.serialize().byteLength,
          })),
          cause: getErrorSummary(error),
        };
        throw new Error(
          `sendDirectTextMessage delivery failed: ${JSON.stringify(sendSummary)}`,
          { cause: error }
        );
      }
    }

    try {
      const syncMessages = await encryptForDestination({
        chat,
        destinationServiceId: ourAci,
        linkedPayload,
        plaintext: createSentSyncContent({
          attachments,
          body,
          deleteForEveryone,
          destinationServiceId,
          isViewOnce,
          pinMessage,
          quote,
          timestamp,
          unpinMessage,
        }),
      });
      await chat.sendSyncMessage({
        contents: syncMessages,
        timestamp,
        urgent: true,
      });
    } catch (error) {
      console.warn(
        'sendDirectTextMessage: sent to destination, but failed to sync sent message',
        JSON.stringify({
          destinationServiceId,
          cause: getErrorSummary(error),
        })
      );
    }
  }

  return {
    id: `sent:${destinationServiceId}:${timestamp}`,
    conversationId: destinationServiceId,
    body,
    timestamp,
    receivedAt: timestamp,
    direction: 'outgoing',
    status: 'sent',
    attachments,
    pinMessage,
    quote,
    unpinMessage,
    sourceServiceId: getLinkedAci(linkedPayload),
  };
}

function createGroupContextV2(
  groupV2: GroupTextSendOptions['groupV2']
): Proto.GroupContextV2.Params {
  return {
    masterKey: Bytes.fromBase64(groupV2.masterKey),
    revision: groupV2.revision,
    groupChange: null,
  };
}

function createGroupUpdateContextV2(
  groupV2: GroupTextSendOptions['groupV2'],
  groupChangeBase64: string
): Proto.GroupContextV2.Params {
  return {
    masterKey: Bytes.fromBase64(groupV2.masterKey),
    revision: groupV2.revision,
    groupChange: Bytes.fromBase64(groupChangeBase64),
  };
}

export async function sendGroupUpdateMessage({
  chat,
  groupChangeBase64,
  groupId,
  groupV2,
  linkedPayload,
  recipients,
  timestamp,
}: GroupUpdateSendOptions): Promise<void> {
  const ourAci = getLinkedAci(linkedPayload);
  const groupContext = createGroupUpdateContextV2(groupV2, groupChangeBase64);
  const plaintext = createTextContent('', timestamp, [], undefined, undefined, undefined, undefined, undefined, groupContext);
  const recipientServiceIds = Array.from(new Set(recipients)).filter(
    recipient => recipient !== ourAci
  );

  for (const destinationServiceId of recipientServiceIds) {
    let messages = await encryptForDestination({
      chat,
      destinationServiceId,
      linkedPayload,
      plaintext,
    });

    try {
      await chat.sendMessage({
        destination: ServiceId.parseFromServiceIdString(destinationServiceId),
        contents: messages,
        timestamp,
        onlineOnly: false,
        urgent: true,
      });
    } catch (error) {
      const mismatchedEntries = getMismatchedDevicesEntries(
        error,
        destinationServiceId
      );
      if (!mismatchedEntries) {
        throw new Error(
          `sendGroupUpdateMessage delivery failed: ${JSON.stringify({
            groupId,
            destinationServiceId,
            cause: getErrorSummary(error),
          })}`,
          { cause: error }
        );
      }

      await handleWebMismatchedDevices({
        chat,
        entries: mismatchedEntries,
        linkedPayload,
      });
      messages = await encryptForDestination({
        chat,
        destinationServiceId,
        linkedPayload,
        plaintext,
      });
      await chat.sendMessage({
        destination: ServiceId.parseFromServiceIdString(destinationServiceId),
        contents: messages,
        timestamp,
        onlineOnly: false,
        urgent: true,
      });
    }
  }

  try {
    const syncMessages = await encryptForDestination({
      chat,
      destinationServiceId: ourAci,
      linkedPayload,
      plaintext: createSentSyncContent({
        body: '',
        groupV2: groupContext,
        timestamp,
      }),
    });
    await chat.sendSyncMessage({
      contents: syncMessages,
      timestamp,
      urgent: true,
    });
  } catch (error) {
    console.warn(
      'sendGroupUpdateMessage: sent to group recipients, but failed to sync sent group update',
      JSON.stringify({
        groupId,
        cause: getErrorSummary(error),
      })
    );
  }
}

export async function sendGroupTextMessage({
  attachments = [],
  body,
  chat,
  deleteForEveryone,
  groupId,
  groupV2,
  isViewOnce,
  linkedPayload,
  pinMessage,
  quote,
  recipients,
  timestamp,
  unpinMessage,
}: GroupTextSendOptions): Promise<WebMessage & { attachments?: ReadonlyArray<WebAttachment> }> {
  const ourAci = getLinkedAci(linkedPayload);
  const groupContext = createGroupContextV2(groupV2);
  const plaintext = createTextContent(
    body,
    timestamp,
    attachments,
    pinMessage,
    deleteForEveryone,
    quote,
    unpinMessage,
    isViewOnce,
    groupContext
  );
  const recipientServiceIds = Array.from(new Set(recipients)).filter(
    recipient => recipient !== ourAci
  );

  for (const destinationServiceId of recipientServiceIds) {
    let messages = await encryptForDestination({
      chat,
      destinationServiceId,
      linkedPayload,
      plaintext,
    });

    try {
      await chat.sendMessage({
        destination: ServiceId.parseFromServiceIdString(destinationServiceId),
        contents: messages,
        timestamp,
        onlineOnly: false,
        urgent: true,
      });
    } catch (error) {
      const mismatchedEntries = getMismatchedDevicesEntries(
        error,
        destinationServiceId
      );
      if (!mismatchedEntries) {
        const sendSummary = {
          destinationServiceId,
          groupId,
          devices: messages.map(message => ({
            deviceId: message.deviceId,
            registrationId: message.registrationId,
            type: message.contents.type(),
            contentLength: message.contents.serialize().byteLength,
          })),
          cause: getErrorSummary(error),
        };
        throw new Error(
          `sendGroupTextMessage delivery failed: ${JSON.stringify(sendSummary)}`,
          { cause: error }
        );
      }

      await handleWebMismatchedDevices({
        chat,
        entries: mismatchedEntries,
        linkedPayload,
      });
      messages = await encryptForDestination({
        chat,
        destinationServiceId,
        linkedPayload,
        plaintext,
      });
      await chat.sendMessage({
        destination: ServiceId.parseFromServiceIdString(destinationServiceId),
        contents: messages,
        timestamp,
        onlineOnly: false,
        urgent: true,
      });
    }
  }

  try {
    const syncMessages = await encryptForDestination({
      chat,
      destinationServiceId: ourAci,
      linkedPayload,
      plaintext: createSentSyncContent({
        attachments,
        body,
        deleteForEveryone,
        groupV2: groupContext,
        isViewOnce,
        pinMessage,
        quote,
        timestamp,
        unpinMessage,
      }),
    });
    await chat.sendSyncMessage({
      contents: syncMessages,
      timestamp,
      urgent: true,
    });
  } catch (error) {
    console.warn(
      'sendGroupTextMessage: sent to group recipients, but failed to sync sent message',
      JSON.stringify({
        groupId,
        cause: getErrorSummary(error),
      })
    );
  }

  const secretParams = deriveGroupSecretParams(Bytes.fromBase64(groupV2.masterKey));
  const publicParams = deriveGroupPublicParams(secretParams);

  return {
    id: `sent:${groupId}:${timestamp}`,
    conversationId: groupId,
    body,
    timestamp,
    receivedAt: timestamp,
    direction: 'outgoing',
    status: 'sent',
    attachments,
    isViewOnce,
    quote,
    groupV2: {
      id: groupId,
      masterKey: groupV2.masterKey,
      publicParams: Bytes.toBase64(publicParams),
      revision: groupV2.revision,
      secretParams: Bytes.toBase64(secretParams),
    },
    sourceServiceId: ourAci,
  };
}

export async function sendDirectReaction({
  chat,
  destinationServiceId,
  emoji,
  linkedPayload,
  remove,
  targetAuthorAci,
  targetTimestamp,
  timestamp,
}: DirectReactionSendOptions): Promise<void> {
  const ourAci = getLinkedAci(linkedPayload);
  const messages = await encryptForDestination({
    chat,
    destinationServiceId,
    linkedPayload,
    plaintext: createReactionContent({
      emoji,
      remove,
      targetAuthorAci,
      targetTimestamp,
      timestamp,
    }),
  });

  if (destinationServiceId === ourAci) {
    await chat.sendSyncMessage({
      contents: messages,
      timestamp,
      urgent: true,
    });
    return;
  }

  await chat.sendMessage({
    destination: ServiceId.parseFromServiceIdString(destinationServiceId),
    contents: messages,
    timestamp,
    onlineOnly: false,
    urgent: true,
  });

  try {
    const syncMessages = await encryptForDestination({
      chat,
      destinationServiceId: ourAci,
      linkedPayload,
      plaintext: createSentReactionSyncContent({
        destinationServiceId,
        emoji,
        remove,
        targetAuthorAci,
        targetTimestamp,
        timestamp,
      }),
    });
    await chat.sendSyncMessage({
      contents: syncMessages,
      timestamp,
      urgent: true,
    });
  } catch (error) {
    console.warn(
      'sendDirectReaction: sent to destination, but failed to sync sent reaction',
      JSON.stringify({
        destinationServiceId,
        targetAuthorAci,
        targetTimestamp,
        cause: getErrorSummary(error),
      })
    );
  }
}

export async function sendGroupReaction({
  chat,
  emoji,
  groupId,
  groupV2,
  linkedPayload,
  recipients,
  remove,
  targetAuthorAci,
  targetTimestamp,
  timestamp,
}: GroupReactionSendOptions): Promise<void> {
  const ourAci = getLinkedAci(linkedPayload);
  const groupContext = createGroupContextV2(groupV2);
  const plaintext = createReactionContent({
    emoji,
    groupV2: groupContext,
    remove,
    targetAuthorAci,
    targetTimestamp,
    timestamp,
  });
  const recipientServiceIds = Array.from(new Set(recipients)).filter(
    recipient => recipient !== ourAci
  );

  for (const destinationServiceId of recipientServiceIds) {
    let messages = await encryptForDestination({
      chat,
      destinationServiceId,
      linkedPayload,
      plaintext,
    });

    try {
      await chat.sendMessage({
        destination: ServiceId.parseFromServiceIdString(destinationServiceId),
        contents: messages,
        timestamp,
        onlineOnly: false,
        urgent: true,
      });
    } catch (error) {
      const mismatchedEntries = getMismatchedDevicesEntries(
        error,
        destinationServiceId
      );
      if (!mismatchedEntries) {
        const sendSummary = {
          destinationServiceId,
          groupId,
          targetAuthorAci,
          targetTimestamp,
          cause: getErrorSummary(error),
        };
        throw new Error(
          `sendGroupReaction delivery failed: ${JSON.stringify(sendSummary)}`,
          { cause: error }
        );
      }

      await handleWebMismatchedDevices({
        chat,
        entries: mismatchedEntries,
        linkedPayload,
      });
      messages = await encryptForDestination({
        chat,
        destinationServiceId,
        linkedPayload,
        plaintext,
      });
      await chat.sendMessage({
        destination: ServiceId.parseFromServiceIdString(destinationServiceId),
        contents: messages,
        timestamp,
        onlineOnly: false,
        urgent: true,
      });
    }
  }

  try {
    const syncMessages = await encryptForDestination({
      chat,
      destinationServiceId: ourAci,
      linkedPayload,
      plaintext: createSentReactionSyncContent({
        emoji,
        groupV2: groupContext,
        remove,
        targetAuthorAci,
        targetTimestamp,
        timestamp,
      }),
    });
    await chat.sendSyncMessage({
      contents: syncMessages,
      timestamp,
      urgent: true,
    });
  } catch (error) {
    console.warn(
      'sendGroupReaction: sent to group recipients, but failed to sync sent reaction',
      JSON.stringify({
        groupId,
        targetAuthorAci,
        targetTimestamp,
        cause: getErrorSummary(error),
      })
    );
  }
}

export async function sendDirectEditMessage({
  body,
  chat,
  destinationServiceId,
  linkedPayload,
  targetTimestamp,
  timestamp,
}: DirectEditSendOptions): Promise<{ ok: true; timestamp: number }> {
  const ourAci = getLinkedAci(linkedPayload);
  const messages = await encryptForDestination({
    chat,
    destinationServiceId,
    linkedPayload,
    plaintext: createEditContent({
      body,
      targetTimestamp,
      timestamp,
    }),
  });

  if (destinationServiceId === ourAci) {
    await chat.sendSyncMessage({
      contents: messages,
      timestamp,
      urgent: true,
    });
    return { ok: true, timestamp };
  }

  await chat.sendMessage({
    destination: ServiceId.parseFromServiceIdString(destinationServiceId),
    contents: messages,
    timestamp,
    onlineOnly: false,
    urgent: true,
  });

  try {
    const syncMessages = await encryptForDestination({
      chat,
      destinationServiceId: ourAci,
      linkedPayload,
      plaintext: createSentEditSyncContent({
        body,
        destinationServiceId,
        targetTimestamp,
        timestamp,
      }),
    });
    await chat.sendSyncMessage({
      contents: syncMessages,
      timestamp,
      urgent: true,
    });
  } catch (error) {
    console.warn(
      'sendDirectEditMessage: sent to destination, but failed to sync sent edit',
      JSON.stringify({
        destinationServiceId,
        targetTimestamp,
        cause: getErrorSummary(error),
      })
    );
  }

  return { ok: true, timestamp };
}

export async function sendMessageRequestResponseSync({
  chat,
  linkedPayload,
  threadAci,
  timestamp,
  type,
}: MessageRequestResponseSyncOptions): Promise<{
  threadAci: string;
  timestamp: number;
  type: number;
}> {
  const ourAci = getLinkedAci(linkedPayload);
  let messages = await encryptForDestination({
    chat,
    destinationServiceId: ourAci,
    linkedPayload,
    plaintext: createMessageRequestResponseSyncContent({
      threadAci,
      type,
    }),
  });

  try {
    await chat.sendSyncMessage({
      contents: messages,
      timestamp,
      urgent: false,
    });
  } catch (error) {
    const sendSummary = {
      threadAci,
      type,
      devices: messages.map(message => ({
        deviceId: message.deviceId,
        registrationId: message.registrationId,
        type: message.contents.type(),
        contentLength: message.contents.serialize().byteLength,
      })),
      cause: getErrorSummary(error),
    };
    const mismatchedEntries = getMismatchedDevicesEntries(error, ourAci);
    if (mismatchedEntries) {
      await handleWebMismatchedDevices({
        chat,
        entries: mismatchedEntries,
        linkedPayload,
      });
      messages = await encryptForDestination({
        chat,
        destinationServiceId: ourAci,
        linkedPayload,
        plaintext: createMessageRequestResponseSyncContent({
          threadAci,
          type,
        }),
      });
      await chat.sendSyncMessage({
        contents: messages,
        timestamp,
        urgent: false,
      });
      return {
        threadAci,
        timestamp,
        type,
      };
    }
    throw new Error(
      `sendMessageRequestResponseSync failed: ${JSON.stringify(sendSummary)}`,
      { cause: error }
    );
  }

  return {
    threadAci,
    timestamp,
    type,
  };
}

export async function sendAttachmentBackfillRequestSync({
  chat,
  conversationId,
  conversationType,
  linkedPayload,
  targetAuthorAci,
  targetSentTimestamp,
  timestamp,
}: AttachmentBackfillRequestOptions): Promise<{
  conversationId: string;
  targetAuthorAci: string;
  targetSentTimestamp: number;
  timestamp: number;
}> {
  const ourAci = getLinkedAci(linkedPayload);
  let messages = await encryptForDestination({
    chat,
    destinationServiceId: ourAci,
    linkedPayload,
    plaintext: createAttachmentBackfillRequestSyncContent({
      conversationId,
      conversationType,
      targetAuthorAci,
      targetSentTimestamp,
    }),
  });

  try {
    await chat.sendSyncMessage({
      contents: messages,
      timestamp,
      urgent: false,
    });
  } catch (error) {
    const sendSummary = {
      conversationId,
      targetAuthorAci,
      targetSentTimestamp,
      devices: messages.map(message => ({
        deviceId: message.deviceId,
        registrationId: message.registrationId,
        type: message.contents.type(),
        contentLength: message.contents.serialize().byteLength,
      })),
      cause: getErrorSummary(error),
    };
    const mismatchedEntries = getMismatchedDevicesEntries(error, ourAci);
    if (mismatchedEntries) {
      await handleWebMismatchedDevices({
        chat,
        entries: mismatchedEntries,
        linkedPayload,
      });
      messages = await encryptForDestination({
        chat,
        destinationServiceId: ourAci,
        linkedPayload,
        plaintext: createAttachmentBackfillRequestSyncContent({
          conversationId,
          conversationType,
          targetAuthorAci,
          targetSentTimestamp,
        }),
      });
      await chat.sendSyncMessage({
        contents: messages,
        timestamp,
        urgent: false,
      });
      return {
        conversationId,
        targetAuthorAci,
        targetSentTimestamp,
        timestamp,
      };
    }
    throw new Error(
      `sendAttachmentBackfillRequestSync failed: ${JSON.stringify(sendSummary)}`,
      { cause: error }
    );
  }

  return {
    conversationId,
    targetAuthorAci,
    targetSentTimestamp,
    timestamp,
  };
}
