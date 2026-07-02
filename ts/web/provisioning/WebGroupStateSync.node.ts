// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import https from 'node:https';
import { createRequire } from 'node:module';

import { AuthCredentialWithPniResponse } from '@signalapp/libsignal-client/zkgroup.js';
import type { AuthenticatedChatConnection } from '@signalapp/libsignal-client/dist/net.js';

import * as Bytes from '../../Bytes.std.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import type { GroupCredentialType } from '../../textsecure/WebAPI.preload.ts';
import type {
  AciString,
  ServiceIdString,
  UntaggedPniString,
} from '../../types/ServiceId.std.ts';
import { toTaggedPni } from '../../types/ServiceId.std.ts';
import { toAciObject, toPniObject } from '../../util/ServiceId.node.ts';
import { toDayMillis } from '../../util/timestamp.std.ts';
import {
  decryptAci,
  decryptGroupBlob,
  decryptServiceId,
  createProfileKeyCredentialPresentation,
  deriveProfileKeyVersion,
  deriveGroupID,
  deriveGroupPublicParams,
  deriveGroupSecretParams,
  encryptGroupBlob,
  encryptServiceId,
  generateProfileKeyCredentialRequest,
  getAuthCredentialPresentation,
  getClientZkAuthOperations,
  getClientZkGroupCipher,
  getClientZkProfileOperations,
  handleProfileKeyCredential,
} from '../../util/zkgroup.node.ts';
import type { LinkedPayload, WebConversation } from '../types.std.ts';

const require = createRequire(import.meta.url);
const productionConfig = require('../../../config/production.json') as {
  serverPublicParams: string;
  storageUrl: string;
};

type AvatarUploadAttributes = Readonly<{
  acl: string;
  algorithm: string;
  credential: string;
  date: string;
  key: string;
  policy: string;
  signature: string;
}>;

type GroupCredentialsResponse = Readonly<{
  pni?: string | null;
  credentials: ReadonlyArray<GroupCredentialType>;
}>;

type GroupCredentials = Readonly<{
  groupPublicParamsHex: string;
  authCredentialPresentationHex: string;
}>;

type ProfileCredentialResponse = Readonly<{
  credential?: string;
}>;

const WEB_GROUP_SIZE_HARD_LIMIT = 32;
const GROUP_TITLE_MAX_ENCRYPTED_BYTES = 1024;
const GROUP_DESC_MAX_ENCRYPTED_BYTES = 8192;
const GROUP_STATE_FORBIDDEN_SKIP_MS = 5 * 60 * 1000;

const groupStateForbiddenUntilById = new Map<string, number>();

export type WebGroupMemberModifyAction =
  | 'add'
  | 'make-admin'
  | 'make-member'
  | 'remove';

export type WebGroupMemberModifyResult = Readonly<{
  groupChangeBase64: string;
  revision: number;
}>;

export type WebGroupSettingsModifyAction =
  | 'access-control-add-from-invite-link'
  | 'access-control-attributes'
  | 'access-control-members'
  | 'access-control-member-label'
  | 'announcements-only'
  | 'description'
  | 'title';

export type WebGroupSettingsModifyResult = Readonly<{
  groupChangeBase64: string;
  revision: number;
}>;

export type WebGroupCreateResult = WebConversation;

class GroupHttpStatusError extends Error {
  public readonly code: number;

  public constructor(message: string, code: number) {
    super(message);
    this.name = 'GroupHttpStatusError';
    this.code = code;
  }
}

function generateGroupAuth({
  authCredentialPresentationHex,
  groupPublicParamsHex,
}: GroupCredentials): string {
  return Bytes.toBase64(
    Bytes.fromString(`${groupPublicParamsHex}:${authCredentialPresentationHex}`)
  );
}

function verifyAvatarUploadAttributes(
  attributes: Proto.AvatarUploadAttributes.Params
): AvatarUploadAttributes {
  const { acl, algorithm, credential, date, key, policy, signature } =
    attributes;

  if (
    !acl ||
    !algorithm ||
    !credential ||
    !date ||
    !key ||
    !policy ||
    !signature
  ) {
    throw new Error(
      'verifyAvatarUploadAttributes: missing value from AvatarUploadAttributes'
    );
  }

  return {
    acl,
    algorithm,
    credential,
    date,
    key,
    policy,
    signature,
  };
}

