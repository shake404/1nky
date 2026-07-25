/**
 * `@1nky/protocol` — the shared event layer for 1NKY.
 *
 * Everything that touches the Nostr wire format lives here: kinds, tag
 * builders, proof-of-work checks, blackbook (NIP-49) helpers and the copy
 * deck. All cryptography is delegated to `nostr-tools` / `@noble` — this
 * package hand-rolls none of it.
 */

// --- Kinds -----------------------------------------------------------------
export {
  ALL_KINDS,
  isKnownKind,
  isRelayAcceptedKind,
  isWrapInternalKind,
  KINDS,
  RELAY_ACCEPTED_KINDS,
  WRAP_INTERNAL_KINDS,
} from './kinds.js';
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
  VideoImeta,
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
  buildCrewBadgeRegistry,
  buildCrewDefinition,
  buildCrewProfile,
  buildExpiration,
  buildFlick,
  buildInvite,
  buildModBan,
  buildMuteList,
  buildProfile,
  buildReport,
  buildThreadOp,
  buildVideo,
  CREW_BADGES_DTAG,
  CREW_DEFINITION_DTAG,
  decodeInviteCode,
  encodeInviteCode,
  imetaTag,
  INVITE_DTAG_PREFIX,
  inviteRedemptionTag,
  isSubtreeBan,
  MOD_BAN_DTAG_PREFIX,
  normalizeBoard,
  parseInvite,
  parseInviteRedemption,
  parseModBan,
  SUBTREE_BAN_REASON_PREFIX,
  videoImetaTag,
} from './builders.js';
export { PROFILE_BIO_MAX } from './builders.js';
export type {
  BuildCrewBadgeRegistryInput,
  BuildCrewDefinitionInput,
  BuilderOptions,
  BuildBuffOptions,
  BuildCommentOptions,
  BuildFlickInput,
  BuildInviteOptions,
  BuildModBanOptions,
  BuildMuteListOptions,
  BuildProfileInput,
  BuildReportOptions,
  BuildThreadOpInput,
  BuildVideoInput,
  InviteTag,
  ReportTarget,
} from './builders.js';

// --- Explore facets --------------------------------------------------------
export {
  GRAF_TYPES,
  legalPermissionTag,
  LEGAL_PERMISSION_TAG,
  parseFacets,
  regionTag,
  surfaceTag,
  SURFACES,
  typeTag,
} from './facets.js';
export type { GrafType, ParsedFacets, Surface } from './facets.js';

// --- Private messages (NIP-17 / NIP-59) ------------------------------------
export {
  DM_TEXT_MAX,
  GIFT_WRAP_MAX_BACKDATE_SECONDS,
  giftWrapRecipient,
  unwrapMessage,
  wrapMessage,
} from './dm.js';
export type { UnwrappedMessage } from './dm.js';

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
