#!/usr/bin/env bash
#
# Start zencli fully detached from the launching shell.
#
# `npm start` makes npm the parent of electron, and the terminal the
# grandparent of everything inside the ptys (zsh, claude, etc.). Ctrl-C
# or closing the terminal then tears the whole tree down and your Claude
# sessions die with it.
#
# This launcher skips npm, invokes the electron binary directly via
# `nohup` (ignores SIGHUP), redirects stdio to a log, backgrounds with &,
# and `disown`s it from the shell's job table. The launching terminal
# can close freely — zencli keeps running until you explicitly stop it
# with `npm run stop` (or kill -TERM <pid>).
#
# Idempotent: if a pidfile exists and points to a live process, bail.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${ZENCLI_LOG:-/tmp/zencli.log}"
PID="${ZENCLI_PID:-/tmp/zencli.pid}"
ELECTRON="$DIR/node_modules/.bin/electron"

if [ ! -x "$ELECTRON" ]; then
  echo "[zencli] electron binary not found at $ELECTRON" >&2
  echo "[zencli] run 'npm install' first" >&2
  exit 1
fi

if [ -f "$PID" ]; then
  existing="$(cat "$PID" 2>/dev/null || true)"
  if [ -n "$existing" ] && kill -0 "$existing" 2>/dev/null; then
    echo "[zencli] already running (pid $existing). stop with: npm run stop"
    exit 0
  fi
  # Stale pidfile — clean up.
  rm -f "$PID"
fi

cd "$DIR"
# nohup:     ignore SIGHUP so closing the terminal doesn't kill us
# </dev/null: detach stdin so ^C / ^D in the shell doesn't reach us
# >"$LOG" 2>&1: capture stdout/stderr for debugging
# &:         background
# disown:    remove from shell job table so shell exit doesn't signal us
nohup "$ELECTRON" . </dev/null >"$LOG" 2>&1 &
pid=$!
echo "$pid" > "$PID"
disown "$pid" 2>/dev/null || true

echo "[zencli] started (pid $pid)"
echo "[zencli] log:  $LOG"
echo "[zencli] stop: npm run stop"