function buildAvatarUploadForm({
  attributes,
  ciphertext,
}: Readonly<{
  attributes: AvatarUploadAttributes;
  ciphertext: Uint8Array<ArrayBuffer>;
}>): Readonly<{
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
}> {
  const boundaryString = `----------------${randomBytes(16).toString('hex')}`;
  const CRLF = '\r\n';
  const getSection = (name: string, value: string) => {
    return [
      `--${boundaryString}`,
      `Content-Disposition: form-data; name="${name}"${CRLF}`,
      value,
    ].join(CRLF);
  };

  const start = [
    getSection('key', attributes.key),
    getSection('x-amz-credential', attributes.credential),
    getSection('acl', attributes.acl),
    getSection('x-amz-algorithm', attributes.algorithm),
    getSection('x-amz-date', attributes.date),
    getSection('policy', attributes.policy),
    getSection('x-amz-signature', attributes.signature),
    getSection('Content-Type', 'application/octet-stream'),
    `--${boundaryString}`,
    'Content-Disposition: form-data; name="file"',
    `Content-Type: application/octet-stream${CRLF}${CRLF}`,
  ].join(CRLF);
  const end = `${CRLF}--${boundaryString}--${CRLF}`;
  const body = Bytes.concatenate([
    Bytes.fromString(start),
    ciphertext,
    Bytes.fromString(end),
  ]);

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundaryString}`,
  };
}

async function fetchGroupCredentialResponse(
  chat: AuthenticatedChatConnection
): Promise<GroupCredentialsResponse> {
  const startDayInMs = toDayMillis(Date.now());
  const endDayInMs = startDayInMs + 7 * 24 * 60 * 60 * 1000;
  const response = await chat.fetch({
    verb: 'GET',
    path:
      `/v1/certificate/auth/group?redemptionStartSeconds=${startDayInMs / 1000}` +
      `&redemptionEndSeconds=${endDayInMs / 1000}` +
      '&zkcCredential=true',
    headers: [],
    timeoutMillis: 30_000,
  });
  const responseBody = Buffer.from(response.body ?? new Uint8Array()).toString(
    'utf8'
  );
  if (response.status !== 200) {
    throw new Error(
      responseBody
        ? `getGroupCredentials failed with status ${response.status}: ${responseBody}`
        : `getGroupCredentials failed with status ${response.status}`
    );
  }
  return JSON.parse(responseBody) as GroupCredentialsResponse;
}

function getCredentialForToday(
  credentials: ReadonlyArray<GroupCredentialType>
): GroupCredentialType {
  const today = toDayMillis(Date.now());
  const credential = credentials.find(item => item.redemptionTime * 1000 === today);
  if (!credential) {
    throw new Error('getCredentialForToday: group credentials do not include today');
  }
  return credential;
}

function getGroupCredentialsFromResponse({
  response,
  linkedPayload,
  publicParams,
  secretParams,
}: Readonly<{
  response: GroupCredentialsResponse;
  linkedPayload: LinkedPayload;
  publicParams: string;
  secretParams: string;
}>): GroupCredentials {
  const aci = linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
  if (!aci) {
    throw new Error('getGroupCredentials: missing ACI');
  }

  if (!response.pni) {
    throw new Error('getGroupCredentials: missing PNI');
  }

  const rawCredential = getCredentialForToday(response.credentials);
  const clientZkAuthOperations = getClientZkAuthOperations(
    productionConfig.serverPublicParams
  );
  const authCredential =
    clientZkAuthOperations.receiveAuthCredentialWithPniAsServiceId(
      toAciObject(aci as AciString),
      toPniObject(toTaggedPni(response.pni as UntaggedPniString)),
      rawCredential.redemptionTime,
      new AuthCredentialWithPniResponse(Bytes.fromBase64(rawCredential.credential))
    );
  const credential = Bytes.toBase64(authCredential.serialize());
  const presentation = getAuthCredentialPresentation(
    clientZkAuthOperations,
    credential,
    secretParams
  );

  return {
    authCredentialPresentationHex: Bytes.toHex(presentation),
    groupPublicParamsHex: Bytes.toHex(Bytes.fromBase64(publicParams)),
  };
}

async function getGroupCredentials({
  chat,
  linkedPayload,
  publicParams,
  secretParams,
}: Readonly<{
  chat: AuthenticatedChatConnection;
  linkedPayload: LinkedPayload;
  publicParams: string;
  secretParams: string;
}>): Promise<GroupCredentials> {
  return getGroupCredentialsFromResponse({
    response: await fetchGroupCredentialResponse(chat),
    linkedPayload,
    publicParams,
    secretParams,
  });
}

async function fetchGroupBytes({
  allowInsecureTls,
  credentials,
  storageUrl,
}: Readonly<{
  allowInsecureTls?: boolean;
  credentials: GroupCredentials;
  storageUrl: string;
}>): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL('/v2/groups', storageUrl);
  const headers = {
    authorization: `Basic ${generateGroupAuth(credentials)}`,
    'content-type': 'application/x-protobuf',
  };
  try {
    const response = await fetch(url, {
      headers,
      method: 'GET',
    });
    const bytes = new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>;
    if (!response.ok) {
      throw new GroupHttpStatusError(
        `/v2/groups failed with status ${response.status}: ${Buffer.from(bytes).toString('utf8')}`,
        response.status
      );
    }
    return bytes;
  } catch (error) {
    if (!allowInsecureTls) {
      throw error;
    }
    return new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          headers,
          method: 'GET',
          rejectUnauthorized: false,
        },
        response => {
          const chunks = new Array<Buffer>();
          response.on('data', chunk => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            const bytes = Buffer.concat(chunks);
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(
                new GroupHttpStatusError(
                  `/v2/groups failed with status ${statusCode}: ${bytes.toString('utf8')}`,
                  statusCode
                )
              );
              return;
            }
            resolve(new Uint8Array(bytes) as Uint8Array<ArrayBuffer>);
          });
        }
      );
      request.on('error', reject);
      request.end();
    });
  }
}

async function putGroupBytes({
  allowInsecureTls,
  credentials,
  group,
  storageUrl,
}: Readonly<{
  allowInsecureTls?: boolean;
  credentials: GroupCredentials;
  group: Proto.Group.Params;
  storageUrl: string;
}>): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL('/v2/groups', storageUrl);
  const data = Buffer.from(Proto.Group.encode(group));
  const headers = {
    authorization: `Basic ${generateGroupAuth(credentials)}`,
    'content-type': 'application/x-protobuf',
  };

  try {
    const response = await fetch(url, {
      body: data,
      headers,
      method: 'PUT',
    });
    const bytes = new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>;
    if (!response.ok) {
      throw new GroupHttpStatusError(
        `/v2/groups PUT failed with status ${response.status}: ${Buffer.from(bytes).toString('utf8')}`,
        response.status
      );
    }
    return bytes;
  } catch (error) {
    if (!allowInsecureTls) {
      throw error;
    }
    return new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          headers: {
            ...headers,
            'content-length': String(data.byteLength),
          },
          method: 'PUT',
          rejectUnauthorized: false,
        },
        response => {
          const chunks = new Array<Buffer>();
          response.on('data', chunk => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            const bytes = Buffer.concat(chunks);
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(
                new GroupHttpStatusError(
                  `/v2/groups PUT failed with status ${statusCode}: ${bytes.toString('utf8')}`,
                  statusCode
                )
              );
              return;
            }
            resolve(new Uint8Array(bytes) as Uint8Array<ArrayBuffer>);
          });
        }
      );
      request.on('error', reject);
      request.end(data);
    });
  }
}

async function fetchGroupAvatarUploadAttributes({
  allowInsecureTls,
  credentials,
  storageUrl,
}: Readonly<{
  allowInsecureTls?: boolean;
  credentials: GroupCredentials;
  storageUrl: string;
}>): Promise<AvatarUploadAttributes> {
  const url = new URL('/v2/groups/avatar/form', storageUrl);
  const headers = {
    authorization: `Basic ${generateGroupAuth(credentials)}`,
  };
  try {
    const response = await fetch(url, {
      headers,
      method: 'GET',
    });
    const bytes = new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>;
    if (!response.ok) {
      throw new Error(
        `/v2/groups/avatar/form failed with status ${response.status}: ${Buffer.from(bytes).toString('utf8')}`
      );
    }
    return verifyAvatarUploadAttributes(
      Proto.AvatarUploadAttributes.decode(bytes)
    );
  } catch (error) {
    if (!allowInsecureTls) {
      throw error;
    }
    return new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          headers,
          method: 'GET',
          rejectUnauthorized: false,
        },
        response => {
          const chunks = new Array<Buffer>();
          response.on('data', chunk => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            const bytes = Buffer.concat(chunks);
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(
                new Error(
                  `/v2/groups/avatar/form failed with status ${statusCode}: ${bytes.toString('utf8')}`
                )
              );
              return;
            }
            resolve(
              verifyAvatarUploadAttributes(
                Proto.AvatarUploadAttributes.decode(bytes)
              )
            );
          });
        }
      );
      request.on('error', reject);
      request.end();
    });
  }
}

async function postGroupAvatarUpload({
  allowInsecureTls,
  cdnUrl,
  contentType,
  data,
}: Readonly<{
  allowInsecureTls?: boolean;
  cdnUrl: string;
  contentType: string;
  data: Uint8Array<ArrayBuffer>;
}>): Promise<void> {
  const url = new URL('/', cdnUrl);
  const headers = {
    'content-length': String(data.byteLength),
    'content-type': contentType,
  };
  try {
    const response = await fetch(url, {
      body: data,
      headers,
      method: 'POST',
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(
        `group avatar upload failed with status ${response.status}: ${bytes.toString('utf8')}`
      );
    }
    return;
  } catch (error) {
    if (!allowInsecureTls) {
      throw error;
    }
    return new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          headers,
          method: 'POST',
          rejectUnauthorized: false,
        },
        response => {
          const chunks = new Array<Buffer>();
          response.on('data', chunk => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            const bytes = Buffer.concat(chunks);
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(
                new Error(
                  `group avatar upload failed with status ${statusCode}: ${bytes.toString('utf8')}`
                )
              );
              return;
            }
            resolve();
          });
        }
      );
      request.on('error', reject);
      request.end(data);
    });
  }
}

async function uploadGroupAvatar({
  allowInsecureTls,
  avatar,
  cdnUrl,
  credentials,
  secretParams,
  storageUrl,
}: Readonly<{
  allowInsecureTls?: boolean;
  avatar: Uint8Array<ArrayBuffer>;
  cdnUrl: string;
  credentials: GroupCredentials;
  secretParams: string;
  storageUrl: string;
}>): Promise<string> {
  const clientZkGroupCipher = getClientZkGroupCipher(secretParams);
  const blobPlaintext = Proto.GroupAttributeBlob.encode({
    content: {
      avatar,
    },
  });
  const ciphertext = encryptGroupBlob(clientZkGroupCipher, blobPlaintext);
  const attributes = await fetchGroupAvatarUploadAttributes({
    allowInsecureTls,
    credentials,
    storageUrl,
  });
  const form = buildAvatarUploadForm({
    attributes,
    ciphertext,
  });
  await postGroupAvatarUpload({
    allowInsecureTls,
    cdnUrl,
    contentType: form.contentType,
    data: form.body,
  });
  return attributes.key;
}

function toGroupActionsParams(
  input: Pick<Proto.GroupChange.Actions.Params, 'version'> &
    Partial<Omit<Proto.GroupChange.Actions.Params, 'sourceUserId' | 'groupId'>>
): Proto.GroupChange.Actions.Params {
  return {
    sourceUserId: null,
    groupId: null,
    addMembers: null,
    deleteMembers: null,
    modifyMemberRoles: null,
    modifyMemberLabels: null,
    modifyMemberProfileKeys: null,
    addMembersPendingProfileKey: null,
    deleteMembersPendingProfileKey: null,
    promoteMembersPendingProfileKey: null,
    modifyTitle: null,
    modifyAvatar: null,
    modifyDisappearingMessageTimer: null,
    modifyAttributesAccess: null,
    modifyMemberAccess: null,
    modifyAddFromInviteLinkAccess: null,
    modifyMemberLabelAccess: null,
    addMembersPendingAdminApproval: null,
    deleteMembersPendingAdminApproval: null,
    promoteMembersPendingAdminApproval: null,
    modifyInviteLinkPassword: null,
    modifyDescription: null,
    modifyAnnouncementsOnly: null,
    addMembersBanned: null,
    deleteMembersBanned: null,
    promoteMembersPendingPniAciProfileKey: null,
    terminateGroup: null,
    ...input,
  };
}

async function fetchProfileKeyCredential({
  chat,
  targetConversation,
}: Readonly<{
  chat: AuthenticatedChatConnection;
  targetConversation: WebConversation;
}>): Promise<string> {
  const { profileKey, serviceId } = targetConversation;
  if (!profileKey || !serviceId) {
    throw new Error('fetchProfileKeyCredential: target conversation is missing profileKey or serviceId');
  }

  const clientZkProfileCipher = getClientZkProfileOperations(
    productionConfig.serverPublicParams
  );
  const { context, requestHex } = generateProfileKeyCredentialRequest(
    clientZkProfileCipher,
    serviceId as ServiceIdString,
    profileKey
  );
  const profileKeyVersion = deriveProfileKeyVersion(
    profileKey,
    serviceId as ServiceIdString
  );
  const response = await chat.fetch({
    verb: 'GET',
    path:
      `/v1/profile/${serviceId}/${profileKeyVersion}/${requestHex}` +
      '?credentialType=expiringProfileKey',
    headers: [],
    timeoutMillis: 30_000,
  });
  const responseBody = Buffer.from(response.body ?? new Uint8Array()).toString(
    'utf8'
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      responseBody
        ? `profile credential ${serviceId} failed with status ${response.status}: ${responseBody}`
        : `profile credential ${serviceId} failed with status ${response.status}`
    );
  }
  const profile = JSON.parse(responseBody) as ProfileCredentialResponse;
  if (!profile.credential) {
    throw new Error('fetchProfileKeyCredential: profile response is missing credential');
  }
  return handleProfileKeyCredential(
    clientZkProfileCipher,
    context,
    profile.credential
  ).credential;
}

function buildModifyMemberActions({
  action,
  conversation,
  profileKeyCredentialBase64,
  ourAci,
  targetConversation,
  targetServiceId,
}: Readonly<{
  action: WebGroupMemberModifyAction;
  conversation: WebConversation;
  profileKeyCredentialBase64?: string;
  ourAci: string;
  targetConversation?: WebConversation;
  targetServiceId: ServiceIdString;
}>): Proto.GroupChange.Actions.Params {
  const { secretParams } = conversation;
  if (!secretParams) {
    throw new Error('buildModifyMemberActions: group was missing secretParams');
  }

  const revision = (conversation.revision ?? 0) + 1;
  const clientZkGroupCipher = getClientZkGroupCipher(secretParams);
  const userId = encryptServiceId(clientZkGroupCipher, targetServiceId);

  if (action === 'add') {
    if (!profileKeyCredentialBase64 || !targetConversation?.profileKey) {
      throw new Error('buildModifyMemberActions: add action is missing target profile credential');
    }
    const clientZkProfileCipher = getClientZkProfileOperations(
      productionConfig.serverPublicParams
    );
    const presentation = createProfileKeyCredentialPresentation(
      clientZkProfileCipher,
      profileKeyCredentialBase64,
      secretParams
    );
    const deletedUserId = conversation.bannedMembersV2?.some(member => {
      return member.serviceId === targetServiceId;
    })
      ? userId
      : null;
    return toGroupActionsParams({
      version: revision,
      addMembers: [
        {
          added: {
            joinedAtVersion: null,
            labelEmoji: null,
            labelString: null,
            presentation,
            profileKey: null,
            role: Proto.Member.Role.DEFAULT,
            userId: null,
          },
          joinFromInviteLink: null,
        },
      ],
      deleteMembersBanned: deletedUserId != null ? [{ deletedUserId }] : null,
    });
  }

  if (action === 'remove') {
    const { addMembersBanned, deleteMembersBanned } =
      maybeBuildAddBannedMemberActions({
        clientZkGroupCipher,
        conversation,
        ourAci,
        targetServiceId,
      });

    return toGroupActionsParams({
      version: revision,
      deleteMembers: [
        {
          deletedUserId: userId,
        },
      ],
      addMembersBanned,
      deleteMembersBanned,
    });
  }

  const membership = conversation.membersV2?.find(member => {
    return member.aci === targetServiceId;
  });
  const onlyAdminsCanAddMemberLabel =
    conversation.accessControl?.memberLabel ===
    Proto.AccessControl.AccessRequired.ADMINISTRATOR;
  const wasPreviouslyAnAdmin =
    membership?.role === Proto.Member.Role.ADMINISTRATOR;
  const nowNotAnAdmin = action !== 'make-admin';
  const shouldDropMemberLabel =
    Boolean(membership?.labelString) &&
    onlyAdminsCanAddMemberLabel &&
    wasPreviouslyAnAdmin &&
    nowNotAnAdmin;

  return toGroupActionsParams({
    version: revision,
    modifyMemberRoles: [
      {
        userId,
        role:
          action === 'make-admin'
            ? Proto.Member.Role.ADMINISTRATOR
            : Proto.Member.Role.DEFAULT,
      },
    ],
    modifyMemberLabels: shouldDropMemberLabel
      ? [
          {
            userId,
            labelEmoji: null,
            labelString: null,
          },
        ]
      : null,
  });
}

function maybeBuildAddBannedMemberActions({
  clientZkGroupCipher,
  conversation,
  ourAci,
  targetServiceId,
}: Readonly<{
  clientZkGroupCipher: ReturnType<typeof getClientZkGroupCipher>;
  conversation: WebConversation;
  ourAci: string;
  targetServiceId: ServiceIdString;
}>): Pick<
  Proto.GroupChange.Actions.Params,
  'addMembersBanned' | 'deleteMembersBanned'
> {
  const doesMemberNeedBan =
    !conversation.bannedMembersV2?.some(member => {
      return member.serviceId === targetServiceId;
    }) && targetServiceId !== ourAci;

  if (!doesMemberNeedBan) {
    return {
      addMembersBanned: null,
      deleteMembersBanned: null,
    };
  }

  const sortedBannedMembers = [...(conversation.bannedMembersV2 ?? [])].sort(
    (a, b) => {
      return b.timestamp - a.timestamp;
    }
  );
  const deletedBannedMembers = sortedBannedMembers.slice(
    Math.max(0, WEB_GROUP_SIZE_HARD_LIMIT - 1)
  );
  const deleteMembersBanned = deletedBannedMembers.length
    ? deletedBannedMembers.map(bannedMember => {
        return {
          deletedUserId: encryptServiceId(
            clientZkGroupCipher,
            bannedMember.serviceId
          ),
        };
      })
    : null;

  return {
    addMembersBanned: [
      {
        added: {
          userId: encryptServiceId(clientZkGroupCipher, targetServiceId),
          timestamp: null,
        },
      },
    ],
    deleteMembersBanned,
  };
}

function buildGroupTitleBuffer(
  clientZkGroupCipher: ReturnType<typeof getClientZkGroupCipher>,
  title: string
): Uint8Array<ArrayBuffer> {
  const titleBlobPlaintext = Proto.GroupAttributeBlob.encode({
    content: {
      title,
    },
  });
  const result = encryptGroupBlob(clientZkGroupCipher, titleBlobPlaintext);
  if (result.byteLength > GROUP_TITLE_MAX_ENCRYPTED_BYTES) {
    throw new Error('buildGroupTitleBuffer: encrypted group title is too long');
  }
  return result;
}

function buildCreateGroupProto({
  accessControl,
  avatarUrl,
  expireTimer,
  membersV2,
  name,
  pendingMembersV2,
  profileKeyCredentialByAci,
  publicParams,
  secretParams,
}: Readonly<{
  accessControl: Proto.AccessControl.Params;
  avatarUrl?: string;
  expireTimer?: number;
  membersV2: ReadonlyArray<NonNullable<WebConversation['membersV2']>[number]>;
  name: string;
  pendingMembersV2: ReadonlyArray<NonNullable<WebConversation['pendingMembersV2']>[number]>;
  profileKeyCredentialByAci: ReadonlyMap<string, string>;
  publicParams: string;
  secretParams: string;
}>): Proto.Group.Params {
  const clientZkGroupCipher = getClientZkGroupCipher(secretParams);
  const clientZkProfileCipher = getClientZkProfileOperations(
    productionConfig.serverPublicParams
  );
  const ourAci = membersV2.find(member => {
    return member.role === Proto.Member.Role.ADMINISTRATOR;
  })?.aci;
  if (!ourAci) {
    throw new Error('buildCreateGroupProto: missing administrator member');
  }
  const addedByUserId = encryptServiceId(clientZkGroupCipher, ourAci);

  let disappearingMessagesTimer: Uint8Array<ArrayBuffer> | null = null;
  if (expireTimer) {
    const timerBlobPlaintext = Proto.GroupAttributeBlob.encode({
      content: {
        disappearingMessagesDuration: expireTimer,
      },
    });
    disappearingMessagesTimer = encryptGroupBlob(
      clientZkGroupCipher,
      timerBlobPlaintext
    );
  }

  return {
    publicKey: Bytes.fromBase64(publicParams),
    version: 0,
    title: name ? buildGroupTitleBuffer(clientZkGroupCipher, name) : null,
    avatarUrl: avatarUrl ?? null,
    disappearingMessagesTimer,
    accessControl,
    members: membersV2.map(member => {
      const profileKeyCredentialBase64 = profileKeyCredentialByAci.get(member.aci);
      if (!profileKeyCredentialBase64) {
        throw new Error('buildCreateGroupProto: missing member profile credential');
      }
      return {
        role: member.role,
        presentation: createProfileKeyCredentialPresentation(
          clientZkProfileCipher,
          profileKeyCredentialBase64,
          secretParams
        ),
        userId: null,
        profileKey: null,
        joinedAtVersion: null,
        labelEmoji: null,
        labelString: null,
      };
    }),
    membersPendingProfileKey: pendingMembersV2.map(member => {
      return {
        timestamp: BigInt(member.timestamp),
        addedByUserId,
        member: {
          userId: encryptServiceId(clientZkGroupCipher, member.serviceId),
          role: member.role,
          presentation: null,
          profileKey: null,
          joinedAtVersion: null,
          labelEmoji: null,
          labelString: null,
        },
      };
    }),
    description: null,
    membersPendingAdminApproval: null,
    membersBanned: null,
    inviteLinkPassword: null,
    announcementsOnly: null,
    terminated: null,
  };
}

export async function createGroupConversation({
  allowInsecureTls,
  avatar,
  cdnUrl,
  chat,
  conversationIds,
  conversations,
  expireTimer,
  linkedPayload,
  name,
  storageUrl = productionConfig.storageUrl,
}: Readonly<{
  allowInsecureTls?: boolean;
  avatar?: string;
  cdnUrl: string;
  chat: AuthenticatedChatConnection;
  conversationIds: ReadonlyArray<string>;
  conversations: Readonly<Record<string, WebConversation>>;
  expireTimer?: number;
  linkedPayload: LinkedPayload;
  name: string;
  storageUrl?: string;
}>): Promise<WebGroupCreateResult> {
  const ourAci = linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
  if (!ourAci) {
    throw new Error('createGroupConversation: missing linked ACI');
  }
  if (!linkedPayload.profileKeyBase64) {
    throw new Error('createGroupConversation: missing linked profile key');
  }

  const masterKeyBytes = new Uint8Array(randomBytes(32)) as Uint8Array<ArrayBuffer>;
  const secretParamsBytes = deriveGroupSecretParams(masterKeyBytes);
  const publicParamsBytes = deriveGroupPublicParams(secretParamsBytes);
  const groupIdBytes = deriveGroupID(secretParamsBytes);
  const groupId = Bytes.toBase64(groupIdBytes);
  const masterKey = Bytes.toBase64(masterKeyBytes);
  const publicParams = Bytes.toBase64(publicParamsBytes);
  const secretParams = Bytes.toBase64(secretParamsBytes);
  const accessControl: Proto.AccessControl.Params = {
    attributes: Proto.AccessControl.AccessRequired.MEMBER,
    members: Proto.AccessControl.AccessRequired.MEMBER,
    addFromInviteLink: Proto.AccessControl.AccessRequired.UNSATISFIABLE,
    memberLabel: Proto.AccessControl.AccessRequired.MEMBER,
  };
  const conversationAccessControl: NonNullable<WebConversation['accessControl']> = {
    attributes: Proto.AccessControl.AccessRequired.MEMBER,
    members: Proto.AccessControl.AccessRequired.MEMBER,
    addFromInviteLink: Proto.AccessControl.AccessRequired.UNSATISFIABLE,
    memberLabel: Proto.AccessControl.AccessRequired.MEMBER,
  };
  const membersV2 = new Array<NonNullable<WebConversation['membersV2']>[number]>();
  const pendingMembersV2 =
    new Array<NonNullable<WebConversation['pendingMembersV2']>[number]>();
  const profileKeyCredentialByAci = new Map<string, string>();

  membersV2.push({
    aci: ourAci as AciString,
    role: Proto.Member.Role.ADMINISTRATOR,
    joinedAtVersion: 0,
  });
  profileKeyCredentialByAci.set(
    ourAci,
    await fetchProfileKeyCredential({
      chat,
      targetConversation: {
        id: ourAci,
        serviceId: ourAci,
        profileKey: linkedPayload.profileKeyBase64,
        type: 'direct',
        conversationType: 'direct',
      },
    })
  );

  for (const conversationId of conversationIds) {
    const conversation = conversations[conversationId];
    if (!conversation?.serviceId) {
      continue;
    }
    if (conversation.profileKey) {
      const profileKeyCredentialBase64 = await fetchProfileKeyCredential({
        chat,
        targetConversation: conversation,
      });
      profileKeyCredentialByAci.set(conversation.serviceId, profileKeyCredentialBase64);
      membersV2.push({
        aci: conversation.serviceId as AciString,
        role: Proto.Member.Role.DEFAULT,
        joinedAtVersion: 0,
      });
    } else {
      pendingMembersV2.push({
        addedByUserId: ourAci as AciString,
        serviceId: conversation.serviceId as ServiceIdString,
        timestamp: Date.now(),
        role: Proto.Member.Role.DEFAULT,
      });
    }
  }

  if (membersV2.length + pendingMembersV2.length > WEB_GROUP_SIZE_HARD_LIMIT) {
    throw new Error(
      `createGroupConversation: too many members: ${membersV2.length + pendingMembersV2.length}`
    );
  }

  const credentials = await getGroupCredentials({
    chat,
    linkedPayload,
    publicParams,
    secretParams,
  });
  const avatarBytes = avatar
    ? (Bytes.fromBase64(avatar) as Uint8Array<ArrayBuffer>)
    : undefined;
  const avatarUrl = avatarBytes
    ? await uploadGroupAvatar({
        allowInsecureTls,
        avatar: avatarBytes,
        cdnUrl,
        credentials,
        secretParams,
        storageUrl,
      })
    : undefined;
  const group = buildCreateGroupProto({
    accessControl,
    avatarUrl,
    expireTimer,
    membersV2,
    name,
    pendingMembersV2,
    profileKeyCredentialByAci,
    publicParams,
    secretParams,
  });
  const bytes = await putGroupBytes({
    allowInsecureTls,
    credentials,
    group,
    storageUrl,
  });
  const response = Proto.GroupResponse.decode(bytes);
  if (!response.groupSendEndorsementsResponse) {
    throw new Error('createGroupConversation: missing groupSendEndorsementsResponse');
  }

  const timestamp = Date.now();
  const localAvatarUrl = avatar
    ? `data:image/jpeg;base64,${avatar}`
    : undefined;
  return {
    id: groupId,
    type: 'group',
    conversationType: 'group',
    acceptedMessageRequest: true,
    accessControl: conversationAccessControl,
    activeAt: timestamp,
    avatarUrl: localAvatarUrl,
    groupId,
    hasMessages: true,
    hasAvatar: Boolean(localAvatarUrl),
    isArchived: false,
    isPinned: false,
    left: false,
    lastUpdated: timestamp,
    markedUnread: false,
    masterKey,
    membersV2,
    name,
    pendingMembersV2,
    profileSharing: true,
    publicParams,
    remoteAvatarUrl: avatarUrl,
    revision: 0,
    searchableTitle: name,
    secretParams,
    timestamp,
    title: name,
    titleNoDefault: name,
  };
}

function buildGroupDescriptionBuffer(
  clientZkGroupCipher: ReturnType<typeof getClientZkGroupCipher>,
  description: string
): Uint8Array<ArrayBuffer> {
  const descriptionBlobPlaintext = Proto.GroupAttributeBlob.encode({
    content: {
      descriptionText: description,
    },
  });
  const result = encryptGroupBlob(clientZkGroupCipher, descriptionBlobPlaintext);
  if (result.byteLength > GROUP_DESC_MAX_ENCRYPTED_BYTES) {
    throw new Error(
      'buildGroupDescriptionBuffer: encrypted group title is too long'
    );
  }
  return result;
}

function buildModifyGroupSettingsActions({
  action,
  conversation,
  value,
}: Readonly<{
  action: WebGroupSettingsModifyAction;
  conversation: WebConversation;
  value: boolean | number | string;
}>): Proto.GroupChange.Actions.Params {
  const { secretParams } = conversation;
  const revision = (conversation.revision ?? 0) + 1;

  if (action === 'access-control-add-from-invite-link') {
    return toGroupActionsParams({
      version: revision,
      modifyAddFromInviteLinkAccess: {
        addFromInviteLinkAccess: Number(value),
      },
    });
  }
  if (action === 'access-control-attributes') {
    return toGroupActionsParams({
      version: revision,
      modifyAttributesAccess: {
        attributesAccess: Number(value),
      },
    });
  }
  if (action === 'access-control-members') {
    return toGroupActionsParams({
      version: revision,
      modifyMemberAccess: {
        membersAccess: Number(value),
      },
    });
  }
  if (action === 'announcements-only') {
    return toGroupActionsParams({
      version: revision,
      modifyAnnouncementsOnly: {
        announcementsOnly: Boolean(value),
      },
    });
  }

  if (!secretParams) {
    throw new Error('buildModifyGroupSettingsActions: group was missing secretParams');
  }

  if (action === 'access-control-member-label') {
    const modifyMemberLabels: Array<Proto.GroupChange.Actions.ModifyMemberLabelAction.Params> =
      [];
    const previousValue = conversation.accessControl?.memberLabel;
    if (
      previousValue !== Proto.AccessControl.AccessRequired.ADMINISTRATOR &&
      Number(value) === Proto.AccessControl.AccessRequired.ADMINISTRATOR
    ) {
      const clientZkGroupCipher = getClientZkGroupCipher(secretParams);
      for (const member of conversation.membersV2 ?? []) {
        if (member.role === Proto.Member.Role.ADMINISTRATOR) {
          continue;
        }
        if (!member.labelString && !member.labelEmoji) {
          continue;
        }
        modifyMemberLabels.push({
          userId: encryptServiceId(clientZkGroupCipher, member.aci),
          labelEmoji: null,
          labelString: null,
        });
      }
    }
    return toGroupActionsParams({
      version: revision,
      modifyMemberLabelAccess: {
        memberLabelAccess: Number(value),
      },
      modifyMemberLabels: modifyMemberLabels.length ? modifyMemberLabels : null,
    });
  }

  const clientZkGroupCipher = getClientZkGroupCipher(secretParams);
  if (action === 'title') {
    return toGroupActionsParams({
      version: revision,
      modifyTitle: {
        title: buildGroupTitleBuffer(clientZkGroupCipher, String(value)),
      },
    });
  }
  if (action === 'description') {
    return toGroupActionsParams({
      version: revision,
      modifyDescription: {
        description: buildGroupDescriptionBuffer(clientZkGroupCipher, String(value)),
      },
    });
  }

  throw new Error(`buildModifyGroupSettingsActions: unsupported action ${action}`);
}

async function patchGroupChangeBytes({
  actions,
  allowInsecureTls,
  credentials,
  storageUrl,
}: Readonly<{
  actions: Proto.GroupChange.Actions.Params;
  allowInsecureTls?: boolean;
  credentials: GroupCredentials;
  storageUrl: string;
}>): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL('/v2/groups', storageUrl);
  const data = Buffer.from(Proto.GroupChange.Actions.encode(actions));
  const headers = {
    authorization: `Basic ${generateGroupAuth(credentials)}`,
    'content-type': 'application/x-protobuf',
  };

  try {
    const response = await fetch(url, {
      body: data,
      headers,
      method: 'PATCH',
    });
    const bytes = new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>;
    if (!response.ok) {
      throw new GroupHttpStatusError(
        `/v2/groups PATCH failed with status ${response.status}: ${Buffer.from(bytes).toString('utf8')}`,
        response.status
      );
    }
    return bytes;
  } catch (error) {
    if (!allowInsecureTls) {
      throw error;
    }
    return new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          headers: {
            ...headers,
            'content-length': String(data.byteLength),
          },
          method: 'PATCH',
          rejectUnauthorized: false,
        },
        response => {
          const chunks = new Array<Buffer>();
          response.on('data', chunk => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            const bytes = Buffer.concat(chunks);
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(
                new GroupHttpStatusError(
                  `/v2/groups PATCH failed with status ${statusCode}: ${bytes.toString('utf8')}`,
                  statusCode
                )
              );
              return;
            }
            resolve(new Uint8Array(bytes) as Uint8Array<ArrayBuffer>);
          });
        }
      );
      request.on('error', reject);
      request.end(data);
    });
  }
}

export async function modifyGroupMember({
  action,
  allowInsecureTls,
  chat,
  conversation,
  linkedPayload,
  storageUrl = productionConfig.storageUrl,
  targetConversation,
  targetServiceId,
}: Readonly<{
  action: WebGroupMemberModifyAction;
  allowInsecureTls?: boolean;
  chat: AuthenticatedChatConnection;
  conversation: WebConversation;
  linkedPayload: LinkedPayload;
  storageUrl?: string;
  targetConversation?: WebConversation;
  targetServiceId: ServiceIdString;
}>): Promise<WebGroupMemberModifyResult> {
  if (
    (conversation.type !== 'group' && conversation.conversationType !== 'group') ||
    !conversation.publicParams ||
    !conversation.secretParams
  ) {
    throw new Error('modifyGroupMember: conversation is not a GroupV2 conversation');
  }
  const ourAci = linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
  if (!ourAci) {
    throw new Error('modifyGroupMember: missing linked ACI');
  }

  const credentials = await getGroupCredentials({
    chat,
    linkedPayload,
    publicParams: conversation.publicParams,
    secretParams: conversation.secretParams,
  });
  const profileKeyCredentialBase64 =
    action === 'add'
      ? await fetchProfileKeyCredential({
          chat,
          targetConversation:
            targetConversation ??
            (() => {
              throw new Error('modifyGroupMember: add action is missing targetConversation');
            })(),
        })
      : undefined;

  let workingConversation = conversation;
  let lastConflict: unknown;
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const actions = buildModifyMemberActions({
      action,
      conversation: workingConversation,
      profileKeyCredentialBase64,
      ourAci,
      targetConversation,
      targetServiceId,
    });

    try {
      // eslint-disable-next-line no-await-in-loop
      const bytes = await patchGroupChangeBytes({
        actions,
        allowInsecureTls,
        credentials,
        storageUrl,
      });
      const response = Proto.GroupChangeResponse.decode(bytes);
      if (!response.groupChange) {
        throw new Error('modifyGroupMember: missing groupChange');
      }

      return {
        groupChangeBase64: Bytes.toBase64(
          Proto.GroupChange.encode(response.groupChange)
        ),
        revision: actions.version ?? workingConversation.revision ?? 0,
      };
    } catch (error) {
      const shouldRefreshGroupState =
        error instanceof GroupHttpStatusError &&
        (error.code === 409 ||
          (error.code === 400 &&
            error.message.includes(
              'group cannot contain the same user in multiple membership lists'
            )));

      if (!shouldRefreshGroupState) {
        throw error;
      }

      lastConflict = error;
      if (attempt + 1 >= maxAttempts) {
        break;
      }

      // eslint-disable-next-line no-await-in-loop
      workingConversation = await fetchLatestGroupStateConversation({
        allowInsecureTls,
        chat,
        conversation: workingConversation,
        linkedPayload,
        storageUrl,
      });
    }
  }

  throw lastConflict;
}

async function uploadGroupActionsWithRetry({
  allowInsecureTls,
  chat,
  conversation,
  createActions,
  linkedPayload,
  storageUrl,
}: Readonly<{
  allowInsecureTls?: boolean;
  chat: AuthenticatedChatConnection;
  conversation: WebConversation;
  createActions: (conversation: WebConversation) => Proto.GroupChange.Actions.Params;
  linkedPayload: LinkedPayload;
  storageUrl: string;
}>): Promise<WebGroupSettingsModifyResult> {
  if (
    (conversation.type !== 'group' && conversation.conversationType !== 'group') ||
    !conversation.publicParams ||
    !conversation.secretParams
  ) {
    throw new Error('uploadGroupActionsWithRetry: conversation is not a GroupV2 conversation');
  }

  const credentials = await getGroupCredentials({
    chat,
    linkedPayload,
    publicParams: conversation.publicParams,
    secretParams: conversation.secretParams,
  });

  let workingConversation = conversation;
  let lastConflict: unknown;
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const actions = createActions(workingConversation);
    try {
      // eslint-disable-next-line no-await-in-loop
      const bytes = await patchGroupChangeBytes({
        actions,
        allowInsecureTls,
        credentials,
        storageUrl,
      });
      const response = Proto.GroupChangeResponse.decode(bytes);
      if (!response.groupChange) {
        throw new Error('uploadGroupActionsWithRetry: missing groupChange');
      }

      return {
        groupChangeBase64: Bytes.toBase64(
          Proto.GroupChange.encode(response.groupChange)
        ),
        revision: actions.version ?? workingConversation.revision ?? 0,
      };
    } catch (error) {
      if (!(error instanceof GroupHttpStatusError) || error.code !== 409) {
        throw error;
      }

      lastConflict = error;
      if (attempt + 1 >= maxAttempts) {
        break;
      }

      // eslint-disable-next-line no-await-in-loop
      workingConversation = await fetchLatestGroupStateConversation({
        allowInsecureTls,
        chat,
        conversation: workingConversation,
        linkedPayload,
        storageUrl,
      });
    }
  }

  throw lastConflict;
}

export async function modifyGroupSettings({
  action,
  allowInsecureTls,
  chat,
  conversation,
  linkedPayload,
  storageUrl = productionConfig.storageUrl,
  value,
}: Readonly<{
  action: WebGroupSettingsModifyAction;
  allowInsecureTls?: boolean;
  chat: AuthenticatedChatConnection;
  conversation: WebConversation;
  linkedPayload: LinkedPayload;
  storageUrl?: string;
  value: boolean | number | string;
}>): Promise<WebGroupSettingsModifyResult> {
  return uploadGroupActionsWithRetry({
    allowInsecureTls,
    chat,
    conversation,
    createActions: nextConversation =>
      buildModifyGroupSettingsActions({
        action,
        conversation: nextConversation,
        value,
      }),
    linkedPayload,
    storageUrl,
  });
}

function decryptGroupTitle(
  title: Uint8Array<ArrayBuffer> | undefined,
  secretParams: string
): string | undefined {
  if (!title || title.byteLength === 0) {
    return undefined;
  }
  const clientZkGroupCipher = getClientZkGroupCipher(secretParams);
  const blob = Proto.GroupAttributeBlob.decode(
    decryptGroupBlob(clientZkGroupCipher, title)
  );
  return blob.content?.title?.trim() || undefined;
}

function decryptMembers(
  members: ReadonlyArray<Proto.Member>,
  secretParams: string
): ReadonlyArray<NonNullable<WebConversation['membersV2']>[number]> {
  const clientZkGroupCipher = getClientZkGroupCipher(secretParams);
  return members
    .map(member => {
      if (!member.userId || member.userId.byteLength === 0) {
        return undefined;
      }
      const aci = decryptAci(clientZkGroupCipher, member.userId);
      return {
        aci,
        joinedAtVersion: member.joinedAtVersion ?? 0,
        role: member.role ?? Proto.Member.Role.DEFAULT,
      };
    })
    .filter((member): member is NonNullable<typeof member> => member != null);
}

function decryptPendingMembers(
  members: ReadonlyArray<Proto.MemberPendingProfileKey>,
  secretParams: string
): ReadonlyArray<NonNullable<WebConversation['pendingMembersV2']>[number]> {
  const clientZkGroupCipher = getClientZkGroupCipher(secretParams);
  return members
    .map(member => {
      if (!member.member?.userId || !member.addedByUserId) {
        return undefined;
      }
      const serviceId = decryptServiceId(clientZkGroupCipher, member.member.userId);
      const addedByUserId = decryptAci(clientZkGroupCipher, member.addedByUserId);
      return {
        addedByUserId,
        role: member.member.role ?? Proto.Member.Role.DEFAULT,
        serviceId,
        timestamp: Number(member.timestamp ?? 0n),
      };
    })
    .filter((member): member is NonNullable<typeof member> => member != null);
}

function decryptBannedMembers(
  members: ReadonlyArray<Proto.MemberBanned>,
  secretParams: string
): ReadonlyArray<NonNullable<WebConversation['bannedMembersV2']>[number]> {
  const clientZkGroupCipher = getClientZkGroupCipher(secretParams);
  return members
    .map(member => {
      if (!member.userId || member.userId.byteLength === 0) {
        return undefined;
      }
      const serviceId = decryptServiceId(clientZkGroupCipher, member.userId);
      return {
        serviceId,
        timestamp: Number(member.timestamp ?? 0n),
      };
    })
    .filter((member): member is NonNullable<typeof member> => member != null);
}

export async function fetchLatestGroupStateConversation({
  allowInsecureTls,
  chat,
  conversation,
  groupCredentialResponse,
  linkedPayload,
  storageUrl = productionConfig.storageUrl,
}: Readonly<{
  allowInsecureTls?: boolean;
  chat: AuthenticatedChatConnection;
  conversation: WebConversation;
  groupCredentialResponse?: GroupCredentialsResponse;
  linkedPayload: LinkedPayload;
  storageUrl?: string;
}>): Promise<WebConversation> {
  if (
    (conversation.type !== 'group' && conversation.conversationType !== 'group') ||
    !conversation.publicParams ||
    !conversation.secretParams
  ) {
    return conversation;
  }

  const credentials = groupCredentialResponse
    ? getGroupCredentialsFromResponse({
        response: groupCredentialResponse,
        linkedPayload,
        publicParams: conversation.publicParams,
        secretParams: conversation.secretParams,
      })
    : await getGroupCredentials({
        chat,
        linkedPayload,
        publicParams: conversation.publicParams,
        secretParams: conversation.secretParams,
      });
  const bytes = await fetchGroupBytes({
    allowInsecureTls,
    credentials,
    storageUrl,
  });
  const response = Proto.GroupResponse.decode(bytes);
  if (!response.group) {
    return conversation;
  }
  const title = decryptGroupTitle(response.group.title, conversation.secretParams);
  const membersV2 = decryptMembers(response.group.members ?? [], conversation.secretParams);
  const pendingMembersV2 = decryptPendingMembers(
    response.group.membersPendingProfileKey ?? [],
    conversation.secretParams
  );
  const bannedMembersV2 = decryptBannedMembers(
    response.group.membersBanned ?? [],
    conversation.secretParams
  );
  const ourAci = linkedPayload.credentials?.aci ?? linkedPayload.account.aci;
  const left = ourAci ? !membersV2.some(member => member.aci === ourAci) : conversation.left;

  return {
    ...conversation,
    avatarUrl: response.group.avatarUrl || conversation.avatarUrl,
    bannedMembersV2,
    hasAvatar: Boolean(response.group.avatarUrl) || conversation.hasAvatar,
    left,
    membersV2,
    pendingMembersV2,
    remoteAvatarUrl: response.group.avatarUrl || conversation.remoteAvatarUrl,
    revision: response.group.version ?? conversation.revision,
    searchableTitle: title ?? conversation.searchableTitle,
    title: title ?? conversation.title,
    titleNoDefault: title ?? conversation.titleNoDefault,
  };
}

export async function enrichGroupConversations({
  allowInsecureTls,
  chat,
  conversations,
  linkedPayload,
  storageUrl,
}: Readonly<{
  allowInsecureTls?: boolean;
  chat: AuthenticatedChatConnection;
  conversations: ReadonlyArray<WebConversation>;
  linkedPayload: LinkedPayload;
  storageUrl: string;
}>): Promise<Array<WebConversation>> {
  const now = Date.now();
  const groupsToFetch = conversations.filter(conversation => {
    if (conversation.type !== 'group' && conversation.conversationType !== 'group') {
      return false;
    }
    const forbiddenUntil = groupStateForbiddenUntilById.get(
      conversation.groupId ?? conversation.id
    );
    return forbiddenUntil == null || forbiddenUntil <= now;
  });

  const groupCredentialResponse =
    groupsToFetch.length > 0 ? await fetchGroupCredentialResponse(chat) : undefined;

  let forbiddenCount = 0;

  const result = await Promise.all(
    conversations.map(async conversation => {
      if (
        conversation.type !== 'group' &&
        conversation.conversationType !== 'group'
      ) {
        return conversation;
      }

      const conversationId = conversation.groupId ?? conversation.id;
      const forbiddenUntil = groupStateForbiddenUntilById.get(conversationId);
      if (forbiddenUntil != null && forbiddenUntil > now) {
        return conversation;
      }

      try {
        return await fetchLatestGroupStateConversation({
          allowInsecureTls,
          chat,
          conversation,
          groupCredentialResponse,
          linkedPayload,
          storageUrl,
        });
      } catch (error) {
        if (error instanceof GroupHttpStatusError && error.code === 403) {
          forbiddenCount += 1;
          groupStateForbiddenUntilById.set(
            conversationId,
            Date.now() + GROUP_STATE_FORBIDDEN_SKIP_MS
          );
          return conversation;
        }
        console.warn('enrichGroupConversations: failed to fetch group state', error);
        return conversation;
      }
    })
  );

  if (forbiddenCount > 0) {
    console.info('enrichGroupConversations: group states unavailable, skipped', {
      count: forbiddenCount,
      skipMs: GROUP_STATE_FORBIDDEN_SKIP_MS,
    });
  }

  return result;
}
