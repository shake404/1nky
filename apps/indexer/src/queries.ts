import type {
  AmendmentRow,
  BanRow,
  BoardRow,
  CommentRow,
  CrewBadgeRow,
  CrewRow,
  DeletionRow,
  EventRow,
  FlickRow,
  InviteRedemption,
  InviteRow,
  MentionRow,
  ProfileRow,
  ReportRow,
  ThreadRow,
  VideoRow,
} from './mappers.js';
import type { Sql } from './types.js';

/**
 * Pure SQL builders. Every statement the indexer runs is produced here as
 * `{ text, params }` so it can be asserted in a unit test without a database.
 * No string interpolation of values — ever. Only bind parameters.
 */
export type { Sql };

const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export function upsertEvent(row: EventRow): Sql {
  return {
    text: `insert into events (id, pubkey, kind, created_at, content, tags, raw, expires_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
           on conflict (id) do nothing`,
    params: [
      row.id,
      row.pubkey,
      row.kind,
      row.created_at,
      row.content,
      row.tags,
      row.raw,
      row.expires_at,
    ],
  };
}

// ---------------------------------------------------------------------------
// derived tables
// ---------------------------------------------------------------------------

export function upsertProfile(row: ProfileRow): Sql {
  return {
    text: `insert into profiles (pubkey, tag_name, city, about, avatar_sha256, crews, first_seen, updated_at)
           values ($1, $2, $3, $4, $5, $6::text[], $7, $8)
           on conflict (pubkey) do update set
             tag_name      = excluded.tag_name,
             city          = excluded.city,
             about         = excluded.about,
             avatar_sha256 = excluded.avatar_sha256,
             crews         = excluded.crews,
             first_seen    = least(profiles.first_seen, excluded.first_seen),
             updated_at    = excluded.updated_at
            where excluded.updated_at >= profiles.updated_at`,
    params: [
      row.pubkey,
      row.tag_name,
      row.city,
      row.about,
      row.avatar_sha256,
      row.crews,
      row.first_seen,
      row.updated_at,
    ],
  };
}

export function upsertFlick(row: FlickRow): Sql {
  return {
    text: `insert into flicks (event_id, pubkey, created_at, url, sha256, width, height, blurhash, caption, boards)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[])
           on conflict (event_id) do update set
             url      = excluded.url,
             sha256   = excluded.sha256,
             width    = excluded.width,
             height   = excluded.height,
             blurhash = excluded.blurhash,
             caption  = excluded.caption,
             boards   = excluded.boards`,
    params: [
      row.event_id,
      row.pubkey,
      row.created_at,
      row.url,
      row.sha256,
      row.width,
      row.height,
      row.blurhash,
      row.caption,
      row.boards,
    ],
  };
}

export function upsertVideo(row: VideoRow): Sql {
  return {
    text: `insert into videos (event_id, pubkey, created_at, url, sha256, poster_url, duration, width, height, blurhash, caption, boards)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[])
           on conflict (event_id) do update set
             url        = excluded.url,
             sha256     = excluded.sha256,
             poster_url = excluded.poster_url,
             duration   = excluded.duration,
             width      = excluded.width,
             height     = excluded.height,
             blurhash   = excluded.blurhash,
             caption    = excluded.caption,
             boards     = excluded.boards`,
    params: [
      row.event_id,
      row.pubkey,
      row.created_at,
      row.url,
      row.sha256,
      row.poster_url,
      row.duration,
      row.width,
      row.height,
      row.blurhash,
      row.caption,
      row.boards,
    ],
  };
}

/**
 * A kind-1 thread OP. `do nothing` rather than `do update`: a kind 1 is not
 * replaceable, so the same event id always carries the same subject, boards and
 * happening date, and a re-delivery has nothing to say. (`upsertEvent` already
 * short-circuits the duplicate before this runs; this is the second lock.)
 *
 * `happening_at` is null for an ordinary thread and the event's `when` tag for a
 * happening — one column, read from the event, so a rebuild reproduces it.
 */
export function upsertThread(row: ThreadRow): Sql {
  return {
    text: `insert into threads (event_id, pubkey, subject, boards, created_at, happening_at)
           values ($1, $2, $3, $4::text[], $5, $6)
           on conflict (event_id) do nothing`,
    params: [row.event_id, row.pubkey, row.subject, row.boards, row.created_at, row.happening_at],
  };
}

