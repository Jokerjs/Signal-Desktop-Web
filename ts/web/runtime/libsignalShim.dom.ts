// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

function unavailable(name: string): never {
  throw new Error(`${name} is provided by the Signal Web backend`);
}

class BytesValue {
  public readonly value: Uint8Array;

  public constructor(value: string | Uint8Array = new Uint8Array()) {
    this.value = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  }

  public getServiceIdString(): string {
    return new TextDecoder().decode(this.value);
  }

  public getRawUuid(): Uint8Array {
    return this.value;
  }

  public serialize(): Uint8Array {
    return this.value;
  }

  public toString(): string {
    return this.getServiceIdString();
  }
}

export class Aci extends BytesValue {
  public static parseFromServiceIdString(value: string): Aci {
    return new Aci(value);
  }
}

export class Pni extends BytesValue {
  public static parseFromServiceIdString(value: string): Pni {
    return new Pni(value);
  }
}

export class ServiceId extends BytesValue {
  public static parseFromServiceIdString(value: string): ServiceId {
    return value.startsWith('PNI:') ? new Pni(value) : new Aci(value);
  }
}

export class PublicKey extends BytesValue {}
export class PrivateKey extends BytesValue {
  public static generate(): PrivateKey {
    return new PrivateKey(crypto.getRandomValues(new Uint8Array(32)));
  }

  public static deserialize(value: Uint8Array): PrivateKey {
    return new PrivateKey(value);
  }

  public getPublicKey(): PublicKey {
    return new PublicKey(this.value);
  }

  public agree(): Uint8Array {
    return new Uint8Array(32);
  }

  public sign(): Uint8Array {
    return new Uint8Array(64);
  }
}

export class Fingerprint {
  public displayString = '';
  public scannableEncoding = new Uint8Array();
}

export class SenderCertificate extends BytesValue {}
export class PlaintextContent extends BytesValue {}
export class CiphertextMessage extends BytesValue {}
export class GroupSendFullToken extends BytesValue {}
export class GroupSendEndorsement extends BytesValue {}
export class GroupSendEndorsementsResponse extends BytesValue {}
export class ReceiptCredential extends BytesValue {}
export class ReceiptCredentialPresentation extends BytesValue {}
export class ReceiptCredentialRequestContext extends BytesValue {}
export class ReceiptCredentialResponse extends BytesValue {}
export class ReceiptSerial extends BytesValue {}

export class LibSignalErrorBase extends Error {
  public readonly code?: number;
}

export const ContentHint = {
  Default: 0,
  Resendable: 1,
  Implicit: 2,
} as const;

export const ErrorCode = {
  Unknown: 0,
} as const;

export const LogLevel = {
  Trace: 0,
  Debug: 1,
  Info: 2,
  Warn: 3,
  Error: 4,
} as const;

export const CiphertextMessageType = {
  Whisper: 2,
  PreKey: 3,
  SenderKey: 4,
  Plaintext: 5,
} as const;

export const IdentityChange = {
  NewOrUnchanged: 0,
  ReplacedExisting: 1,
} as const;

export const Direction = {
  Sending: 0,
  Receiving: 1,
} as const;

export const AccountDataField = {
  Aci: 'Aci',
  E164: 'E164',
  UsernameHash: 'UsernameHash',
} as const;

export const BackupLevel = {
  Free: 200,
  Paid: 201,
} as const;

export const BackupCredentialType = {
  Messages: 0,
  Media: 1,
} as const;

export const Purpose = {
  RemoteBackup: 0,
} as const;

export const BuildVariant = {
  Desktop: 'Desktop',
  Testing: 'Testing',
} as const;

export const AccountAttributes = {};
export const Net = {};
export const REMOTE_CONFIG_KEYS: ReadonlyArray<string> = [];

export const usernames = {
  hash(value: string): Uint8Array {
    return new TextEncoder().encode(value);
  },
  fromParts(nickname: string, discriminator?: string): string {
    return discriminator ? `${nickname}.${discriminator}` : nickname;
  },
  getNickname(value: string): string {
    return value.split('.')[0] ?? value;
  },
};

