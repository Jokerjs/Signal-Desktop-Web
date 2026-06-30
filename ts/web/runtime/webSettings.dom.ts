// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { ThemeType } from '../../types/Util.std.ts';
import type { NotificationSettingType } from '../../types/StorageKeys.std.ts';

const WEB_SETTINGS_STORAGE_KEY = 'signal-web-settings-v1';

export type WebSettings = Readonly<{
  linkPreviews: boolean;
  notificationContent: NotificationSettingType;
  textFormatting: boolean;
  theme: ThemeType;
}>;

export const DEFAULT_WEB_SETTINGS: WebSettings = {
  linkPreviews: false,
  notificationContent: 'message',
  textFormatting: true,
  theme: ThemeType.light,
};

function parseTheme(value: unknown): ThemeType {
  return value === ThemeType.dark ? ThemeType.dark : ThemeType.light;
}

function parseNotificationContent(value: unknown): NotificationSettingType {
  return value === 'off' || value === 'name' || value === 'count'
    ? value
    : 'message';
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function loadWebSettings(): WebSettings {
  try {
    const raw = window.localStorage.getItem(WEB_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_WEB_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<WebSettings>;
    return {
      linkPreviews: parseBoolean(
        parsed.linkPreviews,
        DEFAULT_WEB_SETTINGS.linkPreviews
      ),
      notificationContent: parseNotificationContent(
        parsed.notificationContent
      ),
      textFormatting: parseBoolean(
        parsed.textFormatting,
        DEFAULT_WEB_SETTINGS.textFormatting
      ),
      theme: parseTheme(parsed.theme),
    };
  } catch {
    return DEFAULT_WEB_SETTINGS;
  }
}

export function saveWebSettings(settings: WebSettings): void {
  window.localStorage.setItem(WEB_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function updateWebSettings(
  patch: Partial<WebSettings>
): WebSettings {
  const next = {
    ...loadWebSettings(),
    ...patch,
  };
  saveWebSettings(next);
  return next;
}