export function upsertComment(row: CommentRow): Sql {
  return {
    text: `insert into comments (event_id, parent_id, root_id, pubkey, created_at, content)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (event_id) do update set
             parent_id = excluded.parent_id,
             root_id   = excluded.root_id,
             content   = excluded.content`,
    params: [row.event_id, row.parent_id, row.root_id, row.pubkey, row.created_at, row.content],
  };
}

/**
 * One deliberate @-mention (migration 009). `do nothing` on conflict: a kind
 * 1111 is not replaceable, so the same comment always names the same writers,
 * and a re-delivery has nothing to say.
 */
export function insertMention(row: MentionRow): Sql {
  return {
    text: `insert into mentions (event_id, mentioned_pubkey, author_pubkey, root_id, created_at)
           values ($1, $2, $3, $4, $5)
           on conflict (event_id, mentioned_pubkey) do nothing`,
    params: [row.event_id, row.mentioned_pubkey, row.author_pubkey, row.root_id, row.created_at],
  };
}

// ---------------------------------------------------------------------------
// Amendments — kind 1113, "Add to this" (migration 010)
// ---------------------------------------------------------------------------

/**
 * Record the amendment itself. `do nothing` on conflict: a kind 1113 is not
 * replaceable, so the same event id always adds the same tags.
 *
 * Stored whether or not it applies to anything yet — that is the whole point.
 * The relay hands back stored events newest first, so on a rebuild an amendment
 * routinely arrives before the post it amends; the row waits here until the
 * target lands and `selectPendingAmendments` replays it.
 */
export function insertAmendment(row: AmendmentRow): Sql {
  return {
    text: `insert into amendments (event_id, target_id, author_pubkey, boards, mentions, created_at)
           values ($1, $2, $3, $4::text[], $5::text[], $6)
           on conflict (event_id) do nothing`,
    params: [
      row.event_id,
      row.target_id,
      row.author_pubkey,
      row.boards,
      row.mentions,
      row.created_at,
    ],
  };
}

/** The derived tables an amendment can add board slugs to. */
export const AMENDABLE_TABLES = ['flicks', 'videos', 'threads'] as const;
export type AmendableTable = (typeof AMENDABLE_TABLES)[number];

/**
 * Merge an amendment's board slugs into the target's `boards` array.
 *
 * THE AUTHORSHIP RULE IS THIS `where` CLAUSE. `event_id = $1 and pubkey = $2`
 * says: the post exists, and the writer amending it is the writer who put it up.
 * In SQL rather than as a read-then-write, exactly like `buffDelete`'s ownership
 * predicate, so a forged amendment cannot race a legitimate one — and so a
 * BUFFED post (hard-deleted, cascading this table's target away from `events`)
 * matches nothing and quietly stays buffed.
 *
 * The merge appends only slugs not already present, which keeps the original's
 * tag order intact and makes a re-delivery a no-op. It is a set union: add-only
 * semantics mean applying the same amendment twice, or two amendments in either
 * order, always lands on the same set. `rowCount` is 0 when the guard refused —
 * which is also how the caller knows not to register the boards.
 *
 * `table` is interpolated from {@link AMENDABLE_TABLES}, never from a value.
 */
export function applyAmendmentBoards(
  table: AmendableTable,
  row: Pick<AmendmentRow, 'target_id' | 'author_pubkey' | 'boards'>,
): Sql {
  return {
    text: `update ${table} as t
              set boards = t.boards || coalesce(
                    (select array_agg(s) from unnest($3::text[]) as s where s <> all(t.boards)),
                    '{}'::text[])
            where t.event_id = $1
              and t.pubkey = $2`,
    params: [row.target_id, row.author_pubkey, row.boards],
  };
}

/**
 * File one mention from an amendment — but only if the amended post is really
 * there, really this author's, and really something that can be amended.
 *
 * The `where exists` is the same guard `applyAmendmentBoards` gets from its
 * `where`, spelled out because an insert has no target row to constrain: without
 * it, an amendment naming a stranger against a buffed (or invented, or somebody
 * else's) event id would put a row in a writer's shout-outs pointing at nothing.
 * A mention is the one part of an amendment that reaches another person, so it
 * is the part that must not fire on an unverifiable target.
 */
