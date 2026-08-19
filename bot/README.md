# exaroton Telegram Bot

Telegram bot for managing one exaroton Minecraft server.

## Commands

- `/status` — server status and players
- `/server_start` — start the server
- `/server_restart` — restart the server
- `/server_stop` — stop the server
- `/players` — show online players
- `/credits` — check the remaining exaroton credits
- `/logs` — show the latest server log lines
- `/chat` — show the latest player and server messages
- `/chat_on` — enable live player and server message delivery
- `/chat_off` — disable live player and server message delivery
- `/<minecraft command> [arguments]` — send a Minecraft command, for example `/say hello`
- `/command <minecraft command>` — legacy command format
- `/help` — show the command list

All commands are restricted to the Telegram IDs in `ALLOWED_TELEGRAM_IDS`.

`/chat_on` subscribes to exaroton's console WebSocket and batches player messages plus messages in the `[Server] ...` format before sending them to Telegram. `/chat` reads those messages from the server log; other system messages remain available through `/logs`. The live subscription is kept in memory and must be enabled again after a Render restart.

`ALLOWED_TELEGRAM_IDS` is a comma-separated list of Telegram user IDs. For example, `1534687734,987654321` allows both users; spaces around commas are ignored. The value must contain at least one ID.

## Server status notifications

Whenever exaroton reports that the server is online, the bot sends the same message to every ID in `ALLOWED_TELEGRAM_IDS`, regardless of how the server was started:

- `Сервер запущен.`

Stopping the server does not trigger a notification. Restarting it triggers `Сервер запущен.` when it returns online.

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
