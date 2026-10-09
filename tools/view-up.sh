#!/usr/bin/env sh
# Debug visualization: a top-down surface map of the bot's surroundings, read from the observer.
# Prints an ANSI map to the terminal and writes a colored HTML grid.
#
#   tools/view-up.sh [--radius 20] [--watch]
#
# prismarine-viewer (3D) is deferred: it needs the native `canvas` module, not installable here.
set -e
cd "$(dirname "$0")/.."
OUT="${MCAGENT_VIEW_HTML:-/tmp/opencode/view.html}"
exec node tools/view.mjs --html "$OUT" "$@"