export function insertAmendmentMention(row: MentionRow, amendableKinds: readonly number[]): Sql {
  return {
    text: `insert into mentions (event_id, mentioned_pubkey, author_pubkey, root_id, created_at)
           select $1, $2, $3, $4, $5
           where exists (
             select 1 from events e
              where e.id = $4
                and e.pubkey = $3
                and e.kind = any($6::int[])
           )
           on conflict (event_id, mentioned_pubkey) do nothing`,
    params: [
      row.event_id,
      row.mentioned_pubkey,
      row.author_pubkey,
      row.root_id,
      row.created_at,
      [...amendableKinds],
    ],
  };
}

/**
 * Every amendment already filed against a post by the writer who put it up.
 *
 * Run once, when the post itself is indexed, to catch the amendments that
 * arrived first. `author_pubkey = $2` (the target's own pubkey) is the second
 * place authorship is enforced: a stranger's amendment is in the table but is
 * never selected here. Ordered so a replay is deterministic.
 */
export function selectPendingAmendments(targetId: string, authorPubkey: string): Sql {
  return {
    text: `select event_id, target_id, author_pubkey, boards, mentions, created_at
             from amendments
            where target_id = $1
              and author_pubkey = $2
            order by created_at asc, event_id asc`,
    params: [targetId, authorPubkey],
  };
}

export function upsertReport(row: ReportRow): Sql {
  return {
    text: `insert into reports (event_id, reporter, target_pubkey, target_event, reason, note, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (event_id) do nothing`,
    params: [
      row.event_id,
      row.reporter,
      row.target_pubkey,
      row.target_event,
      row.reason,
      row.note,
      row.created_at,
    ],
  };
}

export function upsertDeletion(row: DeletionRow): Sql {
  return {
    text: `insert into deletions (event_id, pubkey, targets, created_at)
           values ($1, $2, $3::text[], $4)
           on conflict (event_id) do nothing`,
    params: [row.event_id, row.pubkey, row.targets, row.created_at],
  };
}

/**
 * `registry` rows come from the site-key-signed kind 30078 event and win.
 * `discovered` rows are inferred from a flick's `t` tags and never overwrite
 * a real title. A registry entry may also set a city's parent `region_slug`
 * (and never unsets one it does not declare, via `coalesce`).
 */
export function upsertBoard(row: BoardRow, source: 'registry' | 'discovered'): Sql {
  const conflict =
    source === 'registry'
      ? `do update set title = excluded.title,
                       kind = excluded.kind,
                       region_slug = coalesce(excluded.region_slug, boards.region_slug),
                       created_by = coalesce(excluded.created_by, boards.created_by),
                       created_at = least(boards.created_at, excluded.created_at)`
      : `do update set created_at = least(boards.created_at, excluded.created_at)`;

  return {
    text: `insert into boards (slug, title, kind, created_by, created_at, region_slug)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (slug) ${conflict}`,
    params: [row.slug, row.title, row.kind, row.created_by, row.created_at, row.region_slug ?? null],
  };
}

// ---------------------------------------------------------------------------
// crews (kind 30078 d:crew) and crew_badges (kind 30078 d:crew-badges)
// ---------------------------------------------------------------------------

export function upsertCrew(row: CrewRow): Sql {
  return {
    text: `insert into crews (crew_pubkey, name, mark, founder_pubkey, founded_at, members, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6::text[], $7, $8)
           on conflict (crew_pubkey) do update set
             name           = excluded.name,
             mark           = excluded.mark,
             founder_pubkey = excluded.founder_pubkey,
             founded_at     = excluded.founded_at,
             members        = excluded.members,
             updated_at     = excluded.updated_at
           where excluded.updated_at >= crews.updated_at`,
    params: [
      row.crew_pubkey,
      row.name,
      row.mark,
      row.founder_pubkey,
      row.founded_at,
      row.members,
      row.created_at,
      row.updated_at,
    ],
  };
}

