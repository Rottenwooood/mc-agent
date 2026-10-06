#!/usr/bin/env sh
# Run the chop_tree scenario against the running server.
# Env: CHOP_BLOCK, CHOP_COUNT, MC_USER, MC_HOST, MC_PORT, MC_VERSION, MCAGENT_OBSERVER
set -e
cd "$(dirname "$0")/../agent"
exec node src/scenarios/chop_tree.js "$@"
