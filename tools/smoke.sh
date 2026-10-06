#!/usr/bin/env sh
# Smoke-test the read-only observer HTTP endpoints.
set -e
B="${MCAGENT_OBSERVER:-http://127.0.0.1:8765}"
U="${MC_USER:-Bot}"
for p in \
  "/health" \
  "/self?player=$U" \
  "/inventory?player=$U" \
  "/blocks?x=0&y=70&z=0&r=4&limit=10" \
  "/block?x=0&y=64&z=0" \
  "/events?since=0&max=5"; do
  printf '== %s ==\n' "$p"
  curl -s --max-time 3 "$B$p"
  printf '\n'
done
