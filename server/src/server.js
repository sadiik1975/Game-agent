import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Parser from 'rss-parser';
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

  CREATE TABLE IF NOT EXISTS content_posts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('linkedin','telegram')),
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft','scheduled','publishing','published','failed')),
    scheduled_at TEXT,
    published_at TEXT,
    platform_post_id TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS content_posts_schedule
  ON content_posts(status, scheduled_at);

  CREATE TABLE IF NOT EXISTS social_notifications (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    external_id TEXT NOT NULL,
    sender TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT,
    auto_replied INTEGER NOT NULL DEFAULT 0,
    UNIQUE(platform, external_id)
  );

  CREATE TABLE IF NOT EXISTS content_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS integration_cursors (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS integrations_provider_unique
  ON integrations(provider)
`);

const now = () => new Date().toISOString();

const parse = value => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const serializeWorkflow = row => {
  if (!row) return null;

  const completedSteps = parse(row.completed_steps);

  return {
    ...row,
    completed_steps: completedSteps,
    remaining_steps: parse(row.remaining_steps),
    context_snapshot: parse(row.context_snapshot),
    completed: Array.isArray(completedSteps)
      ? completedSteps.length
      : row.current_step_number,
    total: row.total_steps,
    next: row.next_action
  };
};

const log = (
  action,
  entityType,
  entityId,
  metadata = {}
) =>
  db.prepare(
    'INSERT INTO activity_logs (action, entity_type, entity_id, metadata, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(
    action,
    entityType,
    entityId || null,
    JSON.stringify(metadata),
    now()
  );

const gmailRedirect = status => {
  const redirect = new URL(
    process.env.WEB_APP_URL || '/app/',
    process.env.WEB_ORIGIN || 'http://localhost:8787'
  );

  redirect.searchParams.set('gmail', status);

  return redirect.toString();
};

const googleAuthStates = new Set();
let googleToken = null;

const hasGoogleOAuth = () =>
  Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    !process.env.GOOGLE_CLIENT_ID.includes('your-client-id') &&
    !process.env.GOOGLE_CLIENT_SECRET.includes('your-client-secret')
  );

const safeImageTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
]);

const decodeBase64Url = value =>
  Buffer.from(value, 'base64url').toString('utf8');

const collectGmailContent = (
  part,
  result = {
    text: '',
    html: '',
    images: []
  }
) => {
  const mimeType = String(part.mimeType || '').toLowerCase();
  const body = part.body || {};

  if (
    mimeType === 'text/plain' &&
    body.data &&
    !result.text
  ) {
    result.text = decodeBase64Url(body.data).slice(0, 50000);
  }

  if (
    mimeType === 'text/html' &&
    body.data &&
    !result.html
  ) {
    result.html = decodeBase64Url(body.data).slice(0, 100000);
  }

  if (
    safeImageTypes.has(mimeType) &&
    body.attachmentId
  ) {
    result.images.push({
      attachmentId: body.attachmentId,
      mimeType,
      filename: part.filename || 'Email image'
    });
  }

  (part.parts || []).forEach(child =>
    collectGmailContent(child, result)
  );

  return result;
};

const app = express();

/*
 * CORS CONFIGURATION
 * Allows the Netlify frontend to communicate with this API.
 */
app.use(cors({
  origin: process.env.WEB_ORIGIN || 'https://nexus1ai.netlify.app',
  credentials: true
}));

app.use(express.json());

app.use(
  '/app',
  express.static(path.resolve(serverRoot, '..'))
);

const rssParser = new Parser({
  timeout: 10000,
  headers: {
    'user-agent': 'PersonalBusinessAgent/1.0'
  }
});

const newsSources = [
  {
    category: 'ai',
    label: 'AI & Agents',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/'
  },
  {
    category: 'robotics',
    label: 'Robotics',
    url: 'https://www.therobotreport.com/feed/'
  },
  {
    category: 'markets',
    label: 'Markets & Stocks',
    url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html'
  },
  {
    category: 'crypto',
    label: 'Crypto',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml'
  }
];

const newsCache = {
  articles: [],
  updatedAt: null,
  expiresAt: 0,
  refreshPromise: null
};

const plainNewsText = (value, limit = 500) =>
  String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);

const refreshNews = async () => {
  const results = await Promise.allSettled(
    newsSources.map(async source => {
      const feed = await rssParser.parseURL(source.url);

      return (feed.items || [])
        .slice(0, 15)
        .map(item => {
          let link = '';

          try {
            const candidate = new URL(
              item.link || feed.link
            );

            if (
              candidate.protocol === 'https:' ||
              candidate.protocol === 'http:'
            ) {
              link = candidate.href;
            }
          } catch {}

          const timestamp = Date.parse(
            item.isoDate ||
            item.pubDate ||
            ''
          );

          return {
            id: `${source.category}:${item.guid || item.link || item.title || ''}`,
            category: source.category,
            categoryLabel: source.label,
            title:
              plainNewsText(item.title, 220) ||
              'Untitled story',
            summary: plainNewsText(
              item.contentSnippet ||
              item.summary ||
              item.content ||
              item['content:encoded'],
              600
            ),
            source: plainNewsText(
              feed.title || source.label,
              100
            ),
            url: link,
            publishedAt: Number.isFinite(timestamp)
              ? new Date(timestamp).toISOString()
              : null
          };
        });
    })
  );

  const articles = [];
  const unavailable = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      articles.push(...result.value);
    } else {
      unavailable.push(newsSources[index].label);
    }
  });

  const deduplicated = [
    ...new Map(
      articles
        .filter(article => article.url)
        .map(article => [article.url, article])
    ).values()
  ].sort(
    (a, b) =>
      (Date.parse(b.publishedAt || '') || 0) -
      (Date.parse(a.publishedAt || '') || 0)
  );

  newsCache.articles = deduplicated.slice(0, 60);
  newsCache.updatedAt = new Date().toISOString();
  newsCache.expiresAt =
    Date.now() + 10 * 60 * 1000;

  return {
    articles: newsCache.articles,
    updatedAt: newsCache.updatedAt,
    unavailable
  };
};

app.get('/', (_req, res) =>
  res.redirect('/app/')
);

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    service: 'central-orchestrator',
    database: 'sqlite'
  })
);

app.get('/api/workflows', (_req, res) => {
  const workflows = db.prepare(
    'SELECT * FROM workflows ORDER BY updated_at DESC'
  ).all();

  res.json(workflows.map(serializeWorkflow));
});

app.post('/api/workflows', (req, res) => {
  const name = String(req.body?.name || '').trim();

  if (!name || name.length > 160) {
    return res.status(400).json({
      error: 'Workflow name is required and must be 160 characters or fewer.'
    });
  }

  const id = crypto.randomUUID();
  const timestamp = now();
  const nextAction = 'Review the goal and define the first step.';

  db.prepare(`
    INSERT INTO workflows (
      id, name, status, current_step, current_step_number,
      total_steps, completed_steps, remaining_steps, blocked_reason,
      waiting_for, next_action, last_action, resume_token,
      context_snapshot, created_at, updated_at
    ) VALUES (?, ?, 'active', ?, 0, 1, '[]', ?, '', '', ?, '', ?, '{}', ?, ?)
  `).run(
    id,
    name,
    'Ready to start',
    JSON.stringify([nextAction]),
    nextAction,
    crypto.randomUUID(),
    timestamp,
    timestamp
  );

  log('Workflow created', 'workflow', id, { name });
  res.status(201).json(serializeWorkflow(
    db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
  ));
});

app.get('/api/activity', (_req, res) => {
  const activity = db.prepare(
    'SELECT * FROM activity_logs ORDER BY id DESC LIMIT 100'
  ).all();

  res.json(activity.map(item => ({
    ...item,
    metadata: parse(item.metadata)
  })));
});

app.get('/api/integrations', (_req, res) => {
  const savedIntegrations = new Map(
    db.prepare('SELECT * FROM integrations').all()
      .map(integration => [integration.provider, integration])
  );

  const definitions = [
    {
      provider: 'gmail',
      label: 'Google Email',
      detail: 'Connect a Google account to read and reply to email.',
      connected: Boolean(googleToken)
    },
    {
      provider: 'outlook',
      label: 'Outlook',
      detail: 'Connect Microsoft 365 to read Outlook email.',
      connected: Boolean(process.env.MICROSOFT_ACCESS_TOKEN)
    },
    {
      provider: 'linkedin',
      label: 'LinkedIn',
      detail: 'Configure LinkedIn publishing credentials in Render.',
      connected: Boolean(
        process.env.LINKEDIN_ACCESS_TOKEN &&
        process.env.LINKEDIN_AUTHOR_URN
      )
    },
    {
      provider: 'telegram',
      label: 'Telegram',
      detail: 'Configure a Telegram bot and chat in Render.',
      connected: Boolean(
        process.env.TELEGRAM_BOT_TOKEN &&
        process.env.TELEGRAM_CHAT_ID
      )
    }
  ];

  res.json(definitions.map(integration => {
    const saved = savedIntegrations.get(integration.provider);
    const revoked = saved?.status === 'revoked';

    return {
      ...integration,
      configured: integration.connected && !revoked,
      status: revoked
        ? 'revoked'
        : integration.connected
          ? 'connected'
          : 'not_connected',
      permissions: parse(saved?.permissions || '[]')
    };
  }));
});

app.get('/api/checkpoints', (_req, res) => {
  const workflows = db.prepare(
    'SELECT id, name, status, resume_token, updated_at FROM workflows ORDER BY updated_at DESC'
  ).all();

  res.json(workflows);
});

app.get('/api/approvals', (_req, res) => {
  const approvals = db.prepare(
    'SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT 100'
  ).all();

  res.json(approvals.map(approval => ({
    ...approval,
    details: parse(approval.details)
  })));
});

app.post('/api/approvals', (req, res) => {
  const action = String(req.body?.action || '').trim();

  if (!action || action.length > 200) {
    return res.status(400).json({
      error: 'Approval action is required and must be 200 characters or fewer.'
    });
  }

  const id = crypto.randomUUID();
  const timestamp = now();
  const details = req.body?.details && typeof req.body.details === 'object'
    ? req.body.details
    : {};

  db.prepare(`
    INSERT INTO approval_requests (id, action, status, details, created_at)
    VALUES (?, ?, 'pending', ?, ?)
  `).run(id, action, JSON.stringify(details), timestamp);

  log('Approval requested', 'approval', id, { action });
  res.status(201).json({
    id,
    action,
    status: 'pending',
    details,
    created_at: timestamp
  });
});

const requestChatCompletion = async ({
  provider,
  baseUrl,
  apiKey,
  model,
  messages
}) => {
  let endpoint;

  try {
    endpoint = new URL(
      `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    );
  } catch {
    throw new Error(`${provider} API URL is invalid.`);
  }

  if (endpoint.protocol !== 'https:') {
    throw new Error(`${provider} API URL must use HTTPS.`);
  }

  let response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...(provider === 'openrouter' ? {
          'HTTP-Referer': process.env.WEB_ORIGIN || '',
          'X-Title': 'Personal Business Agent'
        } : {})
      },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(55000)
    });
  } catch {
    throw new Error(`${provider} request failed. Check its URL and network settings.`);
  }

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`${provider} returned HTTP ${response.status}.`);
  }

  const text = result.choices?.[0]?.message?.content;

  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('OpenRouter returned an empty response.');
  }

  return { text: text.trim(), provider };
};

