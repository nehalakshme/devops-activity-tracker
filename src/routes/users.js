import { Router } from 'express';
import { es } from '../esClient.js';
import { asyncRoute, mapHit } from '../util.js';

const router = Router();

// GET /api/users  — registered users for the assignment dropdown (no passwords)
router.get('/', asyncRoute(async (req, res) => {
  const { hits } = await es.search({
    index: 'users',
    size: 500,
    query: { match_all: {} },
    sort: [{ username: 'asc' }],
    _source: ['username', 'display_name'],
  });
  res.json(hits.hits.map(mapHit));
}));

export default router;
