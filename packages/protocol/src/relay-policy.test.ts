import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { KINDS, RELAY_ACCEPTED_KINDS, WRAP_INTERNAL_KINDS } from './kinds.js';

/**
 * Contract test for infra/strfry/write-policy.mjs.
 *
 * The plugin is a dependency-free Node script that strfry drives over stdio,
 * so it cannot import `@1nky/protocol` — it hard-codes the kind numbers. This
 * suite is what stops those two copies drifting: it spawns the real plugin as
 * a child process, speaks the real line protocol at it, and asserts both the
 * verdicts and that its default allowlist still equals `ALL_KINDS`.
 *
 * It lives here rather than in infra/ because infra/ is outside the pnpm
 * workspace (pnpm-workspace.yaml globs apps/* and packages/* only) and would
 * never run in CI, and because kinds.ts declares itself the source of truth
 * for the relay write-policy. Owning the contract means owning its test.
 */

const PLUGIN = fileURLToPath(new URL('../../../infra/strfry/write-policy.mjs', import.meta.url));

const BANNED = 'ba'.repeat(32);
const WRITER = 'aa'.repeat(32);

/** A writer someone already here put on. See INVITED_LIST_PATH. */
const INVITED = 'ad'.repeat(32);

const banDir = mkdtempSync(join(tmpdir(), '1nky-policy-'));
const banPath = join(banDir, 'banlist.json');
writeFileSync(banPath, JSON.stringify([BANNED]), 'utf8');
// The invited list ships as bare hex strings — the second entry shape the
// loader accepts, and what apps/indexer/src/invited-export.ts writes.
const invitedPath = join(banDir, 'invited.json');
writeFileSync(invitedPath, JSON.stringify([INVITED]), 'utf8');
afterAll(() => rmSync(banDir, { recursive: true, force: true }));

interface Verdict {
  id: string;
  action: 'accept' | 'reject' | 'shadowReject';
  msg?: string;
}

interface Run {
  verdicts: Verdict[];
  stderr: string;
}

/**
 * An id with exactly `bits` leading zero bits. The policy only reads the id's
 * nibbles, so PoW tiers are testable without grinding for them.
 */
function idWithBits(bits: number): string {
  const wholeNibbles = Math.floor(bits / 4);
  const remainder = bits % 4;
  // 8 >> r is the smallest nibble whose top r bits are zero: r=1 -> 4, 2 -> 2, 3 -> 1.
  const partial = remainder === 0 ? '' : (8 >> remainder).toString(16);
  return ('0'.repeat(wholeNibbles) + partial + 'f'.repeat(64)).slice(0, 64);
}

let counter = 0;

interface EventOverrides {
  kind?: number;
  pubkey?: string;
  id?: string;
  tags?: unknown;
  content?: string;
}

/** A plausible strfry `new` request. Signatures are never checked by a plugin. */
function request(overrides: EventOverrides = {}): Record<string, unknown> {
  counter += 1;
  return {
    type: 'new',
    receivedAt: 1_700_000_000,
    sourceType: 'IP4',
    event: {
      id: overrides.id ?? `${counter.toString(16).padStart(4, '0')}${'e'.repeat(60)}`,
      pubkey: overrides.pubkey ?? WRITER,
      created_at: 1_700_000_000,
      kind: overrides.kind ?? KINDS.NOTE,
      tags: overrides.tags ?? [],
      content: overrides.content ?? '',
      sig: '0'.repeat(128),
    },
  };
}

/** Feed `lines` to a fresh plugin process and collect one verdict per line. */
function drive(lines: unknown[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PLUGIN], {
      env: {
        ...process.env,
        BAN_LIST_PATH: banPath,
        INVITED_LIST_PATH: invitedPath,
        POW_ENABLED: '0',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.stderr.on('data', (chunk: string) => (err += chunk));
    child.on('error', reject);
    child.on('close', () => {
      const verdicts = out
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Verdict);
      resolve({ verdicts, stderr: err });
    });

    for (const line of lines) {
      child.stdin.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
    }
    child.stdin.end();
  });
}

/** Drive a single request and return its verdict. */
async function decide(
  overrides: EventOverrides = {},
  env: Record<string, string> = {},
): Promise<Verdict> {
  const { verdicts } = await drive([request(overrides)], env);
  return verdicts[0] as Verdict;
}

// ---------------------------------------------------------------------------

