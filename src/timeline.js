import { es } from './esClient.js';
import { nowIso, todayStr } from './util.js';

/**
 * Index a timeline_events document. Called automatically by route handlers
 * whenever a completion-style action happens (checklist check, task done,
 * pipeline pass/fail, maintenance log, poc advance).
 */
export async function logTimelineEvent({
  event_type,
  event_title,
  event_description = '',
  related_id,
  completed_at,
  date, // optional: bucket the event under a specific day (the source record's date)
}) {
  const ts = completed_at || nowIso();
  await es.index({
    index: 'timeline_events',
    document: {
      event_type,
      event_title,
      event_description,
      related_id,
      completed_at: ts,
      // Fall back to the completion timestamp's day only when no explicit date given.
      date: date || todayStr(new Date(ts)),
    },
    refresh: 'wait_for', // make it immediately visible to the timeline view
  });
}
