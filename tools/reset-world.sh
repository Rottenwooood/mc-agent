#!/usr/bin/env sh
# Reset the dev world to a fresh generation for a given seed (hard seed isolation for the gate).
#   tools/reset-world.sh <seed>
# Stops the server, deletes the world, sets level-seed, restarts, and waits for /health.
# The caller is responsible for restarting the resident agent afterwards (with MCAGENT_SEED).
set -e
cd "$(dirname "$0")/.."
SEED="$1"
[ -n "$SEED" ] || { echo "usage: reset-world.sh <seed>" >&2; exit 64; }

RUN="mods/mcagent/run"

echo "reset-world: stopping server..."
# The bracket trick avoids pkill matching its own invoking shell's command line.
pkill -f '[n]et.fabricmc.devlaunchinjector.Main' 2>/dev/null || true
pkill -f '[g]radle-wrapper.jar runServer' 2>/dev/null || true
for _ in $(seq 1 30); do
  curl -s --max-time 1 http://127.0.0.1:8765/health >/dev/null 2>&1 || break
  sleep 1
done
sleep 2

rm -rf "$RUN/world" "$RUN/world_nether" "$RUN/world_the_end"
if grep -q '^level-seed=' "$RUN/server.properties"; then
  sed -i "s/^level-seed=.*/level-seed=$SEED/" "$RUN/server.properties"
else
  echo "level-seed=$SEED" >> "$RUN/server.properties"
fi

echo "reset-world: starting server (seed=$SEED)..."
nohup tools/server-up.sh >/tmp/opencode/mc-server.log 2>&1 &
for _ in $(seq 1 120); do
  if curl -s --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1; then
    echo "reset-world: up (seed=$SEED)"
    exit 0
  fi
  sleep 2
done
echo "reset-world: server did not come up" >&2
exit 1
