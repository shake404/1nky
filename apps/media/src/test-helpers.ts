import { Readable } from 'node:stream';

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  KINDS,
  type SignedEvent,
} from '@1nky/protocol';

import type { MediaConfig } from './config.js';
import type { BlobBody, BlobHead, BlobStorage, PutBlobInput } from './storage.js';
import type { VideoTranscoder } from './video.js';

/** In-memory `BlobStorage` double — injected instead of mocking the AWS SDK. */
export class MemoryBlobStorage implements BlobStorage {
  readonly objects = new Map<string, PutBlobInput>();
  /** Set to a message to make every operation throw (failure-path tests). */
  failWith: string | null = null;

  #guard(): void {
    if (this.failWith !== null) throw new Error(this.failWith);
  }

  async put(input: PutBlobInput): Promise<void> {
    this.#guard();
    this.objects.set(input.key, input);
  }

  async head(key: string): Promise<BlobHead | null> {
    this.#guard();
    const obj = this.objects.get(key);
    if (obj === undefined) return null;
    return { size: obj.body.length, contentType: obj.contentType, metadata: { ...obj.metadata } };
  }

  async get(key: string): Promise<BlobBody | null> {
    this.#guard();
    const obj = this.objects.get(key);
    if (obj === undefined) return null;
    return {
      body: Readable.from([obj.body]),
      size: obj.body.length,
      contentType: obj.contentType,
      metadata: { ...obj.metadata },
    };
  }

  async delete(key: string): Promise<void> {
    this.#guard();
    this.objects.delete(key);
  }
}

export const TEST_CONFIG: MediaConfig = {
  port: 0,
  maxUploadBytes: 5 * 1024 * 1024,
  maxVideoBytes: 50 * 1024 * 1024,
  bucket: 'test-bucket',
  publicBase: 'https://media.test',
  maxDimension: 4096,
  webpQuality: 82,
};

export interface TestKeypair {
  readonly secretKey: Uint8Array;
  readonly pubkey: string;
}

export function makeKeypair(): TestKeypair {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export interface AuthEventOptions {
  readonly keys: TestKeypair;
  readonly verb: 'upload' | 'delete' | 'get' | 'list' | 'media';
  readonly hashes?: readonly string[];
  readonly expiration?: number;
  readonly createdAt?: number;
  readonly kind?: number;
}

/** Signs a Blossom BUD-11 authorization event. */
export function signAuthEvent(options: AuthEventOptions): SignedEvent {
  const nowSec = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ['t', options.verb],
    ['expiration', String(options.expiration ?? nowSec + 300)],
  ];
  for (const h of options.hashes ?? []) tags.push(['x', h]);

  return finalizeEvent(
    {
      kind: options.kind ?? KINDS.BLOSSOM_AUTH,
      created_at: options.createdAt ?? nowSec - 5,
      tags,
      content: `${options.verb} blob`,
    },
    options.keys.secretKey,
  );
}

/** Encodes a signed event into an `Authorization: Nostr …` header value. */
export function authHeader(event: SignedEvent): string {
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

import type { VideoTranscodeResult } from './video.js';

/**
 * A deterministic in-memory transcoder for tests that exercise the video
 * upload path without ffmpeg. Returns fixed mp4/poster buffers so the
 * descriptor shape and storage routing can be asserted without a real encode.
 */
export function fakeTranscoder(overrides: Partial<VideoTranscodeResult> = {}): VideoTranscoder {
  return async () => ({
    video: Buffer.from('fake-transcoded-mp4'),
    poster: Buffer.from('fake-poster-webp'),
    duration: 12,
    width: 1280,
    height: 720,
    ...overrides,
  });
}
