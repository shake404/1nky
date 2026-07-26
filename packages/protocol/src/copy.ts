/**
 * The 1NKY copy deck.
 *
 * Hard rule 3: no Nostr jargon in user-facing UI copy. Every string a user
 * can read comes from here (or is written in the same register). Never show
 * "nsec", "npub", "key", "relay", "event", "kind", "Nostr", "crypto", "sign".
 */
export const COPY = {
  /** identity / keypair */
  tag: {
    label: 'tag',
    /** First-run headline. */
    pick: 'PICK A TAG',
    /** Restore entry point. */
    restore: 'Already got a tag?',
    /** Anti-impersonation tooltip. */
    notUnique: 'Tags are not unique. Check the mark.',
  },

  /** key backup file (NIP-49 encrypted secret key) */
  blackbook: {
    label: 'blackbook',
    action: 'Save your blackbook',
    /** The one line that must never be softened. */
    warning:
      'Lose your blackbook, lose your tag. Nobody can recover it. Not even us. Especially not us.',
    nag: 'You have not saved your blackbook yet.',
    passphrasePrompt: 'Lock your blackbook with a passphrase',
    linkDevice: 'Link a device',
    installPrompt: 'Install the app — keeps your blackbook safe.',
  },

  /** photo post (kind 20) */
  flick: {
    label: 'flick',
    plural: 'flicks',
    action: 'Post a flick',
    empty: 'No flicks up yet.',
  },

  /** delete a post (kind 5) */
  buff: {
    label: 'Buff this',
    confirm: 'Buff this? It does not come back.',
    done: 'Buffed',
    past: 'buffed',
  },

  /**
   * additive amendment (kind 1113) — adding to a post that is already up.
   *
   * Never "edit": nothing about what went up changes. You put more on it, the
   * way you would go back to a wall and add to the piece.
   */
  addTo: {
    label: 'Add to this',
    blurb: 'Tag writers, add walls. Whatever is on it already stays on it.',
    done: 'Added.',
  },

  /** retire identity — a ritual, not an error state */
  hangItUp: {
    label: 'Hang it up',
    blurb: 'Writers retire names. Everything you put up comes down and the tag is done.',
    confirm: 'Hang it up for good?',
    done: 'Hung up.',
  },

  /** pubkey fingerprint */
  mark: {
    label: 'mark',
    hint: 'same name, different mark = different writer',
  },

  /** proof-of-work wait — never say "mining" */
  spraying: {
    label: 'spraying...',
    slow: 'still spraying...',
  },

  /** report content (kind 1984) */
  flagIt: {
    label: 'Flag it',
    prompt: 'What is wrong with this?',
    done: 'Flagged. Someone will look at it.',
  },

  /** mute (NIP-51 kind 10000) */
  ignoreWriter: {
    label: 'Ignore this writer',
    done: 'Ignored. You will not see their stuff.',
    undo: 'Stop ignoring',
  },

  /** crew shared identity */
  crew: {
    label: 'crew',
    action: 'Start a crew',
  },

  /** invite (Phase 3) */
  putOn: {
    label: 'getting put on',
    action: 'Put someone on',
  },

  /** ephemeral thread */
  beef: {
    label: 'beef',
    blurb: 'Beef does not stick around. Pick how long it runs.',
  },

  /** a new build is ready to swap in */
  freshCoat: {
    label: 'Fresh coat available — tap to update',
  },
} as const;

export type Copy = typeof COPY;

/**
 * Words that must never appear in user-facing copy (hard rule 3).
 * Exported so apps can assert against it in tests.
 */
export const JARGON_BLOCKLIST: readonly string[] = Object.freeze([
  'nsec',
  'npub',
  'pubkey',
  'private key',
  'public key',
  'keypair',
  'relay',
  'nostr',
  'crypto',
  'proof of work',
  'proof-of-work',
  'mining',
  'hash',
  'blossom',
  'nip-',
]);