describe('write-policy: the line protocol', () => {
  it('echoes the event id on every response', async () => {
    const reqs = [request({ kind: 1 }), request({ kind: 9735 }), request({ kind: KINDS.DM })];
    const { verdicts } = await drive(reqs);

    expect(verdicts).toHaveLength(3);
    for (const [i, verdict] of verdicts.entries()) {
      const event = (reqs[i] as { event: { id: string } }).event;
      expect(verdict.id).toBe(event.id);
    }
  });

  it('drops unparseable lines instead of answering them', async () => {
    const { verdicts } = await drive(['not json', '', '   ', request({ kind: 1 })]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.action).toBe('accept');
  });

  it('drops a request with no event id (nothing to correlate a reply to)', async () => {
    const { verdicts } = await drive([{ type: 'new', event: { kind: 1 } }, { type: 'new' }, {}]);
    expect(verdicts).toHaveLength(0);
  });

  it('accepts unknown request types rather than silently dropping writes', async () => {
    const { verdicts } = await drive([{ ...request({ kind: 9735 }), type: 'lookback' }]);
    expect(verdicts[0]?.action).toBe('accept');
  });

  it('rejects an event whose kind is not a number', async () => {
    const { verdicts } = await drive([{ type: 'new', event: { id: 'x', kind: 'one' } }]);
    expect(verdicts[0]).toMatchObject({ id: 'x', action: 'reject' });
    expect(verdicts[0]?.msg).toBe('blocked: kind NaN is not accepted here');
  });

  it('never wedges: an event that makes the policy throw is rejected, not dropped', async () => {
    // `tags` shaped so JSON.stringify is fine but the nonce scan is not.
    const { verdicts } = await drive(
      [request({ kind: KINDS.NOTE, tags: { 0: 'nonce' } })],
      { POW_ENABLED: '1' },
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.action).toBe('reject');
  });

  it('logs only "kind=<n> <action>" — no pubkeys, ids, content or addresses', async () => {
    const { stderr } = await drive([
      request({ kind: KINDS.FLICK, content: 'the wall on 3rd' }),
      request({ kind: KINDS.DM, content: 'meet me at midnight' }),
      request({ kind: 9735, pubkey: WRITER }),
    ]);

    const lines = stderr.split('\n').filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(/^kind=\d+ (accept|reject)$/);
    expect(stderr).not.toContain(WRITER);
    expect(stderr).not.toContain('midnight');
    expect(stderr).not.toContain('3rd');
  });
});

describe('write-policy: kind allowlist', () => {
  it('accepts every kind in RELAY_ACCEPTED_KINDS', async () => {
    const kinds = [...RELAY_ACCEPTED_KINDS];
    const { verdicts } = await drive(kinds.map((kind) => request({ kind })));

    const rejected = kinds.filter((_, i) => verdicts[i]?.action !== 'accept');
    expect(rejected).toEqual([]);
  });

  it('rejects kinds 1NKY does not use', async () => {
    for (const kind of [3, 4, 7, 9735, 30023]) {
      const verdict = await decide({ kind });
      expect(verdict.action).toBe('reject');
      expect(verdict.msg).toBe(`blocked: kind ${kind} is not accepted here`);
    }
  });

  it('rejects the Blossom upload credential (24242) — it belongs in an HTTP header', async () => {
    expect((await decide({ kind: KINDS.BLOSSOM_AUTH })).action).toBe('reject');
  });

  it("matches @1nky/protocol's RELAY_ACCEPTED_KINDS exactly — no drift either way", async () => {
    // Anything in the plugin's default allowlist that protocol does not know
    // about would be silently accepted forever; anything protocol added that
    // the plugin does not have would bounce at the relay with no clue why.
    const candidates = [
      ...new Set([
        ...RELAY_ACCEPTED_KINDS,
        ...WRAP_INTERNAL_KINDS,
        KINDS.BLOSSOM_AUTH,
        3,
        4,
        7,
        9735,
        30023,
      ]),
    ];
    const { verdicts } = await drive(candidates.map((kind) => request({ kind })));

    const accepted = candidates.filter((_, i) => verdicts[i]?.action === 'accept');
    expect(new Set(accepted)).toEqual(new Set(RELAY_ACCEPTED_KINDS));
  });
});

