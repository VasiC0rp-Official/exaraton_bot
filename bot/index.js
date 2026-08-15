import "dotenv/config";
import http from "node:http";
import { Client } from "exaroton";

const {
  TELEGRAM_BOT_TOKEN,
  EXAROTON_API_TOKEN,
  EXAROTON_SERVER_ID,
  PUBLIC_URL,
  WEBHOOK_PATH = "/telegram/webhook",
  TELEGRAM_WEBHOOK_SECRET,
  PORT = "10000",
  ALLOWED_TELEGRAM_IDS = ""
} = process.env;

const requiredVariables = [
  "TELEGRAM_BOT_TOKEN",
  "EXAROTON_API_TOKEN",
  "EXAROTON_SERVER_ID"
];

for (const variable of requiredVariables) {
  if (!process.env[variable]) {
    throw new Error(`Missing required environment variable: ${variable}`);
  }
}

const allowedTelegramIds = new Set(
  ALLOWED_TELEGRAM_IDS
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

if (allowedTelegramIds.size === 0) {
  throw new Error("ALLOWED_TELEGRAM_IDS must contain at least one Telegram user ID");
}

const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const exarotonClient = new Client(EXAROTON_API_TOKEN);
const minecraftServer = exarotonClient.server(EXAROTON_SERVER_ID);

const statusNames = {
  0: "выключен",
  1: "онлайн",
  2: "запускается",
  3: "останавливается",
  4: "перезапускается",
  5: "сохраняется",
  6: "загружается",
  7: "аварийно остановлен",
  8: "ожидает запуска",
  9: "переносится",
  10: "подготавливается"
};

const helpText = [
  "Доступные команды:",
  "/status — статус сервера и игроки",
  "/server_start — запустить сервер",
  "/server_stop — остановить сервер",
  "/players — показать игроков онлайн",
  "/logs — последние строки лога",
  "/command <команда> — выполнить команду Minecraft",
  "/help — показать эту справку"
].join("\n");

function normalizePath(path) {
  if (!path.startsWith("/")) return `/${path}`;
  return path;
}

function publicWebhookUrl() {
  if (!PUBLIC_URL) return null;
  return `${PUBLIC_URL.replace(/\/$/, "")}${normalizePath(WEBHOOK_PATH)}`;
}

async function telegram(method, body) {
  const response = await fetch(`${telegramApiUrl}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description ?? response.statusText}`);
  }

  return result.result;
}

async function sendMessage(chatId, text) {
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += 3900) {
    chunks.push(text.slice(offset, offset + 3900));
  }

  for (const chunk of chunks) {
    await telegram("sendMessage", { chat_id: chatId, text: chunk });
  }
}

function isAllowed(update) {
  const userId = update.message?.from?.id;
  return userId !== undefined && allowedTelegramIds.has(String(userId));
}

function displayStatus(status) {
  return statusNames[status] ?? `неизвестный статус (${status})`;
}

function getPlayers(server) {
  const players = server.players ?? {};
  const list = Array.isArray(players.list) ? players.list : [];
  return { count: players.count ?? list.length, max: players.max ?? "?", list };
}

async function refreshServer() {
  await minecraftServer.get();
  return minecraftServer;
}

async function serverStatusText() {
  const server = await refreshServer();
  const players = getPlayers(server);
  const playerNames = players.list
    .map((player) => typeof player === "string" ? player : player.name)
    .filter(Boolean);

  return [
    `Сервер: ${server.name ?? EXAROTON_SERVER_ID}`,
    `Статус: ${displayStatus(server.status)}`,
    `Игроки: ${players.count}/${players.max}`,
    playerNames.length > 0 ? `Сейчас онлайн: ${playerNames.join(", ")}` : "Сейчас онлайн: никого"
  ].join("\n");
}

async function playersText() {
  const server = await refreshServer();
  const players = getPlayers(server);
  const playerNames = players.list
    .map((player) => typeof player === "string" ? player : player.name)
    .filter(Boolean);

  return playerNames.length > 0
    ? `Игроки онлайн (${players.count}/${players.max}):\n${playerNames.join("\n")}`
    : `Сейчас никто не играет (${players.count}/${players.max})`;
}

