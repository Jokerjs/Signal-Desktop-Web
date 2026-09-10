// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  ProtocolKyberPreKeyRecord,
  ProtocolPreKeyRecord,
  ProtocolSenderKeyRecord,
  ProtocolSessionRecord,
  ProtocolState,
} from './types.std.ts';

function namespaceMatchesDevice(
  namespace: string,
  aci: string,
  deviceId: number
): boolean {
  const parts = namespace.split(':');
  if (parts[0] !== aci) {
    return false;
  }

  if (parts[1] === 'aci' && parts[2] === aci) {
    return parts[3] === String(deviceId);
  }

  if (parts[1] !== 'pni') {
    return false;
  }

  // PNI is serialized as `PNI:<uuid>`, so it occupies two namespace fields.
  if (parts[2] === 'PNI') {
    return parts[4] === String(deviceId);
  }

  return parts[3] === String(deviceId);
}

function filterProtocolRecords<T extends { namespace: string }>(
  records: ReadonlyArray<T>,
  aci: string,
  deviceId: number
): Array<T> {
  return records.filter(record =>
    namespaceMatchesDevice(record.namespace, aci, deviceId)
  );
}

export function pruneProtocolStateForDevice(
  protocol: ProtocolState | undefined,
  aci: string | undefined,
  deviceId: number | undefined
): ProtocolState | undefined {
  if (!protocol || !aci || typeof deviceId !== 'number') {
    return protocol;
  }
  if (!Number.isInteger(deviceId)) {
    return protocol;
  }

  return {
    ...protocol,
    preKeys: filterProtocolRecords(
      protocol.preKeys as ReadonlyArray<ProtocolPreKeyRecord>,
      aci,
      deviceId
    ),
    kyberPreKeys: filterProtocolRecords(
      protocol.kyberPreKeys as ReadonlyArray<ProtocolKyberPreKeyRecord>,
      aci,
      deviceId
    ),
    sessions: filterProtocolRecords(
      protocol.sessions as ReadonlyArray<ProtocolSessionRecord>,
      aci,
      deviceId
    ),
    senderKeys: filterProtocolRecords(
      protocol.senderKeys as ReadonlyArray<ProtocolSenderKeyRecord>,
      aci,
      deviceId
    ),
  };
}

export function isProtocolNamespaceForDevice(
  namespace: string,
  aci: string,
  deviceId: number | undefined
): boolean {
  if (typeof deviceId !== 'number' || !Number.isInteger(deviceId)) {
    return false;
  }

  return namespaceMatchesDevice(namespace, aci, deviceId);
}
