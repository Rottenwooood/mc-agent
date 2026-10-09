#!/usr/bin/env sh
# One-click benchmark: ensure the MC server is up, then run the agent-driven runner
# (reset worlds -> start the resident agent -> drive the LLM client via MCP -> independent verify).
#
#   tools/bench.sh [--tasks T1,T3] [--seeds 5001,5002] [--model opencode-go/deepseek-v4.1-flash]
set -e
cd "$(dirname "$0")/.."

if ! curl -s --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1; then
  echo "bench: starting server..."
  nohup tools/server-up.sh >/tmp/opencode/mc-server.log 2>&1 &
  for _ in $(seq 1 120); do
    curl -s --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1 && break
    sleep 2
  done
fi

exec node tests/eval/runner.mjs "$@"
