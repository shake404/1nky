import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import type { S3Config } from './config.js';

/**
 * The storage surface the HTTP layer depends on.
 *
 * Everything the routes need is expressed here so tests can inject an
 * in-memory double instead of mocking the AWS SDK.
 */
export interface BlobStorage {
  put(input: PutBlobInput): Promise<void>;
  head(key: string): Promise<BlobHead | null>;
  get(key: string): Promise<BlobBody | null>;
  delete(key: string): Promise<void>;
}

export interface PutBlobInput {
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
  readonly cacheControl: string;
  /** Free-form S3 user metadata; stored as `x-amz-meta-*`. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface BlobHead {
  readonly size: number;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface BlobBody extends BlobHead {
  readonly body: Readable;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
}

function normalizeMetadata(meta: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta ?? {})) out[k.toLowerCase()] = v;
  return out;
}

/** Builds the S3 client for Cloudflare R2 (or any S3-compatible endpoint). */
export function createS3Client(cfg: S3Config): S3Client {
  const clientConfig: S3ClientConfig = {
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  };
  return new S3Client(clientConfig);
}

/** `BlobStorage` backed by an S3-compatible bucket. */
export class S3BlobStorage implements BlobStorage {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  async put(input: PutBlobInput): Promise<void> {
    const upload = new Upload({
      client: this.#client,
      params: {
        Bucket: this.#bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        CacheControl: input.cacheControl,
        Metadata: { ...input.metadata },
      },
    });
    await upload.done();
  }

  async head(key: string): Promise<BlobHead | null> {
    try {
      const res = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? 'application/octet-stream',
        metadata: normalizeMetadata(res.Metadata),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async get(key: string): Promise<BlobBody | null> {
    try {
      const res = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      if (!res.Body) return null;
      return {
        body: res.Body as Readable,
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? 'application/octet-stream',
        metadata: normalizeMetadata(res.Metadata),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}
