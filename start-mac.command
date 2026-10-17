#!/bin/bash
# Double-click to run the demo on macOS. Needs Node.js 18+ (https://nodejs.org).
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org, then double-click this file again."
  read -n 1 -s -r -p "Press any key to close"; exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund
(sleep 2 && open -a "Google Chrome" "http://localhost:${PORT:-8787}" 2>/dev/null || open "http://localhost:${PORT:-8787}") &
npm start
