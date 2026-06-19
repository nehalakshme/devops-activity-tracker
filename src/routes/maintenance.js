import { Router } from 'express';
import { es } from '../esClient.js';
import { logTimelineEvent } from '../timeline.js';
import { logActivity } from '../activity.js';
import { asyncRoute, mapHit, nowIso, todayStr } from '../util.js';
import { getActor } from '../auth.js';

const router = Router();
const INDEX = 'maintenance';

// GET /api/maintenance?environment=&tag=
router.get('/', asyncRoute(async (req, res) => {
  const { environment, tag } = req.query;
  const filter = [];
  if (environment) filter.push({ term: { environment } });
  if (tag) filter.push({ term: { tags: tag } });

  const { hits } = await es.search({
    index: INDEX,
    size: 200,
    query: filter.length ? { bool: { filter } } : { match_all: {} },
    sort: [{ created_at: 'desc' }],
  });

  res.json(hits.hits.map(mapHit));
}));

// POST /api/maintenance
router.post('/', asyncRoute(async (req, res) => {
  const b = req.body;
  const now = nowIso();
  const doc = {
    environment: b.environment || 'test',
    version: b.version || '',
    release_version: b.release_version || '',
    notes: b.notes || '',
    date: b.date || todayStr(),
    created_at: now,
    tags: Array.isArray(b.tags) ? b.tags : [],
    recurrence_rule_id: b.recurrence_rule_id || null,
    created_by: getActor(req),
    assigned_to: getActor(req),
  };

  const { _id } = await es.index({ index: INDEX, document: doc, refresh: 'wait_for' });

  await logActivity({
    entity_type: 'maintenance', entity_id: _id, action: 'created',
    new_value: `${doc.environment} ${doc.version}`.trim(),
    reason_note: b.reason_note || 'Maintenance logged', actor: getActor(req),
  });

  await logTimelineEvent({
    event_type: 'maintenance',
    event_title: `Maintenance: ${doc.environment} ${doc.release_version || ''}`.trim(),
    event_description: doc.notes || `Release ${doc.release_version} on ${doc.environment}.`,
    related_id: _id, date: doc.date,
  });

  res.status(201).json({ id: _id, ...doc });
}));

export default router;
