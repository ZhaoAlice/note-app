#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
backend_dir="$repo_root/backend"
frontend_dir="$repo_root/frontend"
backend_python="$backend_dir/.venv/bin/python"

[[ -x "$backend_python" ]] || { echo 'Backend virtual environment was not found. Run ./scripts/linux/setup.sh first.' >&2; exit 1; }

(cd "$backend_dir" && env -u NOTE_TEST_DATABASE_URL -u NOTE_DATABASE__URL "$backend_python" -m pytest)

for database_name in MySQL PostgreSQL; do
  if [[ "$database_name" == 'MySQL' ]]; then
    database_url="${TEST_MYSQL_URL:-}"
  else
    database_url="${TEST_POSTGRESQL_URL:-}"
  fi
  [[ -n "$database_url" ]] || continue
  echo "Running backend tests against $database_name..."
  (cd "$backend_dir" && NOTE_TEST_DATABASE_URL="$database_url" NOTE_DATABASE__URL="$database_url" "$backend_python" -m pytest)
done

npm --prefix "$frontend_dir" test -- --run
echo 'All tests passed.'
