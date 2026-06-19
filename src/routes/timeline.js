import { Router } from 'express';
import { es } from '../esClient.js';
import { asyncRoute, mapHit, todayStr } from '../util.js';

const router = Router();
const INDEX = 'timeline_events';

async function fetchEvents(date, type) {
  const filter = [{ term: { date } }];
  if (type && type !== 'all') filter.push({ term: { event_type: type } });

  const { hits } = await es.search({
    index: INDEX,
    size: 500,
    query: { bool: { filter } },
    sort: [{ completed_at: 'desc' }],
  });
  return hits.hits.map(mapHit);
}

// GET /api/timeline?date=YYYY-MM-DD&type=
router.get('/', asyncRoute(async (req, res) => {
  const date = req.query.date || todayStr();
  const events = await fetchEvents(date, req.query.type);
  res.json({ date, events });
}));

// GET /api/timeline/summary?date=YYYY-MM-DD
router.get('/summary', asyncRoute(async (req, res) => {
  const date = req.query.date || todayStr();
  const events = await fetchEvents(date);

  const summary = {
    date,
    tasks_done: 0,
    pipelines_pass: 0,
    pipelines_fail: 0,
    pocs_advanced: 0,
    maintenance_logged: 0,
    checklist_done: 0,
    checklist_total: 3,
  };

  for (const e of events) {
    switch (e.event_type) {
      case 'task': summary.tasks_done++; break;
      case 'pipeline':
        if (/FAIL/i.test(e.event_title)) summary.pipelines_fail++;
        else summary.pipelines_pass++;
        break;
      case 'poc': summary.pocs_advanced++; break;
      case 'maintenance': summary.maintenance_logged++; break;
      case 'checklist': summary.checklist_done++; break;
    }
  }

  // Checklist completion % for the day, capped at the 3 daily items.
  summary.checklist_done = Math.min(summary.checklist_done, summary.checklist_total);
  summary.checklist_pct = Math.round((summary.checklist_done / summary.checklist_total) * 100);

  res.json(summary);
}));

// GET /api/timeline/export?date=YYYY-MM-DD&format=html|txt
router.get('/export', asyncRoute(async (req, res) => {
  const date = req.query.date || todayStr();
  const format = req.query.format === 'txt' ? 'txt' : 'html';
  const events = await fetchEvents(date);

  if (format === 'txt') {
    const lines = [
      `DevOps Daily Report — ${date}`,
      '='.repeat(40),
      '',
      ...events.map((e) => {
        const t = new Date(e.completed_at).toLocaleTimeString();
        return `[${t}] (${e.event_type}) ${e.event_title}\n    ${e.event_description || ''}`.trimEnd();
      }),
      '',
      `Total events: ${events.length}`,
    ];
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="devops-report-${date}.txt"`);
    return res.send(lines.join('\n'));
  }

  const rows = events.map((e) => {
    const t = new Date(e.completed_at).toLocaleTimeString();
    return `<tr><td>${t}</td><td><span class="badge ${e.event_type}">${e.event_type}</span></td>
      <td><strong>${escapeHtml(e.event_title)}</strong></td><td>${escapeHtml(e.event_description || '')}</td></tr>`;
  }).join('\n');

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>DevOps Daily Report — ${date}</title>
<style>
  body{font-family:system-ui,Arial,sans-serif;background:#0f1320;color:#e6e9f0;padding:32px;}
  h1{color:#7aa2ff;} table{width:100%;border-collapse:collapse;margin-top:16px;}
  td,th{border-bottom:1px solid #2a3148;padding:8px 10px;text-align:left;vertical-align:top;}
  .badge{padding:2px 8px;border-radius:10px;font-size:12px;text-transform:capitalize;background:#2a3148;}
  .badge.task{background:#1f6f54;} .badge.pipeline{background:#7a4dd0;} .badge.checklist{background:#2f6fb0;}
  .badge.maintenance{background:#b0792f;} .badge.poc{background:#b03f6f;}
</style></head><body>
<h1>DevOps Daily Report</h1><p>${date} &middot; ${events.length} events</p>
<table><thead><tr><th>Time</th><th>Type</th><th>Title</th><th>Description</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">No activity recorded.</td></tr>'}</tbody></table>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="devops-report-${date}.html"`);
  res.send(html);
}));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export default router;
