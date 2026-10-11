#!/usr/bin/env sh
# Stop the Fabric dev server (graceful: SIGTERM lets it save the world and exit).
# The bracket trick avoids pkill matching its own invoking shell's command line.
pkill -f '[n]et.fabricmc.devlaunchinjector.Main' 2>/dev/null || true
pkill -f '[g]radle-wrapper.jar runServer' 2>/dev/null || true
for _ in $(seq 1 30); do
  curl -s --max-time 1 http://127.0.0.1:8765/health >/dev/null 2>&1 || break
  sleep 1
done
echo "server-down: stopped"
