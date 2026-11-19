#!/usr/bin/env bash
# Serve the airport watch page (_watch/) tailnet-only from the home server.
#
#   scripts/deploy-watch-homeserver.sh [deploy] [REF]   # export REF (default HEAD), sync, (re)start, publish
#   scripts/deploy-watch-homeserver.sh status           # LaunchAgent, local HTTP probe, tailscale serve status
#   scripts/deploy-watch-homeserver.sh undo             # unpublish :8790 (only if it is ours), remove the agent
#
# What it does (idempotent; no sudo):
#   0. Preflight, before changing anything: `tailscale serve` port 8790 must be unused or already ours
#      (HTTPS proxy to http://127.0.0.1:8790). Anything else, or unreadable serve config, aborts.
#   1. `git archive REF` of ONLY the files the page loads (not the PWA: index.html/sw.js stay off this origin, so the
#      app's service worker can never take over /_watch/), rsynced to ~/contrails-watch/ on the home server.
#   2. A user LaunchAgent (tech.gauravraj.contrails-watch) runs `/usr/bin/python3 _watch/serve.py --bind 127.0.0.1
#      8790` there: stdlib http.server plus gzip, loopback only.
#   3. `tailscale serve --bg --https=8790 http://127.0.0.1:8790` publishes it on the tailnet (never Funnel).
# It never runs `tailscale serve reset` and never touches other serve ports (Immich 443, Tesla 8786/8787). Full
# `tailscale serve status` is printed before and after every mode.
#
# Page: https://home-server.tail7af116.ts.net:8790/_watch/?airport=SFO
set -euo pipefail

HOST="${WATCH_HOST:-homeserver@100.90.1.88}"
PORT=8790
LABEL=tech.gauravraj.contrails-watch
REMOTE_DIR=contrails-watch            # relative to the remote $HOME
PATHS=(_watch contrails-core.js js/data.js js/render.js js/airport-board.js airports.json runways.json airlines.json)
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST")

mode="${1:-deploy}"
ref="${2:-HEAD}"

# Runs on the home server. $1 = mode (preflight|deploy|undo|status), $2 = port, $3 = label, $4 = dir under $HOME.
remote() {
  "${SSH[@]}" bash -s -- "$@" <<'REMOTE'
set -euo pipefail
mode="$1"; port="$2"; label="$3"; dir="$HOME/$4"
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
command -v tailscale >/dev/null 2>&1 && TS="$(command -v tailscale)"
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

# Prints absent | ours | foreign <detail>; exits non-zero if the serve config cannot be read (fail closed).
serve_owner() {
  local cfg
  cfg="$("$TS" serve status --json)" || { echo "cannot read tailscale serve status" >&2; return 1; }
  printf '%s' "$cfg" | /usr/bin/python3 -c '
import json, sys
port = sys.argv[1]
raw = sys.stdin.read().strip()
if not raw:
    sys.exit("empty tailscale serve status")      # fail closed
cfg = json.loads(raw) or {}                        # valid JSON null = no serve config
tcp = (cfg.get("TCP") or {}).get(port)
web = {h: v for h, v in (cfg.get("Web") or {}).items() if h.rsplit(":", 1)[-1] == port}
# Foreground (non --bg) sessions carry their own configs; anything there on this port is foreign.
for session, fg in (cfg.get("Foreground") or {}).items():
    fg = fg or {}
    if port in (fg.get("TCP") or {}) or any(h.rsplit(":", 1)[-1] == port for h in (fg.get("Web") or {})):
        print("foreign foreground session " + session)
        sys.exit(0)
if tcp is None and not web:
    print("absent")
elif tcp == {"HTTPS": True} and len(web) == 1 and \
        list(web.values())[0].get("Handlers") == {"/": {"Proxy": "http://127.0.0.1:" + port}}:
    print("ours")
else:
    print("foreign " + json.dumps({"TCP": tcp, "Web": web}, sort_keys=True))
' "$port"
}

echo "--- tailscale serve status (before $mode)"
"$TS" serve status
owner="$(serve_owner)"
echo "--- :$port is $owner"

case "$mode" in
preflight)
  case "$owner" in absent|ours) ;; *) echo "REFUSING: :$port is served by something else" >&2; exit 1 ;; esac
  exit 0
  ;;
