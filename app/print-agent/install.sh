#!/bin/bash
# Installs MonkeyBean Print on this Mac: run the command shown in the app
# (Shipping → Settings → Packing computers). It pairs this Mac with the app using
# the one-time code, and sets the print agent to start whenever you log in.
APP_URL=__APP_URL__
CODE="$1"
LABEL=com.monkeybean.printagent
DIR="$HOME/Library/Application Support/MonkeyBean Print"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Everything is in main, so a half-downloaded script never runs partly
main() {
fail() { printf '\n✗ %s\n\n' "$*" >&2; exit 1; }
[ "$(uname)" = Darwin ] || fail "This installer is for Macs."
[ -n "$CODE" ] || fail "The install code is missing. Copy the whole command from the app."

echo "Installing MonkeyBean Print…"
mkdir -p "$DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" || fail "Couldn't create $DIR"
chmod 700 "$DIR"

host=$(/usr/sbin/scutil --get ComputerName 2>/dev/null || hostname)
reply=$(/usr/bin/curl -sS --max-time 30 -w '\n_status=%{http_code}' \
  --data-urlencode "code=$CODE" --data-urlencode "host=$host" \
  "$APP_URL/print-agent/pair") || fail "Couldn't reach the app at $APP_URL. Check the internet connection and try again."
status=$(printf '%s\n' "$reply" | sed -n 's/^_status=//p')
token=$(printf '%s\n' "$reply" | sed -n 's/^token=//p')
station=$(printf '%s\n' "$reply" | sed -n 's/^station=//p')
if [ "$status" != 200 ] || [ -z "$token" ]; then
  msg=$(printf '%s\n' "$reply" | sed -n 's/^error=//p')
  fail "${msg:-Pairing failed.} Make a new install command in the app and try again."
fi

/usr/bin/curl -fsS --max-time 60 "$APP_URL/print-agent/agent.sh" -o "$DIR/agent.sh.new" || fail "Couldn't download the print agent."
/bin/bash -n "$DIR/agent.sh.new" || fail "The downloaded print agent looks damaged. Try again."
mv "$DIR/agent.sh.new" "$DIR/agent.sh" && chmod 755 "$DIR/agent.sh"

(
  umask 077
  printf 'url=%s\n' "$APP_URL" >"$DIR/config"
  printf 'header = "Authorization: Bearer %s"\n' "$token" >"$DIR/curlrc"
)

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/agent.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/MonkeyBean Print.log</string>
</dict>
</plist>
PLIST

uid=$(id -u)
/bin/launchctl bootout "gui/$uid/$LABEL" 2>/dev/null
sleep 1
/bin/launchctl bootstrap "gui/$uid" "$PLIST" 2>/dev/null || /bin/launchctl load -w "$PLIST" || fail "Couldn't start the print agent."

printf '\n✓ Done. This Mac is now “%s” in MonkeyBean.\n' "$station"
echo "  Its printers will show in the app within a few seconds: pick the label and packing slip printers there."
echo "  It starts by itself whenever you log in. If macOS shows a Background Items Added notice, that's this."
}

main "$@"
