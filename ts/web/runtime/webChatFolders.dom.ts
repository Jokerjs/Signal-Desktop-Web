// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  ALL_CHATS_FOLDER_REQUIRED_PARAMS,
  CHAT_FOLDER_DELETED_POSITION,
  ChatFolderType,
  type ChatFolder,
  type ChatFolderId,
} from '../../types/ChatFolder.std.ts';
import type { CurrentChatFolder } from '../../types/CurrentChatFolders.std.ts';

const WEB_CHAT_FOLDERS_STORAGE_PREFIX = 'signal-web-chat-folders-v1';

function getStorageKey(accountId: string | undefined): string {
  return `${WEB_CHAT_FOLDERS_STORAGE_PREFIX}:${accountId ?? 'anonymous'}`;
}

function getCurrentTimestamp(): number {
  return Date.now();
}

function toCurrentChatFolders(
  chatFolders: ReadonlyArray<ChatFolder>
): ReadonlyArray<CurrentChatFolder> {
  return chatFolders
    .filter((chatFolder): chatFolder is CurrentChatFolder => {
      return (
        chatFolder.deletedAtTimestampMs === 0 &&
        (chatFolder.folderType === ChatFolderType.ALL ||
          chatFolder.folderType === ChatFolderType.CUSTOM)
      );
    })
    .toSorted((left, right) => left.position - right.position);
}

function normalizePositions(
  chatFolders: ReadonlyArray<ChatFolder>
): Array<ChatFolder> {
  let nextPosition = 0;
  return chatFolders
    .toSorted((left, right) => left.position - right.position)
    .map(chatFolder => {
      if (chatFolder.deletedAtTimestampMs !== 0) {
        return {
          ...chatFolder,
          position: CHAT_FOLDER_DELETED_POSITION,
        };
      }
      const next = {
        ...chatFolder,
        position: nextPosition,
      };
      nextPosition += 1;
      return next;
    });
}

function saveWebChatFolders(
  accountId: string | undefined,
  chatFolders: ReadonlyArray<ChatFolder>
): void {
  window.localStorage.setItem(
    getStorageKey(accountId),
    JSON.stringify(normalizePositions(chatFolders))
  );
}

function loadStoredWebChatFolders(
  accountId: string | undefined
): Array<ChatFolder> {
  try {
    const raw = window.localStorage.getItem(getStorageKey(accountId));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return toCurrentChatFolders(parsed as ReadonlyArray<ChatFolder>);
  } catch {
    return [];
  }
}

function createAllChatsChatFolder(): ChatFolder {
  return {
    id: crypto.randomUUID() as ChatFolderId,
    ...ALL_CHATS_FOLDER_REQUIRED_PARAMS,
    position: 0,
    deletedAtTimestampMs: 0,
    storageID: null,
    storageVersion: null,
    storageUnknownFields: null,
    storageNeedsSync: true,
  };
}

function hasCurrentAllChatsChatFolder(
  chatFolders: ReadonlyArray<ChatFolder>
): boolean {
  return chatFolders.some(chatFolder => {
    return (
      chatFolder.folderType === ChatFolderType.ALL &&
      chatFolder.deletedAtTimestampMs === 0
    );
  });
}

function loadAllWebChatFolders(
  accountId: string | undefined
): Array<ChatFolder> {
  const chatFolders = loadStoredWebChatFolders(accountId);
  if (hasCurrentAllChatsChatFolder(chatFolders)) {
    return chatFolders;
  }

  const allChatsChatFolder = createAllChatsChatFolder();
  const nextChatFolders = [
    allChatsChatFolder,
    ...chatFolders.map(chatFolder => {
      if (chatFolder.deletedAtTimestampMs !== 0) {
        return chatFolder;
      }
      return {
        ...chatFolder,
        position: chatFolder.position + 1,
        storageNeedsSync: true,
      };
    }),
  ];
  saveWebChatFolders(accountId, nextChatFolders);
  return nextChatFolders;
}

export function loadWebChatFolders(
  accountId: string | undefined
): ReadonlyArray<CurrentChatFolder> {
  return toCurrentChatFolders(loadAllWebChatFolders(accountId));
}

export function getOldestDeletedWebChatFolder(
  accountId: string | undefined
): ChatFolder | undefined {
  return loadAllWebChatFolders(accountId)
    .filter(chatFolder => chatFolder.deletedAtTimestampMs !== 0)
    .toSorted(
      (left, right) => left.deletedAtTimestampMs - right.deletedAtTimestampMs
    )
    .at(0);
}

export function createWebChatFolder(
  accountId: string | undefined,
  chatFolder: ChatFolder
): void {
  const chatFolders = loadAllWebChatFolders(accountId).filter(item => {
    if (chatFolder.folderType === ChatFolderType.ALL) {
      return item.folderType !== ChatFolderType.ALL;
    }
    return item.id !== chatFolder.id;
  });
  saveWebChatFolders(accountId, [...chatFolders, chatFolder]);
}

