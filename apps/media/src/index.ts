/**
 * `@1nky/media` — Blossom-compatible (BUD-01/BUD-02) media service.
 *
 * Blobs are content-addressed by the SHA-256 of the bytes this service
 * produces after a mandatory sharp re-encode, and served from an S3-compatible
 * bucket (Cloudflare R2 in production) behind an immutable cache header.
 *
 * There is no request logging here, by design. See CLAUDE.md hard rule #1.
 */
import { pathToFileURL } from 'node:url';

import { createApp } from './app.js';
import { loadConfig, loadS3Config } from './config.js';
import { createS3Client, S3BlobStorage } from './storage.js';

export { createApp } from './app.js';
export type { AppDeps, BlobDescriptor, VideoDescriptor } from './app.js';
export { loadConfig, loadS3Config } from './config.js';
export type { Env, MediaConfig, S3Config } from './config.js';
export { HttpError } from './errors.js';
export { createS3Client, S3BlobStorage } from './storage.js';
export type { BlobBody, BlobHead, BlobStorage, PutBlobInput } from './storage.js';
export { verifyBlossomAuth } from './auth.js';
export { reencodeToWebp } from './image.js';
export { transcodeVideo } from './video.js';
export type { VideoTranscoder, VideoTranscodeOptions, VideoTranscodeResult } from './video.js';

export function start(): void {
  const config = loadConfig();
  const storage = new S3BlobStorage(createS3Client(loadS3Config()), config.bucket);
  const app = createApp({ storage, config });

  app.listen(config.port, () => {
    process.stdout.write(`media listening on :${config.port}\n`);
  });
}

// Only boot when executed directly, so importing the package in tests or in a
// combined process does not open a socket.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  start();
}
