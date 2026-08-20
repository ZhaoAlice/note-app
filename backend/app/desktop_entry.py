from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import threading


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="拾笺 desktop backend sidecar")
    parser.add_argument("--desktop", action="store_true")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token")
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--resource-dir", type=Path)
    parser.add_argument("--parent-pid", type=int)
    parser.add_argument("--allow-remote-migrations", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--ocr-job")
    parser.add_argument("--ocr-token")
    return parser


def _self_test() -> int:
    modules: dict[str, str] = {}
    for name in ("rapidocr", "onnxruntime", "cv2", "pypdfium2"):
        module = __import__(name)
        modules[name] = str(getattr(module, "__version__", "available"))
    from app.desktop_migrations import application_revision

    print(json.dumps({"status": "ok", "revision": application_revision(), "modules": modules}), flush=True)
    return 0


def _set_runtime_environment(args: argparse.Namespace) -> None:
    if not args.desktop:
        raise SystemExit("--desktop is required unless --self-test is used")
    if args.config is None or not args.config.is_file():
        raise SystemExit("--config must point to an existing YAML file")
    if not args.token or len(args.token) < 16:
        raise SystemExit("--token must contain at least 16 characters")
    config = args.config.expanduser().resolve()
    os.environ["NOTE_CONFIG_FILE"] = str(config)
    os.environ["NOTE_DESKTOP__ENABLED"] = "true"
    os.environ["NOTE_DESKTOP__TOKEN"] = args.token
    os.environ["NOTE_DESKTOP__CONFIG_PATH"] = str(config)
    if args.allow_remote_migrations:
        os.environ["NOTE_DESKTOP__ALLOW_REMOTE_MIGRATIONS"] = "true"
    if args.data_dir:
        os.environ["NOTE_DESKTOP__DATA_DIR"] = str(args.data_dir.expanduser().resolve())
    if args.resource_dir:
        resource_dir = args.resource_dir.expanduser().resolve()
        os.environ["NOTE_DESKTOP__RESOURCE_DIR"] = str(resource_dir)
        # Installed frontend/model assets always belong to this build. Never
        # let a discovered Web config redirect the sidecar back into a source
        # checkout or another installation.
        os.environ["NOTE_SERVER__FRONTEND_DIST"] = str(resource_dir / "frontend")
        os.environ["NOTE_OCR__MODEL_DIR"] = str(resource_dir / "ocr-models")
    if args.parent_pid:
        os.environ["NOTE_DESKTOP__PARENT_PID"] = str(args.parent_pid)


def _parent_exists(pid: int | None) -> bool:
    if pid is None:
        return True
    if os.name == "nt":
        # On Windows os.kill(pid, 0) maps to TerminateProcess rather than the
        # POSIX existence probe, so use a read-only process handle.
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            exit_code = wintypes.DWORD()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == 259
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


async def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    from app.config import get_settings
    from app.desktop_migrations import prepare_database

    settings = get_settings()
    prepare_database(
        settings,
        allow_remote_migrations=args.allow_remote_migrations
        or settings.desktop.allow_remote_migrations,
    )

    # Import only after the CLI has installed all NOTE_* environment overrides
    # and completed schema migration.
    from app.main import app

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", args.port))
    listener.listen(2048)
    listener.setblocking(False)
    port = listener.getsockname()[1]

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    server.install_signal_handlers = lambda: None
    serve_task = asyncio.create_task(server.serve(sockets=[listener]))

    while not server.started:
        if serve_task.done():
            await serve_task
            return 1
        await asyncio.sleep(0.01)
    print(json.dumps({"event": "ready", "port": port}, separators=(",", ":")), flush=True)

    stdin_closed = threading.Event()

    def watch_stdin() -> None:
        try:
            sys.stdin.buffer.read()
        finally:
            stdin_closed.set()

    threading.Thread(target=watch_stdin, name="desktop-stdin", daemon=True).start()
    while not serve_task.done():
        if stdin_closed.is_set() or not _parent_exists(args.parent_pid):
            server.should_exit = True
            break
        await asyncio.sleep(0.5)
    await serve_task
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.self_test:
        return _self_test()
    if args.ocr_job:
        if not args.ocr_token:
            raise SystemExit("--ocr-token is required with --ocr-job")
        from app.book_ocr import process_claimed_job

        return process_claimed_job(args.ocr_job, args.ocr_token)
    _set_runtime_environment(args)
    return asyncio.run(_serve(args))


if __name__ == "__main__":
    raise SystemExit(main())
