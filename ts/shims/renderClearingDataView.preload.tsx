// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createRoot } from 'react-dom/client';
import { ClearingData } from '../components/ClearingData.dom.tsx';
import { strictAssert } from '../util/assert.std.ts';
import { deleteAllData } from './deleteAllData.preload.ts';
import type { StateType } from './deleteAllData.preload.ts';
import { AppProvider } from '../windows/AppProvider.dom.tsx';
import { clearWebPersistence } from '../web/persistence.dom.ts';
import * as Registration from '../util/registration.preload.ts';

async function deleteAllWebData(
  callback: (state: StateType) => unknown
): Promise<void> {
  callback('deleting-data');
  await Registration.remove();
  await clearWebPersistence();
  window.location.reload();
}

export function renderClearingDataView(): void {
  const appContainer = document.getElementById('app-container');
  const isSignalWebRuntime = Boolean(
    (window as typeof window & { SignalWebRuntime?: unknown }).SignalWebRuntime
  );

  strictAssert(appContainer != null, 'No #app-container');
  createRoot(appContainer).render(
    <AppProvider>
      <ClearingData
        deleteAllData={isSignalWebRuntime ? deleteAllWebData : deleteAllData}
        i18n={window.SignalContext.i18n}
      />
    </AppProvider>
  );
}
