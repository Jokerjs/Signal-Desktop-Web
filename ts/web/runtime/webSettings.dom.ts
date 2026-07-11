// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ThemeType } from '../../types/Util.std.ts';
import { Emoji } from '../../axo/emoji.std.ts';
import { PhoneNumberSharingMode } from '../../types/PhoneNumberSharingMode.std.ts';
import { PhoneNumberDiscoverability } from '../../util/phoneNumberDiscoverability.std.ts';
import { DEFAULT_AUTO_DOWNLOAD_ATTACHMENT } from '../../textsecure/Storage.preload.ts';
import { DurationInSeconds } from '../../util/durations/index.std.ts';
import { ConversationColors } from '../../types/Colors.std.ts';
import type { ThemeSettingType } from '../../util/theme.std.ts';
import type {
  AutoDownloadAttachmentType,
  NotificationSettingType,
  SentMediaQualitySettingType,
} from '../../types/StorageKeys.std.ts';
import type {
  CustomColorsItemType,
  DefaultConversationColorType,
} from '../../types/Colors.std.ts';

const WEB_SETTINGS_STORAGE_KEY = 'signal-web-settings-v1';

export type WebSettings = Readonly<{
  audioNotifications: boolean;
  autoConvertEmoji: boolean;
  autoDownloadAttachment: AutoDownloadAttachmentType;
  countMutedConversations: boolean;
  customColors?: CustomColorsItemType;
  defaultConversationColor: DefaultConversationColorType;
  emojiSkinToneDefault: Emoji.SkinTone;
  keepMutedChatsArchived: boolean;
  linkPreviews: boolean;
  messageAudio: boolean;
  navTabsCollapsed: boolean;
  notificationContent: NotificationSettingType;
  phoneNumberDiscoverability: PhoneNumberDiscoverability;
  phoneNumberSharingMode: PhoneNumberSharingMode;
  preferContactAvatars: boolean;
  readReceipts: boolean;
  sealedSenderIndicators: boolean;
  sentMediaQuality: SentMediaQualitySettingType;
  spellCheck: boolean;
  textFormatting: boolean;
  theme: ThemeSettingType;
  typingIndicators: boolean;
  universalExpireTimer: number;
  zoomFactor: number;
}>;

export const DEFAULT_WEB_SETTINGS: WebSettings = {
  audioNotifications: false,
  autoConvertEmoji: true,
  autoDownloadAttachment: DEFAULT_AUTO_DOWNLOAD_ATTACHMENT,
  countMutedConversations: false,
  defaultConversationColor: {
    color: ConversationColors[0],
  },
  emojiSkinToneDefault: Emoji.SkinTone.None,
  keepMutedChatsArchived: false,
  linkPreviews: false,
  messageAudio: false,
  navTabsCollapsed: false,
  notificationContent: 'message',
  phoneNumberDiscoverability: PhoneNumberDiscoverability.NotDiscoverable,
  phoneNumberSharingMode: PhoneNumberSharingMode.Nobody,
  preferContactAvatars: false,
  readReceipts: false,
  sealedSenderIndicators: false,
  sentMediaQuality: 'standard',
  spellCheck: true,
  textFormatting: true,
  theme: ThemeType.light,
  typingIndicators: false,
  universalExpireTimer: DurationInSeconds.ZERO,
  zoomFactor: 1,
};

function parseTheme(value: unknown): ThemeSettingType {
  if (value === 'system' || value === ThemeType.dark) {
    return value;
  }
  return ThemeType.light;
}

export function getEffectiveWebTheme(
  settings: WebSettings = loadWebSettings()
): ThemeType {
  if (settings.theme === ThemeType.dark) {
    return ThemeType.dark;
  }
  if (settings.theme === 'system') {
    return getBrowserSystemTheme();
  }
  return ThemeType.light;
}

export function getBrowserSystemTheme(): ThemeType {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? ThemeType.dark
    : ThemeType.light;
}

function parseNotificationContent(value: unknown): NotificationSettingType {
  return value === 'off' || value === 'name' || value === 'count'
    ? value
    : 'message';
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseAutoDownloadAttachment(
  value: unknown
): AutoDownloadAttachmentType {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_WEB_SETTINGS.autoDownloadAttachment;
  }
  const record = value as Record<string, unknown>;
  return {
    photos: parseBoolean(
      record.photos,
      DEFAULT_AUTO_DOWNLOAD_ATTACHMENT.photos
    ),
    videos: parseBoolean(
      record.videos,
      DEFAULT_AUTO_DOWNLOAD_ATTACHMENT.videos
    ),
    audio: parseBoolean(record.audio, DEFAULT_AUTO_DOWNLOAD_ATTACHMENT.audio),
    documents: parseBoolean(
      record.documents,
      DEFAULT_AUTO_DOWNLOAD_ATTACHMENT.documents
    ),
  };
}

function parsePhoneNumberDiscoverability(
  value: unknown
): PhoneNumberDiscoverability {
  return value === PhoneNumberDiscoverability.Discoverable
    ? PhoneNumberDiscoverability.Discoverable
    : PhoneNumberDiscoverability.NotDiscoverable;
}

