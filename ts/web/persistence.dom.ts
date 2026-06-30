// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  ChatShellState,
  ContactsBootstrap,
  LinkedPayload,
  LinkedSessionRecord,
  ProtocolState,
} from './types.std.ts';
import { recoverRetriableAttachmentStates } from './runtime/recoverRetriableAttachmentStates.dom.ts';

const CURRENT_LINKED_SESSION_ID = 'current';
const DATABASE_NAME = 'renderPersistence';
const DATABASE_VERSION = 4;
const SESSION_STORE_NAME = 'linkedSessions';
const CHAT_SHELL_STORE_NAME = 'chatShellState';
const CONTACTS_BOOTSTRAP_STORE_NAME = 'contactsBootstrap';
const ACTIVE_LINKED_SESSION_USER_ID_STORAGE_KEY =
  'render.activeLinkedSessionUserId';
const LINKED_SESSION_STORAGE_KEY_BASE = 'render.linkedSession';
const CHAT_SHELL_STORAGE_KEY_BASE = 'render.chatShellState';
const CONTACTS_BOOTSTRAP_STORAGE_KEY_BASE = 'render.contactsBootstrap';
const LEGACY_LINKED_SESSION_STORAGE_KEY = 'my.render.linkedSession';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    };
  });
}

export function canUseIndexedDb(): boolean {
  return typeof window !== 'undefined' && window.indexedDB != null;
}

export async function openRenderPersistenceDatabase(): Promise<
  IDBDatabase | undefined
> {
  if (!canUseIndexedDb()) {
    return undefined;
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains('protocolState')) {
        database.deleteObjectStore('protocolState');
      }
      if (!database.objectStoreNames.contains(SESSION_STORE_NAME)) {
        database.createObjectStore(SESSION_STORE_NAME, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(CHAT_SHELL_STORE_NAME)) {
        database.createObjectStore(CHAT_SHELL_STORE_NAME, {
          keyPath: 'sessionAci',
        });
      }
      if (!database.objectStoreNames.contains(CONTACTS_BOOTSTRAP_STORE_NAME)) {
        database.createObjectStore(CONTACTS_BOOTSTRAP_STORE_NAME, {
          keyPath: 'sessionKey',
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      reject(request.error ?? new Error('Failed to open IndexedDB'));
    };
  });
}

export function getUserScopedStorageKey(userId: string, baseKey: string): string {
  return `user:${encodeURIComponent(userId)}:${baseKey}`;
}

export function getLinkedSessionUserId(
  linkedSession: LinkedSessionRecord | undefined
): string | undefined {
  const raw =
    linkedSession?.credentials?.aci ?? linkedSession?.account?.aci ?? undefined;
  const normalized = raw?.trim();
  return normalized || undefined;
}

function createIdentityKeyPair(
  publicKey?: string,
  privateKey?: string
): { publicKey?: string; privateKey?: string } | undefined {
  if (!publicKey && !privateKey) {
    return undefined;
  }
  return { publicKey, privateKey };
}

export function createProtocolStateFromLinkedPayload(
  linkedPayload: LinkedPayload
): ProtocolState {
  return {
    registrationIds: {
      aci: linkedPayload.aciRegistrationId,
      pni: linkedPayload.pniRegistrationId,
    },
    identityKeys: {
      aci: createIdentityKeyPair(
        linkedPayload.aciIdentityKeyPublic,
        linkedPayload.aciIdentityKeyPrivate
      ),
      pni: createIdentityKeyPair(
        linkedPayload.pniIdentityKeyPublic,
        linkedPayload.pniIdentityKeyPrivate
      ),
    },
    identityRecords: [],
    preKeys: [],
    signedPreKeys: [],
    kyberPreKeys: [],
    sessions: [],
    senderKeys: [],
  };
}

export function createLinkedSessionRecord(
  linkedPayload: LinkedPayload,
  linkedAt = Date.now()
): LinkedSessionRecord {
  return {
    id: CURRENT_LINKED_SESSION_ID,
    version: 1,
    linkedAt,
    lastUpdatedAt: linkedAt,
    account: linkedPayload.account,
    linkedPayload,
    credentials: linkedPayload.credentials,
    storageServiceKey: linkedPayload.storageServiceKey,
    protocol: createProtocolStateFromLinkedPayload(linkedPayload),
  };
}

export function isLinkedSessionReady(
  linkedSession: LinkedSessionRecord | undefined
): boolean {
  return Boolean(
      linkedSession?.credentials?.username &&
      linkedSession.credentials.password &&
      linkedSession.credentials.number &&
      linkedSession.storageServiceKey &&
      typeof linkedSession.linkedPayload.aciRegistrationId === 'number' &&
      Boolean(linkedSession.linkedPayload.aciSignedPreKeyRecordBase64) &&
      Boolean(linkedSession.linkedPayload.pniSignedPreKeyRecordBase64) &&
      Boolean(linkedSession.linkedPayload.aciPqLastResortPreKeyRecordBase64) &&
      Boolean(linkedSession.linkedPayload.pniPqLastResortPreKeyRecordBase64) &&
      linkedSession.linkedPayload.protocolPersistenceVersion === 1
  );
}

function parseStoredLinkedSession(raw: string | null): LinkedSessionRecord | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as LinkedSessionRecord | LinkedPayload;
  const linkedSession =
    'linkedPayload' in parsed && 'linkedAt' in parsed
      ? {
          ...parsed,
          protocol:
            parsed.protocol ??
            createProtocolStateFromLinkedPayload(parsed.linkedPayload),
        }
      : createLinkedSessionRecord(parsed);

  return isLinkedSessionReady(linkedSession) ? linkedSession : undefined;
}

