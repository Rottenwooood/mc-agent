#!/usr/bin/env sh
# Source to set up the Fabric toolchain for this project:
#   source /home/c6h4o2/dev/mc-agent/env.sh
# Gradle + Loom 1.18.2 require a JDK >= 25 to RUN; the mod compiles to Java 17 bytecode.
MCAGENT_JDK25="${MCAGENT_JDK25:-$HOME/.local/share/jdk/25}"
MCAGENT_JDK17="${MCAGENT_JDK17:-$HOME/.local/share/jdk/17}"

if [ -x "$MCAGENT_JDK25/bin/java" ]; then
  export JAVA_HOME="$MCAGENT_JDK25"
  export PATH="$JAVA_HOME/bin:$PATH"
else
  echo "env.sh: JDK 25 not found at $MCAGENT_JDK25" >&2
fi

export MCAGENT_JDK17
