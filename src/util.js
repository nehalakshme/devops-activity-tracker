// Local-date helpers so "today" matches the engineer's wall clock, not UTC.

export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// Derive a YYYY-MM-DD string from any ISO timestamp (local time).
export function dateOf(iso) {
  return todayStr(new Date(iso));
}

// Flatten an ES search hit into { id, ...source }.
export function mapHit(hit) {
  return { id: hit._id, ...hit._source, _highlight: hit.highlight };
}

// Wrap an async express handler so thrown errors hit the error middleware.
export function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export const DEFAULT_ACTOR = 'engineer';

// The index backing each entity type.
export const TYPE_INDEX = {
  task: 'daily_tasks',
  pipeline: 'pipelines',
  poc: 'pocs',
  maintenance: 'maintenance',
};

// Terminal (closed/done) statuses per entity type.
const TERMINAL = {
  task: ['done'],
  pipeline: ['pass', 'fail'],
  poc: ['Documented'],
};

export function isTerminal(type, status) {
  return (TERMINAL[type] || []).includes(status);
}

// Does this PATCH body represent a status transition for the given type?
export function isStatusTransition(type, patch) {
  return typeof patch.status === 'string' && patch.status.length > 0;
}
