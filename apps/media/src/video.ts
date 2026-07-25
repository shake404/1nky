import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import { HttpError } from './errors.js';

/**
 * Server-side video transcode (NIP-71 short-form clips).
 *
 * Opsec is the whole point: every clip is transcoded through ffmpeg with ALL
 * metadata stripped (`-map_metadata -1` drops GPS, device serials, timestamps,
 * encoder tags — everything that is not pixels + audio). The original bytes
 * are written to a temp file only for the duration of the transcode and are
 * deleted in a `finally` before this function returns. Nothing the writer
 * uploaded is ever persisted; only the transcoded mp4 and a poster still are.
 *
 * ffmpeg is spawned with an argv array and `shell: false`, so a hostile
 * filename or tag value can never reach a shell.
 */

/** Hard cap on input duration; the transcode `-t` enforces it. */
export const VIDEO_MAX_DURATION_SEC = 60;
/** Output is scaled to fit within this box, preserving aspect ratio. */
export const VIDEO_MAX_WIDTH = 1280;
export const VIDEO_MAX_HEIGHT = 720;
/** WebP quality of the extracted poster still. */
export const VIDEO_POSTER_QUALITY = 80;

export interface VideoTranscodeOptions {
  /** Max input duration in seconds; longer input is truncated. */
  readonly maxDurationSec: number;
  /** Output is scaled to fit within maxWidth x maxHeight. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** WebP quality (0-100) for the poster still. */
  readonly posterQuality: number;
  /** MIME type of the input bytes — used only to hint the temp file extension. */
  readonly inputMime?: string;
}

export interface VideoTranscodeResult {
  /** Transcoded H.264 mp4 bytes. */
  readonly video: Buffer;
  /** Poster still as webp bytes (metadata stripped). */
  readonly poster: Buffer;
  /** Output duration in whole seconds. */
  readonly duration: number;
  /** Output width in pixels. */
  readonly width: number;
  /** Output height in pixels. */
  readonly height: number;
}

export type VideoTranscoder = (
  input: Buffer,
  options: VideoTranscodeOptions,
) => Promise<VideoTranscodeResult>;

interface ProcResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Spawns `cmd args` with no shell, capturing stdout as a Buffer and stderr as
 * text. Resolves on close (with the exit code); rejects on a spawn failure
 * such as the binary being missing (ENOENT).
 */
function run(cmd: string, args: readonly string[]): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr }),
    );
  });
}

function extForMime(mime: string | undefined): string {
  switch (mime) {
    case 'video/quicktime':
      return '.mov';
    case 'video/webm':
      return '.webm';
    default:
      return '.mp4';
  }
}

/**
 * Whether the input has an audio stream. A probe failure is treated as "no
 * audio": the transcode itself is the source of truth for "is this decodable"
 * (it throws 415), so a flaky probe must not abort a valid silent clip.
 */
async function inputHasAudio(inputPath: string): Promise<boolean> {
  let res: ProcResult;
  try {
    res = await run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'json',
      inputPath,
    ]);
  } catch {
    return false;
  }
  if (res.code !== 0) return false;
  try {
    const parsed = JSON.parse(res.stdout.toString('utf8')) as { streams?: unknown[] };
    return (parsed.streams ?? []).some(
      (s) => (s as Record<string, unknown>)?.codec_type === 'audio',
    );
  } catch {
    return false;
  }
}

/** Probes the transcoded output for duration and pixel dimensions. */
async function probeOutput(
  outputPath: string,
): Promise<{ duration: number; width: number; height: number }> {
  const res = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    outputPath,
  ]);
  if (res.code !== 0) {
    throw new HttpError(415, 'transcoded video could not be probed');
  }

  let parsed: { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
  try {
    parsed = JSON.parse(res.stdout.toString('utf8'));
  } catch {
    throw new HttpError(415, 'transcoded video could not be probed');
  }

  const stream = parsed.streams?.[0];
  const width = stream?.width;
  const height = stream?.height;
  if (typeof width !== 'number' || typeof height !== 'number') {
    throw new HttpError(415, 'transcoded video has no picture');
  }

  const durationRaw = parsed.format?.duration;
  const durationFloat = typeof durationRaw === 'string' ? Number.parseFloat(durationRaw) : NaN;
  if (!Number.isFinite(durationFloat) || durationFloat <= 0) {
    throw new HttpError(415, 'transcoded video has no duration');
  }

  return {
    duration: Math.max(1, Math.floor(durationFloat)),
    width,
    height,
  };
}

/**
 * Transcodes `input` to H.264 720p mp4 + a webp poster still.
 *
 * Temp files live in a private mkdtemp directory and are removed in a
 * `finally` — the original bytes never survive this call.
 */
export const transcodeVideo: VideoTranscoder = async (input, options) => {
  if (input.length === 0) {
    throw new HttpError(415, 'video upload is empty');
  }

  const dir = await mkdtemp(join(tmpdir(), '1nky-video-'));
  const inputPath = join(dir, `input${extForMime(options.inputMime)}`);
  const outputPath = join(dir, 'output.mp4');

  try {
    await writeFile(inputPath, input);

    const hasAudio = await inputHasAudio(inputPath);

    // `-map_metadata -1` strips EVERY metadata field (GPS, device, encoder,
    // timestamps). `-t` truncates to the cap. The scale filter fits the
    // picture inside maxWidth x maxHeight without enlarging. yuv420p is the
    // widest-compatible pixel format. +faststart moves the moov atom to the
    // front so the browser can start playing before the whole file downloads.
    const args: string[] = [
      '-y',
      '-i',
      inputPath,
      '-map_metadata',
      '-1',
      '-t',
      String(options.maxDurationSec),
      '-vf',
      `scale='min(${options.maxWidth},iw)':'min(${options.maxHeight},ih)':force_original_aspect_ratio=decrease`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
    ];
    if (hasAudio) {
      args.push('-c:a', 'aac', '-b:a', '96k');
    } else {
      // No audio stream: omit the audio maps entirely rather than fail.
      args.push('-an');
    }
    args.push('-movflags', '+faststart', outputPath);

    let transcode: ProcResult;
    try {
      transcode = await run('ffmpeg', args);
    } catch {
      // Spawn failure (e.g. ffmpeg not installed) is a server fault, not a
      // bad upload. Let it surface as a 500.
      throw new Error('ffmpeg could not be started');
    }
    if (transcode.code !== 0) {
      // Non-zero exit = ffmpeg could not parse/decode the input.
      throw new HttpError(415, 'video could not be decoded');
    }

    const video = await readFile(outputPath);

    // Poster: a single frame at t=0, piped out of ffmpeg and re-encoded
    // through sharp as webp. sharp writes no metadata unless asked, so the
    // poster carries no EXIF/ICC/XMP either.
    let frame: Buffer;
    try {
      const poster = await run('ffmpeg', [
        '-v',
        'error',
        '-ss',
        '0',
        '-i',
        outputPath,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ]);
      if (poster.code !== 0 || poster.stdout.length === 0) {
        throw new HttpError(415, 'video poster could not be extracted');
      }
      frame = poster.stdout;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(415, 'video poster could not be extracted');
    }

    const posterBytes = await sharp(frame)
      .rotate()
      .webp({ quality: options.posterQuality })
      .toBuffer();

    const probed = await probeOutput(outputPath);

    return {
      video,
      poster: posterBytes,
      duration: probed.duration,
      width: probed.width,
      height: probed.height,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};
