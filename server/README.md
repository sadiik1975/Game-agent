# Central Orchestrator API

This is the persistent backend for the dashboard prototype.

## Run

```powershell
cd server
npm install
Copy-Item .env.example .env
npm start
```

Health check: `http://localhost:8787/api/health`

The backend uses SQLite at `server/data/central-orchestrator.db`. The database is created automatically and is not committed to source control. OAuth integrations are intentionally not enabled until provider credentials are configured.

## Provider credentials

Copy `.env.example` to `.env` and add credentials there. Set `OPENROUTER_API_KEY` for primary chat. If OpenRouter hits its limit, times out, or returns an empty reply, the server uses Groq when `GROQ_API_KEY` is configured. Set `GROQ_MODEL` and `GROQ_API_URL` to override the defaults. Both providers may receive recent email summaries when the user explicitly asks an email-related question. Gmail uses the Google OAuth scopes `gmail.readonly` and `gmail.send`; add the account to OAuth test users while the app is in Testing. Replies are sent only when the user presses Send reply. For Outlook, create an app registration in Microsoft Entra ID and request Microsoft Graph delegated permissions such as `User.Read`, `Mail.Read`, `Mail.Send`, `Calendars.Read`, and `Calendars.ReadWrite`. Use `common` as the tenant for a multi-account sign-in, or replace it with your tenant ID for a single organization.

## Social publishing

Content drafts and scheduled posts are capped at 10 per UTC day. Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to publish to a Telegram chat or channel; add the bot to the destination with permission to post. Telegram reply polling requires the bot to receive message updates (a configured webhook can prevent `getUpdates` polling).

LinkedIn publishing requires an access token with `w_member_social` and an author URN such as `urn:li:person:...`; set these as `LINKEDIN_ACCESS_TOKEN` and `LINKEDIN_AUTHOR_URN`. Comment retrieval and automatic LinkedIn replies require additional LinkedIn API permissions that may require approval. Telegram auto-replies are off by default and can be enabled in the Content view after connecting Telegram.

The Content view uses `GET /api/content/status`, `GET|POST /api/content/posts`, `POST /api/content/posts/:id/publish`, and `GET /api/content/notifications`. Scheduled publishing runs in the server process; keep it running for scheduled posts to fire.

For Zoom, create an OAuth app in the Zoom Marketplace and configure the redirect URI from `ZOOM_REDIRECT_URI`. Request only the scopes needed for the features you enable, such as meeting read access and user read access.

Adding credentials alone does not connect the services. The server still needs OAuth callback routes and provider-specific API routes before the dashboard can read mail, manage calendars, or access Zoom meetings.

## Core endpoints

- `GET /api/health`
- `GET /api/news` (cached live RSS headlines; pass `?refresh=1` to refresh)
- `GET|POST /api/workflows`
- `POST /api/workflows/:id/transition`
- `GET /api/checkpoints`
- `GET /api/activity`
- `GET|POST /api/approvals`
- `GET /api/integrations`
- `POST /api/integrations/:provider/disconnect`
