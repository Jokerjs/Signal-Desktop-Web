// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

type RuntimeConfig = Readonly<{
  apiBaseUrl?: string;
  cdnBaseUrl?: string;
  sfuUrl?: string;
}>;

declare global {
  interface Window {
    __MY_RENDER_CONFIG__?: RuntimeConfig;
  }
}

const LOCAL_RENDER_API_PORT = '3100';
const MY_RENDER_DEV_SERVER_PORT = '3001';

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getMyRenderRuntimeConfig(): RuntimeConfig | undefined {
  const runtimeConfig = window.__MY_RENDER_CONFIG__;
  if (runtimeConfig == null || typeof runtimeConfig !== 'object') {
    return undefined;
  }

  const apiBaseUrl = normalizeOptionalString(runtimeConfig.apiBaseUrl);
  const cdnBaseUrl = normalizeOptionalString(runtimeConfig.cdnBaseUrl);
  const sfuUrl = normalizeOptionalString(runtimeConfig.sfuUrl);

  if (apiBaseUrl == null && cdnBaseUrl == null && sfuUrl == null) {
    return undefined;
  }

  return { apiBaseUrl, cdnBaseUrl, sfuUrl };
}

export function resolveRenderApiBaseUrlFromHref(
  href: string,
  runtimeConfig = getMyRenderRuntimeConfig()
): string {
  const url = new URL(href);
  const explicitApiBaseUrl = normalizeOptionalString(
    url.searchParams.get('apiBase')
  );
  if (explicitApiBaseUrl) {
    return explicitApiBaseUrl;
  }

  const configuredApiBaseUrl = runtimeConfig?.apiBaseUrl;
  const isStandaloneFileMode = url.protocol === 'file:';
  const isLocalHost =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const defaultLocalApiBaseUrl = `${url.protocol}//${url.hostname}:${LOCAL_RENDER_API_PORT}`;

  if (isStandaloneFileMode) {
    return configuredApiBaseUrl ?? `http://127.0.0.1:${LOCAL_RENDER_API_PORT}`;
  }

  if (configuredApiBaseUrl) {
    return configuredApiBaseUrl;
  }

  if (isLocalHost && url.port === MY_RENDER_DEV_SERVER_PORT) {
    return url.origin;
  }

  return isLocalHost && url.port !== LOCAL_RENDER_API_PORT
    ? defaultLocalApiBaseUrl
    : url.origin;
}

export function getRenderApiBaseUrl(): string {
  return resolveRenderApiBaseUrlFromHref(window.location.href);
}

export function getRenderCdnBaseUrl(): string | undefined {
  const explicitCdnBaseUrl = normalizeOptionalString(
    new URL(window.location.href).searchParams.get('cdnBase')
  );
  return explicitCdnBaseUrl ?? getMyRenderRuntimeConfig()?.cdnBaseUrl;
}