describe('write-policy: gift-wrapped private messages', () => {
  it('accepts the gift wrap (kind 1059)', async () => {
    expect((await decide({ kind: KINDS.GIFT_WRAP })).action).toBe('accept');
  });

  it.each([KINDS.SEAL, KINDS.DM])('rejects wrap-internal kind %i as a plaintext leak', async (kind) => {
    const verdict = await decide({ kind });
    expect(verdict.action).toBe('reject');
    expect(verdict.msg).toContain('must be gift-wrapped');
    expect(verdict.msg).toContain('1059');
  });

  it('rejects 13 and 14 even when an operator allowlists them', async () => {
    // The check runs ahead of ALLOWED_KINDS precisely so this cannot be
    // misconfigured back on.
    const env = { ALLOWED_KINDS: '0,1,13,14,1059' };
    for (const kind of [13, 14]) {
      const verdict = await decide({ kind }, env);
      expect(verdict.action).toBe('reject');
      expect(verdict.msg).toContain('must be gift-wrapped');
    }
    expect((await decide({ kind: 1059 }, env)).action).toBe('accept');
  });

  it('holds gift wraps to the same 64KB cap as everything else', async () => {
    const big = await decide({ kind: KINDS.GIFT_WRAP, content: 'w'.repeat(70_000) });
    expect(big.action).toBe('reject');
    expect(big.msg).toMatch(/limit is 65536/);

    const ok = await decide({ kind: KINDS.GIFT_WRAP, content: 'w'.repeat(60_000) });
    expect(ok.action).toBe('accept');
  });

  it('charges a gift wrap the reaction tier, not the newcomer tier', async () => {
    // Every wrap carries a brand-new ephemeral pubkey, so without the reaction
    // tier the "first event from this pubkey" rule would demand 18 bits for
    // every line of every conversation.
    const env = { POW_ENABLED: '1' };
    const tags = [['nonce', '1', '8']];

    const wrap = await decide(
      { kind: KINDS.GIFT_WRAP, pubkey: 'c1'.repeat(32), id: idWithBits(8), tags },
      env,
    );
    expect(wrap.action).toBe('accept');

    // Same 8 bits from a never-before-seen pubkey on an ordinary kind: 18.
    const note = await decide(
      { kind: KINDS.NOTE, pubkey: 'c2'.repeat(32), id: idWithBits(8), tags },
      env,
    );
    expect(note.action).toBe('reject');
    expect(note.msg).toMatch(/below the required 18/);
  });

  it('does not let a flood of ephemeral wrap keys evict the seen-pubkey set', async () => {
    // A wrap's pubkey is single-use: remembering it teaches the policy nothing
    // and would push real pubkeys out of `seen`.
    const env = { POW_ENABLED: '1' };
    const ephemeral = 'e5'.repeat(32);

    const { verdicts } = await drive(
      [
        request({
          kind: KINDS.GIFT_WRAP,
          pubkey: ephemeral,
          id: idWithBits(8),
          tags: [['nonce', '1', '8']],
        }),
        // If the wrap had registered its pubkey as "seen", this would only owe
        // the 13-bit post tier and be accepted.
        request({
          kind: KINDS.NOTE,
          pubkey: ephemeral,
          id: idWithBits(13),
          tags: [['nonce', '1', '13']],
        }),
      ],
      env,
    );

    expect(verdicts[0]?.action).toBe('accept');
    expect(verdicts[1]?.action).toBe('reject');
    expect(verdicts[1]?.msg).toMatch(/below the required 18/);
  });
});

describe('write-policy: size cap', () => {
  it('rejects an event over MAX_EVENT_BYTES', async () => {
    const verdict = await decide({ kind: KINDS.NOTE, content: 'x'.repeat(70_000) });
    expect(verdict.action).toBe('reject');
    expect(verdict.msg).toMatch(/^invalid: event is \d+ bytes, limit is 65536$/);
  });

  it('honours a lowered MAX_EVENT_BYTES', async () => {
    const verdict = await decide({ kind: KINDS.NOTE, content: 'x'.repeat(400) }, {
      MAX_EVENT_BYTES: '300',
    });
    expect(verdict.msg).toMatch(/limit is 300/);
  });
});

