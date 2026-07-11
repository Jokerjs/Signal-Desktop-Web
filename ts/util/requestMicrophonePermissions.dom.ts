// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

function isSignalWebRuntime(): boolean {
  const config = window.SignalContext?.config as unknown;
  return (
    config != null && typeof config === 'object' && 'renderApiBaseUrl' in config
  );
}

async function requestBrowserMicrophonePermissions(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return false;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
      },
    });
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch {
    return false;
  }
}

export async function requestMicrophonePermissions(
  forCalling: boolean
): Promise<boolean> {
  if (isSignalWebRuntime()) {
    return requestBrowserMicrophonePermissions();
  }

  const microphonePermission = await window.IPC.getMediaPermissions();
  if (!microphonePermission) {
    await window.IPC.showPermissionsPopup(forCalling, false);

    // Check the setting again (from the source of truth).
    return window.Events.getMediaPermissions();
  }

  return true;
}
