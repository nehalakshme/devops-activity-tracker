import { Router } from 'express';
import { es } from '../esClient.js';
import { logTimelineEvent } from '../timeline.js';
import { asyncRoute, mapHit, nowIso, TYPE_INDEX } from '../util.js';
import { getActor, assertCanEdit } from '../auth.js';

const router = Router();
const INDEX = 'tags';

// Open / closed predicates per taggable index.
const OPEN = {
  daily_tasks: { bool: { must_not: [{ term: { status: 'done' } }] } },
  pipelines: { bool: { must_not: [{ terms: { status: ['pass', 'fail'] } }] } },
  pocs: { bool: { must_not: [{ term: { status: 'Documented' } }] } },
  maintenance: { match_none: {} },
};
const CLOSED = {
  daily_tasks: { term: { status: 'done' } },
  pipelines: { terms: { status: ['pass', 'fail'] } },
  pocs: { term: { status: 'Documented' } },
  maintenance: { match_all: {} },
};

// GET /api/tags
router.get('/', asyncRoute(async (req, res) => {
  const { hits } = await es.search({ index: INDEX, size: 500, query: { match_all: {} }, sort: [{ name: 'asc' }] });
  res.json(hits.hits.map(mapHit));
}));

// GET /api/tags/overview  — each tag with open vs closed item counts
router.get('/overview', asyncRoute(async (req, res) => {
  const tagsRes = await es.search({ index: INDEX, size: 500, query: { match_all: {} } });
  const tags = tagsRes.hits.hits.map(mapHit);

  const countByQuery = async (queries) => {
    const totals = {};
    for (const [index, query] of Object.entries(queries)) {
      const r = await es.search({
        index, size: 0, query,
        aggs: { t: { terms: { field: 'tags', size: 1000 } } },
      }).catch(() => null);
      if (!r) continue;
      for (const b of r.aggregations.t.buckets) totals[b.key] = (totals[b.key] || 0) + b.doc_count;
    }
    return totals;
  };

  const open = await countByQuery(OPEN);
  const closed = await countByQuery(CLOSED);

  const overview = tags.map((t) => ({
    ...t,
    open: open[t.name] || 0,
    closed: closed[t.name] || 0,
    total: (open[t.name] || 0) + (closed[t.name] || 0),
  })).sort((a, b) => b.total - a.total);

  res.json(overview);
}));

// POST /api/tags
router.post('/', asyncRoute(async (req, res) => {
  const b = req.body;
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  const name = b.name.trim();

  // Avoid duplicates by name.
  const existing = await es.search({ index: INDEX, size: 1, query: { term: { name } } });
  if (existing.hits.total.value > 0) {
    return res.status(200).json(mapHit(existing.hits.hits[0]));
  }

  const doc = {
    name,
    category: b.category || 'custom',
    description: b.description || '',
    color: b.color || randomColor(),
    created_at: nowIso(),
    created_by: getActor(req),
    assigned_to: null,
  };
  const { _id } = await es.index({ index: INDEX, document: doc, refresh: 'wait_for' });
  res.status(201).json({ id: _id, ...doc });
}));

// PATCH /api/tags/:id  (recolor, recategorize, rename, edit description)
router.patch('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { _source: cur } = await es.get({ index: INDEX, id });
  assertCanEdit(req, cur);
  const patch = { ...req.body };
  delete patch.id; delete patch.created_by;

  // Propagate a rename to every referencing document.
  if (patch.name && patch.name !== cur.name) {
    for (const index of Object.values(TYPE_INDEX)) {
      await es.updateByQuery({
        index, refresh: true, conflicts: 'proceed',
        query: { term: { tags: cur.name } },
        script: {
          source: `if (ctx._source.tags != null) { ctx._source.tags.removeIf(x -> x == params.old); if (!ctx._source.tags.contains(params.new)) ctx._source.tags.add(params.new) }`,
          params: { old: cur.name, new: patch.name },
        },
      }).catch(() => {});
    }
  }

  await es.update({ index: INDEX, id, doc: patch, refresh: 'wait_for' });
  const { _source } = await es.get({ index: INDEX, id });
  res.json({ id, ..._source });
}));

// DELETE /api/tags/:id  — also strips the tag from all referencing documents
router.delete('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { _source: cur } = await es.get({ index: INDEX, id });
  assertCanEdit(req, cur);

  for (const index of Object.values(TYPE_INDEX)) {
    await es.updateByQuery({
      index, refresh: true, conflicts: 'proceed',
      query: { term: { tags: cur.name } },
      script: { source: `if (ctx._source.tags != null) { ctx._source.tags.removeIf(x -> x == params.t) }`, params: { t: cur.name } },
    }).catch(() => {});
  }

  await es.delete({ index: INDEX, id, refresh: 'wait_for' });
  res.json({ ok: true, stripped: cur.name });
}));

// GET /api/tags/:name/items  — all items carrying this tag, grouped by entity_type
router.get('/:name/items', asyncRoute(async (req, res) => {
  const { name } = req.params;
  const grouped = {};
  for (const [type, index] of Object.entries(TYPE_INDEX)) {
    const { hits } = await es.search({
      index, size: 200, query: { term: { tags: name } }, sort: [{ created_at: 'desc' }],
    }).catch(() => ({ hits: { hits: [] } }));
    grouped[type] = hits.hits.map(mapHit);
  }
  res.json({ tag: name, items: grouped });
}));

function randomColor() {
  const palette = ['#7aa2ff', '#2ecc8f', '#f5b942', '#ff6b7d', '#b07aff', '#ff7ab0', '#4fa8e0', '#4dd0b0'];
  return palette[Math.floor(Math.random() * palette.length)];
}

export default router;
