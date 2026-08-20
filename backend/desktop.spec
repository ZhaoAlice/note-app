# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata


backend_root = Path(SPECPATH)
datas = [
    (str(backend_root / "alembic"), "alembic"),
    (str(backend_root / "alembic.ini"), "."),
]
binaries = []
hiddenimports = [
    "pymysql",
    "psycopg",
    "sqlalchemy.dialects.mysql.pymysql",
    "sqlalchemy.dialects.postgresql.psycopg",
    "sqlalchemy.dialects.sqlite.pysqlite",
]
datas += collect_data_files("rapidocr")

rapidocr_optional_engines = (
    "rapidocr.inference_engine.mnn",
    "rapidocr.inference_engine.openvino",
    "rapidocr.inference_engine.paddle",
    "rapidocr.inference_engine.pytorch",
    "rapidocr.inference_engine.tensorrt",
)
hiddenimports += collect_submodules(
    "rapidocr",
    filter=lambda name: not name.startswith(rapidocr_optional_engines),
)
hiddenimports += collect_submodules(
    "alembic",
    filter=lambda name: not name.startswith("alembic.testing"),
)
for distribution in ("rapidocr", "onnxruntime", "opencv-python", "opencv-python-headless", "pypdfium2"):
    try:
        datas += copy_metadata(distribution)
    except Exception:
        pass

a = Analysis(
    [str(backend_root / "app" / "desktop_entry.py")],
    pathex=[str(backend_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "pytest",
        "httpx",
        "alembic.testing",
        "onnxruntime.quantization",
        "onnxruntime.tools",
        "onnxruntime.transformers",
        *rapidocr_optional_engines,
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ShijianBackend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="ShijianBackend",
)
