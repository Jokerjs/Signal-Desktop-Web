// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

const platform = navigator.platform.toLowerCase();

const OS = {
  getClassName(): string {
    if (this.isMacOS()) {
      return 'os-macos';
    }
    if (this.isWindows()) {
      return 'os-windows';
    }
    return 'os-linux';
  },
  getName(): 'macOS' | 'Windows' | 'Linux' {
    if (this.isMacOS()) {
      return 'macOS';
    }
    if (this.isWindows()) {
      return 'Windows';
    }
    return 'Linux';
  },
  isAppImage(): boolean {
    return false;
  },
  isFlatpak(): boolean {
    return false;
  },
  isLinux(): boolean {
    return !this.isMacOS() && !this.isWindows();
  },
  isLinuxUsingKDE(): boolean {
    return false;
  },
  isMacOS(): boolean {
    return platform.includes('mac');
  },
  isWaylandEnabled(): boolean {
    return false;
  },
  isWindows(): boolean {
    return platform.includes('win');
  },
};

export default OS;
