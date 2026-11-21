#!/bin/sh
set -e

# Only the API container migrates + seeds; the worker reuses the same image with RUN_MIGRATIONS=0.
if [ "${RUN_MIGRATIONS:-1}" = "1" ]; then
  alembic upgrade head
  python -m app.seed
fi

exec "$@"