describe('write-policy: ban list', () => {
  it('rejects a banned pubkey', async () => {
    const verdict = await decide({ kind: KINDS.NOTE, pubkey: BANNED });
    expect(verdict).toMatchObject({ action: 'reject', msg: 'blocked: this tag is banned' });
  });

  it('bans case-insensitively', async () => {
    const verdict = await decide({ kind: KINDS.NOTE, pubkey: BANNED.toUpperCase() });
    expect(verdict.msg).toBe('blocked: this tag is banned');
  });

  it('bans a gift-wrap sender too, if their ephemeral key is somehow listed', async () => {
    expect((await decide({ kind: KINDS.GIFT_WRAP, pubkey: BANNED })).msg).toBe(
      'blocked: this tag is banned',
    );
  });

  it('checks the ban before the PoW, so banned work is wasted instantly', async () => {
    const verdict = await decide(
      { kind: KINDS.NOTE, pubkey: BANNED, id: 'f'.repeat(64) },
      { POW_ENABLED: '1' },
    );
    expect(verdict.msg).toBe('blocked: this tag is banned');
  });

  it('nobody is banned when the list file is missing', async () => {
    const verdict = await decide({ kind: KINDS.NOTE, pubkey: BANNED }, {
      BAN_LIST_PATH: join(banDir, 'nope.json'),
    });
    expect(verdict.action).toBe('accept');
  });
});

describe('write-policy: NIP-13 proof of work', () => {
  const POW = { POW_ENABLED: '1' };

  it('requires a committed nonce target', async () => {
    const verdict = await decide({ kind: KINDS.NOTE, id: idWithBits(24) }, POW);
    expect(verdict.action).toBe('reject');
    expect(verdict.msg).toMatch(/missing committed difficulty/);
  });

  it('rejects a commitment below the required difficulty', async () => {
    const verdict = await decide(
      { kind: KINDS.NOTE, id: idWithBits(24), tags: [['nonce', '1', '4']] },
      POW,
    );
    expect(verdict.msg).toBe('pow: committed difficulty 4 is below the required 18');
  });

  it('rejects an id that does not reach its own committed target', async () => {
    const verdict = await decide(
      { kind: KINDS.NOTE, id: idWithBits(17), tags: [['nonce', '1', '18']] },
      POW,
    );
    expect(verdict.msg).toBe('pow: difficulty 17 does not meet the committed target 18');
  });

  it('accepts an honest 18-bit newcomer', async () => {
    const verdict = await decide(
      { kind: KINDS.NOTE, id: idWithBits(18), tags: [['nonce', '1', '18']] },
      POW,
    );
    expect(verdict.action).toBe('accept');
  });

  it('drops a returning writer to the 13-bit post tier', async () => {
    const pubkey = 'd1'.repeat(32);
    const { verdicts } = await drive(
      [
        request({ kind: KINDS.NOTE, pubkey, id: idWithBits(18), tags: [['nonce', '1', '18']] }),
        request({ kind: KINDS.NOTE, pubkey, id: idWithBits(13), tags: [['nonce', '1', '13']] }),
        request({ kind: KINDS.NOTE, pubkey, id: idWithBits(12), tags: [['nonce', '1', '12']] }),
      ],
      POW,
    );
    expect(verdicts[0]?.action).toBe('accept');
    expect(verdicts[1]?.action).toBe('accept');
    expect(verdicts[2]?.msg).toMatch(/below the required 13/);
  });

  it('always charges POW_NEW_KINDS the newcomer tier, even for a known writer', async () => {
    const pubkey = 'd2'.repeat(32);
    const { verdicts } = await drive(
      [
        request({ kind: KINDS.NOTE, pubkey, id: idWithBits(18), tags: [['nonce', '1', '18']] }),
        request({ kind: KINDS.PROFILE, pubkey, id: idWithBits(13), tags: [['nonce', '1', '13']] }),
      ],
      POW,
    );
    expect(verdicts[0]?.action).toBe('accept');
    expect(verdicts[1]?.msg).toMatch(/below the required 18/);
  });

  it('charges reports and mute lists the 8-bit reaction tier', async () => {
    for (const kind of [KINDS.REPORT, KINDS.MUTE_LIST]) {
      const verdict = await decide(
        { kind, pubkey: 'd3'.repeat(32), id: idWithBits(8), tags: [['nonce', '1', '8']] },
        POW,
      );
      expect(verdict.action).toBe('accept');
    }
  });

  it('charges an amendment the post tier, like the comment it sits beside', async () => {
    // An amendment adds content — a mention on one lands in somebody's
    // shout-outs — so it must NOT be in POW_REACTION_KINDS. It has no tier of
    // its own: falling through to POW_BITS_POST is the whole intent.
    const pubkey = 'd4'.repeat(32);
    const { verdicts } = await drive(
      [
        request({ kind: KINDS.NOTE, pubkey, id: idWithBits(18), tags: [['nonce', '1', '18']] }),
        request({
          kind: KINDS.AMENDMENT,
          pubkey,
          id: idWithBits(13),
          tags: [['nonce', '1', '13']],
        }),
        request({
          kind: KINDS.AMENDMENT,
          pubkey,
          id: idWithBits(8),
          tags: [['nonce', '1', '8']],
        }),
      ],
      POW,
    );
    expect(verdicts[0]?.action).toBe('accept');
    expect(verdicts[1]?.action).toBe('accept');
    expect(verdicts[2]?.msg).toMatch(/below the required 13/);
  });

  it('takes the first nonce tag, so a second one cannot launder the target', async () => {
    const verdict = await decide(
      {
        kind: KINDS.NOTE,
        id: idWithBits(4),
        tags: [
          ['nonce', '1', '4'],
          ['nonce', '2', '18'],
        ],
      },
      POW,
    );
    expect(verdict.msg).toMatch(/below the required 18/);
  });

  it('skips the gate entirely when POW_ENABLED=0', async () => {
    expect((await decide({ kind: KINDS.NOTE, id: 'f'.repeat(64) })).action).toBe('accept');
  });
});

