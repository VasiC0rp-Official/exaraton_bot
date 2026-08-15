# exaroton Telegram Bot

Telegram bot for managing one exaroton Minecraft server.

## Commands

- `/status` — server status and players
- `/server_start` — start the server
- `/server_stop` — stop the server
- `/players` — show online players
- `/logs` — show the latest server log lines
- `/command <minecraft command>` — send a command to the server console
- `/help` — show the command list

All commands are restricted to the Telegram IDs in `ALLOWED_TELEGRAM_IDS`.

## Local setup

Requires Node.js 22 or later.

```bash
npm install
cp .env.example .env
npm start
```

Set `PUBLIC_URL` to the public HTTPS URL of the running service. On Render it is usually the service URL ending in `.onrender.com`.

## Render setup

Create a **Web Service** connected to this repository:

- Build Command: `npm install`
- Start Command: `npm start`
- Runtime: Node

Add the variables from `.env.example` in Render's Environment settings, except `PORT` (Render sets it automatically). Do not commit `.env` or either bot/API token.

The application registers the Telegram webhook automatically at:

```text
PUBLIC_URL + WEBHOOK_PATH
```

The `/health` endpoint can be used as a health check.
