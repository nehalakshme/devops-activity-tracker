import { Router } from 'express';
import { es } from '../esClient.js';
import { logTimelineEvent } from '../timeline.js';
import { logActivity } from '../activity.js';
import { recordRelationship, openChildren } from '../links.js';
import { asyncRoute, dateOf, mapHit, nowIso } from '../util.js';
import { getActor, assertCanEdit } from '../auth.js';

const router = Router();
const INDEX = 'pipelines';

// GET /api/pipelines?type=&stage=&status=&tag=
router.get('/', asyncRoute(async (req, res) => {
  const { type, stage, status, tag } = req.query;
  const filter = [];
  if (type) filter.push({ term: { type } });
  if (stage) filter.push({ term: { stage } });
  if (status) filter.push({ term: { status } });
  if (tag) filter.push({ term: { tags: tag } });

  const { hits } = await es.search({
    index: INDEX,
    size: 200,
    query: filter.length ? { bool: { filter } } : { match_all: {} },
    sort: [{ created_at: 'desc' }],
  });

  res.json(hits.hits.map(mapHit));
}));

// POST /api/pipelines
router.post('/', asyncRoute(async (req, res) => {
  const b = req.body;
  if (!b.pipeline_name) return res.status(400).json({ error: 'pipeline_name is required' });

  const now = nowIso();
  const status = b.status || 'pending';
  const completed = status === 'pass' || status === 'fail';

  const doc = {
    type: b.type || 'test',
    stage: b.stage || 'API',
    pipeline_name: b.pipeline_name,
    flow: b.flow || '',
    status,
    cicd_triggered: !!b.cicd_triggered,
    run_date: b.run_date || now,
    created_at: now,
    completed_at: completed ? now : null,
    tags: Array.isArray(b.tags) ? b.tags : [],
    parent_id: b.parent_id || null,
    parent_type: b.parent_type || null,
    blocks: [],
    blocked_by: [],
    relationship_label: b.relationship_label || null,
    created_by: getActor(req),
    assigned_to: b.assigned_to || getActor(req),
  };

  const { _id } = await es.index({ index: INDEX, document: doc, refresh: 'wait_for' });

  await logActivity({
    entity_type: 'pipeline', entity_id: _id, action: 'created',
    new_value: doc.pipeline_name, reason_note: b.reason_note || 'Pipeline run created', actor: getActor(req),
  });

  if (doc.parent_id && doc.parent_type) {
    await recordRelationship({
      from_id: doc.parent_id, from_type: doc.parent_type, to_id: _id, to_type: 'pipeline',
      relationship_type: 'parent', notes: b.relationship_label || '',
    });
  }

  if (completed) await logPipeline(_id, doc);
  res.status(201).json({ id: _id, ...doc });
}));

// PATCH /api/pipelines/:id
router.patch('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { reason_note, ...patch } = req.body;
  delete patch.id; delete patch.actor; delete patch.created_by;
  const actor = getActor(req);

  const { _source: current } = await es.get({ index: INDEX, id });
  assertCanEdit(req, current);
  const becomingFinal = (patch.status === 'pass' || patch.status === 'fail') && patch.status !== current.status;

  if (becomingFinal && (!reason_note || !reason_note.trim())) {
    return res.status(400).json({ error: 'reason_note is required for a status change' });
  }

  if (becomingFinal) {
    const open = await openChildren('pipeline', id);
    if (open.length) {
      return res.status(409).json({ error: 'Cannot finalize: open child items remain', open_children: open });
    }
    patch.completed_at = nowIso();
  }

  await es.update({ index: INDEX, id, doc: patch, refresh: 'wait_for' });
  const { _source } = await es.get({ index: INDEX, id });

  if (becomingFinal) {
    await logActivity({
      entity_type: 'pipeline', entity_id: id, action: 'status_changed', field_changed: 'status',
      old_value: current.status, new_value: _source.status, reason_note, actor,
    });
    await logPipeline(id, _source);
  }

  res.json({ id, ..._source });
}));

function logPipeline(id, doc) {
  return logTimelineEvent({
    event_type: 'pipeline',
    event_title: `${doc.pipeline_name} — ${doc.status.toUpperCase()}`,
    event_description: `${doc.type} / ${doc.stage} pipeline ${doc.status}${doc.cicd_triggered ? ' (CI/CD)' : ''}.`,
    related_id: id, completed_at: doc.completed_at, date: dateOf(doc.run_date),
  });
}

export default router;