async function logsText() {
  const logs = await minecraftServer.getLogs();
  const content = typeof logs === "string" ? logs : logs?.content ?? JSON.stringify(logs);
  const lines = content.split("\n").filter(Boolean).slice(-35);
  return lines.length > 0 ? `Последние строки лога:\n${lines.join("\n")}` : "Лог пустой.";
}

async function handleCommand(update) {
  const message = update.message;
  if (!message?.text) return;

  if (!isAllowed(update)) {
    await sendMessage(message.chat.id, "А у тебя нет доступа к этому боту. Сосамба не плакамба!");
    return;
  }

  const [command, ...args] = message.text.trim().split(/\s+/);
  const normalizedCommand = command.split("@")[0].toLowerCase();

  try {
    switch (normalizedCommand) {
      case "/start":
      case "/help":
        await sendMessage(message.chat.id, helpText);
        break;
      case "/status":
        await sendMessage(message.chat.id, await serverStatusText());
        break;
      case "/players":
        await sendMessage(message.chat.id, await playersText());
        break;
      case "/server_start":
        await minecraftServer.start();
        await sendMessage(message.chat.id, "Команда запуска отправлена.");
        break;
      case "/server_stop":
        await minecraftServer.stop();
        await sendMessage(message.chat.id, "Команда остановки отправлена.");
        break;
      case "/logs":
        await sendMessage(message.chat.id, await logsText());
        break;
      case "/command": {
        const minecraftCommand = args.join(" ").trim();
        if (!minecraftCommand) {
          await sendMessage(message.chat.id, "Использование: /command say Привет");
          break;
        }

        await minecraftServer.executeCommand(minecraftCommand);
        await sendMessage(message.chat.id, "Команда отправлена в консоль.");
        break;
      }
      default:
        await sendMessage(message.chat.id, "Неизвестная команда. Используйте /help.");
    }
  } catch (error) {
    console.error("Command failed:", error);
    await sendMessage(message.chat.id, `Ошибка: ${error.message}`);
  }
}

async function configureTelegram() {
  await telegram("setMyCommands", {
    commands: [
      { command: "status", description: "Статус сервера" },
      { command: "server_start", description: "Запустить сервер" },
      { command: "server_stop", description: "Остановить сервер" },
      { command: "players", description: "Игроки онлайн" },
      { command: "logs", description: "Последние логи" },
      { command: "command", description: "Команда Minecraft" },
      { command: "help", description: "Список команд" }
    ]
  });

  const webhookUrl = publicWebhookUrl();
  if (!webhookUrl) {
    console.warn("PUBLIC_URL is not set; Telegram webhook was not configured.");
    return;
  }

  const webhookOptions = {
    url: webhookUrl,
    allowed_updates: ["message"]
  };

  if (TELEGRAM_WEBHOOK_SECRET) {
    webhookOptions.secret_token = TELEGRAM_WEBHOOK_SECRET;
  }

  await telegram("setWebhook", webhookOptions);
  console.log(`Telegram webhook configured: ${webhookUrl}`);
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
      return;
    }

    if (request.method === "POST" && request.url === normalizePath(WEBHOOK_PATH)) {
      if (
        TELEGRAM_WEBHOOK_SECRET &&
        request.headers["x-telegram-bot-api-secret-token"] !== TELEGRAM_WEBHOOK_SECRET
      ) {
        response.writeHead(403);
        response.end("forbidden");
        return;
      }

      const body = await requestBody(request);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");

      if (body) {
        void handleCommand(JSON.parse(body)).catch((error) => {
          console.error("Update failed:", error);
        });
      }
      return;
    }

    response.writeHead(404);
    response.end("not found");
  } catch (error) {
    console.error("HTTP request failed:", error);
    response.writeHead(500);
    response.end("internal server error");
  }
});

server.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`Bot server is listening on port ${PORT}`);
  try {
    await configureTelegram();
  } catch (error) {
    console.error("Telegram configuration failed:", error);
  }
});
