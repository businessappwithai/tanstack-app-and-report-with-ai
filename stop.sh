#!/usr/bin/env bash
#
# Stop everything ./start.sh brought up.
#
#   ./stop.sh             stop the containers, keep the databases
#   ./stop.sh --volumes   discard the databases as well
#
# Both profiles are named, so this works whichever one was started.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

readonly ENV_FILE="common/.runtime/.env"

VOLUMES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --volumes|-v) VOLUMES="--volumes"; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "docker is not installed." >&2; exit 1; }

# `down` only removes services in the profiles it is given, so both are named:
# stopping after a --profile prod run would otherwise leave its two database
# containers behind, and the next demo start would find the volumes in use.
ARGS=(--profile demo --profile prod --profile chat)
[[ -f "$ENV_FILE" ]] && ARGS=(--env-file "$ENV_FILE" "${ARGS[@]}")

docker compose "${ARGS[@]}" down --remove-orphans ${VOLUMES}

if [[ -n "$VOLUMES" ]]; then
  echo "Containers and database volumes removed."
  echo "The next ./start.sh migrates, seeds and re-loads the reporting pack from scratch."
else
  echo "Containers removed. The databases are kept — ./stop.sh --volumes discards them."
fi
