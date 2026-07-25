import {
  buildBuff,
  buildComment,
  KINDS,
  type EventRef,
  type EventTemplate,
  type SignedEvent,
} from '@1nky/protocol';
import { POW_BITS } from './config.js';
import { flickTemplate, prepareImage, uploadBlob, type FlickDetails, type UploadResult } from './flicks.js';
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
  options: PublishOptions & { first?: boolean; city?: string; bio?: string; avatarSha256?: string } = {},
): Promise<SignedEvent> {
  const template = profileTemplate(tag, {
    ...(options.city ? { city: options.city } : {}),
    ...(options.bio !== undefined ? { bio: options.bio } : {}),
    ...(options.avatarSha256 ? { avatarSha256: options.avatarSha256 } : {}),
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

/** Kind 1111 — a comment under a flick. */
export async function postComment(
  tag: Tag,
  parent: EventRef,
  content: string,
  options: PublishOptions = {},
): Promise<SignedEvent> {
  const trimmed = content.trim();
  if (!trimmed) throw new PublishError('Say something first.');
  const event = await send(buildComment(parent, { content: trimmed }), tag, POW_BITS.post, options);
  await rememberOwnPost(event.id);
  await markHasPosted();
  return event;
}

/** Kind 5 — "Buff this". Only ever your own work. */
export function buffEvents(
  tag: Tag,
  ids: readonly string[],
  kinds: readonly number[] = [KINDS.FLICK],
  options: PublishOptions = {},
): Promise<SignedEvent> {
  return send(buildBuff(ids, { kinds }), tag, POW_BITS.reaction, options);
}