describe('write-policy: invited writers ("getting put on")', () => {
  const POW = { POW_ENABLED: '1' };

  it('never charges an invited pubkey the newcomer tier', async () => {
    // Never seen before by this process, so without the invited list this would
    // owe 18 bits.
    const verdict = await decide(
      { kind: KINDS.NOTE, pubkey: INVITED, id: idWithBits(13), tags: [['nonce', '1', '13']] },
      POW,
    );
    expect(verdict.action).toBe('accept');
  });

  it('still holds an invited pubkey to the post tier — invited is not free', async () => {
    const verdict = await decide(
      { kind: KINDS.NOTE, pubkey: INVITED, id: idWithBits(12), tags: [['nonce', '1', '12']] },
      POW,
    );
    expect(verdict.action).toBe('reject');
    expect(verdict.msg).toMatch(/below the required 13/);
  });

  it('drops POW_NEW_KINDS to the post tier for an invited pubkey, so profile edits stay cheap', async () => {
    const verdict = await decide(
      { kind: KINDS.PROFILE, pubkey: INVITED, id: idWithBits(13), tags: [['nonce', '1', '13']] },
      POW,
    );
    expect(verdict.action).toBe('accept');
  });

  it('leaves the reaction tier alone — already the cheapest', async () => {
    const verdict = await decide(
      { kind: KINDS.REPORT, pubkey: INVITED, id: idWithBits(8), tags: [['nonce', '1', '8']] },
      POW,
    );
    expect(verdict.action).toBe('accept');
  });

  it('does not exempt a banned pubkey that somehow appears on both lists', async () => {
    const bothPath = join(banDir, 'invited-banned.json');
    writeFileSync(bothPath, JSON.stringify([BANNED]), 'utf8');
    const verdict = await decide({ kind: KINDS.NOTE, pubkey: BANNED }, {
      ...POW,
      INVITED_LIST_PATH: bothPath,
    });
    expect(verdict.msg).toBe('blocked: this tag is banned');
  });

  it('nobody is invited when the list file is missing', async () => {
    const verdict = await decide(
      { kind: KINDS.NOTE, pubkey: INVITED, id: idWithBits(13), tags: [['nonce', '1', '13']] },
      { ...POW, INVITED_LIST_PATH: join(banDir, 'no-invited.json') },
    );
    expect(verdict.action).toBe('reject');
    expect(verdict.msg).toMatch(/below the required 18/);
  });

  it('accepts the object entry shape too, like the ban list', async () => {
    const objPath = join(banDir, 'invited-objects.json');
    writeFileSync(objPath, JSON.stringify([{ pubkey: INVITED.toUpperCase() }]), 'utf8');
    const verdict = await decide(
      { kind: KINDS.NOTE, pubkey: INVITED, id: idWithBits(13), tags: [['nonce', '1', '13']] },
      { ...POW, INVITED_LIST_PATH: objPath },
    );
    expect(verdict.action).toBe('accept');
  });

  it('says nothing about the invited list on stderr', async () => {
    const { stderr } = await drive(
      [request({ kind: KINDS.NOTE, pubkey: INVITED, id: idWithBits(13), tags: [['nonce', '1', '13']] })],
      POW,
    );
    expect(stderr.split('\n').filter((l) => l.trim() !== '')).toEqual(['kind=1 accept']);
    expect(stderr).not.toContain(INVITED);
  });
});
