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

export function getRenderApiBaseUrl(): string {
  const runtimeConfig = getMyRenderRuntimeConfig();
  if (runtimeConfig?.apiBaseUrl) {
    return runtimeConfig.apiBaseUrl;
  }

  throw new Error('Missing runtime config apiBaseUrl');
}

export function getRenderCdnBaseUrl(): string | undefined {
  const explicitCdnBaseUrl = normalizeOptionalString(
    new URL(window.location.href).searchParams.get('cdnBase')
  );
  return explicitCdnBaseUrl ?? getMyRenderRuntimeConfig()?.cdnBaseUrl;
}
