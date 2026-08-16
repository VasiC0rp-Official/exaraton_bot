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

const ONLINE_STATUS = 1;
const OFFLINE_STATUS = 0;
const WAIT_FOR_ONLINE_STATUSES = new Set([2, 4, 5, 6, 8, 10]);
const STOP_POLL_INTERVAL_MS = 5000;
const STOP_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const START_REQUEST_GRACE_MS = 90 * 1000;

let serverActionQueue = Promise.resolve();
let pendingStop = null;
let stopPollTimer = null;
let stopRequestVersion = 0;
let lastStartRequestAt = 0;

const NOTIFY_IGNORE_WINDOW_MS = 90 * 1000;
const EXTERNAL_ACTION_MESSAGES = {
  start: "Кто-то запустил сервер.",
  restart: "Кто-то перезапустил сервер.",
  stop: "Кто-то остановил сервер."
};
let previousServerStatus = null;
let suppressedExternalAction = null;

const liveChatSubscribers = new Set();
let liveChatBuffer = [];
let liveChatFlushTimer = null;

const helpText = [
  "Доступные команды:",
  "/status — статус сервера и игроки",
  "/server_start — запустить сервер",
  "/server_restart — перезапустить сервер",
  "/server_stop — остановить сервер",
  "/players — показать игроков онлайн",
  "/logs — последние строки лога",
  "/chat — последние сообщения игроков и сервера",
  "/chat_on — включить поток сообщений игроков и сервера",
  "/chat_off — выключить поток сообщений игроков и сервера",
  "/<команда> [аргументы] — выполнить команду Minecraft, например /say hello",
  "/command <команда> — старый формат команды Minecraft",
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
    playerNames.length > 0 ? `Сейчас онлайн: ${playerNames.join(", ")}` : "Сейчас онлайн: нихуя"
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
  return lines.length > 0 ? `Последние строки лога:\n${lines.join("\n")}` : "В логе нихуя нет.";
}

function runServerAction(action) {
  const result = serverActionQueue.then(action, action);
  serverActionQueue = result.catch(() => undefined);
  return result;
}

function markExternalActionSuppressed(action) {
  suppressedExternalAction = {
    action,
    until: Date.now() + NOTIFY_IGNORE_WINDOW_MS
  };
}

function clearExternalActionSuppression() {
  suppressedExternalAction = null;
}

function isExternalActionSuppressed(action) {
  if (!suppressedExternalAction) return false;
  if (Date.now() >= suppressedExternalAction.until) {
    suppressedExternalAction = null;
    return false;
  }
  return suppressedExternalAction.action === action;
}

// Срабатывает на «финальном» статусе, через который стороннее действие проявляется:
// start:  оффлайн/ожидание/загрузка -> 1 (онлайн)
// restart: 4 (перезапускается) -> 1 (онлайн)
// stop:   3 (останавливается) -> 0 (выключен)
function classifyStatusTransition(prev, curr) {
  if (prev === null || prev === curr || curr === undefined) return null;

  if (prev === 4 && curr === ONLINE_STATUS) return "restart";
  if (prev === 3 && curr === OFFLINE_STATUS) return "stop";

  if (
    curr === ONLINE_STATUS &&
    (prev === OFFLINE_STATUS || prev === 7 || prev === 8 || WAIT_FOR_ONLINE_STATUSES.has(prev))
  ) {
    return "start";
  }

  return null;
}

async function broadcastToAllowedUsers(text) {
  await Promise.allSettled(
    [...allowedTelegramIds].map((chatId) =>
      sendMessage(chatId, text).catch((error) => {
        console.error(`External action notification failed for ${chatId}:`, error);
      })
    )
  );
}

async function handleExternalStatusAction(action) {
  if (isExternalActionSuppressed(action)) {
    clearExternalActionSuppression();
    return;
  }
  await broadcastToAllowedUsers(EXTERNAL_ACTION_MESSAGES[action]);
}

function attachStatusWatcher() {
  minecraftServer.on("status", async (server) => {
    try {
      const curr = server?.status;
      const prev = previousServerStatus;
      previousServerStatus = curr;

      if (prev === null || prev === curr || curr === undefined) return;

      const action = classifyStatusTransition(prev, curr);
      if (!action) return;

      await handleExternalStatusAction(action);
    } catch (error) {
      console.error("External status watcher failed:", error);
    }
  });
}

function cancelPendingStop() {
  pendingStop = null;
  stopRequestVersion += 1;
  if (stopPollTimer) {
    clearTimeout(stopPollTimer);
    stopPollTimer = null;
  }
}

