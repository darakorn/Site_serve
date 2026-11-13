#!/usr/bin/env bash
# Check and run the Site Survey app behind Tailscale.
#
#   ./site-serve.sh            same as "start"
#   ./site-serve.sh status     only check: Tailscale, tailscale serve, server.py, HTTPS link
#   ./site-serve.sh start      check, clear a stuck server.py, start it if it is not running
#   ./site-serve.sh stop       stop server.py
#   ./site-serve.sh restart    stop, then start
#
# server.py listens on 127.0.0.1:$PORT; `tailscale serve` publishes it as
# https://<this machine>.<tailnet>.ts.net (tailnet only). Log: tailscale_run/server.log

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$HERE")"
PORT="${PORT:-8080}"
LOG="$HERE/server.log"
PIDFILE="$HERE/server.pid"

# Double-clicked in the file manager: there is no terminal, so the output would go nowhere.
# Re-open this script in a terminal window that stays open until Enter is pressed.
if [ ! -t 0 ] && [ ! -t 1 ] && [ -z "${SITE_SERVE_NO_TERM:-}" ] && [ -z "${SITE_SERVE_IN_TERM:-}" ] \
   && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
  self="$HERE/$(basename "${BASH_SOURCE[0]}")"
  export SITE_SERVE_IN_TERM=1
  for term in ptyxis gnome-terminal kgx konsole x-terminal-emulator xterm; do
    command -v "$term" >/dev/null || continue
    case $term in
      ptyxis)         exec ptyxis --new-window -x "$(printf '%q ' bash "$self" "$@")" ;;
      gnome-terminal) exec gnome-terminal --wait -- bash "$self" "$@" ;;
      kgx)            exec kgx -- bash "$self" "$@" ;;
      *)              exec "$term" -e bash "$self" "$@" ;;
    esac
  done
  unset SITE_SERVE_IN_TERM   # no terminal found: run anyway and report with a notification
fi

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

ping_local() { curl -s -m 3 "http://127.0.0.1:$PORT/api/ping" 2>/dev/null | grep -q '"ok": true'; }

# PID of whatever listens on 127.0.0.1:$PORT (empty if nothing).
port_pid() { ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }

# PIDs of server.py processes that belong to this app folder.
app_pids() {
  local p
  for p in $(pgrep -f 'python[0-9.]* .*server\.py' 2>/dev/null); do
    [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$APP_DIR" ] && echo "$p"
  done
}

is_ours() { [ -n "$1" ] && [ "$(readlink "/proc/$1/cwd" 2>/dev/null)" = "$APP_DIR" ] && tr '\0' ' ' <"/proc/$1/cmdline" | grep -q 'server\.py'; }

ts_url() {
  tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print("https://"+json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null
}

# ---------- checks ----------

check_tailscale() {
  head_ "Tailscale"
  if ! command -v tailscale >/dev/null; then bad "tailscale is not installed"; return 1; fi
  local state
  state="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["BackendState"])' 2>/dev/null)"
  if [ "$state" = "Running" ]; then
    ok "tailscaled is running and logged in ($(ts_url))"
  else
    bad "Tailscale is not up (state: ${state:-tailscaled not reachable})"
    echo "      start it with:  sudo systemctl start tailscaled && sudo tailscale up"
    return 1
  fi
  local phones
  phones="$(tailscale status 2>/dev/null | awk '$4=="android" || $4=="iOS" {print "      " $2 ": " ($5=="-" ? "online" : substr($0, index($0,$5)))}')"
  [ -n "$phones" ] && { echo "    phones / tablets:"; echo "$phones"; }
  return 0
}

check_serve() {
  head_ "tailscale serve"
  local cfg
  cfg="$(tailscale serve status --json 2>/dev/null)"
  if echo "$cfg" | grep -q "\"Proxy\": \"http://127.0.0.1:$PORT\""; then
    ok "HTTPS / → http://127.0.0.1:$PORT (tailnet only)"
    if echo "$cfg" | grep -q '"AllowFunnel"'; then warn "Funnel is on: the app is open to the whole internet, and it has no login"; fi
    return 0
  fi
  bad "tailscale serve does not forward to 127.0.0.1:$PORT"
  return 1
}

fix_serve() {
  echo "    setting it:  tailscale serve --bg http://127.0.0.1:$PORT"
  if tailscale serve --bg "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    ok "tailscale serve set"
  else
    bad "could not set it (needs root or: sudo tailscale set --operator=$USER)"
    echo "      run:  sudo tailscale serve --bg http://127.0.0.1:$PORT"
    return 1
  fi
}

# 0 = running fine, 1 = not running, 2 = stuck, 3 = port taken by something else
check_server() {
  head_ "server.py (port $PORT)"
  local pid others
  pid="$(port_pid)"
  others="$(app_pids | grep -vx "${pid:-x}" | tr '\n' ' ')"
  if [ -z "$pid" ]; then
    if [ -n "$others" ]; then
      bad "server.py is running (PID $others) but not listening on $PORT → stuck"
      return 2
    fi
    bad "not running"
    return 1
  fi
  if ! is_ours "$pid"; then
    bad "port $PORT is used by another program: PID $pid ($(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null))"
    return 3
  fi
  if ping_local; then
    ok "running, PID $pid, answers api/ping"
    [ -n "$others" ] && warn "extra server.py left over (PID $others) — 'start' will stop it"
    return 0
  fi
  bad "PID $pid holds port $PORT but does not answer → stuck"
  return 2
}

check_https() {
  head_ "Link"
  local url; url="$(ts_url)"
  [ -z "$url" ] && { bad "no Tailscale name"; return 1; }
  if curl -s -m 8 "$url/api/ping" 2>/dev/null | grep -q '"ok": true'; then
    ok "$url  works (app + upload)"
  else
    bad "$url  does not answer"
    return 1
  fi
}

# ---------- actions ----------

kill_pids() {
  local p
  for p in "$@"; do kill "$p" 2>/dev/null; done
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    local alive=0
    for p in "$@"; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ $alive = 0 ] && return 0
    sleep 0.3
  done
  for p in "$@"; do kill -9 "$p" 2>/dev/null; done
}

stop_server() {
  local pids; pids="$(app_pids | tr '\n' ' ')"
  if [ -z "${pids// }" ]; then echo "  server.py is not running"; rm -f "$PIDFILE"; return 0; fi
  echo "  stopping server.py (PID $pids)"
  # shellcheck disable=SC2086
  kill_pids $pids
  rm -f "$PIDFILE"
  ok "stopped"
}

start_server() {
  echo "  starting server.py  (log: $LOG)"
  cd "$APP_DIR" || return 1
  # Started directly (no wrapper shell), so the PID is python's and no stdout pipe stays open.
  nohup python3 server.py --port "$PORT" </dev/null >>"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  disown 2>/dev/null
  cd - >/dev/null || true
  for _ in $(seq 1 20); do ping_local && { ok "started, PID $(cat "$PIDFILE")"; return 0; }; sleep 0.25; done
  bad "server.py did not come up — last lines of the log:"
  tail -n 15 "$LOG" | sed 's/^/      /'
  return 1
}

cmd_status() {
  local rc=0
  check_tailscale || rc=1
  check_serve || rc=1
  check_server || rc=1
  check_https || rc=1
  echo
  [ $rc = 0 ] && echo "All good." || echo "Something needs attention (run: $0 start)."
  return $rc
}

cmd_start() {
  check_tailscale || { echo; echo "Fix Tailscale first."; return 1; }
  check_serve || fix_serve || return 1
  check_server; local s=$?
  case $s in
    0) local extra; extra="$(app_pids | grep -vx "$(port_pid)" | tr '\n' ' ')"
       # shellcheck disable=SC2086
       [ -n "${extra// }" ] && { echo "  stopping leftover server.py (PID $extra)"; kill_pids $extra; } ;;
    1) start_server || return 1 ;;
    2) echo "  clearing the stuck server"; stop_server; start_server || return 1 ;;
    3) echo "  free port $PORT first, or run with another port: PORT=8081 $0 start"
       echo "  (tailscale serve would then need: tailscale serve --bg http://127.0.0.1:8081)"
       return 1 ;;
  esac
  check_https
}

