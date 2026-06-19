import { es } from './esClient.js';
import { logTimelineEvent } from './timeline.js';
import { nowIso, TYPE_INDEX } from './util.js';

// Append a value to a keyword-array field uniquely, via painless.
async function appendUnique(index, id, field, value) {
  await es.update({
    index,
    id,
    script: {
      source: `if (ctx._source.${field} == null) { ctx._source.${field} = [] } if (!ctx._source.${field}.contains(params.v)) { ctx._source.${field}.add(params.v) }`,
      params: { v: value },
    },
    refresh: 'wait_for',
  });
}

async function removeFromArray(index, id, field, value) {
  await es.update({
    index,
    id,
    script: {
      source: `if (ctx._source.${field} != null) { ctx._source.${field}.removeIf(x -> x == params.v) }`,
      params: { v: value },
    },
    refresh: 'wait_for',
  }).catch(() => {});
}

/**
 * Persist a relationship record and apply its side effects to the linked docs.
 * Direction is from_id --[relationship_type]--> to_id.
 *   blocks      : from.blocks += to ; to.blocked_by += from
 *   parent/spawns: to becomes child of from (sets to.parent_id/parent_type)
 *   triggers/post_mortem: record only
 */
export async function recordRelationship(rel, { timeline = true } = {}) {
  const doc = {
    from_id: rel.from_id,
    from_type: rel.from_type,
    to_id: rel.to_id,
    to_type: rel.to_type,
    relationship_type: rel.relationship_type,
    notes: rel.notes || '',
    created_at: nowIso(),
  };
  const { _id } = await es.index({ index: 'relationships', document: doc, refresh: 'wait_for' });

  const fromIdx = TYPE_INDEX[rel.from_type];
  const toIdx = TYPE_INDEX[rel.to_type];

  if (rel.relationship_type === 'blocks' && fromIdx && toIdx) {
    await appendUnique(fromIdx, rel.from_id, 'blocks', rel.to_id);
    await appendUnique(toIdx, rel.to_id, 'blocked_by', rel.from_id);
  } else if ((rel.relationship_type === 'parent' || rel.relationship_type === 'spawns') && toIdx) {
    await es.update({
      index: toIdx,
      id: rel.to_id,
      doc: {
        parent_id: rel.from_id,
        parent_type: rel.from_type,
        relationship_label: rel.relationship_type === 'spawns' ? 'spawned-from' : 'child-of',
      },
      refresh: 'wait_for',
    });
  }

  if (timeline) {
    await logTimelineEvent({
      event_type: ['task', 'pipeline', 'poc', 'maintenance'].includes(rel.from_type) ? rel.from_type : 'task',
      event_title: `Linked: ${rel.relationship_type}`,
      event_description: `${rel.from_type}/${rel.from_id} ${rel.relationship_type} ${rel.to_type}/${rel.to_id}`,
      related_id: rel.from_id,
    });
  }

  return { id: _id, ...doc };
}

export async function deleteRelationship(id) {
  let rel;
  try {
    const { _source } = await es.get({ index: 'relationships', id });
    rel = _source;
  } catch {
    return;
  }
  await es.delete({ index: 'relationships', id, refresh: 'wait_for' }).catch(() => {});

  const fromIdx = TYPE_INDEX[rel.from_type];
  const toIdx = TYPE_INDEX[rel.to_type];
  if (rel.relationship_type === 'blocks') {
    if (fromIdx) await removeFromArray(fromIdx, rel.from_id, 'blocks', rel.to_id);
    if (toIdx) await removeFromArray(toIdx, rel.to_id, 'blocked_by', rel.from_id);
  } else if ((rel.relationship_type === 'parent' || rel.relationship_type === 'spawns') && toIdx) {
    await es.update({
      index: toIdx,
      id: rel.to_id,
      doc: { parent_id: null, parent_type: null, relationship_label: null },
      refresh: 'wait_for',
    }).catch(() => {});
  }
}

// Open children of a parent item (used to block premature closure).
export async function openChildren(parentType, parentId) {
  const results = [];
  for (const [type, index] of Object.entries(TYPE_INDEX)) {
    if (type === 'maintenance') continue; // maintenance has no status / children
    let hits;
    try {
      const r = await es.search({
        index,
        size: 100,
        query: { bool: { filter: [{ term: { parent_id: parentId } }] } },
      });
      hits = r.hits.hits;
    } catch {
      continue;
    }
    for (const h of hits) {
      const s = h._source;
      const terminal =
        (type === 'task' && s.status === 'done') ||
        (type === 'pipeline' && (s.status === 'pass' || s.status === 'fail')) ||
        (type === 'poc' && s.status === 'Documented');
      if (!terminal) {
        results.push({
          id: h._id,
          type,
          name: s.task_name || s.pipeline_name || s.title || h._id,
          status: s.status,
        });
      }
    }
  }
  return results;
}
