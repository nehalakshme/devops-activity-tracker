import { es } from './esClient.js';
import { DEFAULT_ACTOR, nowIso } from './util.js';

/**
 * Append an entry to the audit trail. Called by every create/patch/delete on
 * tasks, pipelines, maintenance, POCs (and checklist where useful).
 */
export async function logActivity({
  entity_type,
  entity_id,
  action,
  field_changed = '',
  old_value = '',
  new_value = '',
  reason_note = '',
  actor = DEFAULT_ACTOR,
}) {
  await es.index({
    index: 'activity_log',
    document: {
      entity_type,
      entity_id,
      action,
      field_changed,
      old_value: old_value == null ? '' : String(old_value),
      new_value: new_value == null ? '' : String(new_value),
      reason_note,
      actor: actor || DEFAULT_ACTOR,
      timestamp: nowIso(),
    },
    refresh: 'wait_for',
  });
}
