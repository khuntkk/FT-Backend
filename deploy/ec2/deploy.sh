#!/usr/bin/env bash
# Deploys what is on GitHub to this server: pull, build, migrate, restart.
# Run on the server from anywhere: ~/stitchflow/deploy/ec2/deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

git -C ../.. pull --ff-only
docker compose build api
# Migrations run as the schema owner (MIGRATION_DATABASE_URL) before the new
# API starts; a failed migration stops the deploy with the old API still up.
docker compose run --rm --no-deps api node src/db/migrate.ts
docker compose up -d
docker image prune -f >/dev/null
docker compose ps
