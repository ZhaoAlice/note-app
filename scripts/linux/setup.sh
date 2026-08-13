#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
backend_dir="$repo_root/backend"
frontend_dir="$repo_root/frontend"

python_cmd=""
if command -v python3 >/dev/null 2>&1; then
  python_cmd="python3"
elif command -v python >/dev/null 2>&1; then
  python_cmd="python"
else
  echo 'Python was not found on PATH. Install Python 3.12 or newer.' >&2
  exit 1
fi

command -v npm >/dev/null 2>&1 || { echo 'npm was not found on PATH. Install Node.js 20 or newer.' >&2; exit 1; }
[[ -f "$backend_dir/pyproject.toml" ]] || { echo "Backend project file not found: $backend_dir/pyproject.toml" >&2; exit 1; }
[[ -f "$frontend_dir/package.json" ]] || { echo "Frontend package file not found: $frontend_dir/package.json" >&2; exit 1; }

if command -v uv >/dev/null 2>&1; then
  (cd "$backend_dir" && uv sync --extra test)
else
  backend_python="$backend_dir/.venv/bin/python"
  if [[ ! -x "$backend_python" ]]; then
    "$python_cmd" -m venv "$backend_dir/.venv"
  fi
  "$backend_python" -m pip install --upgrade pip
  (cd "$backend_dir" && "$backend_python" -m pip install -e '.[test]')
fi

npm --prefix "$frontend_dir" ci
echo 'Dependencies installed successfully.'
