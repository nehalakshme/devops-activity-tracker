import { Router } from 'express';
import { es } from '../esClient.js';
import { logTimelineEvent } from '../timeline.js';
import { logActivity } from '../activity.js';
import { recordRelationship, openChildren } from '../links.js';
import { asyncRoute, mapHit, nowIso } from '../util.js';
import { getActor, assertCanEdit } from '../auth.js';

const router = Router();
const INDEX = 'pocs';

export const POC_STATUSES = ['Started', 'In-Progress', 'Completed', 'Documented'];

// GET /api/pocs?status=&tag=
router.get('/', asyncRoute(async (req, res) => {
  const { status, tag } = req.query;
  const filter = [];
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

// POST /api/pocs
router.post('/', asyncRoute(async (req, res) => {
  const b = req.body;
  if (!b.title) return res.status(400).json({ error: 'title is required' });

  const now = nowIso();
  const doc = {
    title: b.title,
    concept_description: b.concept_description || '',
    status: b.status && POC_STATUSES.includes(b.status) ? b.status : 'Started',
    created_at: now,
    updated_at: now,
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
    entity_type: 'poc', entity_id: _id, action: 'created',
    new_value: doc.title, reason_note: b.reason_note || 'POC created', actor: getActor(req),
  });

  if (doc.parent_id && doc.parent_type) {
    await recordRelationship({
      from_id: doc.parent_id, from_type: doc.parent_type, to_id: _id, to_type: 'poc',
      relationship_type: 'parent', notes: b.relationship_label || '',
    });
  }

  await logTimelineEvent({
    event_type: 'poc', event_title: `POC started: ${doc.title}`,
    event_description: doc.concept_description, related_id: _id,
  });

  res.status(201).json({ id: _id, ...doc });
}));

// PATCH /api/pocs/:id  — advance status (reason required)
router.patch('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { reason_note } = req.body;
  const actor = getActor(req);
  const { _source: current } = await es.get({ index: INDEX, id });
  assertCanEdit(req, current);

  let nextStatus;
  if (req.body.status && POC_STATUSES.includes(req.body.status)) {
    nextStatus = req.body.status;
  } else {
    const idx = POC_STATUSES.indexOf(current.status);
    nextStatus = POC_STATUSES[Math.min(idx + 1, POC_STATUSES.length - 1)];
  }

  const changing = nextStatus !== current.status;
  if (changing && (!reason_note || !reason_note.trim())) {
    return res.status(400).json({ error: 'reason_note is required for a status change' });
  }

  // Documented = terminal; block while children are open.
  if (changing && nextStatus === 'Documented') {
    const open = await openChildren('poc', id);
    if (open.length) {
      return res.status(409).json({ error: 'Cannot document: open child items remain', open_children: open });
    }
  }

  const patch = { status: nextStatus, updated_at: nowIso() };
  await es.update({ index: INDEX, id, doc: patch, refresh: 'wait_for' });

  if (changing) {
    await logActivity({
      entity_type: 'poc', entity_id: id, action: 'status_changed', field_changed: 'status',
      old_value: current.status, new_value: nextStatus, reason_note, actor,
    });
    await logTimelineEvent({
      event_type: 'poc', event_title: `POC advanced: ${current.title} → ${nextStatus}`,
      event_description: current.concept_description, related_id: id,
    });
  }

  res.json({ id, ...current, ...patch });
}));

export default router;
