#!/bin/sh
# Create the relay's database if the server does not have it yet, then run the relay.
#
# pg-init creates `buzzdb` on a fresh volume; a deployment whose database volume predates the
# relay has none, and the relay does not create its own. Like everything else here it waits for
# its database rather than declaring depends_on (which a profile split cannot express), so a server
# that is still starting is retried, not fatal.
set -eu

: "${DATABASE_URL:?DATABASE_URL must name the relay database}"
name="${DATABASE_URL##*/}"
name="${name%%\?*}"
admin="${DATABASE_URL%/*}/postgres"

case "$name" in
  *[!a-z0-9_]*|"") echo "buzz-relay: refusing an unusual database name: $name" >&2; exit 1 ;;
esac

tries=0
until psql "$admin" -qtAc "SELECT 1" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then echo "buzz-relay: PostgreSQL did not answer" >&2; exit 1; fi
  sleep 2
done

if [ "$(psql "$admin" -qtAc "SELECT 1 FROM pg_database WHERE datname = '$name'")" != "1" ]; then
  psql "$admin" -qc "CREATE DATABASE $name" && echo "buzz-relay: created database $name"
fi

exec /usr/local/bin/buzz-relay "$@"
