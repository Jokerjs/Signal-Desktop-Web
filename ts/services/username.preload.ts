// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  usernames,
  LibSignalErrorBase,
  ErrorCode,
} from '@signalapp/libsignal-client';

import { singleProtoJobQueue } from '../jobs/singleProtoJobQueue.preload.ts';
import { strictAssert } from '../util/assert.std.ts';
import { sleep } from '../util/sleep.std.ts';
import { getMinNickname, getMaxNickname } from '../util/Username.dom.ts';
import { bytesToUuid, uuidToBytes } from '../util/uuidToBytes.std.ts';
import type { UsernameReservationType } from '../types/Username.std.ts';
import {
  ReserveUsernameError,
  ConfirmUsernameResult,
  getNickname,
  getDiscriminator,
  isCaseChange,
} from '../types/Username.std.ts';
import * as Errors from '../types/errors.std.ts';
import { createLogger } from '../logging/log.std.ts';
import { MessageSender } from '../textsecure/SendMessage.preload.ts';
import {
  reserveUsername as doReserveUsername,
  replaceUsernameLink,
  confirmUsername as doConfirmUsername,
  deleteUsername as doDeleteUsername,
  resolveUsernameLink,
} from '../textsecure/WebAPI.preload.ts';
import type { ResolveUsernameByLinkOptionsType } from '../textsecure/WebAPI.preload.ts';
import { HTTPError } from '../types/HTTPError.std.ts';
import { findRetryAfterTimeFromError } from '../jobs/helpers/findRetryAfterTimeFromError.std.ts';
import * as Bytes from '../Bytes.std.ts';
import { storageServiceUploadJob } from './storage.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import {
  fromWebSafeBase64,
  toWebSafeBase64,
} from '../util/webSafeBase64.std.ts';

const log = createLogger('username');

type WebUsernameRuntime = Readonly<{
  reserveUsername?: (
    usernameHashes: ReadonlyArray<string>
  ) => Promise<{ usernameHash: string }>;
  reserveUsernameByNickname?: (
    body: Readonly<{
      customDiscriminator?: string;
      maxNicknameLength: number;
      minNicknameLength: number;
      nickname: string;
      previousUsername?: string;
    }>
  ) => Promise<{ hashBase64: string; username: string }>;
  confirmUsername?: (
    body: Readonly<{
      encryptedUsername: string;
      usernameHash: string;
      zkProof: string;
    }>
  ) => Promise<{ usernameLinkHandle: string }>;
  confirmUsernameReservation?: (
    body: Readonly<{
      hashBase64: string;
      previousLinkEntropyBase64?: string;
      username: string;
    }>
  ) => Promise<{ entropyBase64: string; usernameLinkHandle: string }>;
  deleteUsername?: () => Promise<void>;
  replaceUsernameLink?: (
    body: Readonly<{
      keepLinkHandle: boolean;
      usernameLinkEncryptedValue: string;
    }>
  ) => Promise<{ usernameLinkHandle: string }>;
  resetUsernameLink?: (
    username: string
  ) => Promise<{ entropyBase64: string; usernameLinkHandle: string }>;
  syncUsernameProfile?: (username: string | undefined) => Promise<void>;
}>;

function getWebUsernameRuntime(): WebUsernameRuntime | undefined {
  return (
    window as typeof window & {
      SignalWebRuntime?: WebUsernameRuntime;
    }
  ).SignalWebRuntime;
}

async function reserveUsernameHash({
  abortSignal,
  hashes,
}: Readonly<{
  abortSignal?: AbortSignal;
  hashes: ReadonlyArray<Uint8Array<ArrayBuffer>>;
}>): Promise<Uint8Array<ArrayBuffer>> {
  const runtime = getWebUsernameRuntime();
  if (runtime?.reserveUsername) {
    const { usernameHash } = await runtime.reserveUsername(
      hashes.map(hash => toWebSafeBase64(Bytes.toBase64(hash)))
    );
    return Bytes.fromBase64(fromWebSafeBase64(usernameHash));
  }

  const result = await doReserveUsername({
    hashes,
    abortSignal,
  });
  return result.usernameHash;
}