deploy)
  case "$owner" in absent|ours) ;; *) echo "REFUSING: :$port is served by something else" >&2; exit 1 ;; esac
  [ -f "$dir/_watch/serve.py" ] || { echo "missing $dir/_watch/serve.py" >&2; exit 1; }
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$plist.tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string><string>_watch/serve.py</string>
    <string>--bind</string><string>127.0.0.1</string><string>$port</string>
  </array>
  <key>WorkingDirectory</key><string>$dir</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/contrails-watch.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/contrails-watch.log</string>
</dict>
</plist>
PLIST
  # Always restart: the export (incl. serve.py) may have changed.
  mv "$plist.tmp" "$plist"
  launchctl bootout "$domain/$label" 2>/dev/null || true
  for _ in $(seq 1 20); do launchctl print "$domain/$label" >/dev/null 2>&1 || break; sleep 0.25; done
  launchctl bootstrap "$domain" "$plist"
  ok=""
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/_watch/"; then ok=1; break; fi
    sleep 0.5
  done
  [ -n "$ok" ] || { echo "local server did not come up on :$port" >&2; exit 1; }
  if [ "$owner" = absent ]; then
    "$TS" serve --bg --https="$port" "http://127.0.0.1:$port"
  else
    echo "tailscale serve :$port already published (ours)"
  fi
  ;;
undo)
  if [ "$owner" = ours ]; then
    "$TS" serve --https="$port" off
  elif [ "$owner" != absent ]; then
    echo "NOT unpublishing :$port: it is not ours ($owner)" >&2
  fi
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  if [ -d "$dir" ]; then
    aside="$dir.removed-$(date +%Y%m%d%H%M%S)"
    mv "$dir" "$aside"
    echo "export moved aside to $aside"
  fi
  ;;
status) ;;
*) echo "unknown remote mode $mode" >&2; exit 2 ;;
esac

echo "--- launchd"
launchctl print "$domain/$label" 2>/dev/null | grep -E '^\s*(state|pid|last exit code) =' || echo "$label not loaded"
echo "--- local probe"
curl -sS -o /dev/null -w "http://127.0.0.1:$port/_watch/ -> %{http_code}\n" "http://127.0.0.1:$port/_watch/" || true
echo "--- tailscale serve status (after $mode)"
"$TS" serve status
REMOTE
}

case "$mode" in
deploy)
  root="$(git rev-parse --show-toplevel)"
  sha="$(git -C "$root" rev-parse --short "$ref")"
  remote preflight "$PORT" "$LABEL" "$REMOTE_DIR"
  tmp="$(mktemp -d)"
  trap 'rm -r -f -- "$tmp"' EXIT
  git -C "$root" archive --format=tar "$ref" -- "${PATHS[@]}" | tar -x -C "$tmp"
  printf '%s\n' "$sha" > "$tmp/_watch/DEPLOYED_SHA"
  "${SSH[@]}" "mkdir -p ~/$REMOTE_DIR"
  rsync -a --delete -e "ssh -o BatchMode=yes -o ConnectTimeout=15" "$tmp/" "$HOST:$REMOTE_DIR/"
  echo "synced $ref ($sha) -> $HOST:~/$REMOTE_DIR"
  remote deploy "$PORT" "$LABEL" "$REMOTE_DIR"
  echo "Page: https://home-server.tail7af116.ts.net:$PORT/_watch/?airport=SFO"
  ;;
undo|status)
  remote "$mode" "$PORT" "$LABEL" "$REMOTE_DIR"
  ;;
*)
  echo "usage: $0 [deploy [REF]|status|undo]" >&2
  exit 2
  ;;
esac