export function createWebAllChatsChatFolder(
  accountId: string | undefined
): ChatFolder {
  const chatFolders = loadAllWebChatFolders(accountId);
  const existingAllChatsChatFolder = chatFolders.find(chatFolder => {
    return (
      chatFolder.folderType === ChatFolderType.ALL &&
      chatFolder.deletedAtTimestampMs === 0
    );
  });
  if (existingAllChatsChatFolder) {
    return existingAllChatsChatFolder;
  }

  const allChatsChatFolder = createAllChatsChatFolder();

  saveWebChatFolders(accountId, [
    allChatsChatFolder,
    ...chatFolders.map(chatFolder => {
      if (chatFolder.deletedAtTimestampMs !== 0) {
        return chatFolder;
      }
      return {
        ...chatFolder,
        position: chatFolder.position + 1,
        storageNeedsSync: true,
      };
    }),
  ]);

  return allChatsChatFolder;
}

export function updateWebChatFolder(
  accountId: string | undefined,
  chatFolder: ChatFolder
): void {
  const chatFolders = loadAllWebChatFolders(accountId);
  saveWebChatFolders(
    accountId,
    chatFolders.map(item => {
      return item.id === chatFolder.id ? chatFolder : item;
    })
  );
}

export function updateWebChatFolderToggleChat(
  accountId: string | undefined,
  chatFolderId: ChatFolderId,
  conversationId: string,
  toggle: boolean
): void {
  const chatFolder = loadAllWebChatFolders(accountId).find(item => {
    return item.id === chatFolderId;
  });
  if (!chatFolder) {
    throw new Error(`Missing chat folder for id: ${chatFolderId}`);
  }

  const included = new Set(chatFolder.includedConversationIds);
  const excluded = new Set(chatFolder.excludedConversationIds);
  if (toggle) {
    included.add(conversationId);
    excluded.delete(conversationId);
  } else {
    included.delete(conversationId);
    excluded.add(conversationId);
  }

  updateWebChatFolder(accountId, {
    ...chatFolder,
    includedConversationIds: Array.from(included),
    excludedConversationIds: Array.from(excluded),
    storageNeedsSync: true,
  });
}

export function updateWebChatFolderPositions(
  accountId: string | undefined,
  chatFolders: ReadonlyArray<ChatFolder>
): void {
  const positions = new Map(
    chatFolders.map(chatFolder => [chatFolder.id, chatFolder.position])
  );
  saveWebChatFolders(
    accountId,
    loadAllWebChatFolders(accountId).map(chatFolder => {
      const position = positions.get(chatFolder.id);
      if (position == null) {
        return chatFolder;
      }
      return {
        ...chatFolder,
        position,
        storageNeedsSync: true,
      };
    })
  );
}

export function markWebChatFolderDeleted(
  accountId: string | undefined,
  chatFolderId: ChatFolderId,
  deletedAtTimestampMs: number = getCurrentTimestamp(),
  storageNeedsSync = true
): void {
  saveWebChatFolders(
    accountId,
    loadAllWebChatFolders(accountId).map(chatFolder => {
      if (chatFolder.id !== chatFolderId) {
        return chatFolder;
      }
      return {
        ...chatFolder,
        position: CHAT_FOLDER_DELETED_POSITION,
        deletedAtTimestampMs,
        includedConversationIds: [],
        excludedConversationIds: [],
        storageNeedsSync,
      };
    })
  );
}

export function updateWebChatFolderDeletedAtTimestampMsFromSync(
  accountId: string | undefined,
  chatFolderId: ChatFolderId,
  deletedAtTimestampMs: number
): void {
  saveWebChatFolders(
    accountId,
    loadAllWebChatFolders(accountId).map(chatFolder => {
      if (chatFolder.id !== chatFolderId) {
        return chatFolder;
      }
      return {
        ...chatFolder,
        deletedAtTimestampMs,
      };
    })
  );
}

export function deleteExpiredWebChatFolders(
  accountId: string | undefined,
  messageQueueTime: number
): ReadonlyArray<ChatFolderId> {
  const now = getCurrentTimestamp();
  const deletedIds = new Set<ChatFolderId>();
  const chatFolders = loadAllWebChatFolders(accountId).filter(chatFolder => {
    const shouldDelete =
      chatFolder.deletedAtTimestampMs !== 0 &&
      chatFolder.deletedAtTimestampMs + messageQueueTime <= now;
    if (shouldDelete) {
      deletedIds.add(chatFolder.id);
    }
    return !shouldDelete;
  });
  saveWebChatFolders(accountId, chatFolders);
  return Array.from(deletedIds);
}
