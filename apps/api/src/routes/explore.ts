import { normalizeBoard } from '@1nky/protocol';
import { Router } from 'express';

import { nextCursor } from '../cursor.js';
import { manyParam, oneParam, parseCursor, parseLimit } from '../http.js';
import { exploreFacetsQuery, exploreQuery } from '../queries.js';
import { type FeedItemSource, shapeFeedItem } from '../shape.js';
import type { Deps } from './deps.js';

/**
 * Explore — browse the unified media feed by location and by type, combined.
 *
 * Facet values in URLs are bare (`?type=throwie`); the query builder adds the
 * `type-` prefix server-side so the URL stays readable. AND across facets, OR
 * within a repeated facet (`?type=throwie&type=piece`).
 */
export function exploreRoutes({ db, config }: Deps): Router {
  const router = Router();

  router.get('/explore/facets', async (_req, res) => {
    const sql = exploreFacetsQuery();
    const { rows } = await db.query<{ slug: string; item_count: number | string }>(sql.text, sql.params);

    const cities: { slug: string; count: number }[] = [];
    const types: { slug: string; count: number }[] = [];
    const surfaces: { slug: string; count: number }[] = [];
    const regions: { slug: string; count: number }[] = [];

    for (const row of rows) {
      const slug = row.slug;
      const count = typeof row.item_count === 'number' ? row.item_count : Number.parseInt(row.item_count, 10);
      const n = Number.isFinite(count) ? count : 0;
      if (slug.startsWith('type-')) types.push({ slug: slug.slice(5), count: n });
      else if (slug.startsWith('surface-')) surfaces.push({ slug: slug.slice(8), count: n });
      else if (slug.startsWith('region-')) regions.push({ slug: slug.slice(7), count: n });
      else if (slug === 'legal-permission') {
        // The legal facet is a single chip, not a countable group here.
      } else cities.push({ slug, count: n });
    }

    res.json({ cities, types, surfaces, regions });
  });

  router.get('/explore', async (req, res) => {
    const city = manyParam(req.query['city']).map(normalizeBoard).filter((s) => s !== '');
    const type = manyParam(req.query['type']);
    const surface = manyParam(req.query['surface']);
    const region = manyParam(req.query['region']);
    const legalRaw = oneParam(req.query['legal']);
    const legal = legalRaw === 'true' || legalRaw === '1';

    const cursor = parseCursor(req.query['cursor']);
    const limit = parseLimit(req.query['limit'], config);

    const sql = exploreQuery({ city, type, surface, region, legal, cursor, limit });
    const { rows } = await db.query<FeedItemSource>(sql.text, sql.params);

    res.json({
      flicks: rows.map(shapeFeedItem),
      nextCursor: nextCursor(
        rows.map((row) => ({ created_at: row.created_at, event_id: row.event_id })),
        limit,
      ),
    });
  });

  return router;
}
