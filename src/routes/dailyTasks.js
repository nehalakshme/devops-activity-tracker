import { Router } from 'express';
import { es } from '../esClient.js';
import { logTimelineEvent } from '../timeline.js';
import { logActivity } from '../activity.js';
import { recordRelationship, openChildren } from '../links.js';
import { computeNextRun } from '../recurrence.js';
import { asyncRoute, dateOf, mapHit, nowIso, todayStr } from '../util.js';
import { getActor, assertCanEdit } from '../auth.js';

const router = Router();
const INDEX = 'daily_tasks';

// GET /api/daily-tasks?date=&priority=&status=&tag=
router.get('/', asyncRoute(async (req, res) => {
  const { date, priority, status, tag } = req.query;
  const filter = [];

  if (date) {
    filter.push({ range: { entry_time: { gte: `${date}T00:00:00`, lte: `${date}T23:59:59` } } });
  }
  if (priority) filter.push({ term: { priority } });
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

// GET /api/daily-tasks/due  — all OPEN tasks that have a due_date, sorted soonest first.
// Powers the "what's due today / this week / overdue" view (ignores entry-time scoping).
router.get('/due', asyncRoute(async (req, res) => {
  const { hits } = await es.search({
    index: INDEX,
    size: 500,
    query: {
      bool: {
        must_not: [{ term: { status: 'done' } }],
        filter: [{ exists: { field: 'due_date' } }],
      },
    },
    sort: [{ due_date: 'asc' }],
  });
  res.json(hits.hits.map(mapHit));
}));

// POST /api/daily-tasks
router.post('/', asyncRoute(async (req, res) => {
  const b = req.body;
  if (!b.task_name) return res.status(400).json({ error: 'task_name is required' });

  const now = nowIso();
  const doc = {
    task_name: b.task_name,
    environment: b.environment || 'test',
    entry_time: b.entry_time || now,
    todo_description: b.todo_description || '',
    who_asked: b.who_asked || '',
    priority: b.priority || 'medium',
    status: b.status || 'pending',
    due_date: b.due_date || null, // optional
    created_at: now,
    completed_at: null,
    tags: Array.isArray(b.tags) ? b.tags : [],
    parent_id: b.parent_id || null,
    parent_type: b.parent_type || null,
    blocks: [],
    blocked_by: [],
    relationship_label: b.relationship_label || null,
    recurrence_rule_id: b.recurrence_rule_id || null,
    created_by: getActor(req),
    assigned_to: b.assigned_to || getActor(req), // default: assign to creator
  };

  const { _id } = await es.index({ index: INDEX, document: doc, refresh: 'wait_for' });

  await logActivity({
    entity_type: 'task', entity_id: _id, action: 'created',
    new_value: doc.task_name, reason_note: b.reason_note || 'Task created', actor: getActor(req),
  });

  // Link to a parent item if one was chosen.
  if (doc.parent_id && doc.parent_type) {
    await recordRelationship({
      from_id: doc.parent_id, from_type: doc.parent_type,
      to_id: _id, to_type: 'task',
      relationship_type: b.relationship_label === 'spawned-from' ? 'spawns' : 'parent',
      notes: b.relationship_label || '',
    });
  }

  res.status(201).json({ id: _id, ...doc });
}));

// PATCH /api/daily-tasks/:id
router.patch('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const { reason_note, ...patch } = req.body;
  delete patch.id;
  delete patch.actor; delete patch.created_by; // not client-settable
  const actor = getActor(req);

  const { _source: current } = await es.get({ index: INDEX, id });
  assertCanEdit(req, current); // creator / assignee / common only

  const statusChanging = patch.status && patch.status !== current.status;
  const priorityChanging = patch.priority && patch.priority !== current.priority;
  const dueChanging = patch.due_date !== undefined && patch.due_date !== current.due_date;

  // Reason is mandatory on a status transition.
  if (statusChanging && (!reason_note || !reason_note.trim())) {
    return res.status(400).json({ error: 'reason_note is required for a status change' });
  }

  // Block closing a parent while it still has open children.
  if (statusChanging && patch.status === 'done') {
    const open = await openChildren('task', id);
    if (open.length) {
      return res.status(409).json({ error: 'Cannot complete: open child items remain', open_children: open });
    }
    patch.completed_at = nowIso();
  }

  await es.update({ index: INDEX, id, doc: patch, refresh: 'wait_for' });
  const { _source } = await es.get({ index: INDEX, id });

  if (statusChanging) {
    await logActivity({
      entity_type: 'task', entity_id: id, action: 'status_changed', field_changed: 'status',
      old_value: current.status, new_value: _source.status, reason_note, actor,
    });
  }
  if (priorityChanging) {
    await logActivity({
      entity_type: 'task', entity_id: id, action: 'priority_changed', field_changed: 'priority',
      old_value: current.priority, new_value: _source.priority,
      reason_note: reason_note || 'priority updated', actor,
    });
  }
  if (dueChanging) {
    await logActivity({
      entity_type: 'task', entity_id: id, action: 'edited', field_changed: 'due_date',
      old_value: current.due_date, new_value: _source.due_date,
      reason_note: reason_note || 'due date updated', actor,
    });
  }
  if (patch.assigned_to !== undefined && patch.assigned_to !== current.assigned_to) {
    await logActivity({
      entity_type: 'task', entity_id: id, action: 'assigned', field_changed: 'assigned_to',
      old_value: current.assigned_to, new_value: _source.assigned_to,
      reason_note: reason_note || `assigned to ${_source.assigned_to}`, actor,
    });
  }
  // Generic content edits (name, description, who, environment) — keep the audit trail complete.
  const CONTENT_FIELDS = ['task_name', 'who_asked', 'todo_description', 'environment'];
  const editedFields = CONTENT_FIELDS.filter((f) => patch[f] !== undefined && patch[f] !== current[f]);
  if (editedFields.length) {
    await logActivity({
      entity_type: 'task', entity_id: id, action: 'edited', field_changed: editedFields.join(', '),
      reason_note: reason_note || 'task edited', actor,
    });
  }

  if (statusChanging && _source.status === 'done') {
    await logTimelineEvent({
      event_type: 'task', event_title: _source.task_name,
      event_description: _source.todo_description || `Task completed (${_source.environment}).`,
      related_id: id, completed_at: _source.completed_at, date: dateOf(_source.entry_time),
    });

    // If this is a recurring instance, roll its rule forward if overdue.
    if (_source.recurrence_rule_id) await advanceRuleIfDue(_source.recurrence_rule_id);
  }

  res.json({ id, ..._source });
}));

async function advanceRuleIfDue(ruleId) {
  try {
    const { _source: rule } = await es.get({ index: 'recurrence_rules', id: ruleId });
    if (rule.active && new Date(rule.next_run_at) <= new Date()) {
      const next = computeNextRun(rule.recurrence_type, rule.recurrence_value, new Date());
      await es.update({ index: 'recurrence_rules', id: ruleId, doc: { next_run_at: next.toISOString() }, refresh: 'wait_for' });
    }
  } catch { /* rule may be gone */ }
}

export default router;
