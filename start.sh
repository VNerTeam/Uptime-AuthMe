#!/usr/bin/env bash
# Chạy trên Linux/macOS: ./start.sh
cd "$(dirname "$0")"
[ -d node_modules ] || { echo "Đang cài thư viện lần đầu..."; npm install --omit=dev; }
[ -f .env ] && set -a && . ./.env && set +a
exec node server.js