export function getActiveLinkedSessionUserIdFromStorage(): string | undefined {
  try {
    const storedUserId =
      window.localStorage
        .getItem(ACTIVE_LINKED_SESSION_USER_ID_STORAGE_KEY)
        ?.trim() || undefined;
    if (storedUserId) {
      return storedUserId;
    }
    return getLinkedSessionUserId(
      parseStoredLinkedSession(
        window.localStorage.getItem(LEGACY_LINKED_SESSION_STORAGE_KEY)
      )
    );
  } catch {
    return undefined;
  }
}

export function loadLinkedSessionRecordFromStorage():
  | LinkedSessionRecord
  | undefined {
  try {
    const activeUserId = getActiveLinkedSessionUserIdFromStorage();
    if (activeUserId) {
      const linkedSession = parseStoredLinkedSession(
        window.localStorage.getItem(
          getUserScopedStorageKey(activeUserId, LINKED_SESSION_STORAGE_KEY_BASE)
        )
      );
      if (linkedSession) {
        return linkedSession;
      }
    }
    return parseStoredLinkedSession(
      window.localStorage.getItem(LEGACY_LINKED_SESSION_STORAGE_KEY)
    );
  } catch {
    return undefined;
  }
}

export function persistLinkedSessionToStorage(
  linkedSession: LinkedSessionRecord | undefined
): void {
  try {
    if (!linkedSession) {
      const activeUserId = getActiveLinkedSessionUserIdFromStorage();
      if (activeUserId) {
        window.localStorage.removeItem(
          getUserScopedStorageKey(activeUserId, LINKED_SESSION_STORAGE_KEY_BASE)
        );
      }
      window.localStorage.removeItem(ACTIVE_LINKED_SESSION_USER_ID_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_LINKED_SESSION_STORAGE_KEY);
      return;
    }

    const userId = getLinkedSessionUserId(linkedSession);
    if (!userId) {
      return;
    }

    const { protocol: _protocol, ...storedLinkedSession } = linkedSession;
    window.localStorage.setItem(ACTIVE_LINKED_SESSION_USER_ID_STORAGE_KEY, userId);
    window.localStorage.setItem(
      getUserScopedStorageKey(userId, LINKED_SESSION_STORAGE_KEY_BASE),
      JSON.stringify(storedLinkedSession)
    );
    window.localStorage.removeItem(LEGACY_LINKED_SESSION_STORAGE_KEY);
  } catch {
  }
}

export async function persistLinkedSessionRecordToIndexedDb(
  linkedSession: LinkedSessionRecord | undefined
): Promise<void> {
  const database = await openRenderPersistenceDatabase();
  if (!database) {
    return;
  }
  try {
    const transaction = database.transaction(SESSION_STORE_NAME, 'readwrite');
    const sessionStore = transaction.objectStore(SESSION_STORE_NAME);
    if (!linkedSession) {
      sessionStore.delete(CURRENT_LINKED_SESSION_ID);
      await transactionToPromise(transaction);
      return;
    }

    const userId = getLinkedSessionUserId(linkedSession);
    if (!userId) {
      await transactionToPromise(transaction);
      return;
    }

    const { protocol: _protocol, ...storedSession } = linkedSession;
    sessionStore.delete(CURRENT_LINKED_SESSION_ID);
    sessionStore.put({
      ...storedSession,
      id: getUserScopedStorageKey(userId, LINKED_SESSION_STORAGE_KEY_BASE),
    });
    await transactionToPromise(transaction);
  } finally {
    database.close();
  }
}

