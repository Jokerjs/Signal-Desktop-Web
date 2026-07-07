// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createRoot } from 'react-dom/client';
import { bindActionCreators } from 'redux';
import type { Store } from 'redux';
import { Buffer } from 'buffer';

import zhCNMessages from '../../_locales/zh-CN/messages.json';
import { Environment, setEnvironment } from '../environment.std.ts';
import { HourCyclePreference } from '../types/I18N.std.ts';
import { NavTab } from '../types/Nav.std.ts';
import { AppViewType } from '../types/app.std.ts';
import { BackupLevel } from '../services/backups/types.std.ts';
import {
  _refreshRemoteConfig,
  type ConfigMapType,
} from '../RemoteConfig.dom.ts';
import type { StorageInterface } from '../types/Storage.d.ts';
import type { RemoteConfigResponseType } from '../textsecure/WebAPI.preload.ts';
import { setupI18n } from '../util/setupI18n.dom.tsx';
import * as KeyboardLayout from '../services/keyboardLayout.dom.ts';
import { createStore } from '../state/createStore.preload.ts';
import { reducer, type StateType } from '../state/reducer.preload.ts';
import { actionCreators } from '../state/actions.preload.ts';
import { retryPlaceholders } from '../services/retryPlaceholders.std.ts';
import { MessageCache } from '../services/MessageCache.preload.ts';
import { initialize as initializeExpiringMessageService } from '../services/expiringMessagesDeletion.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import {
  markDone as markRegistrationDone,
  remove as removeRegistrationDone,
} from '../util/registration.preload.ts';
import {
  applyContactsBootstrap,
  createDesktopConversationState,
} from './runtime/stateAdapter.dom.ts';
import { setupWebGlobals } from './runtime/setupWebGlobals.dom.ts';
import {
  syncLinkedSessionUserStorage,
  WebDesktopApp,
} from './runtime/WebDesktopApp.dom.tsx';
import type { ChatShellState } from './types.std.ts';
import {
  getLinkedSessionUserId,
  clearWebPersistence,
  loadChatShellStateForSession,
  loadContactsBootstrapForSession,
  loadLinkedSessionRecordFromIndexedDb,
  loadLinkedSessionRecordFromStorage,
  persistLinkedSessionRecordToIndexedDb,
  persistLinkedSessionToStorage,
} from './persistence.dom.ts';
import { loadWebSettings } from './runtime/webSettings.dom.ts';

const EMPTY_SHELL: ChatShellState = {
  conversationLookup: {},
  messages: [],
  pinnedMessages: [],
};
const WEB_BUILD_EXPIRATION = Date.now() + 30 * 24 * 60 * 60 * 1000;
const VITE_SECRET = 'JBSWY3DPEHPK3PXPIOHHIUGYUGFAFST';

Object.assign(globalThis, { Buffer });

const minimalSignalContext = {
  getResolvedMessagesLocaleDirection: () => 'ltr' as const,
  getHourCyclePreference: () => HourCyclePreference.UnknownPreference,
};
window.SignalContext = {
  ...(window.SignalContext ?? {}),
  ...minimalSignalContext,
};

setEnvironment(Environment.PackagedApp, false);

const WEB_REMOTE_CONFIG = [
  ['global.groupsv2.groupSizeHardLimit', '64'],
  ['global.groupsv2.maxGroupSize', '32'],
  ['global.pinnedChatLimit', '4'],
] as const;

function getWebRemoteConfigState(): ConfigMapType {
  const enabledAt = Date.now();
  return Object.fromEntries(
    WEB_REMOTE_CONFIG.map(([name, value]) => [
      name,
      {
        name,
        enabled: true,
        enabledAt,
        value,
      },
    ])
  ) as ConfigMapType;
}

async function initializeWebRemoteConfig(): Promise<void> {
  const storageMap = new Map<string, unknown>();
  const storage: Pick<StorageInterface, 'get' | 'put' | 'remove'> = {
    get: ((key: string) => storageMap.get(key)) as Pick<
      StorageInterface,
      'get'
    >['get'],
    put: async (key: string, value: unknown) => {
      storageMap.set(key, value);
    },
    remove: async (key: string) => {
      storageMap.delete(key);
    },
  };
  await _refreshRemoteConfig({
    getConfig: async (): Promise<RemoteConfigResponseType> => {
      const serverTimestamp = Date.now();
      return {
        config: new Map(WEB_REMOTE_CONFIG),
        configHash: `web-${serverTimestamp}`,
        serverTimestamp,
      };
    },
    storage,
  });
}

const retryPlaceholdersStorage: Pick<StorageInterface, 'get' | 'put'> = {
  get: ((key: string, defaultValue?: unknown) =>
    key === 'retryPlaceholders' ? [] : defaultValue) as Pick<
    StorageInterface,
    'get'
  >['get'],
  put: async () => undefined,
};
retryPlaceholders.start(retryPlaceholdersStorage);
initializeExpiringMessageService();
MessageCache.install();

const i18n = setupI18n('zh-CN', zhCNMessages);

function bindActionCreatorsDeep<T>(creators: T, dispatch: Store['dispatch']): T {
  if (typeof creators === 'function') {
    return bindActionCreators(creators as never, dispatch) as T;
  }
  if (creators == null || typeof creators !== 'object') {
    return creators;
  }
  return Object.fromEntries(
    Object.entries(creators).map(([key, value]) => [
      key,
      bindActionCreatorsDeep(value, dispatch),
    ])
  ) as T;
}

