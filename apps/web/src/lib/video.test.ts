import { buildVideo, KINDS } from '@1nky/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildUploadAuth,
  parseVideoUploadResponse,
  probeVideo,
  videoInput,
  videoTemplate,
} from './flicks.js';

const SERVER_HASH = 'a'.repeat(64);
const POSTER_HASH = 'b'.repeat(64);
const mediaBase = 'https://media.example';

function descriptorFixture(overrides: Partial<ReturnType<typeof parseVideoUploadResponse>> = {}): ReturnType<typeof parseVideoUploadResponse> {
  return {
    url: `${mediaBase}/aaa`,
    sha256: SERVER_HASH,
    type: 'video/mp4',
    duration: 42,
    width: 1280,
    height: 720,
    poster: { sha256: POSTER_HASH, url: `${mediaBase}/bbb` },
    size: 12345,
    ...overrides,
  };
}

describe('parseVideoUploadResponse', () => {
  it('keeps the server hash, poster and duration', () => {
    const descriptor = parseVideoUploadResponse(
      {
        sha256: SERVER_HASH,
        url: 'https://media.example/aaa',
        size: 12345,
        type: 'video/mp4',
        duration: 42,
        width: 1280,
        height: 720,
        poster: { sha256: POSTER_HASH, url: 'https://media.example/bbb' },
      },
      mediaBase,
    );

    expect(descriptor).toEqual(descriptorFixture());
  });

  it('derives URLs from the media base when the server omits them', () => {
    const descriptor = parseVideoUploadResponse(
      {
        sha256: SERVER_HASH,
        duration: 10,
        width: 640,
        height: 360,
        poster: { sha256: POSTER_HASH },
      },
      mediaBase,
    );

    expect(descriptor.url).toBe(`${mediaBase}/${SERVER_HASH}`);
    expect(descriptor.poster.url).toBe(`${mediaBase}/${POSTER_HASH}`);
  });

  it('refuses a descriptor missing its poster or duration', () => {
    expect(() => parseVideoUploadResponse({ sha256: SERVER_HASH }, mediaBase)).toThrow();
    expect(() =>
      parseVideoUploadResponse(
        { sha256: SERVER_HASH, duration: 0, width: 1, height: 1, poster: { sha256: POSTER_HASH } },
        mediaBase,
      ),
    ).toThrow();
    expect(() =>
      parseVideoUploadResponse(
        { sha256: SERVER_HASH, duration: 5, width: 1, height: 1, poster: {} },
        mediaBase,
      ),
    ).toThrow();
  });

  it('says nothing about protocols in its error copy', () => {
    try {
      parseVideoUploadResponse(null, mediaBase);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      for (const word of ['hash', 'sha', 'blossom', 'nostr', 'relay', 'nip']) {
        expect(message).not.toContain(word);
      }
    }
  });
});

describe('video construction from a descriptor', () => {
  const descriptor = descriptorFixture();

  it('produces a kind-22 with imeta poster + duration', () => {
    const event = videoTemplate(descriptor, { caption: 'roof top', alt: 'a clip' });

    expect(event.kind).toBe(KINDS.VIDEO);
    expect(event.content).toBe('roof top');

    const imeta = event.tags.find((t) => t[0] === 'imeta');
    expect(imeta).toBeDefined();
    expect(imeta).toContain(`url ${mediaBase}/aaa`);
    expect(imeta).toContain(`x ${SERVER_HASH}`);
    expect(imeta).toContain('dim 1280x720');
    expect(imeta).toContain('m video/mp4');
    expect(imeta).toContain('duration 42');
    expect(imeta).toContain(`image ${mediaBase}/bbb`);
    expect(imeta).toContain('alt a clip');
  });

  it('mirrors the address and duration into top-level tags', () => {
    const event = videoTemplate(descriptor);
    expect(event.tags).toContainEqual(['x', SERVER_HASH]);
    expect(event.tags).toContainEqual(['m', 'video/mp4']);
    expect(event.tags).toContainEqual(['duration', '42']);
  });

  it('emits facet t tags through the same vocabulary flicks use', () => {
    const input = videoInput(descriptor, {
      boards: ['sf-bay'],
      types: ['throwie'],
      surfaces: ['street'],
      region: 'bay-area',
      legalPermission: true,
    });
    const event = buildVideo(input);
    const t = event.tags.filter((tag) => tag[0] === 't').map((tag) => tag[1]);
    expect(t).toContain('sf-bay');
    expect(t).toContain('type-throwie');
    expect(t).toContain('surface-street');
    expect(t).toContain('region-bay-area');
    expect(t).toContain('legal-permission');
  });

  it('omits optional fields rather than emitting empties', () => {
    const bare = videoInput({ ...descriptor, size: undefined });
    expect(bare).not.toHaveProperty('caption');
    expect(bare).not.toHaveProperty('alt');
    expect(bare).not.toHaveProperty('size');
    expect(buildVideo(bare).content).toBe('');
  });
});