app.post('/api/chat', async (req, res) => {
  const inputMessages = Array.isArray(req.body?.messages)
    ? req.body.messages
    : [];
  const messages = inputMessages
    .filter(message =>
      ['user', 'assistant'].includes(message?.role) &&
      typeof (message?.text || message?.content) === 'string'
    )
    .slice(-24)
    .map(message => ({
      role: message.role,
      content: String(message.text || message.content).slice(0, 12000)
    }));

  if (!messages.length) {
    return res.status(400).json({
      error: 'At least one user or assistant message is required.'
    });
  }

  const businessContext = String(req.body?.businessContext || '').trim();
  const providerMessages = [
    {
      role: 'system',
      content: `You are a practical personal business assistant. Be accurate, concise, and transparent about uncertainty. Do not invent emails, leads, meetings, or completed actions. Do not give investment advice.${businessContext ? ` The user's business context is: ${businessContext.slice(0, 2000)}` : ''}`
    },
    ...messages
  ];
  const openRouterKey =
    req.get('x-openrouter-api-key') || process.env.OPENROUTER_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  if (!openRouterKey && !groqKey) {
    return res.status(503).json({
      error: 'Configure OPENROUTER_API_KEY or GROQ_API_KEY in Render to enable chat.'
    });
  }

  let openRouterError;

  if (openRouterKey) {
    try {
      return res.json(await requestChatCompletion({
        provider: 'openrouter',
        baseUrl: process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1',
        apiKey: openRouterKey,
        model: process.env.OPENROUTER_MODEL || 'openrouter/free',
        messages: providerMessages
      }));
    } catch (error) {
      openRouterError = error;
    }
  }

  if (groqKey) {
    try {
      return res.json(await requestChatCompletion({
        provider: 'groq',
        baseUrl: process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1',
        apiKey: groqKey,
        model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
        messages: providerMessages
      }));
    } catch (error) {
      return res.status(502).json({
        error: `Chat providers failed: ${openRouterError?.message || 'OpenRouter is unavailable.'} ${error.message}`
      });
    }
  }

  res.status(502).json({
    error: openRouterError?.message || 'OpenRouter is unavailable.'
  });
});

