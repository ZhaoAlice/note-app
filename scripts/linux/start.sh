#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
backend_dir="$repo_root/backend"
frontend_dist="$repo_root/frontend/dist"
backend_python="$backend_dir/.venv/bin/python"

[[ -d "$frontend_dist" ]] || { echo 'frontend/dist was not found. Run ./scripts/linux/build.sh first.' >&2; exit 1; }
[[ -x "$backend_python" ]] || { echo 'Backend virtual environment was not found. Run ./scripts/linux/setup.sh first.' >&2; exit 1; }

cd "$backend_dir"
"$backend_python" -m alembic upgrade head
exec "$backend_python" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 "$@"
