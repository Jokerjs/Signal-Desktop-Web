// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useState, type JSX } from 'react';
import { useSelector } from 'react-redux';
import { InstallScreen } from '../../components/InstallScreen.dom.tsx';
import {
  InstallScreenError,
  InstallScreenStep,
} from '../../types/InstallScreen.std.ts';
import { DialogType } from '../../types/Dialogs.std.ts';
import { LoadingState } from '../../util/loadable.std.ts';
import { getIntl } from '../../state/selectors/user.std.ts';
import {
  createLinkedSessionRecord,
  persistLinkedSessionRecordToIndexedDb,
  persistLinkedSessionToStorage,
} from '../persistence.dom.ts';
import {
  getProvisioningLinkedSession,
  getProvisioningSession,
  startProvisioningSession,
} from '../api.dom.ts';

type ProvisioningViewState =
  | Readonly<{ step: 'loading' }>
  | Readonly<{ step: 'qr'; sessionId: string; url: string }>
  | Readonly<{ step: 'linking' }>
  | Readonly<{ step: 'error' }>;

async function wait(ms: number): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export function WebInstallScreen({
  onLinked,
}: Readonly<{
  onLinked: () => void;
}>): JSX.Element {
  const i18n = useSelector(getIntl);
  const [state, setState] = useState<ProvisioningViewState>({
    step: 'loading',
  });

  const start = useCallback(() => {
    let canceled = false;

    async function run(): Promise<void> {
      setState({ step: 'loading' });
      try {
        const session = await startProvisioningSession('Signal Web');
        if (session.url) {
          setState({
            step: 'qr',
            sessionId: session.sessionId,
            url: session.url,
          });
        }

        while (!canceled) {
          await wait(1200);
          const current = await getProvisioningSession(session.sessionId);
          if (current.url) {
            setState({
              step: 'qr',
              sessionId: session.sessionId,
              url: current.url,
            });
          }
          if (current.status === 'ready') {
            setState({ step: 'linking' });
            const linkedPayload =
              current.linkedPayload ??
              (await getProvisioningLinkedSession(session.sessionId));
            const linkedSession = createLinkedSessionRecord(linkedPayload);
            persistLinkedSessionToStorage(linkedSession);
            await persistLinkedSessionRecordToIndexedDb(linkedSession);
            onLinked();
            return;
          }
          if (
            current.status === 'closed' ||
            current.status === 'error' ||
            current.status.endsWith('-error')
          ) {
            throw new Error(current.error ?? current.status);
          }
        }
      } catch (error) {
        if (!canceled) {
          console.error('Web provisioning failed', error);
          setState({ step: 'error' });
        }
      }
    }

    void run();
    return () => {
      canceled = true;
    };
  }, [onLinked]);

  useEffect(() => start(), [start]);

  if (state.step === 'linking') {
    return (
      <InstallScreen
        step={InstallScreenStep.LinkInProgress}
        screenSpecificProps={{ i18n }}
      />
    );
  }

  if (state.step === 'error') {
    return (
      <InstallScreen
        step={InstallScreenStep.Error}
        screenSpecificProps={{
          i18n,
          error: InstallScreenError.ConnectionFailed,
          quit: () => undefined,
          tryAgain: start,
        }}
      />
    );
  }

  return (
    <InstallScreen
      step={InstallScreenStep.QrCodeNotScanned}
      screenSpecificProps={{
        i18n,
        provisioningUrl:
          state.step === 'qr'
            ? { loadingState: LoadingState.Loaded, value: state.url }
            : { loadingState: LoadingState.Loading },
        hasExpired: false,
        updates: {
          dialogType: DialogType.None,
          didSnooze: false,
          isCheckingForUpdates: false,
          showEventsCount: 0,
        },
        currentVersion: window.getVersion(),
        startUpdate: () => undefined,
        forceUpdate: () => undefined,
        retryGetQrCode: start,
        isConfirmingDataDeletion: false,
        restartInstall: start,
        continueInstallWithDataDeletion: () => undefined,
        OS: window.Signal.OS.getName(),
        isStaging: false,
      }}
    />
  );
}
