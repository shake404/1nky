import sharp from 'sharp';

import { ALLOWED_IMAGE_FORMATS } from './config.js';
import { HttpError } from './errors.js';

export interface ReencodeOptions {
  /** Longest edge in pixels; larger images are shrunk to fit. */
  readonly maxDimension: number;
  /** WebP quality (0-100). */
  readonly quality: number;
}

export interface ReencodeResult {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Defense-in-depth re-encode.
 *
 * The client is expected to have stripped EXIF already (canvas re-encode), but
 * we never trust that. Decoding and re-encoding through sharp guarantees that
 * whatever we persist contains only pixels:
 *
 *   - `rotate()` with no argument bakes the EXIF orientation into the pixels,
 *     so dropping the tag does not flip the image.
 *   - sharp writes **no** metadata unless `withMetadata()`/`withExif()` is
 *     called. We deliberately call neither, so EXIF (GPS, camera serials,
 *     timestamps), ICC, IPTC and XMP are all dropped.
 *   - Anything sharp cannot decode is rejected outright.
 *
 * The original bytes are never persisted.
 */
export async function reencodeToWebp(
  input: Buffer,
  options: ReencodeOptions,
): Promise<ReencodeResult> {
  let pipeline: sharp.Sharp;
  let metadata: sharp.Metadata;

  try {
    pipeline = sharp(input, { failOn: 'error' });
    metadata = await pipeline.metadata();
  } catch {
    throw new HttpError(415, 'blob is not a decodable image');
  }

  if (typeof metadata.format !== 'string' || !ALLOWED_IMAGE_FORMATS.has(metadata.format)) {
    throw new HttpError(415, 'blob is not a supported image format');
  }

  let output: { data: Buffer; info: sharp.OutputInfo };
  try {
    output = await pipeline
      .rotate()
      .resize({
        width: options.maxDimension,
        height: options.maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: options.quality })
      // NOTE: no withMetadata()/withExif() — stripping is the whole point.
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new HttpError(415, 'blob could not be re-encoded as an image');
  }

  return { data: output.data, width: output.info.width, height: output.info.height };
}
