#!/usr/bin/env sh
# Build + install the mcagent mod into the Fabric client profile, then launch the real client
# (auto-connecting to the dev server). Only the ControlPort backend changes; the agent then runs
# with MCAGENT_CONTROL=client-mod.
#
#   tools/client-up.sh                 # build, install, launch, connect to 127.0.0.1:25565
#   tools/client-up.sh --install-only  # build + install the jar, do not launch
set -e
cd "$(dirname "$0")/.."

PROFILE="${MCAGENT_PROFILE:-$HOME/.local/share/red.ghs.axolotl/profiles/1.20.1-Fabric 0.19.5}"
SERVER="${MCAGENT_SERVER:-127.0.0.1:25565}"

INSTALL_ONLY=0
for a in "$@"; do
  [ "$a" = "--install-only" ] && INSTALL_ONLY=1
done

. ./env.sh
echo "[client-up] building mod"
( cd mods/mcagent && ./gradlew build --no-daemon --console=plain -q )

mkdir -p "$PROFILE/mods"
cp -f mods/mcagent/build/libs/mcagent-0.1.0.jar "$PROFILE/mods/"
echo "[client-up] installed mcagent-0.1.0.jar -> $PROFILE/mods"

if ! ls "$PROFILE"/mods/fabric-api-*.jar >/dev/null 2>&1; then
  node tools/fetch-fabric-api.mjs "$PROFILE/mods"
fi

if [ "$INSTALL_ONLY" = "1" ]; then
  echo "[client-up] install-only: not launching"
  exit 0
fi

echo "[client-up] launching client (server=$SERVER)"
exec node tools/launch-client.mjs --profile "$PROFILE" --server "$SERVER" "$@"