app.get('/api/news', async (req, res) => {
  if (
    req.query.refresh !== '1' &&
    newsCache.articles.length &&
    Date.now() < newsCache.expiresAt
  ) {
    return res.json({
      articles: newsCache.articles,
      updatedAt: newsCache.updatedAt,
      unavailable: []
    });
  }

  try {
    if (!newsCache.refreshPromise) {
      newsCache.refreshPromise = refreshNews()
        .finally(() => {
          newsCache.refreshPromise = null;
        });
    }

    const result = await newsCache.refreshPromise;

    if (!result.articles.length) {
      return res.status(502).json({
        error: 'News feeds are temporarily unavailable.',
        unavailable: result.unavailable
      });
    }

    res.json(result);
  } catch (error) {
    res.status(502).json({
      error: `News refresh failed: ${error.message}`
    });
  }
});

const getContentSetting = key =>
  db.prepare('SELECT value FROM content_settings WHERE key = ?').get(key)?.value;

const getContentStatus = () => {
  const scheduledToday = db.prepare(`
    SELECT COUNT(*) AS count
    FROM content_posts
    WHERE status IN ('scheduled', 'published')
      AND date(CASE WHEN status = 'published' THEN published_at ELSE scheduled_at END) = date('now')
  `).get().count;
  const telegramAutoReply = getContentSetting('telegram_auto_reply') === 'true';
  const telegramAutoReplyTemplate = getContentSetting('telegram_auto_reply_template') || '';
  const linkedinConnected = Boolean(
    process.env.LINKEDIN_ACCESS_TOKEN && process.env.LINKEDIN_AUTHOR_URN
  );
  const telegramConnected = Boolean(
    process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
  );

  return {
    platforms: {
      linkedin: {
        connected: linkedinConnected,
        detail: linkedinConnected
          ? 'LinkedIn publishing is configured.'
          : 'Add LinkedIn publishing credentials in Render.'
      },
      telegram: {
        connected: telegramConnected,
        detail: telegramConnected
          ? 'Telegram publishing is configured.'
          : 'Add a Telegram bot token and chat ID in Render.'
      }
    },
    scheduledToday,
    dailyLimit: 10,
    telegramAutoReply,
    telegramAutoReplyTemplate
  };
};

