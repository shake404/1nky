import { Router } from 'express';

import { parseHexId, parseLimit, requireModKey } from '../http.js';
import {
  banlistQuery,
  inviteEdgesQuery,
  inviteNodeQuery,
  inviteRootsQuery,
  inviteSubtreeEdgesQuery,
  modQueueQuery,
} from '../queries.js';
import { buildInviteForest, type InviteNodeSource, markOf, num } from '../shape.js';
import type { Deps } from './deps.js';

interface QueueRow {
  event_id: string;
  reporter: string;
  target_pubkey: string | null;
  target_event: string | null;
  reason: string | null;
  note: string | null;
  created_at: number | string;
  target_kind: number | null;
  target_content: string | null;
  target_created_at: number | string | null;
  thumbnail_url: string | null;
  thumbnail_blurhash: string | null;
  target_boards: string[] | null;
  target_tag_name: string | null;
  reporter_first_event_at: number | string | null;
  reporter_event_count: number | string;
  reporter_report_count: number | string;
  target_report_count: number | string;
  target_banned: boolean;
}

interface BanRow {
  pubkey: string;
  reason: string | null;
  banned_at: number | string;
  banned_by: string | null;
  report_count: number | string;
  event_count: number | string;
}

/**
 * `GET /mod/queue`, `/mod/banlist` and `/mod/tree`, gated by `X-Mod-Key`.
 *
 * Read-only, like everything else here. A takedown is a signed event from a
 * mod key published to the relay, not a POST to this service — that is what
 * makes the moderation log auditable. `/mod/tree` is a *preview*: the ban it
 * informs is still a signed kind-30078 with `subtree: true`.
 */
export function modRoutes({ db, config }: Deps): Router {
  const router = Router();
  router.use('/mod', requireModKey(config));

  router.get('/mod/queue', async (req, res) => {
    const limit = parseLimit(req.query['limit'], config);
    const sql = modQueueQuery(limit);
    const { rows } = await db.query<QueueRow>(sql.text, sql.params);

    res.json({
      reports: rows.map((row) => ({
        id: row.event_id,
        createdAt: num(row.created_at),
        reason: row.reason,
        note: row.note ?? '',
        reporter: {
          pubkey: row.reporter,
          mark: markOf(row.reporter),
          firstEventAt:
            row.reporter_first_event_at === null ? null : num(row.reporter_first_event_at),
          eventCount: num(row.reporter_event_count),
          // How many reports this writer has *received*. A reporter with a
          // pile of their own reports is worth a second look.
          reportCount: num(row.reporter_report_count),
        },
        target: {
          pubkey: row.target_pubkey,
          tag: row.target_tag_name,
          mark: row.target_pubkey ? markOf(row.target_pubkey) : null,
          eventId: row.target_event,
          kind: row.target_kind,
          content: row.target_content,
          createdAt: row.target_created_at === null ? null : num(row.target_created_at),
          thumbnailUrl: row.thumbnail_url,
          blurhash: row.thumbnail_blurhash,
          boards: row.target_boards ?? [],
          reportCount: num(row.target_report_count),
          banned: row.target_banned === true,
          // Null when the reported event is already gone (buffed, expired, or
          // taken down) — the report stays in the queue as a record.
          present: row.target_kind !== null,
        },
      })),
    });
  });

  router.get('/mod/banlist', async (_req, res) => {
    const sql = banlistQuery();
    const { rows } = await db.query<BanRow>(sql.text, sql.params);

    res.json({
      banned: rows.map((row) => ({
        pubkey: row.pubkey,
        mark: markOf(row.pubkey),
        reason: row.reason,
        bannedAt: num(row.banned_at),
        bannedBy: row.banned_by,
        reportCount: num(row.report_count),
        eventCount: num(row.event_count),
      })),
    });
  });

  /**
   * `GET /mod/tree` — the whole invite forest.
   *
   * Only writers with an edge appear: a root is somebody who put others on and
   * was never put on themselves, so a writer with no invites either way is
   * simply not in the forest. Capped at depth 12 / 2000 nodes, with
   * `truncated: true` when either bites — a moderator about to ban a branch has
   * to know whether they are seeing all of it.
   */
  router.get('/mod/tree', async (_req, res) => {
    const rootsSql = inviteRootsQuery();
    const roots = await db.query<InviteNodeSource>(rootsSql.text, rootsSql.params);

    const edgesSql = inviteEdgesQuery();
    const edges = await db.query<InviteNodeSource>(edgesSql.text, edgesSql.params);

    const forest = buildInviteForest(roots.rows, edges.rows);
    res.json(forest);
  });

  /**
   * `GET /mod/tree/:pubkey` — the branch below one writer.
   *
   * This is what the console's "ban the whole branch" preview reads, so it walks
   * `invite_edges` with the same recursive CTE the indexer's cascade uses. The
   * root is always returned, even for a writer with no profile and no invites: a
   * lone node with zeroes is the true answer and a 404 would read like a fault.
   */
  router.get('/mod/tree/:pubkey', async (req, res) => {
    const pubkey = parseHexId(req.params['pubkey'], 'writer id');

    const nodeSql = inviteNodeQuery(pubkey);
    const node = await db.query<InviteNodeSource>(nodeSql.text, nodeSql.params);

    const edgesSql = inviteSubtreeEdgesQuery(pubkey);
    const edges = await db.query<InviteNodeSource>(edgesSql.text, edgesSql.params);

    const rootRows = node.rows.length > 0 ? node.rows : [{ pubkey }];
    const forest = buildInviteForest(rootRows, edges.rows);
    res.json(forest);
  });

  return router;
}
