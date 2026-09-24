# Central Orchestrator Setup

## What is here?

This is a Node.js application with a single-page dashboard and a persistent backend. The dashboard is one HTML page because it is a command-center SPA: navigation changes the active view without opening separate HTML files.

## Requirements

- Windows 10 or newer
- Node.js LTS 24 or newer
- npm (included with Node.js)

No Python `requirements.txt` is needed. This project uses `server/package.json` for dependencies.

## Start the backend

Open PowerShell:

```powershell
cd D:\apps\game-agent-ai\server
npm.cmd install
Copy-Item .env.example .env
npm.cmd start
```

Keep that terminal open.

## Open the application

Use the browser URL:

```text
http://localhost:8787/app/
```

Backend health check:

```text
http://localhost:8787/api/health
```

The database is created automatically at `server/data/central-orchestrator.db`.

## Environment file

The template is [server/.env.example](server/.env.example). Copy it to `server/.env`.

```env
PORT=8787
DATABASE_FILE=./data/central-orchestrator.db
WEB_ORIGIN=http://localhost:8787
```

Do not put API keys in the HTML, CSS, or frontend JavaScript. Add provider credentials to `server/.env` only when OAuth integrations are implemented and authorized.

## What can be tested now?

- Dashboard navigation
- Command bar suggestions
- Start and pause workflow actions
- Workflow creation
- Persistent SQLite workflow records
- Checkpoint retrieval
- Activity logging
- Light/dark theme
- Backend health endpoint

Email, calendar, Zoom, authentication, and AI provider connections remain disabled until real credentials and OAuth applications are configured.
