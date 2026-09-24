import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const databaseFile = path.resolve(serverRoot, process.env.DATABASE_FILE || './data/central-orchestrator.db');
fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
const db = new DatabaseSync(databaseFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','paused','waiting','blocked','completed','cancelled')),
    current_step TEXT NOT NULL,
    current_step_number INTEGER NOT NULL DEFAULT 0,
    total_steps INTEGER NOT NULL DEFAULT 1,
    completed_steps TEXT NOT NULL DEFAULT '[]',
    remaining_steps TEXT NOT NULL DEFAULT '[]',
    blocked_reason TEXT NOT NULL DEFAULT '',
    waiting_for TEXT NOT NULL DEFAULT '',
    next_action TEXT NOT NULL,
    last_action TEXT NOT NULL DEFAULT '',
    resume_token TEXT NOT NULL,
    context_snapshot TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('not_connected','connected','revoked')),
    permissions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();
const parse = value => { try { return JSON.parse(value); } catch { return value; } };
const serializeWorkflow = row => row && ({ ...row, completed_steps: parse(row.completed_steps), remaining_steps: parse(row.remaining_steps), context_snapshot: parse(row.context_snapshot) });
const log = (action, entityType, entityId, metadata = {}) => db.prepare('INSERT INTO activity_logs (action, entity_type, entity_id, metadata, created_at) VALUES (?, ?, ?, ?, ?)').run(action, entityType, entityId || null, JSON.stringify(metadata), now());

const app = express();
app.use(cors({ origin: process.env.WEB_ORIGIN || true }));
app.use(express.json());
app.use('/app', express.static(path.resolve(serverRoot, '..')));

app.get('/', (_req, res) => res.json({ service: 'central-orchestrator', status: 'running', health: '/api/health', dashboard: 'file:///D:/apps/game-agent-ai/index.html' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'central-orchestrator', database: 'sqlite' }));
app.get('/api/workflows', (_req, res) => {
  const rows = db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all();
  res.json(rows.map(serializeWorkflow));
});
app.post('/api/workflows', (req, res) => {
  const { name, steps = [], context_snapshot = {} } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  const id = crypto.randomUUID();
  const timestamp = now();
  const workflowSteps = steps.length ? steps : ['Define the smallest next step'];
  const workflow = { id, name: name.trim(), status: 'active', current_step: workflowSteps[0], current_step_number: 0, total_steps: workflowSteps.length, completed_steps: [], remaining_steps: workflowSteps.slice(1), blocked_reason: '', waiting_for: '', next_action: workflowSteps[0], last_action: '', resume_token: crypto.randomUUID(), context_snapshot, created_at: timestamp, updated_at: timestamp };
  db.prepare(`INSERT INTO workflows (id,name,status,current_step,current_step_number,total_steps,completed_steps,remaining_steps,blocked_reason,waiting_for,next_action,last_action,resume_token,context_snapshot,created_at,updated_at) VALUES (@id,@name,@status,@current_step,@current_step_number,@total_steps,@completed_steps,@remaining_steps,@blocked_reason,@waiting_for,@next_action,@last_action,@resume_token,@context_snapshot,@created_at,@updated_at)`).run({ ...workflow, completed_steps: '[]', remaining_steps: JSON.stringify(workflow.remaining_steps), context_snapshot: JSON.stringify(context_snapshot) });
  log('Workflow created', 'workflow', id, { name: workflow.name });
  res.status(201).json(workflow);
});
app.post('/api/workflows/:id/transition', (req, res) => {
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id);
  if (!workflow) return res.status(404).json({ error: 'workflow not found' });
  const { status, next_action, reason = '' } = req.body || {};
  const allowed = ['active', 'paused', 'waiting', 'blocked', 'completed', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid workflow status' });
  const timestamp = now();
  db.prepare('UPDATE workflows SET status = ?, next_action = COALESCE(?, next_action), blocked_reason = ?, last_action = ?, updated_at = ? WHERE id = ?').run(status, next_action || null, status === 'blocked' ? reason : '', `Transitioned to ${status}`, timestamp, req.params.id);
  log(`Workflow transitioned to ${status}`, 'workflow', req.params.id, { reason });
  res.json(serializeWorkflow(db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id)));
});
app.get('/api/checkpoints', (_req, res) => {
  const rows = db.prepare('SELECT * FROM workflows WHERE status IN (\'paused\', \'waiting\', \'blocked\') ORDER BY updated_at DESC').all();
  res.json(rows.map(serializeWorkflow));
});
app.get('/api/activity', (_req, res) => res.json(db.prepare('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 50').all().map(row => ({ ...row, metadata: parse(row.metadata) }))));
app.get('/api/approvals', (_req, res) => res.json(db.prepare('SELECT * FROM approval_requests ORDER BY created_at DESC').all().map(row => ({ ...row, details: parse(row.details) }))));
app.post('/api/approvals', (req, res) => {
  const { action, details = {} } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action is required' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO approval_requests (id, action, status, details, created_at) VALUES (?, ?, \'pending\', ?, ?)').run(id, action, JSON.stringify(details), now());
  log('Approval requested', 'approval', id, { action });
  res.status(201).json({ id, action, status: 'pending', details });
});
app.get('/api/integrations', (_req, res) => res.json(db.prepare('SELECT * FROM integrations ORDER BY provider').all().map(row => ({ ...row, permissions: parse(row.permissions) }))));
app.post('/api/integrations/:provider/disconnect', (req, res) => {
  const timestamp = now();
  db.prepare('INSERT INTO integrations (id, provider, status, permissions, created_at, updated_at) VALUES (?, ?, \'revoked\', \'[]\', ?, ?) ON CONFLICT(provider) DO UPDATE SET status = \'revoked\', permissions = \'[]\', updated_at = excluded.updated_at').run(crypto.randomUUID(), req.params.provider, timestamp, timestamp);
  log('Integration revoked', 'integration', req.params.provider);
  res.json({ provider: req.params.provider, status: 'revoked' });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`Central Orchestrator API listening on http://localhost:${port}`));
