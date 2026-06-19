import { Router } from 'express';
import { es } from '../esClient.js';
import { computeNextRun, describeSchedule, generateDueInstances } from '../recurrence.js';
import { asyncRoute, mapHit, nowIso } from '../util.js';
import { getActor, assertCanEdit } from '../auth.js';

const router = Router();
const INDEX = 'recurrence_rules';

function withSchedule(rule) {
  return { ...rule, schedule_human: describeSchedule(rule.recurrence_type, rule.recurrence_value) };
}

// GET /api/recurrence-rules
router.get('/', asyncRoute(async (req, res) => {
  const { hits } = await es.search({
    index: INDEX, size: 200, query: { match_all: {} }, sort: [{ created_at: 'desc' }],
  });
  res.json(hits.hits.map(mapHit).map(withSchedule));
}));

// POST /api/recurrence-rules
router.post('/', asyncRoute(async (req, res) => {
  const b = req.body;
  if (!b.recurrence_type || !b.template_type) {
    return res.status(400).json({ error: 'template_type and recurrence_type are required' });
  }
  const now = nowIso();
  const next = b.next_run_at
    ? new Date(b.next_run_at)
    : computeNextRun(b.recurrence_type, b.recurrence_value || '', new Date());

  const doc = {
    template_type: b.template_type,
    template_payload: b.template_payload || {},
    recurrence_type: b.recurrence_type,
    recurrence_value: b.recurrence_value || '',
    next_run_at: next.toISOString(),
    last_generated_at: null,
    active: b.active !== false,
    created_at: now,
    created_by: getActor(req),
    assigned_to: null,
  };

  const { _id } = await es.index({ index: INDEX, document: doc, refresh: 'wait_for' });
  res.status(201).json(withSchedule({ id: _id, ...doc }));
}));

// PATCH /api/recurrence-rules/:id  (pause/resume, edit schedule or payload)
router.patch('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const existing = await es.get({ index: INDEX, id });
  assertCanEdit(req, existing._source);
  const patch = { ...req.body };
  delete patch.id; delete patch.created_by;

  // Recompute next_run_at if the schedule changed.
  if (patch.recurrence_type || patch.recurrence_value) {
    const { _source: cur } = await es.get({ index: INDEX, id });
    const type = patch.recurrence_type || cur.recurrence_type;
    const value = patch.recurrence_value ?? cur.recurrence_value;
    patch.next_run_at = computeNextRun(type, value, new Date()).toISOString();
  }

  await es.update({ index: INDEX, id, doc: patch, refresh: 'wait_for' });
  const { _source } = await es.get({ index: INDEX, id });
  res.json(withSchedule({ id, ..._source }));
}));

// DELETE /api/recurrence-rules/:id
router.delete('/:id', asyncRoute(async (req, res) => {
  const existing = await es.get({ index: INDEX, id: req.params.id });
  assertCanEdit(req, existing._source);
  await es.delete({ index: INDEX, id: req.params.id, refresh: 'wait_for' });
  res.json({ ok: true });
}));

// POST /api/recurrence-rules/run-now  — manual trigger (handy for testing)
router.post('/run-now', asyncRoute(async (req, res) => {
  await generateDueInstances();
  res.json({ ok: true });
}));

export default router;
