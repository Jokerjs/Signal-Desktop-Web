// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  APPLICATION_OCTET_STREAM,
  IMAGE_BMP,
  IMAGE_GIF,
  IMAGE_JPEG,
  IMAGE_PNG,
  IMAGE_WEBP,
  VIDEO_MP4,
  stringToMIMEType,
} from '../types/MIME.std.ts';
import {
  isImageTypeSupported,
  isVideoTypeSupported,
} from '../util/GoogleChrome.std.ts';

const EXTENSION_TO_WEB_ATTACHMENT_CONTENT_TYPE = new Map<string, string>([
  ['bmp', IMAGE_BMP],
  ['gif', IMAGE_GIF],
  ['jpeg', IMAGE_JPEG],
  ['jpg', IMAGE_JPEG],
  ['mp4', VIDEO_MP4],
  ['ogv', 'video/ogg'],
  ['png', IMAGE_PNG],
  ['webm', 'video/webm'],
  ['webp', IMAGE_WEBP],
]);

function getFileExtension(fileName: string | undefined): string | undefined {
  if (!fileName) {
    return undefined;
  }

  const lastPeriod = fileName.lastIndexOf('.');
  if (lastPeriod < 0) {
    return undefined;
  }

  const extension = fileName.slice(lastPeriod + 1).toLowerCase();
  return extension.length > 0 ? extension : undefined;
}

function getSupportedVisualContentType(
  contentType: string | undefined
): string | undefined {
  if (!contentType || contentType === APPLICATION_OCTET_STREAM) {
    return undefined;
  }

  const mimeType = stringToMIMEType(contentType);
  if (isImageTypeSupported(mimeType) || isVideoTypeSupported(mimeType)) {
    return contentType;
  }

  return undefined;
}

export function getWebAttachmentContentTypeFromParts({
  contentType,
  fileName,
}: Readonly<{
  contentType?: string;
  fileName?: string;
}>): string {
  const supportedContentType = getSupportedVisualContentType(contentType);
  if (supportedContentType) {
    return supportedContentType;
  }

  const extension = getFileExtension(fileName);
  if (!extension) {
    return contentType || APPLICATION_OCTET_STREAM;
  }

  const extensionContentType =
    EXTENSION_TO_WEB_ATTACHMENT_CONTENT_TYPE.get(extension);
  const supportedExtensionContentType = getSupportedVisualContentType(
    extensionContentType
  );
  if (supportedExtensionContentType) {
    return supportedExtensionContentType;
  }

  return contentType || APPLICATION_OCTET_STREAM;
}

export function getWebAttachmentContentType(file: File): string {
  return getWebAttachmentContentTypeFromParts({
    contentType: file.type,
    fileName: file.name,
  });
}