function scheduleDeferredStop() {
  if (stopPollTimer || !pendingStop) return;

  const requestVersion = stopRequestVersion;
  const deadline = pendingStop.deadline;

  const poll = async () => {
    stopPollTimer = null;
    if (!pendingStop || requestVersion !== stopRequestVersion) return;

    try {
      const server = await refreshServer();
      if (!pendingStop || requestVersion !== stopRequestVersion) return;

      if (server.status === ONLINE_STATUS) {
        const chatId = pendingStop.chatId;
        pendingStop = null;
        markExternalActionSuppressed("stop");
        await minecraftServer.stop();
        await sendMessage(chatId, "Сервер запустился, поэтому я сразу отправил команду остановки.");
        return;
      }

      if (server.status === OFFLINE_STATUS || server.status === 7) {
        const startRequestAt = pendingStop.startRequestAt;
        const startIsStillPropagating = startRequestAt && Date.now() - startRequestAt < START_REQUEST_GRACE_MS;

        if (startIsStillPropagating) {
          stopPollTimer = setTimeout(() => void poll(), STOP_POLL_INTERVAL_MS);
          return;
        }

        const chatId = pendingStop.chatId;
        pendingStop = null;
        await sendMessage(chatId, "Сервер не вышел в онлайн-состояние и уже недоступен.");
        return;
      }

      if (Date.now() >= deadline) {
        const chatId = pendingStop.chatId;
        pendingStop = null;
        await sendMessage(chatId, "Не удалось дождаться запуска сервера за 10 минут; автоматическая остановка отменена.");
        return;
      }

      stopPollTimer = setTimeout(() => void poll(), STOP_POLL_INTERVAL_MS);
    } catch (error) {
      console.error("Deferred stop failed:", error);
      if (pendingStop && requestVersion === stopRequestVersion) {
        stopPollTimer = setTimeout(() => void poll(), STOP_POLL_INTERVAL_MS);
      }
    }
  };

  stopPollTimer = setTimeout(() => void poll(), STOP_POLL_INTERVAL_MS);
}

async function startServer() {
  return runServerAction(async () => {
    cancelPendingStop();
    const server = await refreshServer();

    if (server.status === OFFLINE_STATUS || server.status === 7) {
      await minecraftServer.start();
      lastStartRequestAt = Date.now();
      markExternalActionSuppressed("start");
      return "Команда СТАРТУЕМ отправлена.";
    }

    return `Сервер уже не выключен: ${displayStatus(server.status)}.`;
  });
}

async function restartServer() {
  return runServerAction(async () => {
    cancelPendingStop();
    const server = await refreshServer();

    if (server.status === ONLINE_STATUS) {
      await minecraftServer.restart();
      markExternalActionSuppressed("restart");
      return "Команда РЕСТАРТУЕМ отправлена.";
    }

    return `Перезапустить сервер сейчас нельзя: ${displayStatus(server.status)}.`;
  });
}

async function stopServer(chatId) {
  return runServerAction(async () => {
    const server = await refreshServer();

    if (server.status === ONLINE_STATUS) {
      await minecraftServer.stop();
      markExternalActionSuppressed("stop");
      return "Команда СТОПЭ отправлена.";
    }

    const startIsStillPropagating =
      server.status === OFFLINE_STATUS &&
      lastStartRequestAt > 0 &&
      Date.now() - lastStartRequestAt < START_REQUEST_GRACE_MS;

    if (WAIT_FOR_ONLINE_STATUSES.has(server.status) || startIsStillPropagating) {
      pendingStop = {
        chatId,
        deadline: Date.now() + STOP_WAIT_TIMEOUT_MS,
        startRequestAt: lastStartRequestAt || null
      };
      scheduleDeferredStop();
      return "Сервер ещё запускается. Я остановлю его автоматически, когда он перейдёт в онлайн-состояние.";
    }

    if (server.status === 3) {
      return "Сервер уже останавливается.";
    }

    return `Остановить сервер сейчас нельзя: ${displayStatus(server.status)}.`;
  });
}

function cleanConsoleLine(line) {
  return String(line ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u0000/g, "")
    .trim();
}

function formatChatLine(line) {
  const cleanLine = cleanConsoleLine(line);
  if (!cleanLine) return null;

  // В логах Minecraft сообщения игроков имеют формат "<имя> текст".
  const playerMatch = cleanLine.match(/<([^<>]+)>\s+(.+)$/);
  if (playerMatch) {
    return `💬 ${playerMatch[1]}: ${playerMatch[2]}`;
  }

  // Серверные сообщения могут иметь префикс вроде "[Not Secure] ".
  const serverMatch = cleanLine.match(/\[Server\]\s*(.+)$/);
  return serverMatch ? `📢 Server: ${serverMatch[1]}` : null;
}

