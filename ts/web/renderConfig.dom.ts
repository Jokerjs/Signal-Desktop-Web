// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

type RuntimeConfig = Readonly<{
  apiBaseUrl?: string;
  cdnBaseUrl?: string;
  sfuUrl?: string;
}>;

type RenderApiBaseUrlListener = () => void;

const RENDER_API_BASE_URL_POLL_INTERVAL_MS = 100;
const renderApiBaseUrlListeners = new Set<RenderApiBaseUrlListener>();

let renderApiBaseUrlPoll: number | undefined;
let lastRenderApiBaseUrl: string | undefined;

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
  const apiBaseUrl = getRenderApiBaseUrlSnapshot();
  if (apiBaseUrl) {
    return apiBaseUrl;
  }

  throw new Error('Missing runtime config apiBaseUrl');
}

export function getRenderApiBaseUrlSnapshot(): string | undefined {
  return getMyRenderRuntimeConfig()?.apiBaseUrl;
}

function pollRenderApiBaseUrl(): void {
  const apiBaseUrl = getRenderApiBaseUrlSnapshot();
  if (apiBaseUrl === lastRenderApiBaseUrl) {
    return;
  }

  lastRenderApiBaseUrl = apiBaseUrl;
  for (const listener of renderApiBaseUrlListeners) {
    listener();
  }
}

export function subscribeToRenderApiBaseUrl(
  listener: RenderApiBaseUrlListener
): () => void {
  renderApiBaseUrlListeners.add(listener);

  if (renderApiBaseUrlPoll == null) {
    lastRenderApiBaseUrl = getRenderApiBaseUrlSnapshot();
    renderApiBaseUrlPoll = window.setInterval(
      pollRenderApiBaseUrl,
      RENDER_API_BASE_URL_POLL_INTERVAL_MS
    );
  }

  return () => {
    renderApiBaseUrlListeners.delete(listener);
    if (renderApiBaseUrlListeners.size === 0 && renderApiBaseUrlPoll != null) {
      window.clearInterval(renderApiBaseUrlPoll);
      renderApiBaseUrlPoll = undefined;
      lastRenderApiBaseUrl = undefined;
    }
  };
}

export function getRenderCdnBaseUrl(): string | undefined {
  const explicitCdnBaseUrl = normalizeOptionalString(
    new URL(window.location.href).searchParams.get('cdnBase')
  );
  return explicitCdnBaseUrl ?? getMyRenderRuntimeConfig()?.cdnBaseUrl;
}