async function confirmUsernameHash({
  abortSignal,
  encryptedUsername,
  hash,
  proof,
}: Readonly<{
  abortSignal?: AbortSignal;
  encryptedUsername: Uint8Array<ArrayBuffer>;
  hash: Uint8Array<ArrayBuffer>;
  proof: Uint8Array<ArrayBuffer>;
}>): Promise<{ usernameLinkHandle: string }> {
  const runtime = getWebUsernameRuntime();
  if (runtime?.confirmUsername) {
    return runtime.confirmUsername({
      encryptedUsername: toWebSafeBase64(Bytes.toBase64(encryptedUsername)),
      usernameHash: toWebSafeBase64(Bytes.toBase64(hash)),
      zkProof: toWebSafeBase64(Bytes.toBase64(proof)),
    });
  }

  return doConfirmUsername({
    hash,
    proof,
    encryptedUsername,
    abortSignal,
  });
}

async function replaceUsernameLinkWebAware({
  encryptedUsername,
  keepLinkHandle,
}: Readonly<{
  encryptedUsername: Uint8Array<ArrayBuffer>;
  keepLinkHandle: boolean;
}>): Promise<{ usernameLinkHandle: string }> {
  const runtime = getWebUsernameRuntime();
  if (runtime?.replaceUsernameLink) {
    return runtime.replaceUsernameLink({
      keepLinkHandle,
      usernameLinkEncryptedValue: toWebSafeBase64(
        Bytes.toBase64(encryptedUsername)
      ),
    });
  }

  return replaceUsernameLink({
    encryptedUsername,
    keepLinkHandle,
  });
}

async function reserveUsernameViaWebRuntime({
  customDiscriminator,
  nickname,
  previousUsername,
}: Readonly<{
  customDiscriminator: string | undefined;
  nickname: string;
  previousUsername: string | undefined;
}>): Promise<UsernameReservationType | undefined> {
  const runtime = getWebUsernameRuntime();
  if (!runtime?.reserveUsernameByNickname) {
    return undefined;
  }

  const result = await runtime.reserveUsernameByNickname({
    customDiscriminator,
    maxNicknameLength: getMaxNickname(),
    minNicknameLength: getMinNickname(),
    nickname,
    previousUsername,
  });

  return {
    hash: Bytes.fromBase64(result.hashBase64),
    previousUsername,
    username: result.username,
  };
}

function getWebReserveUsernameError(
  error: HTTPError
): ReserveUsernameError | undefined {
  const message = error.message;
  if (!message.startsWith('ReserveUsernameError:')) {
    return undefined;
  }

  const [rawValue] = message
    .slice('ReserveUsernameError:'.length)
    .split(';', 1);

  if (rawValue === ReserveUsernameError.NotEnoughCharacters) {
    return ReserveUsernameError.NotEnoughCharacters;
  }
  if (rawValue === ReserveUsernameError.TooManyCharacters) {
    return ReserveUsernameError.TooManyCharacters;
  }
  if (rawValue === ReserveUsernameError.CheckStartingCharacter) {
    return ReserveUsernameError.CheckStartingCharacter;
  }
  if (rawValue === ReserveUsernameError.CheckCharacters) {
    return ReserveUsernameError.CheckCharacters;
  }
  if (rawValue === ReserveUsernameError.NotEnoughDiscriminator) {
    return ReserveUsernameError.NotEnoughDiscriminator;
  }
  if (rawValue === ReserveUsernameError.AllZeroDiscriminator) {
    return ReserveUsernameError.AllZeroDiscriminator;
  }
  if (rawValue === ReserveUsernameError.LeadingZeroDiscriminator) {
    return ReserveUsernameError.LeadingZeroDiscriminator;
  }
  if (rawValue === ReserveUsernameError.TooManyAttempts) {
    return ReserveUsernameError.TooManyAttempts;
  }

  return undefined;
}

