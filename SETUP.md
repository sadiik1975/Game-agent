# Central Orchestrator Setup

## What is here?

This is a Node.js application with a single-page dashboard and a persistent backend. The dashboard is one HTML page because it is a command-center SPA: navigation changes the active view without opening separate HTML files.

## Requirements

- Windows 10 or newer
- Node.js LTS 24 or newer
- npm (included with Node.js)

No Python `requirements.txt` is needed. This project uses `server/package.json` for dependencies.

## Run from the repository root

Install the backend dependencies once, then start the app from the project root:

```sh
npm install --prefix server
python app.py
```

Open `http://localhost:8787/app/` while the process is running. Press `Ctrl+C` in the terminal to stop it.

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
WEB_APP_URL=http://localhost:8787/app/
OPENROUTER_API_KEY=your-openrouter-api-key
GROQ_API_KEY=your-groq-api-key
```

Add your OpenRouter API key from [OpenRouter](https://openrouter.ai/keys) and your Groq API key from [Groq Console](https://console.groq.com/keys) to `server/.env`, then restart `python app.py`. OpenRouter is tried first; Groq is used if OpenRouter is rate-limited, times out, or returns an empty reply. Each provider has its own free usage limits. The `.env` file is ignored by Git; do not put API keys in the HTML, CSS, or frontend JavaScript. The Control Center key field remains available for temporary OpenRouter use.

Do not add other provider credentials until the corresponding OAuth integrations are configured and authorized.

For Outlook and Microsoft 365, use Microsoft Entra ID app registration and Microsoft Graph OAuth. The usual delegated permissions are `User.Read`, `Mail.Read`, `Mail.Send`, `Calendars.Read`, and `Calendars.ReadWrite`.

For Zoom, create an OAuth app in the Zoom Marketplace and register `http://localhost:8787/auth/zoom/callback` as the redirect URL. Add its client ID and secret to `server/.env`.

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
