import { Router } from 'express';
import { es } from '../esClient.js';
import { logTimelineEvent } from '../timeline.js';
import { asyncRoute, mapHit, nowIso, todayStr } from '../util.js';
import { getActor, assertCanEdit } from '../auth.js';

const router = Router();
const INDEX = 'checklist_items';

// Fixed category headings; sub-items live under each.
export const CATEGORIES = ['Pre-Requisites', 'API-Services', 'UI-Services'];

// GET /api/checklist?date=YYYY-MM-DD
// Returns sub-items grouped under each category heading + overall progress.
router.get('/', asyncRoute(async (req, res) => {
  const date = req.query.date || todayStr();

  const { hits } = await es.search({
    index: INDEX,
    size: 500,
    query: { term: { date } },
    sort: [{ created_at: 'asc' }],
  });

  const items = hits.hits.map(mapHit);
  const categories = CATEGORIES.map((name) => ({
    name,
    items: items.filter((i) => i.category === name),
  }));

  const done = items.filter((i) => i.checked).length;
  res.json({ date, categories, done, total: items.length });
}));

// POST /api/checklist  { category, label, date? }  — add a sub-checklist item
router.post('/', asyncRoute(async (req, res) => {
  const { category, label } = req.body;
  if (!category || !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'valid category is required' });
  }
  if (!label || !label.trim()) {
    return res.status(400).json({ error: 'label is required' });
  }

  const doc = {
    category,
    label: label.trim(),
    checked: false,
    date: req.body.date || todayStr(),
    created_at: nowIso(),
    created_by: getActor(req),
    assigned_to: 'common', // shared daily checklist — anyone can tick
  };

  const { _id } = await es.index({ index: INDEX, document: doc, refresh: 'wait_for' });
  res.status(201).json({ id: _id, ...doc });
}));

// PATCH /api/checklist/:id  { checked }  — toggle a sub-item
router.patch('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const checked = !!req.body.checked;

  const existing = await es.get({ index: INDEX, id });
  assertCanEdit(req, existing._source);
  await es.update({ index: INDEX, id, doc: { checked }, refresh: 'wait_for' });
  const { _source } = await es.get({ index: INDEX, id });

  if (checked) {
    await logTimelineEvent({
      event_type: 'checklist',
      event_title: `${_source.category}: ${_source.label}`,
      event_description: `Checklist item completed under ${_source.category}.`,
      related_id: id,
      date: _source.date, // file under the checklist item's own day
    });
  }

  res.json({ id, ..._source });
}));

// DELETE /api/checklist/:id  — remove a sub-item
router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = await es.get({ index: INDEX, id: req.params.id });
  assertCanEdit(req, existing._source);
  await es.delete({ index: INDEX, id: req.params.id, refresh: 'wait_for' });
  res.json({ ok: true });
}));

export default router;