export function upsertCrewBadge(row: CrewBadgeRow): Sql {
  return {
    text: `insert into crew_badges (crew_pubkey, verified_at, verified_by)
           values ($1, $2, $3)
           on conflict (crew_pubkey) do update set
             verified_at = excluded.verified_at,
             verified_by  = excluded.verified_by`,
    params: [row.crew_pubkey, row.verified_at, row.verified_by],
  };
}

// ---------------------------------------------------------------------------
// pubkey_stats
// ---------------------------------------------------------------------------

/** Called once per event actually inserted (not once per event received). */
export function touchPubkeyStats(pubkey: string, createdAt: number): Sql {
  return {
    text: `insert into pubkey_stats (pubkey, first_event_at, event_count, report_count)
           values ($1, $2, 1, 0)
           on conflict (pubkey) do update set
             first_event_at = least(pubkey_stats.first_event_at, excluded.first_event_at),
             event_count    = pubkey_stats.event_count + 1`,
    params: [pubkey, createdAt],
  };
}

/** Bumps the *reported* writer's counter, not the reporter's. */
export function incrementReportCount(targetPubkey: string, createdAt: number): Sql {
  return {
    text: `insert into pubkey_stats (pubkey, first_event_at, event_count, report_count)
           values ($1, $2, 0, 1)
           on conflict (pubkey) do update set
             first_event_at = least(pubkey_stats.first_event_at, excluded.first_event_at),
             report_count   = pubkey_stats.report_count + 1`,
    params: [targetPubkey, createdAt],
  };
}

// ---------------------------------------------------------------------------
// banned_pubkeys — operator state, written only from a moderator's kind 30078
// ---------------------------------------------------------------------------

/**
 * Apply a ban.
 *
 * The `where` clause is the parameterized-replaceable rule, in SQL rather than
 * in a read-then-write: a mod action whose `created_at` is OLDER than the one
 * already applied to this target loses. Relays hand events back slightly out of
 * order and the indexer replays an overlap window on every reconnect, so
 * without this a stale ban could resurrect a lifted one. `rowCount` is 0 when
 * the guard rejects the update, which is also how the caller knows there is
 * nothing new to export.
 */
export function upsertBan(row: BanRow): Sql {
  return {
    text: `insert into banned_pubkeys (pubkey, reason, banned_at, banned_by)
           values ($1, $2, $3, $4)
           on conflict (pubkey) do update set
             reason    = excluded.reason,
             banned_at = excluded.banned_at,
             banned_by = excluded.banned_by
           where excluded.banned_at >= banned_pubkeys.banned_at`,
    params: [row.pubkey, row.reason, row.banned_at, row.banned_by],
  };
}

/**
 * Lift a ban. `banned_at <= $2` is the same no-regression rule from the other
 * side: an unban signed BEFORE the ban currently in force must not delete it.
 */
export function deleteBan(pubkey: string, createdAt: number): Sql {
  return {
    text: `delete from banned_pubkeys where pubkey = $1 and banned_at <= $2`,
    params: [pubkey, createdAt],
  };
}

/**
 * Every ban, for the strfry ban-list export. Ordered so the exported file is
 * byte-stable and a no-op export does not churn the write policy's mtime check.
 * Only the two columns the relay can use — nothing about who banned whom leaves
 * Postgres.
 */
export function selectBanList(): Sql {
  return {
    text: `select pubkey, reason from banned_pubkeys order by pubkey`,
    params: [],
  };
}

/**
 * Ban every writer reachable *through invite edges* from `rootPubkey`, and
 * attribute all of it to the same moderator and the same instant as the ban that
 * asked for it. The root itself is banned by `upsertBan`; this is the cascade.
 *
 * `union` (not `union all`) is doing real work: it deduplicates, which is what
 * makes the recursion terminate even if the edges contain a cycle. A cycle is
 * possible in principle — A puts B on, then later B puts A on, which is legal
 * because A had no parent at the time — and `union all` would spin forever on it.
 *
 * The `where excluded.banned_at >= banned_pubkeys.banned_at` guard is the same
 * no-regression rule `upsertBan` uses: a descendant who already carries a NEWER
 * ban (their own, for their own reasons) keeps it rather than having its reason
 * and timestamp overwritten by this cascade.
 *
 * There is deliberately no unban counterpart. Lifting a ban never cascades:
 * each descendant may have earned theirs since, and a moderator who wants a
 * branch back signs an unban per writer.
 */
