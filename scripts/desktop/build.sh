#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
backend_dir="$repo_root/backend"
frontend_dir="$repo_root/frontend"
desktop_dir="$repo_root/desktop"
skip_install="${SKIP_INSTALL:-0}"

command -v uv >/dev/null 2>&1 || { echo 'uv was not found on PATH.' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo 'npm was not found on PATH.' >&2; exit 1; }
if [[ -z "${ELECTRON_MIRROR:-}" && "${CI:-}" != "true" ]]; then
  export ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
fi

if [[ "$skip_install" != "1" ]]; then
  npm --prefix "$frontend_dir" ci
  npm --prefix "$desktop_dir" ci
fi

npm --prefix "$frontend_dir" run build

(
  cd "$backend_dir"
  uv sync --extra test --extra desktop
  uv run --no-sync python -m app.book_ocr --prepare
  uv run --no-sync pyinstaller --clean --noconfirm desktop.spec
)

"$backend_dir/dist/ShijianBackend/ShijianBackend" --self-test

node "$script_dir/prepare-resources.mjs" \
  --sidecar "$backend_dir/dist/ShijianBackend" \
  --models "$backend_dir/data/ocr-models"

npm --prefix "$desktop_dir" run test
npm --prefix "$desktop_dir" run make
node "$script_dir/checksums.mjs"

echo "Desktop installers are available under $desktop_dir/out/make"