app.get('/api/content/status', (_req, res) =>
  res.json(getContentStatus())
);

app.get('/api/content/posts', (_req, res) => {
  res.json(db.prepare(
    'SELECT * FROM content_posts ORDER BY created_at DESC'
  ).all());
});

app.get('/api/content/notifications', (_req, res) => {
  const notifications = db.prepare(
    'SELECT * FROM social_notifications ORDER BY created_at DESC LIMIT 100'
  ).all();

  res.json(notifications.map(notification => ({
    ...notification,
    auto_replied: Boolean(notification.auto_replied)
  })));
});

app.post('/api/content/settings', (req, res) => {
  const { telegramAutoReply, telegramAutoReplyTemplate } = req.body || {};

  if (typeof telegramAutoReply !== 'boolean') {
    return res.status(400).json({
      error: 'telegramAutoReply must be a boolean.'
    });
  }

  const template = String(telegramAutoReplyTemplate || '').slice(0, 2000);
  const saveSetting = db.prepare(`
    INSERT INTO content_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  saveSetting.run('telegram_auto_reply', String(telegramAutoReply));
  saveSetting.run('telegram_auto_reply_template', template);
  log('Telegram reply settings updated', 'integration', 'telegram', {
    autoReply: telegramAutoReply
  });

  res.json(getContentStatus());
});

app.post('/api/content/posts', (req, res) => {
  const content = String(req.body?.content || '').trim();
  const platform = String(req.body?.platform || '');
  const action = String(req.body?.action || 'draft');

  if (!content || content.length > 10000) {
    return res.status(400).json({
      error: 'Post content is required and must be 10,000 characters or fewer.'
    });
  }

  if (!['linkedin', 'telegram'].includes(platform)) {
    return res.status(400).json({
      error: 'Choose LinkedIn or Telegram as the publishing platform.'
    });
  }

  if (!['draft', 'schedule'].includes(action)) {
    return res.status(400).json({
      error: 'Post action must be draft or schedule.'
    });
  }

  let scheduledAt = null;

  if (action === 'schedule') {
    const requestedTime = Date.parse(req.body?.scheduledAt || '');

    if (!Number.isFinite(requestedTime) || requestedTime <= Date.now()) {
      return res.status(400).json({
        error: 'Choose a valid future date and time to schedule this post.'
      });
    }

    scheduledAt = new Date(requestedTime).toISOString();
    const scheduledCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM content_posts
      WHERE status IN ('scheduled', 'published')
        AND date(CASE WHEN status = 'published' THEN published_at ELSE scheduled_at END) = date(?)
    `).get(scheduledAt).count;

    if (scheduledCount >= 10) {
      return res.status(429).json({
        error: 'The daily limit of 10 scheduled or published posts has been reached.'
      });
    }
  }

  const id = crypto.randomUUID();
  const timestamp = now();
  const status = action === 'schedule' ? 'scheduled' : 'draft';

  db.prepare(`
    INSERT INTO content_posts (
      id, platform, content, status, scheduled_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, platform, content, status, scheduledAt, timestamp, timestamp);

  log(action === 'schedule' ? 'Content post scheduled' : 'Content draft saved', 'content_post', id, {
    platform,
    scheduledAt
  });

  res.status(201).json(
    db.prepare('SELECT * FROM content_posts WHERE id = ?').get(id)
  );
});

app.delete('/api/content/posts/:id', (req, res) => {
  const result = db.prepare(
    'DELETE FROM content_posts WHERE id = ?'
  ).run(req.params.id);

  if (!result.changes) {
    return res.status(404).json({ error: 'Content post not found.' });
  }

  log('Content post removed', 'content_post', req.params.id);
  res.json({ deleted: true, id: req.params.id });
});

app.post('/api/content/notifications/:id/read', (req, res) => {
  const result = db.prepare(`
    UPDATE social_notifications SET read_at = ? WHERE id = ?
  `).run(now(), req.params.id);

  if (!result.changes) {
    return res.status(404).json({ error: 'Notification not found.' });
  }

  res.json({ id: req.params.id, read: true });
});

app.post('/api/content/posts/:id/publish', async (req, res) => {
  const post = db.prepare(
    'SELECT * FROM content_posts WHERE id = ?'
  ).get(req.params.id);

  if (!post) {
    return res.status(404).json({ error: 'Content post not found.' });
  }

  if (post.status === 'published') {
    return res.status(409).json({ error: 'This post has already been published.' });
  }

  let endpoint;
  let requestBody;
  let requestHeaders = { 'content-type': 'application/json' };

  if (post.platform === 'telegram') {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      return res.status(503).json({
        error: 'Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Render before publishing.'
      });
    }

    endpoint = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    requestBody = {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: post.content
    };
  } else {
    if (!process.env.LINKEDIN_ACCESS_TOKEN || !process.env.LINKEDIN_AUTHOR_URN) {
      return res.status(503).json({
        error: 'Configure LINKEDIN_ACCESS_TOKEN and LINKEDIN_AUTHOR_URN in Render before publishing.'
      });
    }

    endpoint = 'https://api.linkedin.com/rest/posts';
    requestHeaders = {
      ...requestHeaders,
      authorization: `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
      'LinkedIn-Version': process.env.LINKEDIN_API_VERSION || '202609',
      'X-Restli-Protocol-Version': '2.0.0'
    };
    requestBody = {
      author: process.env.LINKEDIN_AUTHOR_URN,
      commentary: post.content,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: []
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false
    };
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000)
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(responseText || `Platform returned HTTP ${response.status}.`);
    }

    let platformPostId = response.headers.get('x-restli-id') || '';

    if (post.platform === 'telegram') {
      const result = JSON.parse(responseText);

      if (!result.ok) {
        throw new Error(result.description || 'Telegram rejected the post.');
      }

      platformPostId = String(result.result?.message_id || '');
    }

    const timestamp = now();
    db.prepare(`
      UPDATE content_posts
      SET status = 'published', published_at = ?, platform_post_id = ?, error = '', updated_at = ?
      WHERE id = ?
    `).run(timestamp, platformPostId, timestamp, post.id);
    log('Content post published', 'content_post', post.id, {
      platform: post.platform,
      platformPostId
    });

    res.json({
      id: post.id,
      status: 'published',
      platformPostId
    });
  } catch (error) {
    const timestamp = now();
    db.prepare(`
      UPDATE content_posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
    `).run(error.message.slice(0, 1000), timestamp, post.id);
    log('Content post publication failed', 'content_post', post.id, {
      platform: post.platform,
      error: error.message
    });

    res.status(502).json({
      error: `Post could not be published: ${error.message}`
    });
  }
});

