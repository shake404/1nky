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

/** The relay caps difficulty well under this; the ceiling only stops a runaway. */
const MAX_POW_BITS = 24;

/**
 * The difficulty a `pow:` rejection is asking for, if it names one higher than
 * what we already tried. The relay's newcomer gate keeps an in-process memory
 * of pubkeys it has seen, so after it restarts a returning writer briefly looks
 * new again and their normal-tier work is turned away with
 * "committed difficulty 13 is below the required 18". Rather than make the
 * writer eat a mysterious failure, we read the number back off the message and
 * grind once more at that tier.
 */
export function powShortfall(message: string, triedBits: number): number | null {
  const lower = message.toLowerCase();
  if (!lower.includes('pow') && !lower.includes('difficulty')) return null;
  const required = [...lower.matchAll(/(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > triedBits);
  const want = Math.max(0, ...required);
  return want > triedBits && want <= MAX_POW_BITS ? want : null;
}

/**
 * Mine, publish, and — if the relay turns it away for too little work — mine
 * once more at the difficulty it named and resend. EVERY publish path routes
 * through here (a writer's own posts via {@link send}, and crew edits / invite
 * mints / any raw template via {@link publishTemplate}), so the relay-restart
 * newcomer-gate reset self-heals everywhere, not just on the flick path.
 */
async function mineSendRetry(
  template: EventTemplate,
  secret: Uint8Array,
  pubkey: string,
  bits: number,
  options: PublishOptions = {},
): Promise<SignedEvent> {
  options.onStage?.('spraying');
  let event = await mineAndSign(template, secret, pubkey, bits);

  options.onStage?.('posting');
  let result = await relay.publish(event);

  if (!result.accepted) {
    const harder = powShortfall(result.message, bits);
    if (harder !== null) {
      options.onStage?.('spraying');
      event = await mineAndSign(template, secret, pubkey, harder);
      options.onStage?.('posting');
      result = await relay.publish(event);
    }
  }

  if (!result.accepted) {
    throw new PublishError(friendly(result.message));
  }
  options.onStage?.('done');
  return event;
}

function send(
  template: EventTemplate,
  tag: Pick<Tag, 'secret' | 'pubkey'>,
  bits: number,
  options: PublishOptions = {},
): Promise<SignedEvent> {
  return mineSendRetry(template, tag.secret, tag.pubkey, bits, options);
}

/**
 * Record the writer's-own bookkeeping for a post — but ONLY when the signer is
 * the device's own tag.
 *
 * Both {@link rememberOwnPost} (the own-posts prefs list) and
 * {@link markHasPosted} (the `me` row's `hasPosted` flag) describe the DEVICE
 * TAG's history. When a post is signed by a crew key off the switcher's
 * active-signer overlay, none of that applies: the crew is not "me", and —
 * critically — `markHasPosted` WRITES the single-slot `tag` store, which the
 * crew path must never touch. Posting-as-crew callers pass `recordOwn: false`;
 * the ordinary me path defaults to true and behaves exactly as before.
 */
async function noteOwnPost(eventId: string, recordOwn: boolean): Promise<void> {
  if (!recordOwn) return;
  await rememberOwnPost(eventId);
  await markHasPosted();
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

/**
 * Kind 0 — the writer's tag.
 *
 * A profile ALWAYS pays the newcomer tier, first post or hundredth: the relay
 * keeps kind 0 in `POW_NEW_KINDS`, so it demands `POW_BITS_NEW` for every
 * profile regardless of how long the writer has been around. Mining at the
 * cheaper post tier here is what made "save" bounce with "that did not stick"
 * on every edit (the retry papered over it; this stops it happening at all).
 *
 * `putOn` only ever belongs on the first one: it is how somebody who got put
 * on says so, and it is read once, when they turn up. `first` is kept for that
 * intent and no longer changes the freight.
 */
export function publishProfile(
  tag: Pick<Tag, 'secret' | 'pubkey' | 'name'>,
  options: PublishOptions & {
    first?: boolean;
    city?: string;
    bio?: string;
    avatarSha256?: string;
    crews?: readonly string[];
    putOn?: { inviteId: string; inviterPubkey: string };
  } = {},
): Promise<SignedEvent> {
  const template = profileTemplate(tag, {
    ...(options.city ? { city: options.city } : {}),
    ...(options.bio !== undefined ? { bio: options.bio } : {}),
    ...(options.avatarSha256 ? { avatarSha256: options.avatarSha256 } : {}),
    ...(options.crews ? { crews: options.crews } : {}),
    ...(options.putOn ? { putOn: options.putOn } : {}),
  });
  return send(template, tag, POW_BITS.new, options);
}

export interface PostFlickInput extends FlickDetails, PublishOptions {
  file: File;
  /**
   * Record this as one of the DEVICE TAG's own posts (own-posts list +
   * `hasPosted`). Default true. The switcher passes false when posting as a
   * crew, so a crew post never writes the single-slot `tag` store.
   */
  recordOwn?: boolean;
}

/**
 * The whole flick pipeline, end to end.
 *
 * Strip and resize on-device, upload, then build the event around the hash
 * the SERVER returned — it re-encodes, so its bytes (and therefore its
 * address) are the only ones that exist.
 */
export async function postFlick(tag: Tag, input: PostFlickInput): Promise<SignedEvent> {
  const { file, onStage, recordOwn = true, ...details } = input;

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

  await noteOwnPost(event.id, recordOwn);
  return event;
}

export interface PostVideoInput extends MediaDetails, PublishOptions {
  file: File;
  /** See {@link PostFlickInput.recordOwn}. Default true. */
  recordOwn?: boolean;
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
  const { file, onStage, recordOwn = true, ...details } = input;

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

  await noteOwnPost(event.id, recordOwn);
  return event;
}

export interface PostThreadInput extends PublishOptions {
  content: string;
  /** See {@link PostFlickInput.recordOwn}. Default true. */
  recordOwn?: boolean;
  /** Board slugs this thread goes up on. */
  boards?: readonly string[];
  /** Optional title. */
  subject?: string;
  /**
   * When the wall should take it away (unix seconds) — this is what makes it a
   * beef thread. Omit for one that stays up.
   */
  expiration?: number;
  /**
   * When the thing actually goes down (unix seconds) — this is what makes it a
   * **happening**. The builder puts the date on it, adds the happening marker to
   * its boards, and gives it a lifetime of a week after the date unless a
   * lifetime was picked here, which always wins.
   */
  happeningAt?: number;
}

/**
 * Kind 1 — start a thread on a board.
 *
 * Same freight as a flick: a fresh tag pays the newcomer tier on its first
 * thing, everything after that is the ordinary post tier.
 */
export async function postThread(tag: Tag, input: PostThreadInput): Promise<SignedEvent> {
  const { content, boards, subject, expiration, happeningAt, recordOwn = true, ...options } = input;
  const trimmed = content.trim();
  if (!trimmed) throw new PublishError('Say something first.');

  const template = buildThreadOp({
    content: trimmed,
    ...(boards?.length ? { boards } : {}),
    ...(subject?.trim() ? { subject: subject.trim() } : {}),
    ...(expiration !== undefined ? { expiration } : {}),
    ...(happeningAt !== undefined ? { happeningAt } : {}),
  });

  const bits = tag.hasPosted ? POW_BITS.post : POW_BITS.new;
  const event = await send(template, tag, bits, options);
  await noteOwnPost(event.id, recordOwn);
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
    /**
     * Pubkeys of writers named in the body (an @-mention). Each rides along as
     * a real `p` tag so the mention can drive a "you were mentioned" signal
     * later — see `buildComment`, which dedupes them against the reply's own
     * anchors.
     */
    mentions?: readonly string[];
    /** See {@link PostFlickInput.recordOwn}. Default true. */
    recordOwn?: boolean;
  } = {},
): Promise<SignedEvent> {
  const trimmed = content.trim();
  if (!trimmed) throw new PublishError('Say something first.');
  const { root, mentions, recordOwn = true, ...publishOptions } = options;
  const event = await send(
    buildComment(parent, {
      content: trimmed,
      ...(root ? { root } : {}),
      ...(mentions?.length ? { mentions } : {}),
    }),
    tag,
    POW_BITS.post,
    publishOptions,
  );
  await noteOwnPost(event.id, recordOwn);
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
  return mineSendRetry(template, secret, pubkey, bits, options);
}