export type WriteUsernameOptionsType = Readonly<
  | {
      reservation: UsernameReservationType;
    }
  | {
      username: undefined;
      previousUsername: string | undefined;
      reservation?: undefined;
    }
>;

export type ReserveUsernameOptionsType = Readonly<{
  nickname: string;
  customDiscriminator: string | undefined;
  previousUsername: string | undefined;
  abortSignal?: AbortSignal;
}>;

export type ReserveUsernameResultType = Readonly<
  | {
      ok: true;
      reservation: UsernameReservationType;
      error?: void;
    }
  | {
      ok: false;
      reservation?: void;
      error: ReserveUsernameError;
    }
>;

export async function reserveUsername(
  options: ReserveUsernameOptionsType
): Promise<ReserveUsernameResultType> {
  const { nickname, customDiscriminator, previousUsername, abortSignal } =
    options;

  const me = window.ConversationController.getOurConversationOrThrow();

  if (me.get('username') !== previousUsername) {
    throw new Error('reserveUsername: Username has changed on another device');
  }

  try {
    const webReservation = await reserveUsernameViaWebRuntime({
      customDiscriminator,
      nickname,
      previousUsername,
    });
    if (webReservation) {
      return {
        ok: true,
        reservation: webReservation,
      };
    }

    if (previousUsername !== undefined && !customDiscriminator) {
      const previousNickname = getNickname(previousUsername);

      // Case change
      if (
        previousNickname !== undefined &&
        nickname.toLowerCase() === previousNickname.toLowerCase()
      ) {
        const previousDiscriminator = getDiscriminator(previousUsername);
        const newUsername = `${nickname}.${previousDiscriminator}`;
        const hash = usernames.hash(newUsername);
        return {
          ok: true,
          reservation: { previousUsername, username: newUsername, hash },
        };
      }
    }

    const candidates = customDiscriminator
      ? [
          usernames.fromParts(
            nickname,
            customDiscriminator,
            getMinNickname(),
            getMaxNickname()
          ).username,
        ]
      : usernames.generateCandidates(
          nickname,
          getMinNickname(),
          getMaxNickname()
        );

    const hashes = candidates.map(username => usernames.hash(username));

    const usernameHash = await reserveUsernameHash({
      hashes,
      abortSignal,
    });

    const index = hashes.findIndex(hash => Bytes.areEqual(hash, usernameHash));
    if (index === -1) {
      log.warn('reserveUsername: failed to find username hash in the response');
      return { ok: false, error: ReserveUsernameError.Unprocessable };
    }

    // oxlint-disable-next-line typescript/no-non-null-assertion
    const username = candidates[index]!;

    return {
      ok: true,
      reservation: { previousUsername, username, hash: usernameHash },
    };
  } catch (error) {
    if (error instanceof HTTPError) {
      const webError = getWebReserveUsernameError(error);
      if (webError) {
        return { ok: false, error: webError };
      }

      if (error.code === 422) {
        return { ok: false, error: ReserveUsernameError.Unprocessable };
      }
      if (error.code === 409) {
        return { ok: false, error: ReserveUsernameError.Conflict };
      }
      if (error.code === 413 || error.code === 429) {
        return {
          ok: false,
          error: ReserveUsernameError.TooManyAttempts,
        };
      }
    }
    if (error instanceof LibSignalErrorBase) {
      if (
        error.code === ErrorCode.NicknameCannotBeEmpty ||
        error.code === ErrorCode.NicknameTooShort
      ) {
        return {
          ok: false,
          error: ReserveUsernameError.NotEnoughCharacters,
        };
      }
      if (error.code === ErrorCode.NicknameTooLong) {
        return {
          ok: false,
          error: ReserveUsernameError.TooManyCharacters,
        };
      }
      if (error.code === ErrorCode.CannotStartWithDigit) {
        return {
          ok: false,
          error: ReserveUsernameError.CheckStartingCharacter,
        };
      }
      if (error.code === ErrorCode.BadNicknameCharacter) {
        return {
          ok: false,
          error: ReserveUsernameError.CheckCharacters,
        };
      }

      if (error.code === ErrorCode.DiscriminatorCannotBeZero) {
        return {
          ok: false,
          error: ReserveUsernameError.AllZeroDiscriminator,
        };
      }

      if (error.code === ErrorCode.DiscriminatorCannotHaveLeadingZeros) {
        return {
          ok: false,
          error: ReserveUsernameError.LeadingZeroDiscriminator,
        };
      }

      if (
        error.code === ErrorCode.DiscriminatorCannotBeEmpty ||
        error.code === ErrorCode.DiscriminatorCannotBeSingleDigit ||
        // This is handled on UI level
        error.code === ErrorCode.DiscriminatorTooLarge
      ) {
        return {
          ok: false,
          error: ReserveUsernameError.NotEnoughDiscriminator,
        };
      }
    }
    throw error;
  }
}