export function hkdf(): Uint8Array {
  return new Uint8Array();
}

export function sanitize(input: Uint8Array): Uint8Array {
  return input;
}

export function initLogger(): void {}

export class AccountEntropyPool {
  public static generate(): string {
    return crypto.randomUUID().replaceAll('-', '');
  }
}

export class BackupKey extends BytesValue {}
export class MessageBackupKey extends BytesValue {}
export class BackupJsonExporter {}
export class MessageBackupValidator {}
export class OnlineBackupValidator {
  public constructor(..._args: ReadonlyArray<unknown>) {}

  public addFrame(): void {}

  public finalize(): void {}
}
export class InputStream {}
export class DigestingPassThrough {}
export class ValidatingPassThrough {}

export class ClientZkGroupCipher {}
export class ClientZkAuthOperations {}
export class ClientZkProfileOperations {}
export class ClientZkReceiptOperations {}
export class ServerPublicParams {}
export class GenericServerPublicParams {}
export class AuthCredentialWithPni {}
export class AuthCredentialWithPniResponse {}
export class BackupAuthCredential {}
export class BackupAuthCredentialRequestContext {}
export class BackupAuthCredentialResponse {}
export class CallLinkAuthCredential {}
export class CallLinkAuthCredentialPresentation {}
export class CallLinkAuthCredentialResponse {}
export class CallLinkRootKey {}
export class CallLinkPublicParams {}
export class CallLinkSecretParams {}
export class CreateCallLinkCredentialPresentation {}
export class CreateCallLinkCredentialRequestContext {}
export class CreateCallLinkCredentialResponse {}
export class ExpiringProfileKeyCredentialResponse {}
export class ExpiringProfileKeyCredential {}
export class ProfileKey {}
export class ProfileKeyCiphertext {}
export class ProfileKeyCredentialPresentation {}
export class ProfileKeyCredentialRequestContext {}
export class ProfileKeyVersion {}
export class ServerSecretParams {}
export class GroupMasterKey extends BytesValue {}
export class GroupSecretParams extends BytesValue {}
export class IdentityKeyPair extends BytesValue {}
export class IdentityKeyStore {}
export class KEMPublicKey extends BytesValue {}
export class KEMKeyPair extends BytesValue {
  public static generate(): KEMKeyPair {
    return new KEMKeyPair(crypto.getRandomValues(new Uint8Array(32)));
  }

  public getPublicKey(): KEMPublicKey {
    return new KEMPublicKey(this.value);
  }
}
export class KyberPreKeyRecord extends BytesValue {
  public static new(): KyberPreKeyRecord {
    return new KyberPreKeyRecord();
  }
}
export class KyberPreKeyStore {}
export class PreKeyBundle extends BytesValue {}
export class PreKeyRecord extends BytesValue {}
export class PreKeyStore {}
export class PreKeySignalMessage extends BytesValue {}
export class ProtocolAddress extends BytesValue {}
export class SenderKeyDistributionMessage extends BytesValue {}
export class SenderKeyRecord extends BytesValue {}
export class SenderKeyStore {}
export class ServerCertificate extends BytesValue {}
export class SessionRecord extends BytesValue {}
export class SessionStore {}
export class SignalMessage extends BytesValue {}
export class SignedPreKeyRecord extends BytesValue {}
export class SignedPreKeyStore {}
export class DecryptionErrorMessage extends BytesValue {}
export class UnidentifiedSenderMessageContent extends BytesValue {}
export class UuidCiphertext extends BytesValue {}

export const ProvisioningConnection = {};
export const AuthenticatedChatConnection = {};
export const UnauthenticatedChatConnection = {};

export function chunkSizeInBytes(): number {
  return 0;
}

export function everyNthByte(input: Uint8Array): Uint8Array {
  return input;
}

export function inferChunkSize(): number {
  return 0;
}

export function groupDecrypt(): Uint8Array {
  return unavailable('groupDecrypt');
}

export function groupEncrypt(): Uint8Array {
  return unavailable('groupEncrypt');
}

export function decryptAci(): Aci {
  return new Aci();
}

export function decryptGroupBlob(): Uint8Array {
  return new Uint8Array();
}

