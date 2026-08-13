#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
backend_dir="$repo_root/backend"
frontend_dir="$repo_root/frontend"
backend_python="$backend_dir/.venv/bin/python"

[[ -x "$backend_python" ]] || { echo 'Backend virtual environment was not found. Run ./scripts/linux/setup.sh first.' >&2; exit 1; }
(cd "$backend_dir" && "$backend_python" -m alembic upgrade head)

backend_pid=""
frontend_pid=""
cleanup() {
  [[ -n "$backend_pid" ]] && kill "$backend_pid" 2>/dev/null || true
  [[ -n "$frontend_pid" ]] && kill "$frontend_pid" 2>/dev/null || true
  wait "$backend_pid" "$frontend_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(cd "$backend_dir" && exec "$backend_python" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000) &
backend_pid=$!
(cd "$frontend_dir" && exec npm run dev -- --host 127.0.0.1) &
frontend_pid=$!

echo 'Frontend: http://localhost:5173'
echo 'Backend:  http://localhost:8000'
echo 'Press Ctrl+C to stop both processes.'

set +e
wait -n "$backend_pid" "$frontend_pid"
status=$?
set -e
exit "$status"
