#!/usr/bin/env bash
#
# Generate an application from an EML model and bring it up alongside the
# reporting platform, on one origin.
#
#   ./start.sh                                  the reference CRM model
#   ./start.sh common/examples/my-app.eml.mmd   any other model
#   ./start.sh my-app.eml.mmd --profile prod    two database servers
#   ./start.sh --port 8080                      somewhere other than :80
#   ./start.sh --with-chat                      also the chat assistant, at /chat
#
# When it finishes:
#
#   http://localhost/app      the generated application
#   http://localhost/report   the reporting platform, already holding that
#                             application's schema as a data source and its
#                             reports, charts and dashboard
#
# Everything this script writes goes under common/.runtime/, which is not
# checked in. Neither product's directory is touched.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

readonly COMMON="common"
readonly RUNTIME="${COMMON}/.runtime"
readonly APP_DIR="${RUNTIME}/app"
readonly PACK_DIR="${RUNTIME}/pack"
readonly LANDING_DIR="${RUNTIME}/landing"
readonly ENV_FILE="${RUNTIME}/.env"

# admin@admin.com is seeded on first start, on both sides, with ADMIN_PASSWORD from
# the environment file, and with "administrator" when there is none — the default
# docker-compose.yml applies. Read here so the front door and the banner say what
# will actually be seeded. A configured value the products would ignore (under 8
# characters) is refused rather than shown: they would generate a random password
# instead, and the banner would be naming one nothing set.
ADMIN_PASSWORD_SHOWN="administrator"
if [[ -f "$ENV_FILE" ]]; then
  _configured="$(sed -n 's/^ADMIN_PASSWORD=//p' "$ENV_FILE" | tail -1)"
  # Compose strips one pair of surrounding quotes; so does this.
  _configured="${_configured#\"}"; _configured="${_configured%\"}"
  _configured="${_configured#\'}"; _configured="${_configured%\'}"
  if [[ -n "$_configured" ]]; then
    if [[ ${#_configured} -lt 8 ]]; then
      echo "error: ADMIN_PASSWORD in ${ENV_FILE} is shorter than 8 characters; the application and the" >&2
      echo "       reporting platform would ignore it and generate a random one. Use 8 or more," >&2
      echo "       or delete the line to get the default." >&2
      exit 1
    fi
    ADMIN_PASSWORD_SHOWN="$_configured"
  fi
fi
readonly DEFAULT_MODEL="${COMMON}/language/examples/crm.eml.mmd"

MODEL=""
PROFILE="demo"
PORT="80"
REBUILD=""
KEEP_APP=""
WITH_CHAT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --port)    PORT="${2:-}"; shift 2 ;;
    --rebuild) REBUILD="--no-cache"; shift ;;
    --keep-app) KEEP_APP="1"; shift ;;
    --with-chat) WITH_CHAT="1"; shift ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *)  MODEL="$1"; shift ;;
  esac
done

MODEL="${MODEL:-$DEFAULT_MODEL}"

case "$PROFILE" in
  demo|prod) ;;
  *) echo "Unknown profile \"$PROFILE\". Use demo or prod." >&2; exit 2 ;;
esac

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v bun >/dev/null 2>&1 || die "bun is not installed. The model is checked, generated and turned into a reporting pack on this machine, before anything is built."
command -v docker >/dev/null 2>&1 || die "docker is not installed."
docker compose version >/dev/null 2>&1 || die "docker compose (v2) is not available."
[[ -f "$MODEL" ]] || die "Model not found: $MODEL"

# The two products are separate repositories, placed by ./deps.sh at the commits
# deps.json pins. Without them the generate fails on a module it cannot resolve
# and compose fails on a build context that does not exist — both a long way in,
# and neither error says what is actually missing.
for dep in app-with-ai-tanstack enterprise_reporting_tanstack; do
  [[ -d "$dep" ]] || die "$dep is not checked out. Run ./deps.sh first — it places both product repositories at the commits deps.json pins."
done
# The tanstack-nestjs target drives the orchestrator in app-with-ai-tanstack,
# which resolves its own dependencies from its own node_modules.
[[ -d "app-with-ai-tanstack/node_modules" ]] || die "app-with-ai-tanstack has no node_modules. Run ./deps.sh --install, or install it yourself — generating with --stack tanstack-nestjs drives its orchestrator, which fails on 'Cannot find package' without it."

APP_NAME="$(basename "$MODEL" | sed 's/\.eml\.mmd$//;s/\.mmd$//')"
# A Postgres database name, from a model file name.
APP_DB_NAME="$(printf '%s' "$APP_NAME" | tr '[:upper:]-' '[:lower:]_' | tr -cd 'a-z0-9_')"
[[ -n "$APP_DB_NAME" ]] || APP_DB_NAME="appdb"

# Resolved here rather than beside the closing message, because the front door
# is generated in step 5 and has to print the same origin the reader will use.
ORIGIN="http://localhost"
[[ "$PORT" == "80" ]] || ORIGIN="http://localhost:${PORT}"

say "1/7  Checking the model"
# The checker writes a .error file beside whatever it reads; that is its
# interface. Removed again unless it was already tracked.
HAD_ERROR_FILE=""
[[ -f "${MODEL}.error" ]] && HAD_ERROR_FILE="1"
if ! (cd "$COMMON" && bun language/checker.ts "../${MODEL}"); then
  [[ -n "$HAD_ERROR_FILE" ]] || rm -f "${MODEL}.error"
  die "The model has errors. Nothing downstream can be trusted until they are fixed."
fi
[[ -n "$HAD_ERROR_FILE" ]] || rm -f "${MODEL}.error"

