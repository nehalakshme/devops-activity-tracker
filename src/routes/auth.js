import { Router } from 'express';
import { es } from '../esClient.js';
import { asyncRoute, nowIso } from '../util.js';
import { signToken, hashPassword, comparePassword, authRequired } from '../auth.js';

const router = Router();
const INDEX = 'users';

function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase().replace(/\s+/g, '');
}

async function findUser(username) {
  const { hits } = await es.search({ index: INDEX, size: 1, query: { term: { username } } });
  return hits.hits.length ? { id: hits.hits[0]._id, ...hits.hits[0]._source } : null;
}

// POST /api/auth/register  { username, password, display_name }
router.post('/register', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = req.body.password || '';
  const display_name = (req.body.display_name || '').trim() || username;

  if (!username || username.length < 2) return res.status(400).json({ error: 'username must be at least 2 characters' });
  if (password.length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });
  if (await findUser(username)) return res.status(409).json({ error: 'username already taken' });

  const doc = { username, display_name, password_hash: await hashPassword(password), created_at: nowIso() };
  await es.index({ index: INDEX, document: doc, refresh: 'wait_for' });

  const user = { username, display_name };
  res.status(201).json({ token: signToken(user), user });
}));

// POST /api/auth/login  { username, password }
router.post('/login', asyncRoute(async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = req.body.password || '';

  const user = await findUser(username);
  if (!user || !(await comparePassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'invalid username or password' });
  }

  const safe = { username: user.username, display_name: user.display_name };
  res.json({ token: signToken(safe), user: safe });
}));

// GET /api/auth/me  — current user from token
router.get('/me', authRequired, (req, res) => res.json({ user: req.user }));

export default router;