function parsePhoneNumberSharingMode(value: unknown): PhoneNumberSharingMode {
  if (
    value === PhoneNumberSharingMode.Everybody ||
    value === PhoneNumberSharingMode.ContactsOnly
  ) {
    return value;
  }
  return PhoneNumberSharingMode.Nobody;
}

function parseSentMediaQuality(value: unknown): SentMediaQualitySettingType {
  return value === 'high' ? 'high' : 'standard';
}

function parseEmojiSkinTone(value: unknown): Emoji.SkinTone {
  if (
    typeof value === 'string' &&
    Emoji.SKIN_TONE_ORDER.includes(value as Emoji.SkinTone)
  ) {
    return value as Emoji.SkinTone;
  }
  return DEFAULT_WEB_SETTINGS.emojiSkinToneDefault;
}

function parseNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseDefaultConversationColor(
  value: unknown
): DefaultConversationColorType {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_WEB_SETTINGS.defaultConversationColor;
  }
  return value as DefaultConversationColorType;
}

function parseCustomColors(value: unknown): CustomColorsItemType | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as CustomColorsItemType;
}

export function loadWebSettings(): WebSettings {
  try {
    const raw = window.localStorage.getItem(WEB_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_WEB_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<WebSettings>;
    return {
      audioNotifications: parseBoolean(
        parsed.audioNotifications,
        DEFAULT_WEB_SETTINGS.audioNotifications
      ),
      autoConvertEmoji: parseBoolean(
        parsed.autoConvertEmoji,
        DEFAULT_WEB_SETTINGS.autoConvertEmoji
      ),
      autoDownloadAttachment: parseAutoDownloadAttachment(
        parsed.autoDownloadAttachment
      ),
      countMutedConversations: parseBoolean(
        parsed.countMutedConversations,
        DEFAULT_WEB_SETTINGS.countMutedConversations
      ),
      customColors: parseCustomColors(parsed.customColors),
      defaultConversationColor: parseDefaultConversationColor(
        parsed.defaultConversationColor
      ),
      emojiSkinToneDefault: parseEmojiSkinTone(parsed.emojiSkinToneDefault),
      keepMutedChatsArchived: parseBoolean(
        parsed.keepMutedChatsArchived,
        DEFAULT_WEB_SETTINGS.keepMutedChatsArchived
      ),
      linkPreviews: parseBoolean(
        parsed.linkPreviews,
        DEFAULT_WEB_SETTINGS.linkPreviews
      ),
      messageAudio: parseBoolean(
        parsed.messageAudio,
        DEFAULT_WEB_SETTINGS.messageAudio
      ),
      navTabsCollapsed: parseBoolean(
        parsed.navTabsCollapsed,
        DEFAULT_WEB_SETTINGS.navTabsCollapsed
      ),
      notificationContent: parseNotificationContent(parsed.notificationContent),
      phoneNumberDiscoverability: parsePhoneNumberDiscoverability(
        parsed.phoneNumberDiscoverability
      ),
      phoneNumberSharingMode: parsePhoneNumberSharingMode(
        parsed.phoneNumberSharingMode
      ),
      preferContactAvatars: parseBoolean(
        parsed.preferContactAvatars,
        DEFAULT_WEB_SETTINGS.preferContactAvatars
      ),
      readReceipts: parseBoolean(
        parsed.readReceipts,
        DEFAULT_WEB_SETTINGS.readReceipts
      ),
      sealedSenderIndicators: parseBoolean(
        parsed.sealedSenderIndicators,
        DEFAULT_WEB_SETTINGS.sealedSenderIndicators
      ),
      sentMediaQuality: parseSentMediaQuality(parsed.sentMediaQuality),
      spellCheck: parseBoolean(
        parsed.spellCheck,
        DEFAULT_WEB_SETTINGS.spellCheck
      ),
      textFormatting: parseBoolean(
        parsed.textFormatting,
        DEFAULT_WEB_SETTINGS.textFormatting
      ),
      theme: parseTheme(parsed.theme),
      typingIndicators: parseBoolean(
        parsed.typingIndicators,
        DEFAULT_WEB_SETTINGS.typingIndicators
      ),
      universalExpireTimer: parseNumber(
        parsed.universalExpireTimer,
        DEFAULT_WEB_SETTINGS.universalExpireTimer
      ),
      zoomFactor: parseNumber(
        parsed.zoomFactor,
        DEFAULT_WEB_SETTINGS.zoomFactor
      ),
    };
  } catch {
    return DEFAULT_WEB_SETTINGS;
  }
}

export function saveWebSettings(settings: WebSettings): void {
  window.localStorage.setItem(
    WEB_SETTINGS_STORAGE_KEY,
    JSON.stringify(settings)
  );
}

export function updateWebSettings(patch: Partial<WebSettings>): WebSettings {
  const next = {
    ...loadWebSettings(),
    ...patch,
  };
  saveWebSettings(next);
  return next;
}