async function buildInitialState(): Promise<{
  initialState: StateType;
  linkedSession: Awaited<ReturnType<typeof loadLinkedSessionRecordFromIndexedDb>>;
  shell: ChatShellState;
}> {
  await itemStorage.fetch();

  const indexedSession = await loadLinkedSessionRecordFromIndexedDb();
  const storageSession = indexedSession
    ? undefined
    : loadLinkedSessionRecordFromStorage();
  if (storageSession) {
    await persistLinkedSessionRecordToIndexedDb(storageSession);
    persistLinkedSessionToStorage(storageSession);
  }
  const storedSession = indexedSession ?? storageSession;
  await syncLinkedSessionUserStorage(storedSession);
  const sessionUserId = getLinkedSessionUserId(storedSession);
  const [storedShell, contacts] = await Promise.all([
    loadChatShellStateForSession(sessionUserId),
    loadContactsBootstrapForSession(sessionUserId),
  ]);
  const shell = storedSession
    ? applyContactsBootstrap(storedShell ?? EMPTY_SHELL, contacts, storedSession)
    : EMPTY_SHELL;
  const pinnedConversationIds =
    contacts?.pinned.map(conversation => conversation.id) ??
    Object.values(shell.conversationLookup)
      .filter(conversation => conversation.isPinned)
      .map(conversation => conversation.id);
  await itemStorage.put('pinnedConversationIds', pinnedConversationIds);
  if (storedSession) {
    await markRegistrationDone();
  } else {
    await removeRegistrationDone();
  }
  const baseState = reducer(undefined, {
    type: 'NOOP/web',
    payload: null,
  }) as StateType;
  const desktopConversations = storedSession
    ? createDesktopConversationState(shell, storedSession)
    : undefined;
  const selectedConversationId = shell.selectedConversationId;
  const webSettings = loadWebSettings();
  const remoteConfig = getWebRemoteConfigState();

  return {
    linkedSession: storedSession,
    shell,
    initialState: {
      ...baseState,
      app: {
        ...baseState.app,
        appView: storedSession ? AppViewType.Inbox : AppViewType.Installer,
        hasInitialLoadCompleted: true,
      },
      expiration: {
        ...baseState.expiration,
        buildExpiration: WEB_BUILD_EXPIRATION,
      },
      conversations: {
        ...baseState.conversations,
        ...(desktopConversations ?? {}),
      } as StateType['conversations'],
      items: {
        ...baseState.items,
        backupTier: storedSession ? BackupLevel.Paid : baseState.items.backupTier,
        pinnedConversationIds,
        linkPreviews: webSettings.linkPreviews,
        'notification-setting': webSettings.notificationContent,
        hasStoriesDisabled: true,
        remoteConfig,
        textFormatting: webSettings.textFormatting,
      },
      nav: {
        ...baseState.nav,
        selectedLocation: {
          tab: NavTab.Chats,
          details: {
            conversationId: selectedConversationId,
          },
        },
      },
      user: {
        ...baseState.user,
        attachmentsPath: '',
        i18n,
        localeMessages: i18n.getLocaleMessages(),
        menuOptions: {
          development: false,
          devTools: false,
          includeSetup: false,
          isNightly: false,
          isProduction: true,
          platform: window.platform ?? 'web',
        },
        osName: undefined,
        ourAci: storedSession?.credentials?.aci as StateType['user']['ourAci'],
        ourConversationId: storedSession?.credentials?.aci,
        ourDeviceId: storedSession?.credentials?.deviceId,
        ourNumber: storedSession?.credentials?.number,
        ourPni: storedSession?.credentials?.pni as StateType['user']['ourPni'],
        platform: window.platform ?? 'web',
        regionCode: undefined,
        stickersPath: '',
        tempPath: '',
        theme: webSettings.theme,
        version: window.getVersion?.() ?? 'web',
      },
    },
  };
}

function getWindowViteSecret(): unknown {
  return (window as typeof window & { VITE_SECRET?: unknown }).VITE_SECRET;
}

function redirectToNotFound(): void {
  const notFoundUrl = new URL('/404.html', window.location.origin);
  window.location.replace(notFoundUrl.href);
}

async function start(): Promise<void> {
  if (getWindowViteSecret() !== VITE_SECRET) {
    redirectToNotFound();
    return;
  }

  await initializeWebRemoteConfig();
  setupWebGlobals({ i18n });

  const url = new URL(window.location.href);
  if (url.searchParams.get('reset') === '1') {
    await clearWebPersistence();
    url.searchParams.delete('reset');
    window.location.replace(url.toString());
    return;
  }

  const { initialState, linkedSession, shell } = await buildInitialState();
  setupWebGlobals({ i18n, linkedSession });
  await KeyboardLayout.initialize();

  const store = createStore(initialState);
  window.reduxStore = store;
  window.reduxActions = bindActionCreatorsDeep(
    actionCreators,
    store.dispatch
  ) as typeof window.reduxActions;

  const container =
    document.getElementById('app-container') ?? document.getElementById('root');
  if (!container) {
    throw new Error('Missing app container element');
  }

  createRoot(container).render(
    <WebDesktopApp
      initialLinkedSession={linkedSession}
      initialShell={shell}
      store={store}
    />
  );
}

void start();