async function updateUsernameAndSyncProfile(
  username: string | undefined
): Promise<void> {
  const me = window.ConversationController.getOurConversationOrThrow();

  // Update model, update DB
  await me.updateUsername(username);

  const runtime = getWebUsernameRuntime();
  if (runtime?.syncUsernameProfile) {
    await runtime.syncUsernameProfile(username);
    return;
  }

  if (!window.ConversationController.doWeHaveOtherDevices()) {
    return;
  }

  // then tell our other devices about profile update, username
  try {
    await singleProtoJobQueue.add(
      MessageSender.getFetchLocalProfileSyncMessage()
    );
  } catch (error) {
    log.error(
      'updateUsernameAndSyncProfile: Failed to queue sync message',
      Errors.toLogFormat(error)
    );
  }
}

export async function confirmUsername(
  reservation: UsernameReservationType,
  abortSignal?: AbortSignal
): Promise<ConfirmUsernameResult> {
  const { previousUsername, username } = reservation;
  const previousLink = itemStorage.get('usernameLink');

  const me = window.ConversationController.getOurConversationOrThrow();

  if (me.get('username') !== previousUsername) {
    throw new Error('Username has changed on another device');
  }

  const { hash } = reservation;
  const runtime = getWebUsernameRuntime();
  if (!runtime?.confirmUsernameReservation) {
    strictAssert(
      Bytes.areEqual(usernames.hash(username), hash),
      'username hash mismatch'
    );
  }

  const wasCorrupted = itemStorage.get('usernameCorrupted');

  try {
    await itemStorage.remove('usernameLink');

    let serverIdString: string;
    let entropy: Uint8Array<ArrayBuffer>;
    if (runtime?.confirmUsernameReservation) {
      log.info('confirmUsername: confirming via web runtime');

      const result = await runtime.confirmUsernameReservation({
        hashBase64: Bytes.toBase64(hash),
        previousLinkEntropyBase64:
          previousLink && isCaseChange(reservation)
            ? Bytes.toBase64(previousLink.entropy)
            : undefined,
        username,
      });
      entropy = Bytes.fromBase64(result.entropyBase64);
      serverIdString = result.usernameLinkHandle;
    } else if (previousLink && isCaseChange(reservation)) {
      log.info('confirmUsername: updating link only');

      const updatedLink = usernames.createUsernameLink(
        username,
        previousLink.entropy
      );
      ({ entropy } = updatedLink);

      ({ usernameLinkHandle: serverIdString } =
        await replaceUsernameLinkWebAware({
          encryptedUsername: updatedLink.encryptedUsername,
          keepLinkHandle: true,
        }));
    } else {
      log.info('confirmUsername: confirming and replacing link');

      const newLink = usernames.createUsernameLink(username);
      ({ entropy } = newLink);

      const proof = usernames.generateProof(username);

      ({ usernameLinkHandle: serverIdString } = await confirmUsernameHash({
        hash,
        proof,
        encryptedUsername: newLink.encryptedUsername,
        abortSignal,
      }));
    }

    await itemStorage.put('usernameLink', {
      entropy,
      serverId: uuidToBytes(serverIdString),
    });

    await updateUsernameAndSyncProfile(username);
    await itemStorage.remove('usernameCorrupted');
    await itemStorage.remove('usernameLinkCorrupted');
  } catch (error) {
    if (error instanceof HTTPError) {
      if (error.code === 413 || error.code === 429) {
        const time = findRetryAfterTimeFromError(error);
        log.warn(`confirmUsername: got ${error.code}, waiting ${time}ms`);
        await sleep(time, abortSignal);

        return confirmUsername(reservation, abortSignal);
      }

      if (error.code === 409 || error.code === 410) {
        return ConfirmUsernameResult.ConflictOrGone;
      }
    }
    throw error;
  }

  return wasCorrupted
    ? ConfirmUsernameResult.OkRecovered
    : ConfirmUsernameResult.Ok;
}

