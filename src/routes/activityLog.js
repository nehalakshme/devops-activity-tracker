import { Router } from 'express';
import { es } from '../esClient.js';
import { asyncRoute, mapHit } from '../util.js';

const router = Router();
const INDEX = 'activity_log';

// GET /api/activity-log?entity_type=&entity_id=&actor=&from=&to=&q=
router.get('/', asyncRoute(async (req, res) => {
  const { entity_type, entity_id, actor, from, to, q } = req.query;
  const filter = [];
  const must = [];

  if (entity_type) filter.push({ term: { entity_type } });
  if (entity_id) filter.push({ term: { entity_id } });
  if (actor) filter.push({ term: { actor } });
  if (from || to) {
    const range = {};
    if (from) range.gte = from;
    if (to) range.lte = `${to}T23:59:59`;
    filter.push({ range: { timestamp: range } });
  }
  if (q && q.trim()) {
    must.push({ match: { reason_note: q } });
  }

  const { hits } = await es.search({
    index: INDEX,
    size: 500,
    query: { bool: { must: must.length ? must : [{ match_all: {} }], filter } },
    sort: [{ timestamp: 'desc' }],
  });

  res.json(hits.hits.map(mapHit));
}));

// GET /api/activity-log/entity/:type/:id  — full chronological history for one item
router.get('/entity/:type/:id', asyncRoute(async (req, res) => {
  const { type, id } = req.params;
  const { hits } = await es.search({
    index: INDEX,
    size: 500,
    query: { bool: { filter: [{ term: { entity_type: type } }, { term: { entity_id: id } }] } },
    sort: [{ timestamp: 'asc' }],
  });
  res.json(hits.hits.map(mapHit));
}));

export default router;
