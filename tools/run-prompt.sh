#!/usr/bin/env sh
# Run ONE prompt against the running server + agent, headlessly (no benchmark, no verification).
# Use this to try your own task prompt. For the fixed benchmark suite use tools/bench.sh.
#
#   tools/run-prompt.sh <prompt-file | "inline text"> [--model provider/model#variant] [--agent NAME]
#
# Requires: server up (tools/server-up.sh) and agent up (tools/agent-up.sh).
# The OpenCode agent's system prompt is prompts/mc-agent-system.md (agent "mc-agent").
set -e
cd "$(dirname "$0")/.."

[ $# -ge 1 ] || { echo 'usage: run-prompt.sh <prompt-file | "text"> [--model M] [--agent A]' >&2; exit 64; }
PROMPT=$1; shift
OC_AGENT=${MC_OC_AGENT:-mc-agent}
OC_MODEL=${MC_OC_MODEL:-opencode-go/deepseek-v4.1-flash#low}
while [ $# -gt 0 ]; do
  case "$1" in
    --model) OC_MODEL=$2; shift 2 ;;
    --agent) OC_AGENT=$2; shift 2 ;;
    *) echo "run-prompt: unknown option '$1'" >&2; exit 64 ;;
  esac
done

if [ -f "$PROMPT" ]; then TEXT=$(cat "$PROMPT"); else TEXT=$PROMPT; fi
echo "run-prompt: agent=$OC_AGENT model=$OC_MODEL" >&2
exec opencode run --agent "$OC_AGENT" --model "$OC_MODEL" --auto "$TEXT"
