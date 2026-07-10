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

function removeLinkedSessionRecordFromLocalStorage(userId: string | undefined): void {
  if (userId) {
    window.localStorage.removeItem(
      getUserScopedStorageKey(userId, LINKED_SESSION_STORAGE_KEY_BASE)
    );
  }
  window.localStorage.removeItem(LEGACY_LINKED_SESSION_STORAGE_KEY);
}

export function persistLinkedSessionToStorage(
  linkedSession: LinkedSessionRecord | undefined
): void {
  try {
    if (!linkedSession) {
      const activeUserId = getActiveLinkedSessionUserIdFromStorage();
      removeLinkedSessionRecordFromLocalStorage(activeUserId);
      window.localStorage.removeItem(ACTIVE_LINKED_SESSION_USER_ID_STORAGE_KEY);
      return;
    }

    const userId = getLinkedSessionUserId(linkedSession);
    if (!userId) {
      return;
    }

    window.localStorage.setItem(ACTIVE_LINKED_SESSION_USER_ID_STORAGE_KEY, userId);
    removeLinkedSessionRecordFromLocalStorage(userId);
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

    sessionStore.delete(CURRENT_LINKED_SESSION_ID);
    sessionStore.put({
      ...linkedSession,
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
    let storedSession: LinkedSessionRecord | undefined;
    if (activeUserId) {
      storedSession = await requestToPromise(
        sessionStore.get(
          getUserScopedStorageKey(activeUserId, LINKED_SESSION_STORAGE_KEY_BASE)
        )
      );
    }
    await transactionToPromise(transaction);
    if (!storedSession) {
      return undefined;
    }
    const linkedSession = {
      ...storedSession,
      protocol:
        storedSession.protocol ??
        createProtocolStateFromLinkedPayload(storedSession.linkedPayload),
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

function removeChatShellStateFromLocalStorage(sessionAci: string): void {
  try {
    const scopedKey = getScopedChatShellStorageKey(sessionAci);
    window.localStorage.removeItem(scopedKey);
    window.localStorage.removeItem(sessionAci);
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
    removeChatShellStateFromLocalStorage(normalizedSessionAci);
  } finally {
    database.close();
  }
}

export async function loadChatShellStateForSession(
  sessionAci: string | undefined
): Promise<ChatShellState | undefined> {
  const normalizedSessionAci = getSessionKey(sessionAci);
  const database = await openRenderPersistenceDatabase();
  const localStored = normalizedSessionAci
    ? loadChatShellStateFromLocalStorage(normalizedSessionAci)
    : undefined;
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
    if (indexedStored?.state) {
      removeChatShellStateFromLocalStorage(normalizedSessionAci);
      return recoverRetriableAttachmentStates(indexedStored.state);
    }
    if (localStored?.state) {
      const recovered = recoverRetriableAttachmentStates(localStored.state);
      const writeTransaction = database.transaction(
        CHAT_SHELL_STORE_NAME,
        'readwrite'
      );
      writeTransaction.objectStore(CHAT_SHELL_STORE_NAME).put({
        version: 4,
        sessionAci: scopedKey,
        state: recovered,
        updatedAt: Date.now(),
      });
      await transactionToPromise(writeTransaction);
      removeChatShellStateFromLocalStorage(normalizedSessionAci);
      return recovered;
    }
    return undefined;
  } finally {
    database.close();
  }
}

export async function clearChatShellStateForSession(
  sessionAci: string | undefined
): Promise<void> {
  const normalizedSessionAci = getSessionKey(sessionAci);
  if (!normalizedSessionAci) {
    return;
  }

  const chatShellStorageKey = getScopedChatShellStorageKey(normalizedSessionAci);
  const contactsBootstrapStorageKey = getUserScopedStorageKey(
    normalizedSessionAci,
    CONTACTS_BOOTSTRAP_STORAGE_KEY_BASE
  );
  removeChatShellStateFromLocalStorage(normalizedSessionAci);
  try {
    window.localStorage.removeItem(contactsBootstrapStorageKey);
  } catch {
  }

  const database = await openRenderPersistenceDatabase();
  if (!database) {
    return;
  }

  try {
    const transaction = database.transaction(
      [CHAT_SHELL_STORE_NAME, CONTACTS_BOOTSTRAP_STORE_NAME],
      'readwrite'
    );
    transaction.objectStore(CHAT_SHELL_STORE_NAME).delete(chatShellStorageKey);
    transaction.objectStore(CHAT_SHELL_STORE_NAME).delete(normalizedSessionAci);
    transaction
      .objectStore(CONTACTS_BOOTSTRAP_STORE_NAME)
      .delete(contactsBootstrapStorageKey);
    transaction
      .objectStore(CONTACTS_BOOTSTRAP_STORE_NAME)
      .delete(normalizedSessionAci);
    await transactionToPromise(transaction);
  } finally {
    database.close();
  }
}

export async function clearWebPersistence(): Promise<void> {
  const activeUserId = getActiveLinkedSessionUserIdFromStorage();
  try {
    if (activeUserId) {
      window.localStorage.removeItem(getScopedChatShellStorageKey(activeUserId));
      window.localStorage.removeItem(
        getUserScopedStorageKey(activeUserId, CONTACTS_BOOTSTRAP_STORAGE_KEY_BASE)
      );
      window.localStorage.removeItem(activeUserId);
    }
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (
        key?.startsWith('user:') &&
        (key.endsWith(`:${CHAT_SHELL_STORAGE_KEY_BASE}`) ||
          key.endsWith(`:${CONTACTS_BOOTSTRAP_STORAGE_KEY_BASE}`))
      ) {
        window.localStorage.removeItem(key);
      }
    }
    window.sessionStorage.clear();
  } catch {
  }
  persistLinkedSessionToStorage(undefined);
  if (window.caches) {
    try {
      const cacheNames = await window.caches.keys();
      await Promise.all(cacheNames.map(cacheName => window.caches.delete(cacheName)));
    } catch {
    }
  }
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