async function chatRecentText() {
  const logs = await minecraftServer.getLogs();
  const content = typeof logs === "string" ? logs : logs?.content ?? JSON.stringify(logs);
  const lines = content
    .split("\n")
    .map(formatChatLine)
    .filter(Boolean)
    .slice(-35);
  return lines.length > 0
    ? `Последние сообщения игроков и сервера:\n${lines.join("\n")}`
    : "Сообщений игроков или сервера в логе нет.";
}

async function flushLiveChat() {
  liveChatFlushTimer = null;
  if (liveChatBuffer.length === 0 || liveChatSubscribers.size === 0) return;

  const text = liveChatBuffer.splice(0).join("\n");
  await Promise.allSettled(
    [...liveChatSubscribers].map((chatId) => sendMessage(chatId, text))
  );
}

function queueLiveConsoleLine(data) {
  if (liveChatSubscribers.size === 0) return;

  const formatted = formatChatLine(data?.line ?? data?.rawLine);
  if (!formatted) return;

  liveChatBuffer.push(formatted);
  if (!liveChatFlushTimer) {
    liveChatFlushTimer = setTimeout(() => {
      void flushLiveChat().catch((error) => console.error("Live chat delivery failed:", error));
    }, 800);
  }
}

async function setLiveChat(chatId, enabled) {
  if (enabled) {
    const server = await refreshServer();
    if (server.status !== ONLINE_STATUS) {
      return `Живой чат можно включить только когда сервер онлайн. Сейчас: ${displayStatus(server.status)}.`;
    }

    const wasEmpty = liveChatSubscribers.size === 0;
    liveChatSubscribers.add(chatId);
    if (wasEmpty) await minecraftServer.subscribe("console");
    return "Живой чат включён. Новые сообщения игроков и сервера будут приходить сюда. Выключить: /chat_off";
  }

  const wasSubscribed = liveChatSubscribers.delete(chatId);
  if (wasSubscribed && liveChatSubscribers.size === 0) {
    await minecraftServer.unsubscribe("console");
  }
  return "Живой чат выключен.";
}

minecraftServer.on("console:line", queueLiveConsoleLine);

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
        await sendMessage(message.chat.id, await startServer());
        break;
      case "/server_restart":
        await sendMessage(message.chat.id, await restartServer());
        break;
      case "/server_stop":
        await sendMessage(message.chat.id, await stopServer(message.chat.id));
        break;
      case "/logs":
        await sendMessage(message.chat.id, await logsText());
        break;
      case "/chat":
        await sendMessage(message.chat.id, await chatRecentText());
        break;
      case "/chat_on":
        await sendMessage(message.chat.id, await setLiveChat(message.chat.id, true));
        break;
      case "/chat_off":
        await sendMessage(message.chat.id, await setLiveChat(message.chat.id, false));
        break;
      case "/command": {
        const minecraftCommand = args.join(" ").trim();
        if (!minecraftCommand) {
          await sendMessage(message.chat.id, "Использование: /command say Иди нахуй");
          break;
        }

        await minecraftServer.executeCommand(minecraftCommand);
        await sendMessage(message.chat.id, "Команда улетела в консоль.");
        break;
      }
      default:
        if (normalizedCommand.startsWith("/")) {
          const minecraftCommand = message.text.trim().slice(1).trim();
          if (!minecraftCommand) {
            await sendMessage(message.chat.id, "Напиши команду Minecraft после слеша, например: /say hello");
            break;
          }

          await minecraftServer.executeCommand(minecraftCommand);
          await sendMessage(message.chat.id, "Команда Minecraft улетела в консоль.");
          break;
        }

        await sendMessage(message.chat.id, "Неизвестная команда. Используй /help.");
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
      { command: "server_restart", description: "Перезапустить сервер" },
      { command: "server_stop", description: "Остановить сервер" },
      { command: "players", description: "Игроки онлайн" },
      { command: "logs", description: "Последние логи" },
      { command: "chat", description: "Последние сообщения игроков" },
      { command: "chat_on", description: "Включить поток чата" },
      { command: "chat_off", description: "Выключить поток чата" },
      { command: "command", description: "Команда Minecraft (старый формат)" },
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
  try {
    const initialServer = await refreshServer();
    previousServerStatus = initialServer.status;
    attachStatusWatcher();
    await minecraftServer.subscribe();
    console.log(`Status watcher attached (initial: ${displayStatus(initialServer.status)})`);
  } catch (error) {
    console.error("Status watcher initialization failed:", error);
  }
});
