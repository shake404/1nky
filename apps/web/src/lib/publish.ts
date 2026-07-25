import {
  buildBuff,
  buildComment,
  buildThreadOp,
  KINDS,
  type EventRef,
  type EventTemplate,
  type SignedEvent,
} from '@1nky/protocol';
import { POW_BITS } from './config.js';
import {
  flickTemplate,
  prepareImage,
  probeVideo,
  uploadBlob,
  uploadVideo,
  videoTemplate,
  type FlickDetails,
  type MediaDetails,
  type UploadResult,
  type VideoDescriptor,
} from './flicks.js';
import { markHasPosted, rememberOwnPost, type Tag } from './identity.js';
import { mineAndSign } from './pow.js';
import { profileTemplate } from './profiles.js';
import { relay } from './relay.js';

/**
 * Everything that turns an intention into a published event.
 *
 * One shape for all of it: build a template, grind the work, sign, send.
 */

export type Stage = 'preparing' | 'uploading' | 'spraying' | 'posting' | 'done';

export interface PublishOptions {
  onStage?: (stage: Stage) => void;
}

export class PublishError extends Error {}

async function send(
  template: EventTemplate,
  tag: Pick<Tag, 'secret' | 'pubkey'>,
  bits: number,
  options: PublishOptions = {},
): Promise<SignedEvent> {
  options.onStage?.('spraying');
  const event = await mineAndSign(template, tag.secret, tag.pubkey, bits);

  options.onStage?.('posting');
  const result = await relay.publish(event);
  if (!result.accepted) {
    throw new PublishError(friendly(result.message));
  }
  options.onStage?.('done');
  return event;
}

/** Translate whatever the far end said into something a writer should read. */
function friendly(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('timeout')) return 'Could not reach the wall. Check your connection and try again.';
  if (lower.includes('pow') || lower.includes('difficulty')) return 'That did not stick. Try again.';
  if (lower.includes('blocked') || lower.includes('banned')) return 'That did not go up.';
  if (lower.includes('rate') || lower.includes('limit')) return 'Slow down a minute, then try again.';
  return 'That did not go up. Try again.';
}

/** Kind 0 — the writer's tag. First event from a fresh tag pays full freight. */
export function publishProfile(
  tag: Pick<Tag, 'secret' | 'pubkey' | 'name'>,
  options: PublishOptions & {
    first?: boolean;
    city?: string;
    bio?: string;
    avatarSha256?: string;
    crews?: readonly string[];
  } = {},
): Promise<SignedEvent> {
  const template = profileTemplate(tag, {
    ...(options.city ? { city: options.city } : {}),
    ...(options.bio !== undefined ? { bio: options.bio } : {}),
    ...(options.avatarSha256 ? { avatarSha256: options.avatarSha256 } : {}),
    ...(options.crews ? { crews: options.crews } : {}),
  });
  return send(template, tag, options.first === false ? POW_BITS.post : POW_BITS.new, options);
}

export interface PostFlickInput extends FlickDetails, PublishOptions {
  file: File;
}

/**
 * The whole flick pipeline, end to end.
 *
 * Strip and resize on-device, upload, then build the event around the hash
 * the SERVER returned — it re-encodes, so its bytes (and therefore its
 * address) are the only ones that exist.
 */
export async function postFlick(tag: Tag, input: PostFlickInput): Promise<SignedEvent> {
  const { file, onStage, ...details } = input;

  onStage?.('preparing');
  const prepared = await prepareImage(file);

  onStage?.('uploading');
  let upload: UploadResult;
  try {
    upload = await uploadBlob(prepared.full, tag.secret);
    // Thumbnails are content-addressed too; a failure here is cosmetic.
    void uploadBlob(prepared.thumb, tag.secret).catch(() => undefined);
  } catch (error) {
    throw new PublishError(error instanceof Error ? error.message : 'The picture did not go up. Try again.');
  }

  const template = flickTemplate(upload, prepared.dims, details);
  const bits = tag.hasPosted ? POW_BITS.post : POW_BITS.new;
  const event = await send(template, tag, bits, { ...(onStage ? { onStage } : {}) });

  await rememberOwnPost(event.id);
  await markHasPosted();
  return event;
}

export interface PostVideoInput extends MediaDetails, PublishOptions {
  file: File;
}

/**
 * The video pipeline, end to end — same shape as {@link postFlick}.
 *
 * The client probes the clip (duration + dimensions, rejection >60s or over
 * the size ceiling) BEFORE any bytes leave the device. The raw file is then
 * uploaded; the media service transcodes and returns the transcoded bytes'
 * address plus a poster still, which becomes the kind-22 `imeta`. PoW is
 * ground at the POST tier the same way a flick's is. The `spraying...` wait
 * the writer sees covers both the server transcode and the work.
 */
