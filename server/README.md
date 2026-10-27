# Game Builder Agent server

This Node.js service serves the chat app and its API from one Render Web Service. Follow the [setup guide](../SETUP.md) for local and Render deployment instructions.

## Required configuration

Set `APP_ACCESS_PASSWORD` in production to protect the app and its API with HTTP Basic authentication (username `owner`). Health checks stay public. AI providers are tried in order when configured: `XAI_API_KEY`, `GROQ_API_KEY`, then `OPENROUTER_API_KEY`. xAI API usage may be billable; leave that key unset to use Groq first. Provider keys must never be exposed to the browser. Optional server-side integrations use `ROBLOX_OPEN_CLOUD_API_KEY`, `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and `GITHUB_BRANCH`.

## API

- `GET /health` — plain-text `OK` health response.
- `POST /api/game-chat` — takes recent `{ role, text }` messages. The server selects a manual based on game names in user messages and asks “Which game is this for?” if none is named. Responses contain a build sheet, code and placement, and asset list.
- `POST /api/game-artifacts` — creates a GitHub commit under `<game>/<project>/`.
- `POST /api/roblox/approvals/:id` — executes or rejects an announcement only after an explicit approval. Pending approvals expire after ten minutes and are cleared on restart.

Game manuals are loaded from `game-manuals/` at startup. Manual files describe platform language, placement, workflow, and capability limits.

The service does not persist chat, generated files, or Roblox game data locally. Legacy operational tables use an in-memory SQLite database and are discarded on restart.

Run unit tests with `npm test` from this directory.
