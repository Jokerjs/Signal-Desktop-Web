// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { pruneProtocolStateForDevice } from '../../web/protocolState.std.ts';
import type { ProtocolState } from '../../web/types.std.ts';

describe('protocolState', () => {
  it('keeps only the current device records when pruning protocol state', () => {
    const currentPreKey = {
      namespace: 'aci:aci:aci:1:11:22:33',
      keyId: 1,
      recordBase64: 'keep-pre-key',
    };
    const otherPreKey = {
      namespace: 'aci:aci:aci:2:11:22:33',
      keyId: 2,
      recordBase64: 'drop-pre-key',
    };
    const currentKyberPreKey = {
      namespace: 'aci:pni:pni:1:11:22:33',
      keyId: 3,
      recordBase64: 'keep-kyber-pre-key',
    };
    const otherKyberPreKey = {
      namespace: 'aci:pni:pni:2:11:22:33',
      keyId: 4,
      recordBase64: 'drop-kyber-pre-key',
    };
    const currentSession = {
      namespace: 'aci:aci:aci:1:11:22:33',
      addressKey: 'aci.1',
      recordBase64: 'keep-session',
    };
    const otherSession = {
      namespace: 'aci:aci:aci:2:11:22:33',
      addressKey: 'aci.2',
      recordBase64: 'drop-session',
    };
    const currentSenderKey = {
      namespace: 'aci:aci:aci:1:11:22:33',
      senderKey: 'keep-sender-key',
      recordBase64: 'keep-sender-key-record',
    };
    const otherSenderKey = {
      namespace: 'aci:aci:aci:2:11:22:33',
      senderKey: 'drop-sender-key',
      recordBase64: 'drop-sender-key-record',
    };

    const protocol: ProtocolState = {
      registrationIds: {
        aci: 11,
        pni: 22,
      },
      identityKeys: {
        aci: {},
        pni: {},
      },
      identityRecords: ['identity-record'],
      preKeys: [currentPreKey, otherPreKey],
      signedPreKeys: ['signed-pre-key'],
      kyberPreKeys: [currentKyberPreKey, otherKyberPreKey],
      sessions: [currentSession, otherSession],
      senderKeys: [currentSenderKey, otherSenderKey],
      senderKeyInfos: [
        {
          groupId: 'group-id',
          distributionId: 'distribution-id',
          createdAtDate: 123,
          memberDevices: [],
        },
      ],
    };

    assert.deepEqual(pruneProtocolStateForDevice(protocol, 'aci', 1), {
      ...protocol,
      preKeys: [currentPreKey],
      kyberPreKeys: [currentKyberPreKey],
      sessions: [currentSession],
      senderKeys: [currentSenderKey],
    });
  });

  it('matches PNI namespaces with a tagged local service id', () => {
    const protocol: ProtocolState = {
      registrationIds: { aci: 11, pni: 22 },
      identityKeys: {},
      identityRecords: [],
      preKeys: [
        {
          namespace: 'aci:pni:PNI:pni-uuid:1:11:22',
          keyId: 1,
          recordBase64: 'keep',
        },
        {
          namespace: 'aci:pni:PNI:pni-uuid:2:11:22',
          keyId: 2,
          recordBase64: 'drop',
        },
      ],
      signedPreKeys: [],
      kyberPreKeys: [],
      sessions: [],
      senderKeys: [],
    };

    assert.deepEqual(pruneProtocolStateForDevice(protocol, 'aci', 1)?.preKeys, [
      protocol.preKeys[0]!,
    ]);
  });
});
