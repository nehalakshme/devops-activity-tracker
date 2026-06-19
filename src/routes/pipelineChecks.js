import { Router } from 'express';
import { es } from '../esClient.js';
import { logTimelineEvent } from '../timeline.js';
import { asyncRoute, mapHit, nowIso } from '../util.js';
import { getActor, assertCanEdit } from '../auth.js';

const router = Router();
const INDEX = 'pipeline_checks';

export const ENVIRONMENTS = ['dev', 'test', 'qa', 'production'];
export const CATEGORIES = ['API-Services', 'UI-Services'];

// GET /api/pipeline-checks?environment=dev  → items grouped by category + progress
router.get('/', asyncRoute(async (req, res) => {
  const environment = ENVIRONMENTS.includes(req.query.environment) ? req.query.environment : 'dev';

  const { hits } = await es.search({
    index: INDEX,
    size: 500,
    query: { term: { environment } },
    sort: [{ created_at: 'asc' }],
  });

  const items = hits.hits.map(mapHit);
  const categories = CATEGORIES.map((name) => ({ name, items: items.filter((i) => i.category === name) }));
  const done = items.filter((i) => i.checked).length;
  res.json({ environment, categories, done, total: items.length });
}));

// POST /api/pipeline-checks  { environment, category, label }
router.post('/', asyncRoute(async (req, res) => {
  const { environment, category, label } = req.body;
  if (!ENVIRONMENTS.includes(environment)) return res.status(400).json({ error: 'valid environment is required' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'valid category is required' });
  if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });

  const doc = {
    environment, category, label: label.trim(), checked: false, created_at: nowIso(),
    created_by: getActor(req), assigned_to: 'common', // shared environment checklist
  };
  const { _id } = await es.index({ index: INDEX, document: doc, refresh: 'wait_for' });
  res.status(201).json({ id: _id, ...doc });
}));

// PATCH /api/pipeline-checks/:id  { checked }
router.patch('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const checked = !!req.body.checked;

  const existing = await es.get({ index: INDEX, id });
  assertCanEdit(req, existing._source);
  await es.update({ index: INDEX, id, doc: { checked }, refresh: 'wait_for' });
  const { _source } = await es.get({ index: INDEX, id });

  if (checked) {
    await logTimelineEvent({
      event_type: 'pipeline',
      event_title: `${_source.environment} · ${_source.category}: ${_source.label}`,
      event_description: `Pipeline check completed (${_source.environment} / ${_source.category}).`,
      related_id: id,
    });
  }

  res.json({ id, ..._source });
}));

// DELETE /api/pipeline-checks/:id
router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = await es.get({ index: INDEX, id: req.params.id });
  assertCanEdit(req, existing._source);
  await es.delete({ index: INDEX, id: req.params.id, refresh: 'wait_for' });
  res.json({ ok: true });
}));

export default router;