const emailQuestion = text =>
  /\b(email|emails|mail|inbox|gmail|newsletter|newsletters)\b/i.test(
    text
  );

const getRecentEmailContext = async question => {
  if (!googleToken) {
    return {
      status: 401,
      error:
        'Gmail is not connected. Connect Gmail before asking about email.'
    };
  }

  const params = new URLSearchParams({
    maxResults: '12'
  });

  const todayQuery =
    /\b(today|this morning|since midnight)\b/i.test(
      question
    );

  if (todayQuery) {
    params.set('q', 'newer_than:1d');
  }

  const listResponse = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    {
      headers: {
        authorization: `Bearer ${googleToken.accessToken}`
      }
    }
  );

  const list = await listResponse.json();

  if (!listResponse.ok) {
    return {
      error:
        list.error?.message ||
        'Gmail could not search recent messages.',
      status: listResponse.status
    };
  }

  const messages = await Promise.all(
    list.messages || []
  );

  return {
    messages
  };
};

app.get('/auth/google/start', (req, res) => {
  if (!hasGoogleOAuth()) {
    return res.status(503).json({
      error: 'Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Render before connecting Gmail.'
    });
  }

  const state = crypto.randomUUID();
  googleAuthStates.add(state);
  const callbackUrl = process.env.GOOGLE_REDIRECT_URI ||
    `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}/auth/google/callback`;
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');

  authorizationUrl.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state
  }).toString();

  res.redirect(authorizationUrl.toString());
});