describe('buildUploadAuth (shared with the video path)', () => {
  it('describes an upload of exactly this blob', () => {
    const auth = buildUploadAuth(SERVER_HASH, 99_999, 1_700_000_000);
    expect(auth.kind).toBe(KINDS.BLOSSOM_AUTH);
    expect(auth.tags).toContainEqual(['x', SERVER_HASH]);
    expect(auth.tags).toContainEqual(['size', '99999']);
  });
});

// --- probeVideo: driven off a fake <video> element so no real file is needed.
function makeFakeVideoController(duration: number, videoWidth: number, videoHeight: number) {
  // happy-dom implements document.createElement('video') enough to attach
  // handlers; we drive the metadata event by hand by making the `src` setter
  // dispatch a `loadedmetadata` event (the same event a real browser fires
  // once it has parsed the container).
  const video = document.createElement('video');
  Object.defineProperty(video, 'duration', { configurable: true, get: () => duration });
  Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => videoWidth });
  Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => videoHeight });
  Object.defineProperty(video, 'src', {
    configurable: true,
    set() {
      // Fire after the probe has wired its onloadedmetadata handler. The
      // handler is attached before the src assignment in probeVideo, so a
      // microtask is enough to land it.
      queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
    },
  });
  return video;
}

describe('probeVideo', () => {
  it('rejects a non-video file outright', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' });
    await expect(probeVideo(file)).rejects.toThrow(/clips only/i);
  });

  it('rejects an oversized clip before reading it', async () => {
    const big = new File([new Uint8Array(1024)], 'c.mp4', { type: 'video/mp4' });
    Object.defineProperty(big, 'size', { value: 999_999_999_999 });
    await expect(probeVideo(big)).rejects.toThrow(/too big/i);
  });

  it('resolves the duration and dimensions for a usable clip', async () => {
    const originalCreate = document.createElement.bind(document);
    const stub = makeFakeVideoController(15, 1280, 720);
    const file = new File([new Uint8Array(8)], 'c.mp4', { type: 'video/mp4' });
    try {
      document.createElement = ((tag: string) => (tag === 'video' ? stub : originalCreate(tag))) as typeof document.createElement;
      const probe = await probeVideo(file);
      expect(probe.durationSec).toBe(15);
      expect(probe.width).toBe(1280);
      expect(probe.height).toBe(720);
    } finally {
      document.createElement = originalCreate;
    }
  });

  it('rejects a clip over the 60 second ceiling', async () => {
    const originalCreate = document.createElement.bind(document);
    const stub = makeFakeVideoController(120, 1280, 720);
    const file = new File([new Uint8Array(8)], 'c.mp4', { type: 'video/mp4' });
    try {
      document.createElement = ((tag: string) => (tag === 'video' ? stub : originalCreate(tag))) as typeof document.createElement;
      await expect(probeVideo(file)).rejects.toThrow(/60 seconds max/i);
    } finally {
      document.createElement = originalCreate;
    }
  });
});