say "2/7  Generating the application"
mkdir -p "$RUNTIME"
if [[ -n "$KEEP_APP" && -d "$APP_DIR" ]]; then
  echo "  --keep-app: reusing the application already in ${APP_DIR}"
else
  rm -rf "$APP_DIR"
  (cd "$COMMON" && bun language/cli/eml.ts generate \
      -i "../${MODEL}" -o "../${APP_DIR}" -n "$APP_NAME" \
      --stack tanstack-nestjs --force)
fi

say "3/7  Putting the application on /app"
(cd "$COMMON" && bun build/subpath-overlay.ts --dir "../${APP_DIR}/frontend" --base /app)

say "4/7  Deriving the reporting pack"
mkdir -p "$PACK_DIR"
# --app-name is the same value the generate above was given. The reporting
# accounts and the application's are derived from it, so passing a different one
# here puts addresses on the front door that belong to no account.
(cd "$COMMON" && bun build/reporting-pack.ts \
    -i "../${MODEL}" -o "../${PACK_DIR}/reporting-pack.json" \
    --database "$APP_DB_NAME" --app-name "$APP_NAME")

say "5/7  Writing the front door"
# The page nginx serves at /. Generated rather than static because every
# account on it comes from this model's %%rbac.
mkdir -p "$LANDING_DIR"
(cd "$COMMON" && bun build/landing.ts \
    -i "../${PACK_DIR}/reporting-pack.json" -o "../${LANDING_DIR}" --origin "$ORIGIN" \
    --admin-password "$ADMIN_PASSWORD_SHOWN" ${WITH_CHAT:+--chat})

say "6/7  Configuration"
# Secrets are generated once and then left alone: regenerating ENCRYPTION_KEY
# would leave every stored data-source password undecryptable, and the failure
# would look like a broken data source rather than a rotated key.
if [[ ! -f "$ENV_FILE" ]]; then
  gen() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  {
    echo "# Written by ./start.sh. Delete it to regenerate the secrets —"
    echo "# which invalidates every connection config already stored."
    echo "AUTH_SECRET=$(gen)"
    echo "ENCRYPTION_KEY=$(gen)"
    echo "JWT_SECRET=$(gen)"
    echo "SESSION_SECRET=$(gen)"
    echo "BETTER_AUTH_SECRET=$(gen)"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  wrote ${ENV_FILE}"
else
  echo "  keeping the secrets already in ${ENV_FILE}"
fi

# Everything derived from this run is rewritten every time.
sed -i.bak '/^# --- derived/,$d' "$ENV_FILE" && rm -f "${ENV_FILE}.bak"

# The chat assistant's secret is one of the secrets: written once, the first
# time --with-chat is used, and then left alone. It signs the assistant's
# requests to the reporting platform, so the two must hold the same value.
if [[ -n "$WITH_CHAT" ]] && ! grep -q '^CHAT_BRIDGE_SECRET=' "$ENV_FILE"; then
  echo "CHAT_BRIDGE_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$ENV_FILE"
  echo "  wrote CHAT_BRIDGE_SECRET"
fi
{
  echo "# --- derived from this run; rewritten on every ./start.sh"
  echo "APP_NAME=${APP_NAME}"
  echo "APP_DB_NAME=${APP_DB_NAME}"
  echo "PUBLIC_PORT=${PORT}"
  if [[ "$PORT" == "80" ]]; then
    echo "PUBLIC_ORIGIN=http://localhost"
  else
    echo "PUBLIC_ORIGIN=http://localhost:${PORT}"
  fi
  if [[ "$PROFILE" == "prod" ]]; then
    # Two servers, each the image its application asks for.
    echo "APP_DB_HOST=postgres-app"
    echo "REPORT_DB_HOST=postgres-report"
    echo "REPORT_DB_USER=enterprise"
    echo "REPORT_DB_PASSWORD=enterprise_pass"
  else
    # One server, three databases.
    echo "APP_DB_HOST=postgres"
    echo "REPORT_DB_HOST=postgres"
    echo "REPORT_DB_USER=app"
    echo "REPORT_DB_PASSWORD=app"
  fi
  if [[ -n "$WITH_CHAT" ]]; then
    # What lets the reporting platform be framed by the assistant, and where it
    # asks whether the administrator has made the chat the only way in.
    echo "CHAT_EMBED=1"
    echo "CHAT_SWITCHES_URL=http://assistant:4200/chat/switches"
  fi
} >> "$ENV_FILE"

say "7/7  Building and starting (profile: ${PROFILE})"
docker compose --env-file "$ENV_FILE" --profile "$PROFILE" ${WITH_CHAT:+--profile chat} \
  up -d --build ${REBUILD:+--no-cache}

cat <<EOF

  ${APP_NAME} is starting.

    ${ORIGIN}/         both applications, and the accounts for each
    ${ORIGIN}/app      the application
    ${ORIGIN}/report   the reports and charts derived from its model
${WITH_CHAT:+    ${ORIGIN}/chat     the assistant: both of the above, by asking (application accounts)
}
  These are two systems: separate databases, separate user tables, separate
  sign-ins. A role name means "what you may do to a record" in the application
  and "which tables your queries may read" in the reporting platform, so the
  accounts are listed side by side at ${ORIGIN}/ rather than here. Both
  administrators are admin@admin.com / ${ADMIN_PASSWORD_SHOWN} — the same address,
  two different accounts, in two different databases.

  The first start migrates and seeds the application, then loads its schema and
  reporting pack into the platform. That takes a few minutes; until the seeder
  finishes, /report is up but empty.

    docker compose --env-file ${ENV_FILE} logs -f seeder
    docker compose --env-file ${ENV_FILE} ps

  Stop with ./stop.sh, or ./stop.sh --volumes to discard the databases too.
EOF