app.get('/auth/google/callback', async (req, res) => {
  const state = String(req.query.state || '');

  if (req.query.error) {
    return res.redirect(gmailRedirect('denied'));
  }

  if (!state || !googleAuthStates.delete(state) || !req.query.code) {
    return res.redirect(gmailRedirect('invalid_state'));
  }

  if (!hasGoogleOAuth()) {
    return res.redirect(gmailRedirect('not_configured'));
  }

  const callbackUrl = process.env.GOOGLE_REDIRECT_URI ||
    `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}/auth/google/callback`;

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code'
      }),
      signal: AbortSignal.timeout(20000)
    });
    const tokens = await response.json();

    if (!response.ok || !tokens.access_token) {
      return res.redirect(gmailRedirect('error'));
    }

    googleToken = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || googleToken?.refreshToken || '',
      expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000
    };
    const timestamp = now();

    db.prepare(`
      INSERT INTO integrations (id, provider, status, permissions, created_at, updated_at)
      VALUES (?, 'gmail', 'connected', ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        status = 'connected',
        permissions = excluded.permissions,
        updated_at = excluded.updated_at
    `).run(
      crypto.randomUUID(),
      JSON.stringify(['gmail.readonly', 'gmail.send']),
      timestamp,
      timestamp
    );
    log('Gmail connected', 'integration', 'gmail');

    res.redirect(gmailRedirect('connected'));
  } catch {
    res.redirect(gmailRedirect('error'));
  }
});

/*
 * The remainder of the original server.js continues below.
 * Keep your existing route handlers and scheduler code exactly
 * as they were in the uploaded file.
 */

