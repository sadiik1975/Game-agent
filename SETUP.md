# Game Builder Agent

The app is one chat page. Tell it which game you are making (Fortnite, Roblox, standalone Unreal Engine 5, or Unity) and describe the feature in ordinary language. For builds and fixes it returns a build sheet, editor-ready code with placement instructions, and an asset list. The Unreal Engine and Unity chapters are drafts; each becomes official only after a real build session using it and editor approval. No terminal commands are needed to use the deployed chat.

## Run locally

Requirements: Node.js 24 and npm.

In PowerShell:

```powershell
cd D:\apps\game-agent-ai\server
npm.cmd ci
Copy-Item .env.example .env
```

Add your xAI key to `XAI_API_KEY` in `server\.env`, then start the app. If you prefer Groq, leave `XAI_API_KEY` blank and set `GROQ_API_KEY` instead:

```powershell
npm.cmd start
```

Open `http://localhost:8787/app/`. Keep the server running while using it. The public health check is `http://localhost:8787/health` and returns `OK`.

The provider keys are read only by the backend. Never paste a key into chat or put one in `index.html`, `game-chat.js`, or a committed file.

## Deploy as one Render service

Create a Render **Web Service** connected to this GitHub repository:

- Root Directory: `server`
- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/health`

Set `NODE_ENV=production` and a strong `APP_ACCESS_PASSWORD` in Render before deployment. The app requires HTTP Basic authentication in production (username `owner`); your browser shows its native sign-in prompt, separate from the chat. The health endpoint remains public for Render. Add `XAI_API_KEY`, `GROQ_API_KEY`, or `OPENROUTER_API_KEY` to enable chat. When more than one key is configured, the order is xAI, Groq, then OpenRouter. Redeploy after setting or changing environment variables. The service serves both the chat page and API from the same origin.

Render's free service can sleep when idle and take time to wake. Use an always-on Render instance if you need reliable 24/7 availability; a periodic health ping is not a guarantee of uptime.

## Environment variables

- `XAI_API_KEY` — optional xAI API credential for Grok. xAI API usage may be billable.
- `XAI_MODEL`, `XAI_API_URL` — optional xAI model and API URL overrides; the default model is `grok-4.20-0309-non-reasoning`.
- `GROQ_API_KEY` — optional Groq provider credential. Groq offers free usage subject to its current limits and policies.
- `GROQ_MODEL`, `GROQ_API_URL` — optional Groq model and API URL overrides.
- `OPENROUTER_API_KEY` — optional fallback AI provider credential; if set, it may be used when xAI and Groq are unavailable.
- `OPENROUTER_MODEL`, `OPENROUTER_API_URL` — optional OpenRouter model and API URL overrides.
- `ROBLOX_OPEN_CLOUD_API_KEY` — optional Roblox Open Cloud key for DataStore reads and approved announcements. Keep it server-side and grant only the needed permissions.
- `GITHUB_TOKEN` — optional fine-grained GitHub token with Contents read/write access to the target repository.
- `GITHUB_REPOSITORY` — optional target repository in `owner/repository` format.
- `GITHUB_BRANCH` — optional target branch; defaults to `main`.
- `PORT` — assigned by Render automatically; defaults to `8787` locally.
- `NODE_ENV` — set to `production` on Render so missing access protection fails closed.
- `APP_ACCESS_PASSWORD` — required in production to keep the AI and owner integrations private; HTTP Basic username is `owner`.

Create a local `.env` from [server/.env.example](server/.env.example). On Render, set the same values in the Environment tab; do not commit `.env`. GitHub saving is available from the “Save code to GitHub” button after setting the GitHub variables. Files are committed under `<game>/<project>/`.

Create an xAI API key in the xAI API Console, then add it as the value for `XAI_API_KEY` in local `server\.env` or as a Render environment variable. The key can be created without being a per-request fee, but API calls are usage-billed. Check [xAI's current model pricing](https://docs.x.ai/developers/models) before enabling it; for example, the listed default `grok-4.20-0309-non-reasoning` is $1.25 per million input tokens and $2.50 per million output tokens (standard context pricing). Do not paste the key into chat, frontend files, or this repository. Restart locally or redeploy on Render after adding it. To use Groq instead, leave `XAI_API_KEY` blank and set `GROQ_API_KEY`.

## What the integrations can do

- **Roblox:** DataStore reads use Open Cloud when a server key is configured. Announcements show the exact endpoint and payload in chat and are sent only after pressing “Approve and send”. Approval requests expire after 10 minutes or a server restart. No key means the agent offers manual steps.
- **Fortnite:** The agent provides Verse and UEFN steps for the user to perform. It cannot access or publish islands; publishing is done manually in Creator Portal.
- **GitHub:** Generated build notes and source code are committed to the configured repository when the user requests it.

Game knowledge lives in JSON manual packs under `game-manuals/`. A new game can be added by adding a pack with its aliases, language, file extension, and instructions. Unreal Engine is the standalone C++/Blueprint editor, not UEFN; do not use its manual for Fortnite. Unity is a separate C# engine.

The chat keeps its conversation in the browser. The server does not save chat history or generated files to its local filesystem. Roblox approvals are temporary in-memory state; durable code artifacts go to GitHub.

## API endpoints

- `GET /health` — Render health check; responds with `OK`.
- `POST /api/game-chat` — chat message history; requires a configured model provider.
- `POST /api/game-artifacts` — save build notes and code to the configured GitHub repository.
- `POST /api/roblox/approvals/:id` — approve or reject a pending Roblox announcement.