export async function loadLinkedSessionRecordFromIndexedDb(): Promise<
  LinkedSessionRecord | undefined
> {
  const database = await openRenderPersistenceDatabase();
  if (!database) {
    return undefined;
  }
  try {
    const activeUserId = getActiveLinkedSessionUserIdFromStorage();
    const transaction = database.transaction(SESSION_STORE_NAME, 'readonly');
    const sessionStore = transaction.objectStore(SESSION_STORE_NAME);
    let storedSession: Omit<LinkedSessionRecord, 'protocol'> | undefined;
    if (activeUserId) {
      storedSession = await requestToPromise(
        sessionStore.get(
          getUserScopedStorageKey(activeUserId, LINKED_SESSION_STORAGE_KEY_BASE)
        )
      );
    }
    if (!storedSession) {
      storedSession = await requestToPromise(
        sessionStore.get(CURRENT_LINKED_SESSION_ID)
      );
    }
    await transactionToPromise(transaction);
    if (!storedSession) {
      return undefined;
    }
    const linkedSession = {
      ...storedSession,
      protocol: createProtocolStateFromLinkedPayload(
        storedSession.linkedPayload
      ),
    };
    return isLinkedSessionReady(linkedSession) ? linkedSession : undefined;
  } finally {
    database.close();
  }
}

function getSessionKey(sessionKey: string | undefined): string | undefined {
  return sessionKey?.trim() || undefined;
}

type StoredChatShellState = Readonly<{
  version: number;
  sessionAci: string;
  state: ChatShellState;
  updatedAt: number;
}>;

function getScopedChatShellStorageKey(sessionAci: string): string {
  return getUserScopedStorageKey(sessionAci, CHAT_SHELL_STORAGE_KEY_BASE);
}

function persistChatShellStateToLocalStorage(
  chatShellState: ChatShellState,
  sessionAci: string
): void {
  try {
    const scopedKey = getScopedChatShellStorageKey(sessionAci);
    const stored: StoredChatShellState = {
      version: 4,
      sessionAci: scopedKey,
      state: chatShellState,
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(scopedKey, JSON.stringify(stored));
  } catch {
  }
}

function isChatShellState(value: unknown): value is ChatShellState {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'conversationLookup' in value &&
      'messages' in value &&
      Array.isArray((value as { messages?: unknown }).messages)
  );
}

function isStoredChatShellState(value: unknown): value is StoredChatShellState {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'state' in value &&
      isChatShellState((value as { state?: unknown }).state)
  );
}

function loadChatShellStateFromLocalStorage(
  sessionAci: string
): StoredChatShellState | undefined {
  try {
    const scopedKey = getScopedChatShellStorageKey(sessionAci);
    const raw =
      window.localStorage.getItem(scopedKey) ??
      window.localStorage.getItem(sessionAci);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (isStoredChatShellState(parsed)) {
      return parsed;
    }
    if (!isChatShellState(parsed)) {
      return undefined;
    }
    return {
      version: 1,
      sessionAci: scopedKey,
      state: parsed,
      updatedAt: 0,
    };
  } catch {
    return undefined;
  }
}

export async function persistContactsBootstrapForSession(
  sessionKey: string | undefined,
  data: ContactsBootstrap
): Promise<void> {
  const normalizedSessionKey = getSessionKey(sessionKey);
  const database = await openRenderPersistenceDatabase();
  if (!normalizedSessionKey || !database) {
    return;
  }
  try {
    const transaction = database.transaction(
      CONTACTS_BOOTSTRAP_STORE_NAME,
      'readwrite'
    );
    transaction.objectStore(CONTACTS_BOOTSTRAP_STORE_NAME).put({
      version: 2,
      sessionKey: getUserScopedStorageKey(
        normalizedSessionKey,
        CONTACTS_BOOTSTRAP_STORAGE_KEY_BASE
      ),
      data,
      updatedAt: Date.now(),
    });
    await transactionToPromise(transaction);
  } finally {
    database.close();
  }
}

