import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const SECRET = process.env.JWT_SECRET || 'dev-change-me';
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export function signToken(user) {
  return jwt.sign({ sub: user.username, name: user.display_name }, SECRET, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET); // throws on invalid/expired
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}
export async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Express middleware: require a valid Bearer token; sets req.user.
export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = verifyToken(token);
    req.user = { username: decoded.sub, display_name: decoded.name };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// The acting user's username, for audit logging.
export function getActor(req) {
  return req.user?.username || 'engineer';
}

// Ownership check: who may edit/delete a document.
//  - the creator
//  - the assignee (tasks)
//  - anyone, if assigned_to === "common"
//  - anyone, for legacy docs with no created_by (pre-auth data)
export function canEdit(user, doc) {
  if (!doc) return false;
  if (!doc.created_by) return true;
  const u = user?.username;
  if (doc.created_by === u) return true;
  if (doc.assigned_to && doc.assigned_to === u) return true;
  if (doc.assigned_to === 'common') return true;
  return false;
}

// Throw a 403-style error if the user can't edit the doc.
export function assertCanEdit(req, doc) {
  if (!canEdit(req.user, doc)) {
    const err = new Error('You can only edit items you created, are assigned to, or that are marked common');
    err.statusCode = 403;
    throw err;
  }
}
