#!/bin/bash
# Removes MonkeyBean Print from this Mac. (Remove the computer in the app too.)
LABEL=com.monkeybean.printagent
/bin/launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || /bin/launchctl unload "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/Library/Application Support/MonkeyBean Print"
echo "✓ MonkeyBean Print was removed from this Mac. (Its log stays in ~/Library/Logs/MonkeyBean Print.log.)"
