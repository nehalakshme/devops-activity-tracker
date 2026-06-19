import { Router } from 'express';
import { es } from '../esClient.js';
import { asyncRoute, mapHit } from '../util.js';

const router = Router();

// Per-index search config: text fields, the date field to range-filter on,
// and which filters the index supports.
const SEARCHABLE = {
  tasks: {
    index: 'daily_tasks',
    fields: ['task_name', 'task_name.keyword', 'todo_description', 'who_asked'],
    dateField: 'entry_time', hasEnvironment: true, hasStatus: true, hasTags: true, label: 'Tasks',
  },
  pipelines: {
    index: 'pipelines',
    fields: ['pipeline_name', 'pipeline_name.keyword', 'flow'],
    dateField: 'run_date', hasEnvironment: false, hasStatus: true, hasTags: true, label: 'Pipelines',
  },
  maintenance: {
    index: 'maintenance',
    fields: ['notes', 'version', 'release_version'],
    dateField: 'date', hasEnvironment: true, hasStatus: false, hasTags: true, label: 'Maintenance',
  },
  pocs: {
    index: 'pocs',
    fields: ['title', 'title.keyword', 'concept_description'],
    dateField: 'created_at', hasEnvironment: false, hasStatus: true, hasTags: true, label: 'POCs',
  },
  timeline: {
    index: 'timeline_events',
    fields: ['event_title', 'event_title.keyword', 'event_description'],
    dateField: 'completed_at', hasEnvironment: false, hasStatus: false, hasTags: false, label: 'Timeline',
  },
  activity: {
    index: 'activity_log',
    fields: ['reason_note'],
    dateField: 'timestamp', hasEnvironment: false, hasStatus: false, hasTags: false, label: 'Audit Log',
  },
  tags: {
    index: 'tags',
    fields: ['name', 'description'],
    dateField: 'created_at', hasEnvironment: false, hasStatus: false, hasTags: false, label: 'Tags',
  },
};

// Pull a `tag:NAME` token out of the query string, if present.
function extractTag(raw) {
  const m = raw.match(/(?:^|\s)tag:("[^"]+"|\S+)/i);
  if (!m) return { tagName: null, text: raw.trim() };
  const tagName = m[1].replace(/"/g, '');
  const text = raw.replace(m[0], ' ').trim();
  return { tagName, text };
}

// GET /api/search?q=&type=&from=&to=&environment=&status=
// Supports `tag:postgres-staging` syntax inside q.
router.get('/', asyncRoute(async (req, res) => {
  const { type, from, to, environment, status } = req.query;
  const raw = (req.query.q || '').trim();
  if (!raw) return res.json({ q: '', groups: [] });

  const { tagName, text } = extractTag(raw);

  let targets = type && SEARCHABLE[type] ? [[type, SEARCHABLE[type]]] : Object.entries(SEARCHABLE);
  // A tag filter only makes sense for indices that carry tags.
  if (tagName) targets = targets.filter(([, cfg]) => cfg.hasTags);

  const groups = await Promise.all(
    targets.map(async ([key, cfg]) => {
      const filter = [];
      if (from || to) {
        const range = {};
        if (from) range.gte = from;
        if (to) range.lte = `${to}T23:59:59`;
        filter.push({ range: { [cfg.dateField]: range } });
      }
      if (environment && cfg.hasEnvironment) filter.push({ term: { environment } });
      if (status && cfg.hasStatus) filter.push({ term: { status } });
      if (tagName && cfg.hasTags) filter.push({ term: { tags: tagName } });

      // Free-text portion; match_all if the query was only a tag: filter.
      const must = text
        ? [{ multi_match: { query: text, fields: cfg.fields, type: 'best_fields', fuzziness: 'AUTO' } }]
        : [{ match_all: {} }];

      const { hits } = await es.search({
        index: cfg.index,
        size: 20,
        query: { bool: { must, filter } },
        sort: text ? undefined : [{ [cfg.dateField]: 'desc' }],
        highlight: text ? {
          pre_tags: ['<mark>'], post_tags: ['</mark>'],
          fields: cfg.fields.reduce((acc, f) => { if (!f.endsWith('.keyword')) acc[f] = {}; return acc; }, {}),
        } : undefined,
      }).catch(() => ({ hits: { total: { value: 0 }, hits: [] } }));

      return {
        type: key, label: cfg.label, index: cfg.index,
        count: hits.total.value, results: hits.hits.map(mapHit),
      };
    })
  );

  res.json({ q: raw, tag: tagName, groups: groups.filter((g) => g.count > 0) });
}));

export default router;
