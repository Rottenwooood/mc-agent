#!/usr/bin/env sh
# Start the Fabric dev server with the read-only observer mod.
set -e
cd "$(dirname "$0")/.."
. ./env.sh
cd mc-mod
exec ./gradlew runServer --no-daemon --console=plain
