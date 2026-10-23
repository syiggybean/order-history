#!/bin/bash
# MonkeyBean Print: prints labels and packing slips sent from the MonkeyBean app.
#
# Runs in the background on a packing Mac (started at login by launchd). It keeps one
# request open to the app, waiting for print jobs; each job is downloaded and printed
# with macOS's own printing (lp), then the result is reported back to the app.
# Uses only what every Mac has: bash, curl and lp.
#
# Files: ~/Library/Application Support/MonkeyBean Print/  (config, key, this script)
# Log:   ~/Library/Logs/MonkeyBean Print.log

AGENT_VERSION=1

DIR="$HOME/Library/Application Support/MonkeyBean Print"
LOG="$HOME/Library/Logs/MonkeyBean Print.log"
CURLRC="$DIR/curlrc"
SELF="$DIR/agent.sh"
LP=/usr/bin/lp
LPSTAT=/usr/bin/lpstat
export LC_ALL=C
set -f # no filename expansion of anything the server sends

mkdir -p "$(dirname "$LOG")"
# Keep the log small
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 2000000 ]; then
  tail -c 500000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

APP_URL=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in url=*) APP_URL="${line#url=}" ;; esac
done <"$DIR/config"
if [ -z "$APP_URL" ] || [ ! -f "$CURLRC" ]; then
  log "Not set up: run the install command from the app again."
  sleep 300
  exit 1
fi

# curl reads the key from curlrc, so it never shows in the process list
api() { /usr/bin/curl -sS -K "$CURLRC" -A "MonkeyBeanPrint/$AGENT_VERSION" "$@"; }

# Value of key=value from a server reply ($1 reply, $2 key)
field() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n 1; }

computer_name() { /usr/sbin/scutil --get ComputerName 2>/dev/null || hostname; }

hello() {
  local printers default devices reply
  printers=$("$LPSTAT" -l -p 2>&1)
  default=$("$LPSTAT" -d 2>&1)
  devices=$("$LPSTAT" -v 2>&1)
  reply=$(api --max-time 30 -w '\n_status=%{http_code}' \
    --data-urlencode "version=$AGENT_VERSION" \
    --data-urlencode "host=$(computer_name)" \
    --data-urlencode "os=$(/usr/bin/sw_vers -productVersion 2>/dev/null)" \
    --data-urlencode "printers=$printers" \
    --data-urlencode "default=$default" \
    --data-urlencode "devices=$devices" \
    "$APP_URL/print-agent/hello") || return 1
  [ "$(field "$reply" _status)" = 200 ] || return 1
  log "Connected as \"$(field "$reply" station)\"; printers reported."
  return 0
}

report() { # job state message
  api --max-time 30 -o /dev/null \
    --data-urlencode "job=$1" --data-urlencode "state=$2" --data-urlencode "message=$3" \
    "$APP_URL/print-agent/result" || log "Couldn't report job $1 ($2): $3"
}

# Wait (up to ~20 s) for CUPS to finish a request; tells "printed" from "stuck in the queue"
settle() { # printer request-id
  local i=0
  while [ $i -lt 20 ]; do
    if ! "$LPSTAT" -W not-completed -o "$1" 2>/dev/null | grep -q "^$2 "; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

print_job() {
  local reply="$1" job printer format copies title options file out rc req state why
  job=$(field "$reply" job)
  printer=$(field "$reply" printer)
  format=$(field "$reply" format)
  copies=$(field "$reply" copies)
  title=$(field "$reply" title)
  options=$(field "$reply" options)
  case "$job" in '' | *[!0-9]*) log "Bad job reply"; return ;; esac
  case "$copies" in '' | *[!0-9]*) copies=1 ;; esac

  file=$(mktemp "${TMPDIR:-/tmp}/monkeybean-print.XXXXXX") || { report "$job" failed "The Mac couldn't make a temporary file."; return; }
  if ! api --max-time 60 -f -o "$file" "$APP_URL/print-agent/file?job=$job"; then
    rm -f "$file"
    report "$job" failed "The Mac couldn't download the file to print."
    return
  fi

  local -a args
  args=(-d "$printer" -n "$copies" -t "$title")
  if [ "$format" = ZPL ]; then
    args+=(-o raw)
  else
    for o in $options; do args+=(-o "$o"); done
  fi
  out=$("$LP" "${args[@]}" "$file" 2>&1)
  rc=$?
  rm -f "$file"
  if [ $rc -ne 0 ]; then
    log "Job $job to $printer failed: $out"
    report "$job" failed "$out"
    return
  fi
  req=$(printf '%s\n' "$out" | sed -n 's/^request id is \([^ ]*\).*/\1/p')
  state=printed
  why="Sent to $printer"
  if [ -n "$req" ] && ! settle "$printer" "$req"; then
    state=waiting
    why=$("$LPSTAT" -p "$printer" 2>&1 | tr '\n' ' ')
  fi
  log "Job $job ($title) → $printer: $state"
  report "$job" "$state" "$why"
}

update_self() {
  local new="$DIR/agent.sh.new"
  if api --max-time 60 -f -o "$new" "$APP_URL/print-agent/agent.sh" && /bin/bash -n "$new" && grep -q '^AGENT_VERSION=' "$new"; then
    chmod 755 "$new" && mv "$new" "$SELF"
    log "Updated the print agent; restarting."
    exit 0 # launchd starts the new version
  fi
  rm -f "$new"
  log "Update failed; carrying on with version $AGENT_VERSION."
}

log "Starting (version $AGENT_VERSION, app $APP_URL)."
last_hello=0
fails=0
while true; do
  now=$(date +%s)
  if [ $((now - last_hello)) -ge 300 ]; then
    if hello; then last_hello=$now; fi
  fi

  reply=$(api --max-time 45 -w '\n_status=%{http_code}' "$APP_URL/print-agent/next?version=$AGENT_VERSION")
  rc=$?
  status=$(field "$reply" _status)
  if [ $rc -ne 0 ] || [ -z "$status" ] || [ "$status" = 000 ]; then
    fails=$((fails + 1))
    [ $fails -eq 1 ] && log "Can't reach the app; retrying."
    sleep $((fails < 6 ? 5 : 30))
    continue
  fi
  [ $fails -gt 0 ] && log "Reconnected."
  fails=0
  case "$status" in
    200)
      [ "$(field "$reply" hello)" = 1 ] && { hello && last_hello=$(date +%s); }
      [ "$(field "$reply" update)" = 1 ] && update_self
      [ -n "$(field "$reply" job)" ] && print_job "$reply"
      ;;
    204) ;;
    401 | 403)
      log "The app doesn't recognise this Mac any more (removed in the app?). Run the install command again."
      sleep 300
      ;;
    *)
      sleep 10
      ;;
  esac
done