export function decryptPni(): Pni {
  return new Pni();
}

export function decryptProfileKey(): ProfileKey {
  return new ProfileKey();
}

export function decryptServiceId(): ServiceId {
  return new ServiceId();
}

export function createProfileKeyCredentialPresentation(): ProfileKeyCredentialPresentation {
  return new ProfileKeyCredentialPresentation();
}

export function decodeProfileKeyCredentialPresentation(): ProfileKeyCredentialPresentation {
  return new ProfileKeyCredentialPresentation();
}

export function deriveAccessKeyFromProfileKey(): Uint8Array {
  return new Uint8Array();
}

export function deriveProfileKeyCommitment(): Uint8Array {
  return new Uint8Array();
}

export function deriveProfileKeyVersion(): ProfileKeyVersion {
  return new ProfileKeyVersion();
}

export function generateProfileKeyCredentialRequest(): ProfileKeyCredentialRequestContext {
  return new ProfileKeyCredentialRequestContext();
}

export function handleProfileKeyCredential(): ProfileKeyCredentialPresentation {
  return new ProfileKeyCredentialPresentation();
}

export function deriveGroupID(): Uint8Array {
  return new Uint8Array();
}

export function deriveGroupSecretParams(): GroupSecretParams {
  return new GroupSecretParams();
}

export function deriveGroupPublicParams(): GenericServerPublicParams {
  return new GenericServerPublicParams();
}

export function encryptGroupBlob(): Uint8Array {
  return new Uint8Array();
}

export function encryptServiceId(): Uint8Array {
  return new Uint8Array();
}

export function getAuthCredentialPresentation(): AuthCredentialWithPni {
  return new AuthCredentialWithPni();
}

export function getClientZkAuthOperations(): ClientZkAuthOperations {
  return new ClientZkAuthOperations();
}

export function getClientZkGroupCipher(): ClientZkGroupCipher {
  return new ClientZkGroupCipher();
}

export function getClientZkProfileOperations(): ClientZkProfileOperations {
  return new ClientZkProfileOperations();
}

export function verifyNotarySignature(): boolean {
  return true;
}

export function validate(): Promise<{ ok: true }> {
  return Promise.resolve({ ok: true });
}

export function getKeysForServiceId(): undefined {
  return undefined;
}

export function getKeysForServiceIdUnauth(): undefined {
  return undefined;
}

export function processPreKeyBundle(): void {
  unavailable('processPreKeyBundle');
}

export function processSenderKeyDistributionMessage(): void {
  unavailable('processSenderKeyDistributionMessage');
}

export function resetField(): void {}

export function sealedSenderDecryptToUsmc(): Uint8Array {
  return unavailable('sealedSenderDecryptToUsmc');
}

export function sealedSenderEncrypt(): Uint8Array {
  return unavailable('sealedSenderEncrypt');
}

export function sealedSenderMultiRecipientEncrypt(): Uint8Array {
  return unavailable('sealedSenderMultiRecipientEncrypt');
}

export function sendMessagesLegacy(): Promise<void> {
  return Promise.reject(new Error('sendMessagesLegacy is provided by the Signal Web backend'));
}

export function sendMessagesUnauthLegacy(): Promise<void> {
  return Promise.reject(new Error('sendMessagesUnauthLegacy is provided by the Signal Web backend'));
}

export function sendSealedSenderMessage(): Promise<void> {
  return Promise.reject(new Error('sendSealedSenderMessage is provided by the Signal Web backend'));
}

export function sendUnsealedMessage(): Promise<void> {
  return Promise.reject(new Error('sendUnsealedMessage is provided by the Signal Web backend'));
}

export function signalDecrypt(): Uint8Array {
  return unavailable('signalDecrypt');
}

export function signalDecryptPreKey(): Uint8Array {
  return unavailable('signalDecryptPreKey');
}

export function signalEncrypt(): Uint8Array {
  return unavailable('signalEncrypt');
}

export default new Proxy(
  {},
  {
    get(_target, property) {
      if (typeof property === 'string') {
        return () => unavailable(property);
      }
      return undefined;
    },
  }
);
