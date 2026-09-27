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

const now = () => new Date().toISOString();

const parse = value => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const serializeWorkflow = row => row && ({
  ...row,
  completed_steps: parse(row.completed_steps),
  remaining_steps: parse(row.remaining_steps),
  context_snapshot: parse(row.context_snapshot)
});

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
