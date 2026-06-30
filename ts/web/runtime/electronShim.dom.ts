// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import productionConfig from '../../../config/production.json';

type Listener = (...args: ReadonlyArray<unknown>) => void;

const listeners = new Map<string, Set<Listener>>();

function getListeners(channel: string): Set<Listener> {
  let channelListeners = listeners.get(channel);
  if (!channelListeners) {
    channelListeners = new Set();
    listeners.set(channel, channelListeners);
  }
  return channelListeners;
}

export const ipcRenderer = {
  sendSync: (channel: string): unknown => {
    const renderConfig = (
      window as typeof window & {
        __MY_RENDER_CONFIG__?: {
          apiBaseUrl?: string;
          sfuUrl?: string;
        };
      }
    ).__MY_RENDER_CONFIG__;
    const apiBaseUrl = renderConfig?.apiBaseUrl || 'http://127.0.0.1:3100';

    if (channel === 'get-user-data-path') {
      return '/signal-web';
    }
    if (channel === 'get-config') {
      return {
        appInstance: undefined,
        appStartInitialSpellcheckSetting: true,
        argv: undefined,
        availableLocales: ['zh-CN'],
        backupServerPublicParams: 'browser',
        buildCreation: 0,
        buildExpiration: 0,
        cdnUrl0: apiBaseUrl,
        cdnUrl2: apiBaseUrl,
        cdnUrl3: apiBaseUrl,
        certificateAuthority: 'browser',
        challengeUrl: apiBaseUrl,
        ciForceUnprocessed: false,
        ciMode: false,
        contentProxyUrl: apiBaseUrl,
        crashDumpsPath: '/signal-web/crash',
        devTools: false,
        directoryConfig: {
          directoryMRENCLAVE: 'browser',
          directoryUrl: apiBaseUrl,
        },
        disableIPv6: false,
        disableScreenSecurity: true,
        dnsFallback: [],
        environment: 'production',
        genericServerPublicParams: productionConfig.genericServerPublicParams,
        homePath: '/',
        hostname: 'browser',
        hourCyclePreference: 'UnknownPreference',
        installPath: '/',
        isMainWindowFullScreen: false,
        isMainWindowMaximized: false,
        isMockTestEnvironment: false,
        localeOverride: null,
        name: 'Signal Web',
        nodeVersion: '22.0.0',
        osRelease: '0.0.0',
        osVersion: 'browser',
        preferredSystemLocales: ['zh-CN'],
        proxyUrl: undefined,
        reducedMotionSetting: false,
        registrationChallengeUrl: apiBaseUrl,
        resolvedTranslationsLocale: 'zh-CN',
        resolvedTranslationsLocaleDirection: 'ltr',
        resourcesUrl: apiBaseUrl,
        serverPublicParams: productionConfig.serverPublicParams,
        serverTrustRoots: ['browser'],
        serverUrl: apiBaseUrl,
        sfuUrl: renderConfig?.sfuUrl || '',
        storageUrl: apiBaseUrl,
        stripePublishableKey: 'browser',
        theme: 'light',
        updatesUrl: apiBaseUrl,
        userDataPath: '/signal-web',
        version: 'web',
      };
    }
    if (channel === 'native-theme:init') {
      return { shouldUseDarkColors: false };
    }
    if (
      channel === 'locale-data' ||
      channel === 'locale-display-names' ||
      channel === 'country-display-names'
    ) {
      return {};
    }
    if (channel === 'OS.getClassName') {
      return 'browser';
    }
    return undefined;
  },
  invoke: async (
    _channel: string,
    name?: string,
    args?: ReadonlyArray<unknown>
  ): Promise<unknown> => {
    const ipc = window.IPC as
      | undefined
      | {
          sqlCall?: (
            name: string,
            args?: ReadonlyArray<unknown>
          ) => Promise<unknown>;
        };

    if (name && typeof ipc?.sqlCall === 'function') {
      return { ok: true, value: await ipc.sqlCall(name, args) };
    }

    return { ok: true, value: undefined };
  },
  send: (channel: string, ...args: ReadonlyArray<unknown>): void => {
    for (const listener of getListeners(channel)) {
      listener({}, ...args);
    }
  },
  on: (channel: string, listener: Listener): void => {
    getListeners(channel).add(listener);
  },
  once: (channel: string, listener: Listener): void => {
    const wrapped: Listener = (...args) => {
      getListeners(channel).delete(wrapped);
      listener(...args);
    };
    getListeners(channel).add(wrapped);
  },
  off: (channel: string, listener: Listener): void => {
    getListeners(channel).delete(listener);
  },
  removeListener: (channel: string, listener: Listener): void => {
    getListeners(channel).delete(listener);
  },
  removeAllListeners: (channel?: string): void => {
    if (channel) {
      listeners.delete(channel);
      return;
    }
    listeners.clear();
  },
};

export const clipboard = {
  clear: (): void => {
    void navigator.clipboard?.writeText('');
  },
  readText: async (): Promise<string> => navigator.clipboard?.readText() ?? '',
  writeText: (text: string): void => {
    void navigator.clipboard?.writeText(text);
  },
};

export const shell = {
  openExternal: async (url: string): Promise<void> => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};

export const net = {
  resolveHost: async () => ({ addresses: [] }),
};

export const contextBridge = {
  exposeInMainWorld: (key: string, value: unknown): void => {
    Object.assign(window, { [key]: value });
  },
};

export const webUtils = {
  getPathForFile: (file: File): string => file.name,
};
