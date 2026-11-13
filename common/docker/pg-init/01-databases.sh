#!/bin/bash
# Runs once, on the first start of the demo profile's single PostgreSQL.
#
# Three databases in one instance, which is what "different schema" means here:
# the reporting platform's own configuration never shares a database with the
# application it reports on, so a regeneration that drops and recreates the
# application's tables cannot take the reports with it.
#
#   $POSTGRES_DB       the generated application
#   enterprise_config  the reporting platform's own configuration
#   ers_knowledge      the reporting platform's knowledge graph
#
# The production profile splits these across two servers instead — see
# docker-compose.yml — because the two want different images.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  SELECT 'CREATE DATABASE enterprise_config OWNER $POSTGRES_USER'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'enterprise_config')\gexec
  SELECT 'CREATE DATABASE ers_knowledge OWNER $POSTGRES_USER'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ers_knowledge')\gexec
  SELECT 'CREATE DATABASE chatdb OWNER $POSTGRES_USER'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'chatdb')\gexec
EOSQL

# pgvector, in the application's database. Required: the generated
# application's model-context assistant creates an index over it.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

# Apache AGE, in the knowledge-graph database. Optional, and deliberately not
# fatal.
#
# This script runs inside the database's own entrypoint: a non-zero exit here
# does not skip a feature, it aborts initialisation and leaves both
# applications with no database at all. AGE serves one lazy feature of the
# reporting platform — graph context for natural-language queries — and every
# other screen it has boots without it. Taking the whole stack down for that is
# the wrong trade, so a server without AGE says so and carries on.
if psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname ers_knowledge <<-EOSQL 2>/dev/null
  CREATE EXTENSION IF NOT EXISTS age;
  SELECT create_graph('knowledge_graph');
EOSQL
then
  echo "[pg-init] Apache AGE ready in ers_knowledge"
else
  echo "[pg-init] NOTE: this image has no Apache AGE — the knowledge-graph NL"
  echo "[pg-init]       feature is unavailable. Everything else is unaffected."
  echo "[pg-init]       The prod profile runs a separate AGE server for it."
fi

echo "[pg-init] $POSTGRES_DB, enterprise_config and ers_knowledge ready"