export async function deleteUsername(
  previousUsername: string | undefined,
  abortSignal?: AbortSignal
): Promise<void> {
  const me = window.ConversationController.getOurConversationOrThrow();

  if (me.get('username') !== previousUsername) {
    throw new Error('Username has changed on another device');
  }

  await itemStorage.remove('usernameLink');
  const runtime = getWebUsernameRuntime();
  if (runtime?.deleteUsername) {
    await runtime.deleteUsername();
  } else {
    await doDeleteUsername(abortSignal);
  }
  await itemStorage.remove('usernameCorrupted');
  await updateUsernameAndSyncProfile(undefined);
}

export async function resetLink(username: string): Promise<void> {
  const me = window.ConversationController.getOurConversationOrThrow();

  if (me.get('username') !== username) {
    throw new Error('Username has changed on another device');
  }

  await itemStorage.remove('usernameLink');

  let entropy: Uint8Array<ArrayBuffer>;
  let serverIdString: string;
  const runtime = getWebUsernameRuntime();
  if (runtime?.resetUsernameLink) {
    const result = await runtime.resetUsernameLink(username);
    entropy = Bytes.fromBase64(result.entropyBase64);
    serverIdString = result.usernameLinkHandle;
  } else {
    const newLink = usernames.createUsernameLink(username);
    ({ entropy } = newLink);

    ({ usernameLinkHandle: serverIdString } = await replaceUsernameLinkWebAware(
      {
        encryptedUsername: newLink.encryptedUsername,
        keepLinkHandle: false,
      }
    ));
  }

  await itemStorage.put('usernameLink', {
    entropy,
    serverId: uuidToBytes(serverIdString),
  });
  await itemStorage.remove('usernameLinkCorrupted');

  me.captureChange('usernameLink');
  storageServiceUploadJob({ reason: 'resetLink' });
}

const USERNAME_LINK_ENTROPY_SIZE = 32;

export async function resolveUsernameByLinkBase64(
  base64: string
): Promise<string | undefined> {
  const content = Bytes.fromBase64(base64);
  const entropy = content.subarray(0, USERNAME_LINK_ENTROPY_SIZE);
  const serverId = content.subarray(USERNAME_LINK_ENTROPY_SIZE);

  const uuid = bytesToUuid(serverId);
  strictAssert(uuid, 'Failed to re-encode server id as uuid');

  return resolveUsernameByLink({ entropy, uuid });
}

async function resolveUsernameByLink(
  options: ResolveUsernameByLinkOptionsType
): Promise<string | undefined> {
  try {
    const result = await resolveUsernameLink(options);
    if (!result) {
      return undefined;
    }

    return result.username;
  } catch (error) {
    if (error instanceof HTTPError && error.code === 404) {
      return undefined;
    }
    throw error;
  }
}

export function hasUsernameChangeSyncCapability(): boolean {
  const ourConversation =
    window.ConversationController.getOurConversationOrThrow();

  return (
    ourConversation.get('capabilities')?.usernameChangeSyncMessage === true
  );
}

export async function sendUsernameChangeSyncMessage(): Promise<void> {
  if (!hasUsernameChangeSyncCapability()) {
    return;
  }

  await singleProtoJobQueue.add(MessageSender.getUsernameChangeSyncMessage());
}