export async function loadContactsBootstrapForSession(
  sessionKey: string | undefined
): Promise<ContactsBootstrap | undefined> {
  const normalizedSessionKey = getSessionKey(sessionKey);
  const database = await openRenderPersistenceDatabase();
  if (!normalizedSessionKey || !database) {
    return undefined;
  }
  try {
    const transaction = database.transaction(
      CONTACTS_BOOTSTRAP_STORE_NAME,
      'readonly'
    );
    const store = transaction.objectStore(CONTACTS_BOOTSTRAP_STORE_NAME);
    const scopedKey = getUserScopedStorageKey(
      normalizedSessionKey,
      CONTACTS_BOOTSTRAP_STORAGE_KEY_BASE
    );
    const stored =
      (await requestToPromise(store.get(scopedKey))) ??
      (await requestToPromise(store.get(normalizedSessionKey)));
    await transactionToPromise(transaction);
    return stored?.data;
  } finally {
    database.close();
  }
}

export async function persistChatShellStateToStorage(
  chatShellState: ChatShellState,
  sessionAci: string | undefined
): Promise<void> {
  const normalizedSessionAci = getSessionKey(sessionAci);
  if (normalizedSessionAci) {
    persistChatShellStateToLocalStorage(chatShellState, normalizedSessionAci);
  }
  const database = await openRenderPersistenceDatabase();
  if (!normalizedSessionAci || !database) {
    return;
  }
  try {
    const transaction = database.transaction(CHAT_SHELL_STORE_NAME, 'readwrite');
    transaction.objectStore(CHAT_SHELL_STORE_NAME).put({
      version: 4,
      sessionAci: getScopedChatShellStorageKey(normalizedSessionAci),
      state: chatShellState,
      updatedAt: Date.now(),
    });
    await transactionToPromise(transaction);
  } finally {
    database.close();
  }
}

export async function loadChatShellStateForSession(
  sessionAci: string | undefined
): Promise<ChatShellState | undefined> {
  const normalizedSessionAci = getSessionKey(sessionAci);
  const localStored = normalizedSessionAci
    ? loadChatShellStateFromLocalStorage(normalizedSessionAci)
    : undefined;
  const database = await openRenderPersistenceDatabase();
  if (!normalizedSessionAci || !database) {
    return localStored?.state
      ? recoverRetriableAttachmentStates(localStored.state)
      : undefined;
  }
  try {
    const transaction = database.transaction(CHAT_SHELL_STORE_NAME, 'readonly');
    const store = transaction.objectStore(CHAT_SHELL_STORE_NAME);
    const scopedKey = getScopedChatShellStorageKey(normalizedSessionAci);
    const indexedDbStored =
      (await requestToPromise(store.get(scopedKey))) ??
      (await requestToPromise(store.get(normalizedSessionAci)));
    await transactionToPromise(transaction);
    const indexedStored = indexedDbStored as StoredChatShellState | undefined;
    if (
      localStored &&
      (!indexedStored || localStored.updatedAt >= indexedStored.updatedAt)
    ) {
      return recoverRetriableAttachmentStates(localStored.state);
    }
    return indexedStored?.state
      ? recoverRetriableAttachmentStates(indexedStored.state)
      : undefined;
  } finally {
    database.close();
  }
}

export async function clearWebPersistence(): Promise<void> {
  const activeUserId = getActiveLinkedSessionUserIdFromStorage();
  if (activeUserId) {
    try {
      window.localStorage.removeItem(getScopedChatShellStorageKey(activeUserId));
      window.localStorage.removeItem(activeUserId);
    } catch {
    }
  }
  persistLinkedSessionToStorage(undefined);
  const database = await openRenderPersistenceDatabase();
  if (!database) {
    return;
  }
  try {
    const transaction = database.transaction(
      [SESSION_STORE_NAME, CHAT_SHELL_STORE_NAME, CONTACTS_BOOTSTRAP_STORE_NAME],
      'readwrite'
    );
    transaction.objectStore(SESSION_STORE_NAME).clear();
    transaction.objectStore(CHAT_SHELL_STORE_NAME).clear();
    transaction.objectStore(CONTACTS_BOOTSTRAP_STORE_NAME).clear();
    await transactionToPromise(transaction);
  } finally {
    database.close();
  }
}
