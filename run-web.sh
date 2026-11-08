#!/bin/sh
# Запуск веб-версії (JavaScript) на локальному сервері.
# Папка: web/, порт: 8090

WEB_DIR="/Users/wikiwoo/Desktop/нові знання/web"
PORT=8090
LOG="/Users/wikiwoo/Desktop/нові знання/web-server.log"

# Перевіряємо, чи вже запущено
if lsof -t -i:"$PORT" >/dev/null 2>&1; then
    echo "⚠️  Сервер уже запущено на порту $PORT (PID $(lsof -t -i:"$PORT" | head -1))."
    echo "    Відкрий http://localhost:$PORT"
    exit 0
fi

if [ ! -d "$WEB_DIR" ]; then
    echo "❌ Папка не знайдена: $WEB_DIR"
    exit 1
fi

cd "$WEB_DIR" || exit 1

# Запускаємо сервер у фоновому режимі
nohup python3 -m http.server "$PORT" > "$LOG" 2>&1 &
PID=$!

sleep 1
if lsof -t -i:"$PORT" >/dev/null 2>&1; then
    echo "✅ Веб-сервер запущено (PID $PID)."
    echo "    Відкрий http://localhost:$PORT"
else
    echo "❌ Не вдалося запустити сервер. Лог: $LOG"
    exit 1
fi