export async function postVideo(tag: Tag, input: PostVideoInput): Promise<SignedEvent> {
  const { file, onStage, ...details } = input;

  onStage?.('preparing');
  const probe = await probeVideo(file);

  onStage?.('uploading');
  let descriptor: VideoDescriptor;
  try {
    descriptor = await uploadVideo(file, tag.secret);
  } catch (error) {
    throw new PublishError(error instanceof Error ? error.message : 'The clip did not go up. Try again.');
  }

  const template = videoTemplate(descriptor, { ...details });
  const bits = tag.hasPosted ? POW_BITS.post : POW_BITS.new;
  const event = await send(template, tag, bits, { ...(onStage ? { onStage } : {}) });

  await rememberOwnPost(event.id);
  await markHasPosted();
  return event;
}

export interface PostThreadInput extends PublishOptions {
  content: string;
  /** Board slugs this thread goes up on. */
  boards?: readonly string[];
  /** Optional title. */
  subject?: string;
  /**
   * When the wall should take it away (unix seconds) — this is what makes it a
   * beef thread. Omit for one that stays up.
   */
  expiration?: number;
}

/**
 * Kind 1 — start a thread on a board.
 *
 * Same freight as a flick: a fresh tag pays the newcomer tier on its first
 * thing, everything after that is the ordinary post tier.
 */
export async function postThread(tag: Tag, input: PostThreadInput): Promise<SignedEvent> {
  const { content, boards, subject, expiration, ...options } = input;
  const trimmed = content.trim();
  if (!trimmed) throw new PublishError('Say something first.');

  const template = buildThreadOp({
    content: trimmed,
    ...(boards?.length ? { boards } : {}),
    ...(subject?.trim() ? { subject: subject.trim() } : {}),
    ...(expiration !== undefined ? { expiration } : {}),
  });

  const bits = tag.hasPosted ? POW_BITS.post : POW_BITS.new;
  const event = await send(template, tag, bits, options);
  await rememberOwnPost(event.id);
  await markHasPosted();
  return event;
}

/** Kind 1111 — a comment under a flick or a thread. */
export async function postComment(
  tag: Tag,
  parent: EventRef,
  content: string,
  options: PublishOptions & {
    /**
     * The top of the thread, when the thing being replied to is itself a
     * reply. Left off, the parent IS the top — which is right for a comment
     * straight onto a flick or onto a thread's opening post.
     */
    root?: EventRef;
  } = {},
): Promise<SignedEvent> {
  const trimmed = content.trim();
  if (!trimmed) throw new PublishError('Say something first.');
  const { root, ...publishOptions } = options;
  const event = await send(
    buildComment(parent, { content: trimmed, ...(root ? { root } : {}) }),
    tag,
    POW_BITS.post,
    publishOptions,
  );
  await rememberOwnPost(event.id);
  await markHasPosted();
  return event;
}

/**
 * Kind 5 — "Buff this".
 *
 * Normally your own work; a mod taking something down publishes the same shape
 * against somebody else's post. Priced at the POST tier because the wall's
 * write policy only discounts the signal kinds (flags, ignore lists, wrapped
 * messages) — a buff mined at the cheap tier gets turned away at the door.
 */
export function buffEvents(
  tag: Tag,
  ids: readonly string[],
  kinds: readonly number[] = [KINDS.FLICK],
  options: PublishOptions = {},
): Promise<SignedEvent> {
  return send(buildBuff(ids, { kinds }), tag, POW_BITS.post, options);
}

/**
 * Sign and publish an arbitrary template with an arbitrary secret/pubkey.
 *
 * The device's own tag flows through {@link send} (which pays the newcomer or
 * post tier based on the tag's history). This lower-level entry point is for
 * identities that are NOT the device tag — most importantly a freshly-minted
 * crew keypair, which signs its own kind-0 and kind-30078 definition. The
 * caller picks the difficulty, since a brand-new crew pubkey has no history of
 * its own and pays the newcomer's freight on its very first event.
 */
export async function publishTemplate(
  secret: Uint8Array,
  pubkey: string,
  template: EventTemplate,
  bits: number,
  options: PublishOptions = {},
): Promise<SignedEvent> {
  options.onStage?.('spraying');
  const event = await mineAndSign(template, secret, pubkey, bits);
  options.onStage?.('posting');
  const result = await relay.publish(event);
  if (!result.accepted) {
    throw new PublishError(friendly(result.message));
  }
  options.onStage?.('done');
  return event;
}
