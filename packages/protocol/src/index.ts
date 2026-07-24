/**
 * `@1nky/protocol` — the shared event layer for 1NKY.
 *
 * Everything that touches the Nostr wire format lives here: kinds, tag
 * builders, proof-of-work checks, blackbook (NIP-49) helpers and the copy
 * deck. All cryptography is delegated to `nostr-tools` / `@noble` — this
 * package hand-rolls none of it.
 */

// --- Kinds -----------------------------------------------------------------
export { ALL_KINDS, isKnownKind, KINDS } from './kinds.js';
export type { Kind, KindName } from './kinds.js';

// --- Copy deck -------------------------------------------------------------
export { COPY, JARGON_BLOCKLIST } from './copy.js';
export type { Copy } from './copy.js';

// --- Types -----------------------------------------------------------------
export { BEEF_DURATIONS, REPORT_REASONS } from './types.js';
export type {
  BeefDuration,
  BoardTag,
  EventRef,
  EventTemplate,
  ExpirationTag,
  FlickDims,
  FlickImeta,
  NonceTag,
  PowCheckable,
  ReportReason,
  SignedEvent,
  Tag,
  UnsignedEvent,
  VerifiedEvent,
} from './types.js';

// --- Proof of work (NIP-13) ------------------------------------------------
export { committedPowTarget, hasValidPow, minePow, powBits, powTag } from './pow.js';
export type { PowOptions } from './pow.js';

// --- Event builders --------------------------------------------------------
export {
  beefExpiration,
  boardTag,
  buildBuff,
  buildComment,
  buildExpiration,
  buildFlick,
  buildMuteList,
  buildProfile,
  buildReport,
  buildThreadOp,
  imetaTag,
  normalizeBoard,
} from './builders.js';
export type {
  BuilderOptions,
  BuildBuffOptions,
  BuildCommentOptions,
  BuildFlickInput,
  BuildMuteListOptions,
  BuildProfileInput,
  BuildReportOptions,
  BuildThreadOpInput,
  ReportTarget,
} from './builders.js';

// --- Blackbook (NIP-49) ----------------------------------------------------
export {
  BLACKBOOK_LOGN,
  blackbookFileContents,
  blackbookFilename,
  decryptBlackbook,
  encryptBlackbook,
  isBlackbookPayload,
  parseBlackbookFile,
} from './blackbook.js';
export type { BlackbookOptions } from './blackbook.js';

// --- The mark (pubkey fingerprint) -----------------------------------------
export { fingerprint, identiconSeed, MARK_LENGTH, sameMark } from './mark.js';

// --- Re-exported nostr-tools primitives ------------------------------------
// Consumers should import these from here so there is exactly one copy of
// nostr-tools' crypto in the dependency graph.
export {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  serializeEvent,
  verifyEvent,
} from 'nostr-tools/pure';
export { decode as decodeBech32, npubEncode, nsecEncode } from 'nostr-tools/nip19';
export type { NPub, NSec, Ncryptsec } from 'nostr-tools/nip19';
