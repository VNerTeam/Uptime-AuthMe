#!/usr/bin/env bash
# Chạy trên Linux/macOS: ./start.sh
cd "$(dirname "$0")"
[ -d node_modules ] || { echo "Đang cài thư viện lần đầu..."; npm install --omit=dev; }
[ -f .env ] && set -a && . ./.env && set +a
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=384}"
exec node server.js