export function banSubtree(row: BanRow): Sql {
  return {
    text: `with recursive descendants as (
             select child from invite_edges where parent = $1
             union
             select e.child from invite_edges e join descendants d on e.parent = d.child
           )
           insert into banned_pubkeys (pubkey, reason, banned_at, banned_by)
           select d.child, $2, $3, $4 from descendants d
           on conflict (pubkey) do update set
             reason    = excluded.reason,
             banned_at = excluded.banned_at,
             banned_by = excluded.banned_by
           where excluded.banned_at >= banned_pubkeys.banned_at`,
    params: [row.pubkey, row.reason, row.banned_at, row.banned_by],
  };
}

// ---------------------------------------------------------------------------
// invites / invite_edges — "getting put on". Both DERIVED (see DERIVED_TABLES).
// ---------------------------------------------------------------------------

/**
 * Mint an invite. FIRST MINT WINS: `do nothing` on conflict, so a second event
 * claiming an id that is already in the table changes nothing — an inviter
 * cannot retroactively take over an id somebody else published, and a replayed
 * firehose cannot move an invite's inviter or timestamp.
 *
 * A BANNED pubkey mints nothing. That is the `where not exists` on the insert's
 * SELECT rather than a read-then-write, so a ban landing concurrently cannot be
 * raced. `rowCount` is 0 when either rule refused it.
 */
export function upsertInvite(row: InviteRow): Sql {
  return {
    text: `insert into invites (invite_id, inviter, created_at)
           select $1, $2, $3
           where not exists (select 1 from banned_pubkeys b where b.pubkey = $2)
           on conflict (invite_id) do nothing`,
    params: [row.invite_id, row.inviter, row.created_at],
  };
}

/**
 * Mark an invite redeemed — and refuse to, in SQL, unless every rule holds.
 *
 * All five checks are predicates on this one UPDATE rather than a read followed
 * by a write, so two redemptions arriving together cannot both win:
 *
 *   1. `invite_id = $1` — the invite exists at all
 *   2. `inviter = $2`   — the claim names the pubkey that actually minted it.
 *                         The code carries both halves, so a forged pairing is
 *                         refused instead of silently re-parented
 *   3. `inviter <> $3`  — nobody puts themselves on
 *   4. `redeemed_by is null or redeemed_by = $3` — unredeemed, or already
 *                         redeemed by THIS writer, which is what makes a
 *                         replayed kind-0 idempotent instead of a conflict
 *   5. the inviter is not banned, and the child has no edge yet (one parent,
 *      forever — the first redemption that lands is the one that sticks)
 *
 * `rowCount` 0 means the claim was refused. The caller counts nothing, inserts
 * no edge and logs nothing: an invalid redemption is silently ignored, because
 * the alternative is a log line naming pubkeys.
 */
export function redeemInvite(redemption: InviteRedemption): Sql {
  return {
    text: `update invites
              set redeemed_by = $3,
                  redeemed_at = $4
            where invite_id = $1
              and inviter = $2
              and inviter <> $3
              and (redeemed_by is null or redeemed_by = $3)
              and not exists (select 1 from banned_pubkeys b where b.pubkey = invites.inviter)
              and not exists (select 1 from invite_edges e where e.child = $3)`,
    params: [
      redemption.invite_id,
      redemption.inviter,
      redemption.child,
      redemption.redeemed_at,
    ],
  };
}

/**
 * Record the edge. `child` is the primary key and the conflict is `do nothing`,
 * so the one-parent-forever rule is enforced by the schema and not by trust in
 * the caller. Only ever run after `redeemInvite` returned a row.
 */
export function insertInviteEdge(redemption: InviteRedemption): Sql {
  return {
    text: `insert into invite_edges (child, parent, invite_id, redeemed_at)
           values ($1, $2, $3, $4)
           on conflict (child) do nothing`,
    params: [
      redemption.child,
      redemption.inviter,
      redemption.invite_id,
      redemption.redeemed_at,
    ],
  };
}

/**
 * Every writer who was put on, for the invited-list export the relay's write
 * policy hot-reloads. Ordered so the exported file is byte-stable — the policy
 * reloads on any mtime/size change, and a no-op export should not trigger one.
 *
 * One column. The relay has no use for who invited whom, so it never leaves
 * Postgres.
 */
