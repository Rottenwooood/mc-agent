#!/usr/bin/env sh
# Stop every mc-agent resident process (the bot owner). Matches on /proc cmdline instead of
# `pkill -f main-resident`, which would also match (and kill) the invoking shell.
killed=0
for d in /proc/[0-9]*; do
  pid=${d#/proc/}
  [ "$pid" = "$$" ] && continue
  cl=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null) || continue
  case "$cl" in
    "node "*"main-resident.js"*) kill "$pid" 2>/dev/null && killed=$((killed + 1)) ;;
  esac
done
echo "agent-down: killed $killed resident(s)"
