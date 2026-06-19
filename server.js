import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { es } from './src/esClient.js';
import { ensureIndices } from './src/indices.js';

import { startRecurrenceScheduler } from './src/recurrence.js';
import { authRequired } from './src/auth.js';

import auth from './src/routes/auth.js';
import users from './src/routes/users.js';
import checklist from './src/routes/checklist.js';
import dailyTasks from './src/routes/dailyTasks.js';
import pipelines from './src/routes/pipelines.js';
import pipelineChecks from './src/routes/pipelineChecks.js';
import maintenance from './src/routes/maintenance.js';
import pocs from './src/routes/pocs.js';
import timeline from './src/routes/timeline.js';
import search from './src/routes/search.js';
import activityLog from './src/routes/activityLog.js';
import relationships from './src/routes/relationships.js';
import recurrenceRules from './src/routes/recurrenceRules.js';
import tags from './src/routes/tags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve the Lucide icon library (installed via npm) locally — no CDN needed.
app.use('/vendor/lucide', express.static(path.join(__dirname, 'node_modules', 'lucide', 'dist', 'umd')));

// ---- Public endpoints (no auth) ----
app.use('/api/auth', auth);
app.get('/api/health', async (req, res) => {
  try {
    await es.ping();
    res.json({ ok: true, es: 'connected' });
  } catch {
    res.status(503).json({ ok: false, es: 'unreachable' });
  }
});

// ---- Everything below requires a valid JWT ----
app.use('/api', authRequired);

app.use('/api/users', users);
app.use('/api/checklist', checklist);
app.use('/api/daily-tasks', dailyTasks);
app.use('/api/pipelines', pipelines);
app.use('/api/pipeline-checks', pipelineChecks);
app.use('/api/maintenance', maintenance);
app.use('/api/pocs', pocs);
app.use('/api/timeline', timeline);
app.use('/api/search', search);
app.use('/api/activity-log', activityLog);
app.use('/api/relationships', relationships);
app.use('/api/recurrence-rules', recurrenceRules);
app.use('/api/tags', tags);

// Central error handler — surfaces ES errors as JSON instead of crashing.
app.use((err, req, res, next) => {
  console.error('[error]', err?.meta?.body?.error || err);
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error',
  });
});

// Start serving immediately so the UI loads even if ES isn't up yet; the ES
// connection + index bootstrap runs separately and retries in the background.
app.listen(PORT, () => {
  console.log(`\n  DevOps Work Tracker running → http://localhost:${PORT}\n`);
});

async function bootstrapEs() {
  try {
    await es.ping();
    console.log(`[es] connected to ${process.env.ES_NODE || 'http://localhost:9200'}`);
    await ensureIndices();
    startRecurrenceScheduler();
    console.log('[recurrence] scheduler started (every 5m)');
  } catch (e) {
    console.error('\n[es] Elasticsearch not ready. Start it and check ES_NODE in .env.');
    console.error(`     ${e.message}`);
    console.error('[es] retrying in 10s…\n');
    setTimeout(bootstrapEs, 10000);
  }
}

bootstrapEs();