export function selectInvitedList(): Sql {
  return {
    text: `select child as pubkey from invite_edges order by child`,
    params: [],
  };
}

// ---------------------------------------------------------------------------
// buff (kind 5)
// ---------------------------------------------------------------------------

export interface BuffPlan {
  /** The signer of the kind-5 event. Only their own rows may be removed. */
  pubkey: string;
  /** Well-formed event ids named by the request. */
  targets: string[];
  /** Ids that were named but rejected as malformed. Counted, never logged. */
  rejected: number;
  /**
   * True when the signer is a site moderator — a takedown rather than a
   * self-buff, so the ownership check is dropped. Only the store sets this, and
   * only after comparing the signer against `SITE_MOD_PUBKEYS`.
   */
  mod: boolean;
}

/**
 * The buff rule, in one place: a writer may delete their own events and
 * nobody else's. Ownership is enforced in SQL (`pubkey = $2`) rather than by
 * a read-then-write, so a forged deletion cannot race a legitimate one.
 *
 * `isMod` is the single exception, and it is off by default: a moderator's
 * kind-5 is a takedown and reaches any author's event.
 */
export function buffPlan(
  deletion: Pick<DeletionRow, 'pubkey' | 'targets'>,
  isMod = false,
): BuffPlan {
  const targets: string[] = [];
  let rejected = 0;
  for (const id of new Set(deletion.targets)) {
    if (HEX64.test(id)) targets.push(id);
    else rejected += 1;
  }
  return { pubkey: deletion.pubkey, targets, rejected, mod: isMod };
}

/**
 * Hard-delete. `flicks`, `comments`, `reports` and `deletions` all reference
 * `events(id) on delete cascade`, so removing the event row removes every
 * derived row with it.
 *
 * A moderator takedown omits the ownership predicate. Nothing else does, and
 * the only caller that can set `plan.mod` has already checked the signer.
 */
export function buffDelete(plan: BuffPlan): Sql {
  if (plan.mod) {
    return {
      text: `delete from events where id = any($1::text[])`,
      params: [plan.targets],
    };
  }
  return {
    text: `delete from events where id = any($1::text[]) and pubkey = $2`,
    params: [plan.targets, plan.pubkey],
  };
}

// ---------------------------------------------------------------------------
// NIP-40 sweep
// ---------------------------------------------------------------------------

/**
 * The periodic expiration sweep. Runs every `SWEEP_INTERVAL_MS` (60s default).
 * Rows whose expiry has passed are gone from the index even if the relay has
 * not got round to purging them yet.
 */
export function expirationSweep(nowSeconds: number): Sql {
  return {
    text: `delete from events where expires_at is not null and expires_at <= $1`,
    params: [nowSeconds],
  };
}

// ---------------------------------------------------------------------------
// watermark
// ---------------------------------------------------------------------------

export const SYNC_STATE_ID = 'relay';

export function readWatermark(): Sql {
  return {
    text: `select last_created_at from sync_state where id = $1`,
    params: [SYNC_STATE_ID],
  };
}

/** Monotonic: a late out-of-order event never rewinds the stored watermark. */
export function writeWatermark(createdAt: number): Sql {
  return {
    text: `insert into sync_state (id, last_created_at, updated_at)
           values ($1, $2, now())
           on conflict (id) do update set
             last_created_at = greatest(sync_state.last_created_at, excluded.last_created_at),
             updated_at      = now()`,
    params: [SYNC_STATE_ID, createdAt],
  };
}

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

/**
 * Everything derived from the relay. `banned_pubkeys` is intentionally absent:
 * it is operator state, and a rebuild must not unban anyone.
 */
export const DERIVED_TABLES = [
  'events',
  'flicks',
  'videos',
  'threads',
  'profiles',
  'comments',
  'mentions',
  'amendments',
  'reports',
  'deletions',
  'boards',
  'crews',
  'crew_badges',
  'invites',
  'invite_edges',
  'pubkey_stats',
  'sync_state',
] as const;

export function truncateDerived(): Sql {
  return {
    text: `truncate table ${DERIVED_TABLES.join(', ')} restart identity cascade`,
    params: [],
  };
}
