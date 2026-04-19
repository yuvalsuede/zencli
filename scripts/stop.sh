#!/usr/bin/env bash
#
# Graceful shutdown for a detached zencli (started via `npm run start:bg`).
#
# Reads the pidfile written by start-bg.sh, sends SIGTERM so Electron
# can run its normal shutdown path (which lets node-pty clean up
# children). Falls back to SIGKILL if the process is still alive after
# a short grace period.

set -euo pipefail

PID="${ZENCLI_PID:-/tmp/zencli.pid}"

if [ ! -f "$PID" ]; then
  echo "[zencli] not running (no pidfile at $PID)"
  exit 0
fi

pid="$(cat "$PID" 2>/dev/null || true)"
rm -f "$PID"

if [ -z "$pid" ]; then
  echo "[zencli] pidfile was empty"
  exit 0
fi

if ! kill -0 "$pid" 2>/dev/null; then
  echo "[zencli] not running (stale pidfile, pid $pid gone)"
  exit 0
fi

echo "[zencli] stopping pid $pid (SIGTERM)..."
kill -TERM "$pid" 2>/dev/null || true

# Grace period — Electron needs a moment to tear down WebContentsViews
# and kill the pty children.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "[zencli] stopped cleanly"
    exit 0
  fi
  sleep 0.3
done

echo "[zencli] still alive after 3s, sending SIGKILL"
kill -KILL "$pid" 2>/dev/null || true
echo "[zencli] force-killed"
