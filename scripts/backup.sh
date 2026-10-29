#!/bin/sh
# Copy data/ (mod files and the PGlite database). Add a separate pg_dump for Postgres.
set -eu
cd "$(dirname "$0")/.."
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups
if [ -d data ]; then
  tar -czf "backups/data-$stamp.tgz" data
  echo "backups/data-$stamp.tgz"
else
  echo "data directory does not exist yet" >&2
  exit 1
fi