app.get('/api/gmail/inbox', async (_req, res) => {
  if (!googleToken) {
    return res.status(401).json({
      error:
        'Gmail is not connected. Choose Connect Gmail first.'
    });
  }

  try {
    const listResponse = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20',
      {
        headers: {
          authorization:
            `Bearer ${googleToken.accessToken}`
        }
      }
    );

    const list = await listResponse.json();

    if (listResponse.status === 401) {
      return res.status(401).json({
        error:
          'The Google access token is invalid or expired. Reconnect Gmail.'
      });
    }

    if (!listResponse.ok) {
      return res.status(502).json({
        error:
          list.error?.message ||
          'Gmail could not load the inbox.'
      });
    }

    const messages = await Promise.all(
      (list.messages || []).map(async message => {
        const detailResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`,
          {
            headers: {
              authorization:
                `Bearer ${googleToken.accessToken}`
            }
          }
        );

        const detail = await detailResponse.json();

        const headers = Object.fromEntries(
          (detail.payload?.headers || []).map(header => [
            header.name.toLowerCase(),
            header.value
          ])
        );

        const content = collectGmailContent(
          detail.payload || {}
        );

        return {
          id: message.id,
          threadId: detail.threadId,
          subject:
            headers.subject || '(no subject)',
          from: {
            emailAddress: {
              address:
                headers.from || 'Unknown sender'
            }
          },
          receivedDateTime:
            headers.date || detail.internalDate,
          bodyPreview:
            detail.snippet || '',
          bodyText:
            content.text ||
            detail.snippet ||
            '',
          bodyHtml: content.html,
          images: content.images,
          isRead:
            !(detail.labelIds || []).includes(
              'UNREAD'
            )
        };
      })
    );

    res.json(messages);
  } catch (error) {
    res.status(502).json({
      error:
        `Gmail inbox request failed: ${error.message}`
    });
  }
});

app.get(
  '/api/gmail/messages/:messageId/attachments/:attachmentId',
  async (req, res) => {
    if (!googleToken) {
      return res.status(401).json({
        error:
          'Gmail is not connected. Choose Connect Gmail first.'
      });
    }

    const mimeType = String(
      req.query.mime || ''
    ).toLowerCase();

    if (!safeImageTypes.has(mimeType)) {
      return res.status(415).json({
        error:
          'This image type is not supported.'
      });
    }

    try {
      const url =
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(req.params.messageId)}/attachments/${encodeURIComponent(req.params.attachmentId)}`;

      const response = await fetch(url, {
        headers: {
          authorization:
            `Bearer ${googleToken.accessToken}`
        }
      });

      const result = await response.json();

      if (!response.ok) {
        return res
          .status(
            response.status === 401
              ? 401
              : 502
          )
          .json({
            error:
              result.error?.message ||
              'Gmail could not load this image.'
          });
      }

      const image = Buffer.from(
        result.data || '',
        'base64url'
      );

      if (image.length > 5_000_000) {
        return res.status(413).json({
          error:
            'This image is too large to preview.'
        });
      }

      res
        .set({
          'content-type': mimeType,
          'cache-control':
            'private, max-age=300',
          'x-content-type-options':
            'nosniff'
        })
        .send(image);
    } catch (error) {
      res.status(502).json({
        error:
          `Gmail image request failed: ${error.message}`
      });
    }
  }
);

app.post(
  '/api/gmail/messages/:messageId/reply',
  async (req, res) => {
    if (!googleToken) {
      return res.status(401).json({
        error:
          'Gmail is not connected. Choose Connect Gmail first.'
      });
    }

    const body = String(
      req.body?.body || ''
    ).trim();

    if (!body) {
      return res.status(400).json({
        error: 'Reply text is required.'
      });
    }

    if (body.length > 10000) {
      return res.status(400).json({
        error:
          'Reply must be 10,000 characters or fewer.'
      });
    }

    try {
      const messageUrl =
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(req.params.messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`;

      const originalResponse = await fetch(
        messageUrl,
        {
          headers: {
            authorization:
              `Bearer ${googleToken.accessToken}`
          }
        }
      );

      const original =
        await originalResponse.json();

      if (!originalResponse.ok) {
        return res
          .status(
            originalResponse.status === 401
              ? 401
              : 502
          )
          .json({
            error:
              original.error?.message ||
              'Gmail could not load the original message.'
          });
      }

      const headers = Object.fromEntries(
        (original.payload?.headers || []).map(
          header => [
            header.name.toLowerCase(),
            header.value
          ]
        )
      );

      const recipient =
        headers.from?.match(
          /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
        )?.[0];

      if (!recipient) {
        return res.status(502).json({
          error:
            'Gmail could not determine the original sender.'
        });
      }

      const cleanHeader = value =>
        String(value || '')
          .replace(/[\r\n]+/g, ' ')
          .trim();

      const subject = cleanHeader(
        headers.subject || '(no subject)'
      );

      const replyHeaders = [
        `To: ${recipient}`,
        `Subject: ${
          /^re:/i.test(subject)
            ? subject
            : `Re: ${subject}`
        }`
      ];

      if (headers['message-id']) {
        replyHeaders.push(
          `In-Reply-To: ${cleanHeader(
            headers['message-id']
          )}`
        );
      }

      if (
        headers.references ||
        headers['message-id']
      ) {
        replyHeaders.push(
          `References: ${
            [
              headers.references,
              headers['message-id']
            ]
              .filter(Boolean)
              .map(cleanHeader)
              .join(' ')
          }`
        );
      }

      replyHeaders.push(
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit'
      );

      const rawMessage =
        `${replyHeaders.join('\r\n')}\r\n\r\n${body}`;

      const sendResponse = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        {
          method: 'POST',
          headers: {
            authorization:
              `Bearer ${googleToken.accessToken}`,
            'content-type':
              'application/json'
          },
          body: JSON.stringify({
            raw: Buffer.from(
              rawMessage,
              'utf8'
            ).toString('base64url'),
            threadId:
              original.threadId
          })
        }
      );

      const sent =
        await sendResponse.json();

      if (!sendResponse.ok) {
        return res
          .status(
            sendResponse.status === 401
              ? 401
              : 502
          )
          .json({
            error:
              sent.error?.message ||
              'Gmail could not send the reply.'
          });
      }

      log(
        'Gmail reply sent',
        'email',
        req.params.messageId,
        { subject }
      );

      res.json({
        sent: true,
        id: sent.id,
        threadId: sent.threadId
      });
    } catch (error) {
      res.status(502).json({
        error:
          `Gmail reply request failed: ${error.message}`
      });
    }
  }
);

app.get(
  '/api/outlook/inbox',
  async (_req, res) => {
    if (!process.env.MICROSOFT_ACCESS_TOKEN) {
      return res.status(503).json({
        error:
          'Outlook is not connected. Set a valid delegated MICROSOFT_ACCESS_TOKEN or complete Microsoft OAuth.'
      });
    }

    try {
      const response = await fetch(
        'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=20&$select=id,subject,from,receivedDateTime,bodyPreview,isRead',
        {
          headers: {
            authorization:
              `Bearer ${process.env.MICROSOFT_ACCESS_TOKEN}`
          }
        }
      );

      const result =
        await response.json();

      if (response.status === 401) {
        return res.status(401).json({
          error:
            'The Microsoft access token is invalid or expired. Reconnect Outlook and request delegated Mail.Read permission.'
        });
      }

      if (response.status === 403) {
        return res.status(403).json({
          error:
            'Microsoft denied inbox access. Add delegated Mail.Read permission, grant admin consent if required, then reconnect Outlook.'
        });
      }

      if (!response.ok) {
        return res.status(502).json({
          error:
            result.error?.message ||
            'Microsoft Graph could not read the inbox.'
        });
      }

      res.json(result.value || []);
    } catch (error) {
      res.status(502).json({
        error:
          `Outlook inbox request failed: ${error.message}`
      });
    }
  }
);

app.post(
  '/api/notifications/outlook',
  async (req, res) => {
    const {
      subject,
      body
    } = req.body || {};

    const to =
      req.body?.to ||
      process.env.MICROSOFT_NOTIFICATION_TO;

    if (!process.env.MICROSOFT_ACCESS_TOKEN) {
      return res.status(503).json({
        error:
          'Set MICROSOFT_ACCESS_TOKEN in server/.env first.'
      });
    }

    if (!subject || !body || !to) {
      return res.status(400).json({
        error:
          'subject, body, and to are required'
      });
    }

    try {
      const response = await fetch(
        'https://graph.microsoft.com/v1.0/me/sendMail',
        {
          method: 'POST',
          headers: {
            authorization:
              `Bearer ${process.env.MICROSOFT_ACCESS_TOKEN}`,
            'content-type':
              'application/json'
          },
          body: JSON.stringify({
            message: {
              subject,
              body: {
                contentType: 'Text',
                content: body
              },
              toRecipients: [
                {
                  emailAddress: {
                    address: to
                  }
                }
              ]
            },
            saveToSentItems: true
          })
        }
      );

      if (!response.ok) {
        return res.status(502).json({
          error:
            (await response.text()) ||
            'Outlook rejected the message'
        });
      }

      log(
        'Outlook notification sent',
        'notification',
        to,
        { subject }
      );

      res.json({
        sent: true,
        provider: 'outlook'
      });
    } catch (error) {
      res.status(502).json({
        error:
          `Outlook request failed: ${error.message}`
      });
    }
  }
);

app.post(
  '/api/integrations/:provider/disconnect',
  (req, res) => {
    const timestamp = now();

    db.prepare(
      `INSERT INTO integrations
      (id, provider, status, permissions, created_at, updated_at)
      VALUES (?, ?, 'revoked', '[]', ?, ?)
      ON CONFLICT(provider)
      DO UPDATE SET
        status = 'revoked',
        permissions = '[]',
        updated_at = excluded.updated_at`
    ).run(
      crypto.randomUUID(),
      req.params.provider,
      timestamp,
      timestamp
    );

    log(
      'Integration revoked',
      'integration',
      req.params.provider
    );

    res.json({
      provider: req.params.provider,
      status: 'revoked'
    });
  }
);

const port = Number(
  process.env.PORT || 8787
);

const server = app.listen(
  port,
  () =>
    console.log(
      `Central Orchestrator API listening on http://localhost:${port}`
    )
);
