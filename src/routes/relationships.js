import { Router } from 'express';
import { es } from '../esClient.js';
import { recordRelationship, deleteRelationship } from '../links.js';
import { asyncRoute, mapHit, TYPE_INDEX } from '../util.js';

const router = Router();

const OPEN_QUERY = {
  task: { bool: { must_not: [{ term: { status: 'done' } }] } },
  pipeline: { bool: { must_not: [{ terms: { status: ['pass', 'fail'] } }] } },
  poc: { bool: { must_not: [{ term: { status: 'Documented' } }] } },
};

function labelOf(type, s) {
  return s.task_name || s.pipeline_name || s.title || `${type}:${'unknown'}`;
}

async function summary(type, id) {
  try {
    const { _source } = await es.get({ index: TYPE_INDEX[type], id });
    return { id, type, label: labelOf(type, _source), status: _source.status || 'n/a' };
  } catch {
    return { id, type, label: `${type}:${id}`, status: 'missing' };
  }
}

// POST /api/relationships
router.post('/', asyncRoute(async (req, res) => {
  const { from_id, from_type, to_id, to_type, relationship_type, notes } = req.body;
  if (!from_id || !from_type || !to_id || !to_type || !relationship_type) {
    return res.status(400).json({ error: 'from_id, from_type, to_id, to_type, relationship_type are required' });
  }
  const rel = await recordRelationship({ from_id, from_type, to_id, to_type, relationship_type, notes });
  res.status(201).json(rel);
}));

// DELETE /api/relationships/:id
router.delete('/:id', asyncRoute(async (req, res) => {
  await deleteRelationship(req.params.id);
  res.json({ ok: true });
}));

// GET /api/relationships/children/:type/:id
router.get('/children/:type/:id', asyncRoute(async (req, res) => {
  const { type, id } = req.params;
  const children = [];
  for (const [t, index] of Object.entries(TYPE_INDEX)) {
    if (t === 'maintenance') continue;
    const { hits } = await es.search({
      index, size: 100, query: { bool: { filter: [{ term: { parent_id: id } }] } },
    }).catch(() => ({ hits: { hits: [] } }));
    hits.hits.forEach((h) => children.push({ id: h._id, type: t, ...h._source }));
  }
  res.json({ parent: { type, id }, children });
}));

// GET /api/relationships/graph?root_id=&depth=2
router.get('/graph', asyncRoute(async (req, res) => {
  const { root_id } = req.query;
  const depth = Math.min(parseInt(req.query.depth, 10) || 2, 5);

  // All relationship edges (small dataset; fine to pull).
  const relRes = await es.search({ index: 'relationships', size: 1000, query: { match_all: {} } });
  const edges = relRes.hits.hits.map(mapHit);

  const nodes = new Map();
  const links = [];

  if (root_id) {
    // Downward BFS from the root: the root plus its descendants (sub-entities).
    const adj = new Map(); // from_id -> outgoing edges
    for (const e of edges) { if (!adj.has(e.from_id)) adj.set(e.from_id, []); adj.get(e.from_id).push(e); }
    const typeOf = {};
    edges.forEach((e) => { typeOf[e.from_id] = e.from_type; typeOf[e.to_id] = e.to_type; });
    const rootType = req.query.root_type || typeOf[root_id] || 'task';

    const seen = new Set([root_id]);
    let frontier = [{ id: root_id, lvl: 0, type: rootType }];
    while (frontier.length) {
      const next = [];
      for (const { id, lvl, type } of frontier) {
        if (!nodes.has(id)) nodes.set(id, await summary(type, id));
        if (lvl >= depth) continue;
        for (const e of adj.get(id) || []) {
          links.push(e);
          if (!seen.has(e.to_id)) { seen.add(e.to_id); next.push({ id: e.to_id, lvl: lvl + 1, type: e.to_type }); }
        }
      }
      frontier = next;
    }
  } else {
    // Whole-graph view: every open item + edges among them.
    for (const [type, index] of Object.entries(TYPE_INDEX)) {
      if (type === 'maintenance') continue;
      const { hits } = await es.search({ index, size: 500, query: OPEN_QUERY[type] })
        .catch(() => ({ hits: { hits: [] } }));
      hits.hits.forEach((h) => nodes.set(h._id, { id: h._id, type, label: labelOf(type, h._source), status: h._source.status || 'n/a' }));
    }
    for (const e of edges) {
      if (nodes.has(e.from_id) || nodes.has(e.to_id)) {
        if (!nodes.has(e.from_id)) nodes.set(e.from_id, await summary(e.from_type, e.from_id));
        if (!nodes.has(e.to_id)) nodes.set(e.to_id, await summary(e.to_type, e.to_id));
        links.push(e);
      }
    }
  }

  // De-dupe links by id.
  const seenL = new Set();
  const uniqLinks = links.filter((l) => (l.id && !seenL.has(l.id) ? (seenL.add(l.id), true) : !l.id));

  res.json({ nodes: [...nodes.values()], links: uniqLinks });
}));

export default router;