# One-line answer per part, read fresh after the action, shown last and as a notification.
summary() {
  local ts sv srv lnk url state
  url="$(ts_url)"
  state="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["BackendState"])' 2>/dev/null)"
  [ "$state" = "Running" ] && ts="ON" || ts="OFF (${state:-not reachable})"
  tailscale serve status --json 2>/dev/null | grep -q "\"Proxy\": \"http://127.0.0.1:$PORT\"" && sv="ON → :$PORT" || sv="OFF"
  if ping_local; then srv="RUNNING (PID $(port_pid))"; elif [ -n "$(port_pid)$(app_pids)" ]; then srv="STUCK"; else srv="STOPPED"; fi
  [ -n "$url" ] && curl -s -m 8 "$url/api/ping" 2>/dev/null | grep -q '"ok": true' && lnk="OK" || lnk="NOT WORKING"
  head_ "════════ Summary ════════"
  printf '  %-16s %s\n' "Tailscale:" "$ts" "tailscale serve:" "$sv" "server.py:" "$srv" "Link:" "$lnk  ${url:-}"
  SUMMARY="Tailscale: $ts
server.py: $srv
Link: $lnk ${url:-}"
  [ "$ts" = "ON" ] && [ "$lnk" = "OK" ]
}

action="${1:-start}"
case "$action" in
  status)  cmd_status ;;
  start)   cmd_start ;;
  stop)    head_ "server.py"; stop_server ;;
  restart) head_ "server.py"; stop_server; cmd_start ;;
  *) echo "usage: $0 [status|start|stop|restart]"; exit 2 ;;
esac
summary; rc=$?

# Started from the GUI: also pop up a desktop notification, and keep the window open.
if [ -n "${SITE_SERVE_IN_TERM:-}" ] || { [ ! -t 1 ] && [ -z "${SITE_SERVE_NO_TERM:-}" ]; }; then
  command -v notify-send >/dev/null && notify-send -i "$([ $rc = 0 ] && echo network-transmit-receive || echo dialog-warning)" \
    "Site Survey ($action)" "$SUMMARY" 2>/dev/null
fi
if [ -n "${SITE_SERVE_IN_TERM:-}" ]; then
  echo; read -rp "Press Enter to close… " _
fi
exit $rc
