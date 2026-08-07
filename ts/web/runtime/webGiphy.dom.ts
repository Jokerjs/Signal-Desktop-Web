// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

import { fetchInSegments } from '../../components/fun/data/segments.std.ts';
import type { PaginatedGifResults } from '../../components/fun/panels/FunPanelGifs.dom.tsx';
import type { fetchBytesViaProxy } from '../../textsecure/WebAPI.preload.ts';
import {
  getGifCdnUrlOrigin,
  isGifCdnUrlOriginAllowed,
  isGiphyCdnUrlOrigin,
} from '../../util/gifCdnUrls.dom.ts';
import { safeParseInteger } from '../../util/numbers.std.ts';
import { parseUnknown } from '../../util/schemas.std.ts';
import { getRenderApiBaseUrl } from '../renderConfig.dom.ts';

const BASE_API_URL = 'https://api.giphy.com';
const API_KEY = 'ApVVlSyeBfNKK6UWtnBRq9CvAkWsxayB';

const CONTENT_RATING = 'pg-13';
const CONTENT_BUNDLE = 'messaging_non_clips';

const GIF_FIELDS = [
  'id',
  'title',
  'alt_text',
  'images.original.width',
  'images.original.height',
  'images.original.mp4',
  'images.fixed_width.width',
  'images.fixed_width.height',
  'images.fixed_width.mp4',
].join(',');

const GiphyPaginationSchema = z.object({
  offset: z.number().int(),
  total_count: z.number().int(),
  count: z.number().int(),
});

const StringInteger = z.preprocess(input => {
  if (typeof input === 'string') {
    return safeParseInteger(input);
  }
  return input;
}, z.number().int());

const GiphyCdnUrl = z.string().refine(input => {
  const origin = getGifCdnUrlOrigin(input);
  return origin != null && isGiphyCdnUrlOrigin(origin);
});

const GiphyImagesSchema = z.object({
  original: z.object({
    width: StringInteger,
    height: StringInteger,
    mp4: GiphyCdnUrl,
  }),
  fixed_width: z.object({
    width: StringInteger,
    height: StringInteger,
    mp4: GiphyCdnUrl,
  }),
});

const GiphyGifSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  alt_text: z.string(),
  images: GiphyImagesSchema,
});

const GiphyResultsSchema = z.object({
  pagination: GiphyPaginationSchema,
  data: z.array(GiphyGifSchema),
});

type GiphyPagination = z.infer<typeof GiphyPaginationSchema>;
type GiphyResults = z.infer<typeof GiphyResultsSchema>;

function getNextOffset(pagination: GiphyPagination): number | null {
  const end = pagination.offset + pagination.count;
  if (end >= pagination.total_count) {
    return null;
  }
  return end;
}

function normalizeGiphyResults(results: GiphyResults): PaginatedGifResults {
  return {
    next: getNextOffset(results.pagination),
    gifs: results.data.map(item => {
      return {
        id: item.id,
        title: item.title,
        description: item.alt_text,
        previewMedia: {
          url: item.images.fixed_width.mp4,
          width: item.images.fixed_width.width,
          height: item.images.fixed_width.height,
        },
        attachmentMedia: {
          url: item.images.original.mp4,
          width: item.images.original.width,
          height: item.images.original.height,
        },
      };
    }),
  };
}

function getProxyUrl(targetUrl: string): URL {
  const url = new URL('proxy/giphy', getRenderApiBaseUrl());
  url.searchParams.set('url', targetUrl);
  return url;
}

async function fetchViaWebGiphyProxy(
  targetUrl: string,
  options: Readonly<{
    headers?: Readonly<Record<string, string>>;
    method: 'GET' | 'HEAD';
    signal?: AbortSignal;
  }>
): Promise<Response> {
  const response = await fetch(getProxyUrl(targetUrl), {
    method: options.method,
    headers: options.headers,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `GIPHY proxy request failed with status ${response.status}`
    );
  }
  return response;
}

async function fetchJsonViaWebGiphyProxy(
  targetUrl: string,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetchViaWebGiphyProxy(targetUrl, {
    method: 'GET',
    signal,
  });
  return response.json();
}

async function fetchBytesViaWebGiphyProxy(
  params: Parameters<typeof fetchBytesViaProxy>[0]
): ReturnType<typeof fetchBytesViaProxy> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(params.headers ?? {})) {
    if (typeof value === 'string') {
      headers.set(name, value);
    } else {
      headers.set(name, value.join(','));
    }
  }

  const response = await fetchViaWebGiphyProxy(params.url, {
    headers: Object.fromEntries(headers),
    method: params.method,
    signal: params.signal,
  });
  return {
    data: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('Content-Type'),
    response: response as never,
  };
}

export async function fetchWebGiphySearch(
  query: string,
  limit: number,
  offset: number | null,
  signal?: AbortSignal
): Promise<PaginatedGifResults> {
  const url = new URL('v1/gifs/search', BASE_API_URL);

  url.searchParams.set('api_key', API_KEY);
  url.searchParams.set('rating', CONTENT_RATING);
  url.searchParams.set('bundle', CONTENT_BUNDLE);
  url.searchParams.set('fields', GIF_FIELDS);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', `${limit}`);
  if (offset != null) {
    url.searchParams.set('offset', `${offset}`);
  }

  const results = parseUnknown(
    GiphyResultsSchema,
    await fetchJsonViaWebGiphyProxy(url.toString(), signal)
  );
  return normalizeGiphyResults(results);
}

export async function fetchWebGiphyTrending(
  limit: number,
  offset: number | null,
  signal?: AbortSignal
): Promise<PaginatedGifResults> {
  const url = new URL('v1/gifs/trending', BASE_API_URL);

  url.searchParams.set('api_key', API_KEY);
  url.searchParams.set('rating', CONTENT_RATING);
  url.searchParams.set('bundle', CONTENT_BUNDLE);
  url.searchParams.set('fields', GIF_FIELDS);
  url.searchParams.set('limit', `${limit}`);
  if (offset != null) {
    url.searchParams.set('offset', `${offset}`);
  }

  const results = parseUnknown(
    GiphyResultsSchema,
    await fetchJsonViaWebGiphyProxy(url.toString(), signal)
  );
  return normalizeGiphyResults(results);
}

export function fetchWebGiphyFile(
  giphyCdnUrl: string,
  signal?: AbortSignal
): Promise<Blob> {
  const origin = getGifCdnUrlOrigin(giphyCdnUrl);
  if (origin == null) {
    throw new Error('fetchWebGiphyFile: Cannot fetch invalid URL');
  }
  if (!isGifCdnUrlOriginAllowed(origin)) {
    throw new Error(
      `fetchWebGiphyFile: Blocked unsupported url origin: ${origin}`
    );
  }
  return fetchInSegments(giphyCdnUrl, fetchBytesViaWebGiphyProxy, signal);
}
