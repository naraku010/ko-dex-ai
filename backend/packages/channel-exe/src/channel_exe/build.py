"""PyInstaller로 채널 하나를 onedir 실행 파일로 묶는다. 빌드한 OS용으로 나온다 (Windows exe, Linux ELF)."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

COLLECT = (
    "channelkit",
    "fastapi",
    "starlette",
    "uvicorn",
    "pydantic",
    "pydantic_core",
    "anyio",
    "dotenv",
    "httpx",
)

HIDDEN = (
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
)

# 채널별로 PyInstaller가 놓치는 라이브러리. 예: "erp": ("pymssql",)
EXTRA: dict[str, tuple[str, ...]] = {}

HIDDEN_EXTRA: dict[str, tuple[str, ...]] = {}

# exe 옆에 그대로 두는 채널 폴더. 채널 코드가 parents[2] 기준으로 찾는다.
SIDE_DIRS = ("templates", "assets")

IS_WINDOWS = os.name == "nt"
EXE_SUFFIX = ".exe" if IS_WINDOWS else ""


def _can_import(name: str) -> bool:
    try:
        __import__(name)
    except ImportError:
        return False
    return True


def repo_root(explicit: Path | None = None) -> Path:
    if explicit:
        root = explicit.resolve()
        if not (root / "channels").is_dir():
            raise FileNotFoundError(f"channels 폴더가 없습니다: {root / 'channels'}")
        return root
    here = Path(__file__).resolve()
    for path in (here, *here.parents):
        if (path / "channels").is_dir() and (path / "packages").is_dir():
            return path
    raise FileNotFoundError("저장소 루트를 찾지 못했습니다. --root 를 주세요.")


def list_channels(root: Path) -> list[str]:
    names = sorted(
        path.name
        for path in (root / "channels").iterdir()
        if path.is_dir() and (path / "src").is_dir()
    )
    if not names:
        raise FileNotFoundError(f"채널이 없습니다: {root / 'channels'}")
    return names


def _data_arg(src: Path, dest: str) -> str:
    sep = ";" if os.name == "nt" else ":"
    return f"{src}{sep}{dest}"


def build_channel(root: Path, channel: str) -> Path:
    name = channel.strip().lower()
    if not name:
        raise ValueError("채널 이름이 비어 있습니다.")
    channel_dir = root / "channels" / name
    src = channel_dir / "src"
    if not src.is_dir():
        raise FileNotFoundError(f"채널 폴더가 없습니다: {channel_dir}")

    missing = [mod for mod in EXTRA.get(name, ()) if not _can_import(mod)]
    if missing:
        raise RuntimeError(
            f"{name} 빌드에 필요한 패키지가 없습니다: {', '.join(missing)}. "
            "저장소 루트에서 uv sync --all-packages 를 실행하세요."
        )

    pkg = f"{name}_channel"
    exe_name = f"{name}-channel"
    work = root / "build" / "pyi" / name
    dist = root / "dist"
    work.mkdir(parents=True, exist_ok=True)
    entry = work / "_entry.py"
    entry.write_text(
        f"from {pkg}.main import run\n\nif __name__ == '__main__':\n    run()\n",
        encoding="utf-8",
    )

    args: list[str] = [
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        exe_name,
        "--distpath",
        str(dist),
        "--workpath",
        str(work),
        "--specpath",
        str(work),
        "--paths",
        str(src),
        "--paths",
        str(root / "packages" / "channelkit" / "src"),
        "--exclude-module",
        "tkinter",
        "--exclude-module",
        "matplotlib",
        "--exclude-module",
        "numpy",
        "--exclude-module",
        "pandas",
    ]
    if IS_WINDOWS:
        # 서비스로 돌 때 콘솔 창을 띄우지 않는다. Linux에는 해당 없음.
        args.append("--noconsole")
    templates = channel_dir / "templates"
    if templates.is_dir():
        args.extend(("--add-data", _data_arg(templates, "templates")))
    for lib in (*COLLECT, *EXTRA.get(name, ())):
        args.extend(("--collect-all", lib))
    args.extend(("--collect-submodules", pkg))
    for hidden in (*HIDDEN, *HIDDEN_EXTRA.get(name, ())):
        args.extend(("--hidden-import", hidden))
    args.append(str(entry))

    from PyInstaller.__main__ import run as pyi_run

    pyi_run(args)

    exe = dist / exe_name / f"{exe_name}{EXE_SUFFIX}"
    if not exe.is_file():
        raise RuntimeError(f"실행 파일이 만들어지지 않았습니다: {exe}")
    for lib in EXTRA.get(name, ()):
        if not any(exe.parent.rglob(f"*{lib}*")):
            raise RuntimeError(f"exe에 {lib} 가 안 들어갔습니다. uv sync --all-packages 후 다시 빌드하세요.")
    _copy_side_files(channel_dir, exe.parent)
    return exe


def _copy_side_files(channel_dir: Path, exe_dir: Path) -> None:
    """templates·assets 폴더와 .env.example 을 exe 옆에 둔다."""
    for name in SIDE_DIRS:
        src = channel_dir / name
        if not src.is_dir():
            continue
        if not any(path.is_file() for path in src.rglob("*")):
            raise RuntimeError(f"{name} 폴더가 비어 있습니다: {src}")
        shutil.copytree(src, exe_dir / name, dirs_exist_ok=True)
    example = channel_dir / ".env.example"
    if example.is_file():
        shutil.copy2(example, exe_dir / ".env.example")
