#!/usr/bin/env sh
# Start the mc-agent resident (the body owner). One resident per server/identity.
# The resident connects the bot, owns the world client + execution + tools, and listens on a
# unix socket; the MCP bridge (apps/agent/dist/main-bridge.js) connects to it.
#
#   tools/agent-up.sh [options]
#
#   --backend mineflayer|client-mod  control backend            (env MCAGENT_CONTROL; default mineflayer)
#   --server  HOST[:PORT]            target server              (env MC_HOST / MC_PORT; default 127.0.0.1:25565)
#   --user    NAME                   bot / player name          (env MC_USER; default Bot)
#   --version MC                     protocol version            (env MC_VERSION; default 1.20.1)
#   --reflex  0|1                    L1 reflex shield            (env MCAGENT_REFLEX; default 1)
#   --actions PATH                   secondary-action library JSON (env MCAGENT_ACTIONS)
#   --skills  PATH                   skill library JSON          (env MCAGENT_SKILLS)
#   -h | --help
#
# Runs in the foreground; background it yourself, e.g.
#   setsid tools/agent-up.sh --server 127.0.0.1:25565 --user Bot > /tmp/opencode/resident.log 2>&1 < /dev/null &
set -e
cd "$(dirname "$0")/.."

BACKEND=${MCAGENT_CONTROL:-mineflayer}
SERVER=${MC_HOST:-127.0.0.1}:${MC_PORT:-25565}
USER=${MC_USER:-Bot}
VERSION=${MC_VERSION:-1.20.1}
REFLEX=${MCAGENT_REFLEX:-1}
ACTIONS=${MCAGENT_ACTIONS:-}
SKILLS=${MCAGENT_SKILLS:-}

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --backend) BACKEND=$2; shift 2 ;;
    --server)  SERVER=$2;  shift 2 ;;
    --user)    USER=$2;    shift 2 ;;
    --version) VERSION=$2; shift 2 ;;
    --reflex)  REFLEX=$2;  shift 2 ;;
    --actions) ACTIONS=$2; shift 2 ;;
    --skills)  SKILLS=$2;  shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "agent-up: unknown option '$1' (try --help)" >&2; exit 64 ;;
  esac
done

HOST=${SERVER%:*}
PORT=${SERVER##*:}
if [ "$HOST" = "$SERVER" ]; then HOST=$SERVER; PORT=25565; fi

# Seed the skill library from the repo example if none exists yet.
SKILLS_DEFAULT="$(pwd)/.mc-agent/skills.json"
if [ -z "$SKILLS" ] && [ ! -f "$SKILLS_DEFAULT" ] && [ -f scenarios/skills.seed.json ]; then
  mkdir -p .mc-agent && cp scenarios/skills.seed.json "$SKILLS_DEFAULT"
  echo "agent-up: seeded .mc-agent/skills.json from scenarios/skills.seed.json" >&2
fi

export MCAGENT_CONTROL=$BACKEND MC_HOST=$HOST MC_PORT=$PORT MC_USER=$USER MC_VERSION=$VERSION MCAGENT_REFLEX=$REFLEX
[ -n "$ACTIONS" ] && export MCAGENT_ACTIONS=$ACTIONS
[ -n "$SKILLS" ] && export MCAGENT_SKILLS=$SKILLS

echo "agent-up: backend=$BACKEND server=$HOST:$PORT user=$USER version=$VERSION reflex=$REFLEX" >&2
exec node apps/agent/dist/main-resident.js
