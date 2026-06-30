// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

function unavailable(name: string): never {
  throw new Error(`${name} is not available in Signal Web`);
}

export const CallMessageUrgency = {
  Droppable: 0,
  HandleImmediately: 1,
} as const;

export const CallLogLevel = {
  Info: 0,
  Warn: 1,
  Error: 2,
} as const;

export const CallState = {
  Prering: 0,
  Ringing: 1,
  Accepted: 2,
  Reconnecting: 3,
  Ended: 4,
} as const;

export const CallEndReason = {
  LocalHangup: 0,
  RemoteHangup: 1,
  RemoteHangupNeedPermission: 2,
  Declined: 3,
  Busy: 4,
  Glare: 5,
  ReceivedOfferExpired: 6,
  ReceivedOfferWhileActive: 7,
  ReceivedOfferWithGlare: 8,
  SignalingFailure: 9,
  ConnectionFailure: 10,
  InternalFailure: 11,
  Timeout: 12,
  AcceptedOnAnotherDevice: 13,
  DeclinedOnAnotherDevice: 14,
  BusyOnAnotherDevice: 15,
} as const;

export const CallRejectReason = {
  Declined: 0,
  Busy: 1,
} as const;

export const ConnectionState = {
  NotConnected: 0,
  Connecting: 1,
  Connected: 2,
  Reconnecting: 3,
  Disconnected: 4,
} as const;

export const DataMode = {
  Normal: 0,
  LowData: 1,
} as const;

export const JoinState = {
  NotJoined: 0,
  Joining: 1,
  Joined: 2,
} as const;

export const HttpMethod = {
  Get: 'GET',
  Put: 'PUT',
  Post: 'POST',
  Delete: 'DELETE',
} as const;

export const HangupType = {
  Normal: 0,
  Accepted: 1,
  Declined: 2,
  Busy: 3,
  NeedPermission: 4,
} as const;

export const OfferType = {
  AudioCall: 0,
  VideoCall: 1,
} as const;

export const RingCancelReason = {
  DeclinedByUser: 0,
  Busy: 1,
} as const;

export const GroupCallKind = {
  SignalGroup: 0,
  CallLink: 1,
} as const;

export const SpeechEvent = {
  Started: 0,
  Stopped: 1,
} as const;

export const CallLinkRestrictions = {
  None: 0,
  AdminApproval: 1,
  Unknown: 2,
} as const;

export class CallLinkRootKey {
  public readonly bytes: Uint8Array;

  public constructor(bytes?: Uint8Array) {
    this.bytes = new Uint8Array(
      bytes ?? crypto.getRandomValues(new Uint8Array(32))
    );
  }

  public static generate(): CallLinkRootKey {
    return new CallLinkRootKey();
  }

  public static parse(value: string): CallLinkRootKey {
    return new CallLinkRootKey(new TextEncoder().encode(value));
  }

  public static fromBytes(value: Uint8Array): CallLinkRootKey {
    return new CallLinkRootKey(value);
  }

  public deriveRoomId(): Uint8Array {
    return this.bytes.slice(0, 16);
  }

  public toString(): string {
    return btoa(String.fromCharCode(...this.bytes));
  }
}

export class AnswerMessage {}
export class BusyMessage {}
export class Call {
  public hangup(): void {}
}
export class CallingMessage {}
export class GroupCall {
  public leave(): void {}
}
export class GroupMemberInfo {}
export class HangupMessage {}
export class IceCandidateMessage {}
export class OfferMessage {}
export class OpaqueMessage {}
export class RingRTC {
  public static create(): RingRTC {
    return new RingRTC();
  }

  public static getAudioInputs(): Array<never> {
    return [];
  }

  public static getAudioOutputs(): Array<never> {
    return [];
  }

  public static setAudioInput(): void {}

  public static setAudioOutput(): void {}

  public startOutgoingCall(): never {
    return unavailable('RingRTC.startOutgoingCall');
  }

  public startOutgoingGroupCall(): never {
    return unavailable('RingRTC.startOutgoingGroupCall');
  }
}
export class RingUpdate {}

export function callIdFromEra(value: string): bigint {
  return BigInt(`0x${value.slice(0, 16).padEnd(16, '0')}`);
}

export function callIdFromRingId(value: string): bigint {
  return callIdFromEra(value);
}

export function videoPixelFormatToEnum(): number {
  return 0;
}

export default RingRTC;
