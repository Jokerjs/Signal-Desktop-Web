// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import qrCodeFactory from 'qrcode-generator';
import {
  buildAttachmentAccessUrl,
  consumeMessageTransportStream,
  getProvisioningLinkedSession,
  getProvisioningSession,
  sendDirectTextMessage,
  startProvisioningSession,
} from './api.dom.ts';
import {
  clearWebPersistence,
  createLinkedSessionRecord,
  getLinkedSessionUserId,
  isLinkedSessionReady,
  loadChatShellStateForSession,
  loadContactsBootstrapForSession,
  loadLinkedSessionRecordFromIndexedDb,
  loadLinkedSessionRecordFromStorage,
  persistChatShellStateToStorage,
  persistContactsBootstrapForSession,
  persistLinkedSessionRecordToIndexedDb,
  persistLinkedSessionToStorage,
} from './persistence.dom.ts';
import type {
  ChatShellState,
  ContactsBootstrap,
  LinkedSessionRecord,
  MessageStreamEvent,
  WebAttachment,
  WebConversation,
  WebMessage,
} from './types.std.ts';

type ActiveTab = 'chats' | 'settings';

type AppSettings = Readonly<{
  theme: 'system' | 'light' | 'dark';
  notifications: boolean;
  readReceipts: boolean;
  typingIndicators: boolean;
  autoDownloadImages: boolean;
  apiBaseUrl: string;
}>;

const SETTINGS_STORAGE_KEY = 'render.web.settings';

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  notifications: true,
  readReceipts: true,
  typingIndicators: true,
  autoDownloadImages: true,
  apiBaseUrl: window.__MY_RENDER_CONFIG__?.apiBaseUrl ?? '',
};

const EMPTY_CHAT_SHELL: ChatShellState = {
  conversationLookup: {},
  messages: [],
  pinnedMessages: [],
};

function loadSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    return {
      ...DEFAULT_SETTINGS,
      ...(JSON.parse(raw) as Partial<AppSettings>),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(settings: AppSettings): void {
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function getProvisioningStatusText(status: string): string {
  if (status === 'starting') {
    return '正在创建扫码会话';
  }
  if (status === 'qr-ready') {
    return '等待手机扫码确认';
  }
  if (status === 'linking') {
    return '手机已确认，正在关联设备';
  }
  if (status === 'ready') {
    return '登录成功，正在进入聊天';
  }
  if (status === 'closed') {
    return '扫码会话已关闭，请重新生成二维码';
  }
  if (status === 'error') {
    return '扫码登录失败';
  }
  return status;
}

function formatTime(timestamp: number | undefined): string {
  if (!timestamp) {
    return '';
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function getConversationTitle(conversation: WebConversation | undefined): string {
  if (!conversation) {
    return '';
  }
  return (
    conversation.titleNoDefault ??
    conversation.title ??
    conversation.profileName ??
    conversation.phoneNumber ??
    conversation.e164 ??
    conversation.username ??
    conversation.id
  );
}

function getConversationInitial(conversation: WebConversation | undefined): string {
  const title = getConversationTitle(conversation);
  return title.trim().slice(0, 1).toUpperCase() || '#';
}

function getConversationTimestamp(conversation: WebConversation): number {
  return (
    conversation.activeAt ??
    conversation.lastUpdated ??
    conversation.timestamp ??
    0
  );
}

function sortConversations(
  conversationLookup: Record<string, WebConversation>
): Array<WebConversation> {
  return Object.values(conversationLookup)
    .filter(conversation => !conversation.isArchived)
    .sort((left, right) => {
      if (Boolean(left.isPinned) !== Boolean(right.isPinned)) {
        return left.isPinned ? -1 : 1;
      }
      return getConversationTimestamp(right) - getConversationTimestamp(left);
    });
}

function ensureNoteToSelf(
  shell: ChatShellState,
  linkedSession: LinkedSessionRecord
): ChatShellState {
  const sessionAci = linkedSession.credentials?.aci ?? linkedSession.account.aci;
  if (!sessionAci || shell.conversationLookup['note-to-self']) {
    return shell;
  }

  const account = linkedSession.account;
  const title = account.title ?? account.profileName ?? 'Note to Self';
  return {
    ...shell,
    selectedConversationId: shell.selectedConversationId ?? 'note-to-self',
    conversationLookup: {
      ...shell.conversationLookup,
      'note-to-self': {
        id: 'note-to-self',
        type: 'direct',
        conversationType: 'direct',
        isMe: true,
        serviceId: sessionAci,
        e164: account.number ?? account.phoneNumber,
        phoneNumber: account.number ?? account.phoneNumber,
        title,
        titleNoDefault: title,
        searchableTitle: title,
        profileName: account.profileName,
        profileFamilyName: account.profileFamilyName,
        username: account.username,
        avatarUrl: account.avatarUrl,
        activeAt: linkedSession.linkedAt,
        lastUpdated: linkedSession.linkedAt,
        timestamp: linkedSession.linkedAt,
        hasMessages: false,
      },
    },
  };
}

function applyContactsBootstrap(
  shell: ChatShellState,
  bootstrap: ContactsBootstrap,
  linkedSession: LinkedSessionRecord
): ChatShellState {
  const nextLookup: Record<string, WebConversation> = {
    ...shell.conversationLookup,
  };

  for (const conversation of [
    ...bootstrap.pinned.map(item => ({ ...item, isPinned: true })),
    ...bootstrap.conversations.map(item => ({ ...item, isPinned: false })),
    ...bootstrap.archived.map(item => ({ ...item, isArchived: true })),
  ]) {
    nextLookup[conversation.id] = {
      ...nextLookup[conversation.id],
      ...conversation,
      activeAt:
        conversation.activeAt ??
        conversation.lastUpdated ??
        conversation.timestamp ??
        nextLookup[conversation.id]?.activeAt,
    };
  }

  let nextShell: ChatShellState = {
    ...shell,
    conversationLookup: nextLookup,
    selectedConversationId:
      shell.selectedConversationId ??
      bootstrap.selectedConversationId ??
      Object.keys(nextLookup)[0],
  };

  if (bootstrap.account) {
    nextShell = ensureNoteToSelf(
      {
        ...nextShell,
        conversationLookup: {
          ...nextShell.conversationLookup,
          'note-to-self': {
            ...nextShell.conversationLookup['note-to-self'],
            id: 'note-to-self',
            type: 'direct',
            conversationType: 'direct',
            isMe: true,
            serviceId:
              nextShell.conversationLookup['note-to-self']?.serviceId ??
              linkedSession.credentials?.aci,
            title: bootstrap.account.title,
            titleNoDefault: bootstrap.account.title,
            searchableTitle: bootstrap.account.title,
            e164: bootstrap.account.phoneNumber,
            phoneNumber: bootstrap.account.phoneNumber,
            profileName: bootstrap.account.profileName,
            profileFamilyName: bootstrap.account.profileFamilyName,
            username: bootstrap.account.username,
            avatarUrl: bootstrap.account.avatarUrl,
            color: bootstrap.account.color,
            activeAt: bootstrap.generatedAt,
            lastUpdated: bootstrap.generatedAt,
            timestamp: bootstrap.generatedAt,
          },
        },
      },
      linkedSession
    );
  }

  return nextShell;
}

function upsertConversation(
  shell: ChatShellState,
  conversation: WebConversation
): ChatShellState {
  return {
    ...shell,
    conversationLookup: {
      ...shell.conversationLookup,
      [conversation.id]: {
        ...shell.conversationLookup[conversation.id],
        ...conversation,
      },
    },
    selectedConversationId:
      shell.selectedConversationId ?? conversation.id,
  };
}

function upsertMessage(shell: ChatShellState, message: WebMessage): ChatShellState {
  const messages = shell.messages.some(item => item.id === message.id)
    ? shell.messages.map(item => (item.id === message.id ? message : item))
    : [...shell.messages, message];
  const currentConversation = shell.conversationLookup[message.conversationId];
  const conversation: WebConversation = {
    ...currentConversation,
    id: message.conversationId,
    type: currentConversation?.type ?? 'direct',
    conversationType: currentConversation?.conversationType ?? 'direct',
    title: currentConversation?.title ?? message.sourceServiceId,
    serviceId: currentConversation?.serviceId ?? message.sourceServiceId,
    activeAt: message.timestamp,
    lastUpdated: message.timestamp,
    timestamp: message.timestamp,
    snippet: message.body,
    hasMessages: true,
  };

  return {
    ...shell,
    messages,
    conversationLookup: {
      ...shell.conversationLookup,
      [conversation.id]: conversation,
    },
    selectedConversationId: shell.selectedConversationId ?? conversation.id,
  };
}

function setMessageStatus(
  shell: ChatShellState,
  messageId: string,
  status: WebMessage['status']
): ChatShellState {
  return {
    ...shell,
    messages: shell.messages.map(message =>
      message.id === messageId ? { ...message, status } : message
    ),
  };
}

function QrCode({ url }: Readonly<{ url: string | undefined }>) {
  const svg = useMemo(() => {
    if (!url) {
      return '';
    }
    const qr = qrCodeFactory(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 5, margin: 2 });
  }, [url]);

  return (
    <div
      className="WebApp__qr"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function LoginScreen({
  onLinked,
}: Readonly<{ onLinked: (session: LinkedSessionRecord) => void }>) {
  const [sessionId, setSessionId] = useState<string>();
  const [qrUrl, setQrUrl] = useState<string>();
  const [status, setStatus] = useState('正在创建扫码会话');
  const [error, setError] = useState<string>();

  const start = useCallback(async () => {
    setError(undefined);
    setStatus('正在创建扫码会话');
    const session = await startProvisioningSession('Signal Web');
    setSessionId(session.sessionId);
    setQrUrl(session.url);
    setStatus(session.url ? '等待手机扫码确认' : '等待服务端返回二维码');
  }, []);

  useEffect(() => {
    start().catch(reason => {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus('扫码会话创建失败');
    });
  }, [start]);

  useEffect(() => {
    if (!sessionId) {
      return undefined;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      getProvisioningSession(sessionId)
        .then(async session => {
          if (cancelled) {
            return;
          }
          if (session.url) {
            setQrUrl(session.url);
          }
          setStatus(getProvisioningStatusText(session.status));
          if (session.status === 'ready') {
            const payload =
              session.linkedPayload ??
              (await getProvisioningLinkedSession(sessionId));
            const linkedSession = createLinkedSessionRecord(payload);
            persistLinkedSessionToStorage(linkedSession);
            await persistLinkedSessionRecordToIndexedDb(linkedSession);
            onLinked(linkedSession);
          }
          if (session.status === 'error' || session.error) {
            setError(session.error ?? '扫码登录失败');
          }
        })
        .catch(reason => {
          if (!cancelled) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        });
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onLinked, sessionId]);

  return (
    <div className="WebApp__login">
      <div className="WebApp__loginPanel">
        <img src="./images/signal-logo.svg" alt="" width="52" height="52" />
        <h1>关联 Signal Web</h1>
        <QrCode url={qrUrl} />
        <p className="WebApp__status">{error ?? status}</p>
        <button className="WebApp__plainButton" type="button" onClick={start}>
          重新生成二维码
        </button>
      </div>
    </div>
  );
}

function ConversationAvatar({
  conversation,
}: Readonly<{ conversation: WebConversation | undefined }>) {
  return (
    <div className="WebApp__avatar">
      {conversation?.avatarUrl ? (
        <img src={conversation.avatarUrl} alt="" />
      ) : (
        getConversationInitial(conversation)
      )}
    </div>
  );
}

function MessageAttachment({ attachment }: Readonly<{ attachment: WebAttachment }>) {
  const contentType = attachment.contentType ?? '';
  const url = buildAttachmentAccessUrl(attachment);
  if (contentType.startsWith('image/')) {
    return (
      <img
        className="WebApp__attachment"
        src={url}
        alt={attachment.fileName ?? ''}
      />
    );
  }

  if (contentType.startsWith('video/')) {
    return (
      <video className="WebApp__attachment" controls src={url}>
        {attachment.fileName ?? contentType}
      </video>
    );
  }

  if (contentType.startsWith('audio/')) {
    return (
      <audio className="WebApp__attachment" controls src={url}>
        {attachment.fileName ?? contentType}
      </audio>
    );
  }

  return (
    <a href={url} target="_blank" rel="noreferrer">
      {attachment.fileName ?? (contentType || 'Attachment')}
    </a>
  );
}

function SettingsView({
  linkedSession,
  settings,
  onSettingsChange,
  onLogout,
}: Readonly<{
  linkedSession: LinkedSessionRecord;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  onLogout: () => void;
}>) {
  const update = <Key extends keyof AppSettings>(
    key: Key,
    value: AppSettings[Key]
  ) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <div className="WebApp__settings">
      <div className="WebApp__settingsSection">
        <h2>账号</h2>
        <div className="WebApp__settingsRow">
          <div>
            <strong>{linkedSession.account.title ?? linkedSession.credentials?.number}</strong>
            <p>{linkedSession.credentials?.username}</p>
          </div>
          <button className="WebApp__dangerButton" type="button" onClick={onLogout}>
            退出登录
          </button>
        </div>
      </div>

      <div className="WebApp__settingsSection">
        <h2>通知</h2>
        <label className="WebApp__settingsRow">
          <span>
            <strong>桌面通知</strong>
            <p>浏览器环境使用 Web Notification 权限。</p>
          </span>
          <input
            checked={settings.notifications}
            type="checkbox"
            onChange={event => update('notifications', event.currentTarget.checked)}
          />
        </label>
      </div>

      <div className="WebApp__settingsSection">
        <h2>隐私</h2>
        <label className="WebApp__settingsRow">
          <span>
            <strong>已读回执</strong>
            <p>发送消息读取状态。</p>
          </span>
          <input
            checked={settings.readReceipts}
            type="checkbox"
            onChange={event => update('readReceipts', event.currentTarget.checked)}
          />
        </label>
        <label className="WebApp__settingsRow">
          <span>
            <strong>输入提示</strong>
            <p>允许对方看到正在输入状态。</p>
          </span>
          <input
            checked={settings.typingIndicators}
            type="checkbox"
            onChange={event =>
              update('typingIndicators', event.currentTarget.checked)
            }
          />
        </label>
      </div>

      <div className="WebApp__settingsSection">
        <h2>聊天</h2>
        <label className="WebApp__settingsRow">
          <span>
            <strong>自动加载图片</strong>
            <p>附件地址使用 /messages/attachment 代理。</p>
          </span>
          <input
            checked={settings.autoDownloadImages}
            type="checkbox"
            onChange={event =>
              update('autoDownloadImages', event.currentTarget.checked)
            }
          />
        </label>
      </div>

      <div className="WebApp__settingsSection">
        <h2>高级</h2>
        <div className="WebApp__settingsRow">
          <div>
            <strong>API 地址</strong>
            <p>{settings.apiBaseUrl || window.__MY_RENDER_CONFIG__?.apiBaseUrl}</p>
          </div>
        </div>
        <div className="WebApp__settingsRow">
          <div>
            <strong>本地数据库</strong>
            <p>IndexedDB: renderPersistence</p>
          </div>
          <button
            className="WebApp__plainButton"
            type="button"
            onClick={() => {
              void clearWebPersistence().then(() => window.location.reload());
            }}
          >
            清空本地数据
          </button>
        </div>
      </div>
    </div>
  );
}

export function WebApp() {
  const [linkedSession, setLinkedSession] = useState<LinkedSessionRecord>();
  const [isBooting, setIsBooting] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('chats');
  const [settings, setSettings] = useState(loadSettings);
  const [chatShell, setChatShell] = useState<ChatShellState>(EMPTY_CHAT_SHELL);
  const [query, setQuery] = useState('');
  const [composerValue, setComposerValue] = useState('');
  const [transportSessionId, setTransportSessionId] = useState<string>();
  const [streamError, setStreamError] = useState<string>();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const stored =
        (await loadLinkedSessionRecordFromIndexedDb()) ??
        loadLinkedSessionRecordFromStorage();
      if (!stored || !isLinkedSessionReady(stored)) {
        if (!cancelled) {
          setIsBooting(false);
        }
        return;
      }

      const sessionAci = getLinkedSessionUserId(stored);
      const storedShell = await loadChatShellStateForSession(sessionAci);
      const storedBootstrap = await loadContactsBootstrapForSession(sessionAci);
      let nextShell = ensureNoteToSelf(storedShell ?? EMPTY_CHAT_SHELL, stored);
      if (storedBootstrap) {
        nextShell = applyContactsBootstrap(nextShell, storedBootstrap, stored);
      }

      if (!cancelled) {
        setLinkedSession(stored);
        setChatShell(nextShell);
        setIsBooting(false);
      }
    }

    boot().catch(error => {
      console.error(error);
      setIsBooting(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    persistSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!linkedSession) {
      return;
    }
    void persistChatShellStateToStorage(
      chatShell,
      getLinkedSessionUserId(linkedSession)
    );
  }, [chatShell, linkedSession]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [chatShell.selectedConversationId, chatShell.messages.length]);

  const applyStreamEvent = useCallback(
    (event: MessageStreamEvent) => {
      if (event.type === 'session') {
        setTransportSessionId(event.sessionId);
        return;
      }
      if (event.type === 'linked-session-updated') {
        setLinkedSession(current => {
          if (!current) {
            return current;
          }
          const next: LinkedSessionRecord = {
            ...current,
            account: event.linkedPayload.account,
            credentials: event.linkedPayload.credentials,
            linkedPayload: event.linkedPayload,
            lastUpdatedAt: Date.now(),
            storageServiceKey: event.linkedPayload.storageServiceKey,
          };
          persistLinkedSessionToStorage(next);
          void persistLinkedSessionRecordToIndexedDb(next);
          return next;
        });
        return;
      }
      if (event.type === 'contacts-bootstrap' && linkedSession) {
        void persistContactsBootstrapForSession(
          getLinkedSessionUserId(linkedSession),
          event.data
        );
        setChatShell(current =>
          applyContactsBootstrap(current, event.data, linkedSession)
        );
        return;
      }
      if (event.type === 'chat-shell') {
        setChatShell(event.state);
        return;
      }
      if (event.type === 'conversation') {
        setChatShell(current =>
          upsertConversation(current, event.conversation)
        );
        return;
      }
      if (event.type === 'message') {
        setChatShell(current => upsertMessage(current, event.message));
        return;
      }
      if (event.type === 'message-status') {
        setChatShell(current => setMessageStatus(current, event.id, event.status));
        return;
      }
      if (event.type === 'error') {
        setStreamError(event.error);
      }
    },
    [linkedSession]
  );

  useEffect(() => {
    if (!linkedSession) {
      return undefined;
    }
    const abortController = new AbortController();
    setStreamError(undefined);
    void consumeMessageTransportStream({
      linkedSession,
      includeProtocol: true,
      signal: abortController.signal,
      onEvent: applyStreamEvent,
    }).catch(error => {
      if (!abortController.signal.aborted) {
        setStreamError(error instanceof Error ? error.message : String(error));
      }
    });

    return () => abortController.abort();
  }, [applyStreamEvent, linkedSession]);

  const conversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const list = sortConversations(chatShell.conversationLookup);
    if (!normalizedQuery) {
      return list;
    }
    return list.filter(conversation =>
      getConversationTitle(conversation).toLowerCase().includes(normalizedQuery)
    );
  }, [chatShell.conversationLookup, query]);

  const selectedConversation = chatShell.selectedConversationId
    ? chatShell.conversationLookup[chatShell.selectedConversationId]
    : conversations[0];

  const selectedMessages = useMemo(() => {
    if (!selectedConversation) {
      return [];
    }
    return chatShell.messages
      .filter(message => message.conversationId === selectedConversation.id)
      .sort((left, right) => left.timestamp - right.timestamp);
  }, [chatShell.messages, selectedConversation]);

  const handleSend = useCallback(async () => {
    const body = composerValue.trim();
    if (!body || !selectedConversation || !linkedSession) {
      return;
    }
    if (!transportSessionId) {
      setStreamError('消息通道未就绪');
      return;
    }

    const destinationServiceId =
      selectedConversation.serviceId ?? selectedConversation.id;
    const localMessage: WebMessage = {
      id: `local-${Date.now()}`,
      conversationId: selectedConversation.id,
      body,
      timestamp: Date.now(),
      direction: 'outgoing',
      status: 'queued',
    };
    setChatShell(current => upsertMessage(current, localMessage));
    setComposerValue('');

    try {
      const sent = await sendDirectTextMessage({
        runtimeSessionId: transportSessionId,
        destinationServiceId,
        body,
        timestamp: localMessage.timestamp,
      });
      setChatShell(current =>
        upsertMessage(
          setMessageStatus(current, localMessage.id, 'sent'),
          {
            ...sent,
            id: sent.id ?? localMessage.id,
            conversationId: sent.conversationId ?? selectedConversation.id,
            direction: 'outgoing',
            timestamp: sent.timestamp ?? localMessage.timestamp,
            status: sent.status ?? 'sent',
          }
        )
      );
    } catch (error) {
      setChatShell(current => setMessageStatus(current, localMessage.id, 'error'));
      setStreamError(error instanceof Error ? error.message : String(error));
    }
  }, [composerValue, linkedSession, selectedConversation, transportSessionId]);

  const logout = useCallback(() => {
    void clearWebPersistence().then(() => {
      setLinkedSession(undefined);
      setChatShell(EMPTY_CHAT_SHELL);
      setTransportSessionId(undefined);
      setActiveTab('chats');
    });
  }, []);

  if (isBooting) {
    return (
      <div className="WebApp__login">
        <div className="WebApp__loginPanel">
          <p className="WebApp__status">正在加载本地会话</p>
        </div>
      </div>
    );
  }

  if (!linkedSession) {
    return <LoginScreen onLinked={setLinkedSession} />;
  }

  return (
    <div className="WebApp">
      <nav className="WebApp__nav">
        <button
          aria-label="聊天"
          className={`WebApp__navButton ${
            activeTab === 'chats' ? 'WebApp__navButton--active' : ''
          }`}
          type="button"
          onClick={() => setActiveTab('chats')}
        >
          ◐
        </button>
        <button
          aria-label="设置"
          className={`WebApp__navButton ${
            activeTab === 'settings' ? 'WebApp__navButton--active' : ''
          }`}
          type="button"
          onClick={() => setActiveTab('settings')}
        >
          ⚙
        </button>
      </nav>

      <aside className="WebApp__listPane">
        <header className="WebApp__paneHeader">
          <h1 className="WebApp__paneTitle">
            {activeTab === 'chats' ? '聊天' : '设置'}
          </h1>
        </header>
        {activeTab === 'chats' ? (
          <>
            <input
              className="WebApp__search"
              placeholder="搜索"
              value={query}
              onChange={event => setQuery(event.currentTarget.value)}
            />
            <div className="WebApp__conversationList">
              {conversations.map(conversation => (
                <button
                  className={`WebApp__conversation ${
                    conversation.id === selectedConversation?.id
                      ? 'WebApp__conversation--active'
                      : ''
                  }`}
                  key={conversation.id}
                  type="button"
                  onClick={() =>
                    setChatShell(current => ({
                      ...current,
                      selectedConversationId: conversation.id,
                    }))
                  }
                >
                  <ConversationAvatar conversation={conversation} />
                  <span className="WebApp__conversationBody">
                    <span className="WebApp__conversationTop">
                      <span className="WebApp__conversationTitle">
                        {getConversationTitle(conversation)}
                      </span>
                      <span className="WebApp__conversationTime">
                        {formatTime(getConversationTimestamp(conversation))}
                      </span>
                    </span>
                    <span className="WebApp__conversationSnippet">
                      {conversation.snippet ?? ''}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="WebApp__conversationList">
            <button className="WebApp__conversation WebApp__conversation--active" type="button">
              <ConversationAvatar conversation={{ id: 'settings', title: '设置' }} />
              <span className="WebApp__conversationBody">
                <span className="WebApp__conversationTitle">偏好设置</span>
                <span className="WebApp__conversationSnippet">账号、隐私、通知</span>
              </span>
            </button>
          </div>
        )}
      </aside>

      {activeTab === 'settings' ? (
        <SettingsView
          linkedSession={linkedSession}
          settings={settings}
          onSettingsChange={setSettings}
          onLogout={logout}
        />
      ) : (
        <main className="WebApp__chat">
          {selectedConversation ? (
            <>
              <header className="WebApp__chatHeader">
                <ConversationAvatar conversation={selectedConversation} />
                <div className="WebApp__chatHeaderText">
                  <div className="WebApp__conversationTitle">
                    {getConversationTitle(selectedConversation)}
                  </div>
                  <div className="WebApp__status">
                    {streamError ?? (transportSessionId ? '已连接' : '连接中')}
                  </div>
                </div>
              </header>
              <div className="WebApp__messages">
                {selectedMessages.length === 0 ? (
                  <p className="WebApp__empty">暂无聊天记录</p>
                ) : (
                  selectedMessages.map(message => (
                    <div
                      className={`WebApp__message ${
                        message.direction === 'outgoing'
                          ? 'WebApp__message--outgoing'
                          : ''
                      }`}
                      key={message.id}
                    >
                      {message.attachments?.map(attachment => (
                        <MessageAttachment
                          attachment={attachment}
                          key={
                            attachment.id ??
                            attachment.cdnKey ??
                            attachment.fileName ??
                            attachment.contentType
                          }
                        />
                      ))}
                      {message.body}
                      <div className="WebApp__messageMeta">
                        {formatTime(message.timestamp)}
                        {message.status ? ` · ${message.status}` : ''}
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>
              <footer className="WebApp__composer">
                <textarea
                  placeholder="输入消息"
                  value={composerValue}
                  onChange={event => setComposerValue(event.currentTarget.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                />
                <button
                  className="WebApp__primaryButton"
                  disabled={!composerValue.trim()}
                  type="button"
                  onClick={() => void handleSend()}
                >
                  发送
                </button>
              </footer>
            </>
          ) : (
            <div className="WebApp__messages">
              <p className="WebApp__empty">等待联系人与聊天记录同步</p>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
