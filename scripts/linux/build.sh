#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
backend_dir="$repo_root/backend"
frontend_dir="$repo_root/frontend"
backend_python="$backend_dir/.venv/bin/python"

[[ -x "$backend_python" ]] || { echo 'Backend virtual environment was not found. Run ./scripts/linux/setup.sh first.' >&2; exit 1; }
(cd "$backend_dir" && "$backend_python" -m compileall -q app)
npm --prefix "$frontend_dir" run build
echo "Build complete: $frontend_dir/dist"
