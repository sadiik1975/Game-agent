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

## Core endpoints

- `GET /api/health`
- `GET|POST /api/workflows`
- `POST /api/workflows/:id/transition`
- `GET /api/checkpoints`
- `GET /api/activity`
- `GET|POST /api/approvals`
- `GET /api/integrations`
- `POST /api/integrations/:provider/disconnect`
