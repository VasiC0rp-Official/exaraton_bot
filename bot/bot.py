import os
import time
import telebot
import requests

# Загружаем токены из настроек Render (для безопасности)
TG_TOKEN = os.getenv("TG_TOKEN")
EXAROTON_TOKEN = os.getenv("EXAROTON_TOKEN")

bot = telebot.TeleBot(TG_TOKEN)
HEADERS = {"Authorization": f"Bearer {EXAROTON_TOKEN}"}

# Получение списка серверов
def get_servers():
    try:
        response = requests.get("https://exaroton.com", headers=HEADERS)
        if response.status_code == 200:
            return response.json().get("data", [])
    except Exception as e:
        print(f"Ошибка API: {e}")
    return []

# Отправка команды на сервер
def send_command(server_id, command):
    url = f"https://exaroton.com/{server_id}/command"
    data = {"command": command}
    try:
        res = requests.post(url, headers=HEADERS, json=data)
        return res.status_code == 200
    except Exception as e:
        print(f"Ошибка отправки команды: {e}")
        return False

@bot.message_handler(commands=['start', 'help'])
def send_welcome(message):
    help_text = (
        "👋 Привет! Я твой бот-админ для Exaroton.\n\n"
        "📜 **Команды:**\n"
        "/status — Узнать статус и ID серверов\n"
        "/cmd [ID_сервера] [команда] — Отправить команду в консоль\n\n"
        "*Пример:* `/cmd abc123xyz ban ToxicPlayer`"
    )
    bot.reply_to(message, help_text, parse_mode="Markdown")

@bot.message_handler(commands=['status'])
def server_status(message):
    servers = get_servers()
    if not servers:
        bot.reply_to(message, "❌ Не удалось получить список серверов. Проверь токен Exaroton.")
        return
    
    text = "🎮 **Твои серверы Exaroton:**\n\n"
    for s in servers:
        status_emoji = "🟢" if s['status'] == 2 else "🔴" # 2 — онлайн на Exaroton
        status_word = "Онлайн" if s['status'] == 2 else "Выключен"
        text += f"{status_emoji} **{s['name']}**\n"
        text += f"└ ID: `{s['id']}`\n"
        text += f"└ Статус: {status_word}\n"
        text += f"└ Игроков: {s['players']['count']}/{s['players']['max']}\n\n"
    bot.reply_to(message, text, parse_mode="Markdown")

@bot.message_handler(commands=['cmd'])
def run_command(message):
    args = message.text.split(maxsplit=2)
    if len(args) < 3:
        bot.reply_to(message, "❌ Неверный формат! Используй:\n`/cmd [ID_сервера] [команда]`", parse_mode="Markdown")
        return
    
    server_id = args[1]
    mc_command = args[2]
    
    bot.reply_to(message, f"⏳ Отправляю команду `{mc_command}`...")
    
    if send_command(server_id, mc_command):
        bot.reply_to(message, f"✅ Команда `{mc_command}` успешно выполнена на сервере `{server_id}`!")
    else:
        bot.reply_to(message, "❌ Ошибка при отправке команды. Проверь ID сервера и включен ли он.")

# Бесконечный запуск бота
if __name__ == "__main__":
    print("Бот успешно запущен!")
    bot.infinity_polling()
