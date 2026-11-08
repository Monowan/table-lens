#!/bin/sh
# Зупинка веб-сервера (порт 8090).

PORT=8090

PIDS=$(lsof -t -i:"$PORT" 2>/dev/null)

if [ -z "$PIDS" ]; then
    echo "ℹ️  Сервер на порту $PORT не запущено."
    exit 0
fi

for PID in $PIDS; do
    echo "Зупиняю процес PID $PID..."
    kill -9 "$PID" 2>/dev/null
done

sleep 1
if lsof -t -i:"$PORT" >/dev/null 2>&1; then
    echo "❌ Щось ще тримає порт $PORT."
    exit 1
else
    echo "✅ Веб-сервер зупинено (порт $PORT вільний)."
fi
