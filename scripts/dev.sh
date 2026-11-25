#!/usr/bin/env bash
# Test instance of the `dev` branch, running beside production (see CLAUDE.md "Git workflow").
# Run from the dev worktree:  scripts/dev.sh start | stop | logs
#   - frontend http://127.0.0.1:8288, backend http://127.0.0.1:8289 (loopback only)
#   - reads production accounts.json (read-only keys) but a COPY of the history DB, so testing
#     never touches production data; Discord alerts are disabled
set -euo pipefail
DEV=$(cd "$(dirname "$0")/.." && pwd)
MAIN=$(git -C "$DEV" worktree list --porcelain | awk '/^worktree /{print $2; exit}')
if [ "$DEV" = "$MAIN" ]; then
  echo "Run this from the dev worktree, not the production checkout ($MAIN)" >&2
  exit 1
fi
FRONTEND_PORT=8288
BACKEND_PORT=8289

case "${1:-start}" in
  start)
    mkdir -p "$DEV/data" "$DEV/logs"
    rm -f "$DEV"/data/history.db*
    # Consistent snapshot of the live DB (WAL mode: never copy the file directly)
    node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync(process.argv[1], {readOnly: true}).exec(\"VACUUM INTO '\" + process.argv[2] + \"'\")" \
      "$MAIN/data/history.db" "$DEV/data/history.db" 2>/dev/null
    (cd "$DEV" && npm install --no-audit --no-fund >/dev/null)
    (cd "$DEV/backend" && npm run build >/dev/null)
    (cd "$DEV/frontend" && npm run build >/dev/null)
    BIN="$DEV/mt5bridge/bin/mt5snap"; [ -x "$BIN" ] || BIN="$MAIN/mt5bridge/bin/mt5snap"
    pm2 delete unify-dev-backend unify-dev-frontend >/dev/null 2>&1 || true
    CONFIG_PATH="$MAIN/accounts.json" HISTORY_DB="$DEV/data/history.db" MT5SNAP_BIN="$BIN" \
      DISABLE_ALERTS=1 BACKEND_PORT=$BACKEND_PORT BIND_HOST=127.0.0.1 NODE_ENV=production \
      pm2 start "$DEV/backend/dist/index.js" --name unify-dev-backend --cwd "$DEV/backend" \
        -o "$DEV/logs/dev-backend-out.log" -e "$DEV/logs/dev-backend-error.log" --merge-logs >/dev/null
    FRONTEND_PORT=$FRONTEND_PORT BIND_HOST=127.0.0.1 API_TARGET="http://127.0.0.1:$BACKEND_PORT" \
      pm2 start "$DEV/frontend/serve.cjs" --name unify-dev-frontend \
        -o "$DEV/logs/dev-frontend-out.log" -e "$DEV/logs/dev-frontend-error.log" --merge-logs >/dev/null
    echo "dev instance: http://127.0.0.1:$FRONTEND_PORT (API :$BACKEND_PORT)"
    echo "from your computer: ssh -L $FRONTEND_PORT:127.0.0.1:$FRONTEND_PORT <server>, then open http://localhost:$FRONTEND_PORT"
    ;;
  stop)
    pm2 delete unify-dev-backend unify-dev-frontend
    ;;
  logs)
    pm2 logs unify-dev-backend --lines 50
    ;;
  *)
    echo "usage: scripts/dev.sh start | stop | logs" >&2
    exit 1
    ;;
esac
