"""저장소 루트에서 채널 하나를 띄운다.

  uv run kodex-channel
  uv run kodex-channel shop
"""

from __future__ import annotations

import argparse
import importlib
import os
import shutil
import sys
from pathlib import Path


def repo_root() -> Path:
    here = Path(__file__).resolve()
    for path in (here, *here.parents):
        if (path / "channels").is_dir() and (path / "packages").is_dir():
            return path
    raise FileNotFoundError("저장소 루트를 찾지 못했습니다.")


def list_channels(root: Path) -> list[Path]:
    folder = root / "channels"
    return sorted(
        path
        for path in folder.iterdir()
        if path.is_dir() and (path / "src").is_dir()
    )


def _port(channel_dir: Path) -> str:
    env = channel_dir / ".env"
    if not env.is_file():
        return ""
    for line in env.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if raw.startswith("PORT=") and not raw.startswith("PORT=#"):
            return raw.split("=", 1)[1].strip()
    return ""


def print_list(root: Path) -> int:
    channels = list_channels(root)
    if not channels:
        print("channels/ 아래에 채널이 없습니다.", file=sys.stderr)
        return 1
    print("채널")
    for path in channels:
        port = _port(path)
        extra = f"  :{port}" if port else ""
        print(f"  {path.name}{extra}")
    print("예: uv run kodex-channel shop")
    return 0


def ensure_env(channel_dir: Path) -> None:
    env = channel_dir / ".env"
    example = channel_dir / ".env.example"
    if env.is_file() or not example.is_file():
        return
    shutil.copy(example, env)
    print(f".env를 만들었습니다: {env}")


def run_channel(root: Path, name: str) -> int:
    wanted = name.strip().lower()
    channel_dir = root / "channels" / wanted
    if not channel_dir.is_dir() or not (channel_dir / "src").is_dir():
        names = ", ".join(path.name for path in list_channels(root)) or "(없음)"
        print(f"채널이 없습니다: {wanted}. 있는 채널: {names}", file=sys.stderr)
        return 1
    ensure_env(channel_dir)
    os.chdir(channel_dir)
    try:
        module = importlib.import_module(f"{wanted}_channel.main")
    except ModuleNotFoundError as exc:
        print(f"{wanted} 패키지를 불러오지 못했습니다: {exc}", file=sys.stderr)
        return 1
    run = getattr(module, "run", None)
    if not callable(run):
        print(f"{wanted}_channel.main.run 이 없습니다.", file=sys.stderr)
        return 1
    run()
    return 0


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="kodex 채널을 하나 띄웁니다.")
    parser.add_argument("channel", nargs="?", help="channels 아래 폴더 이름. 예: shop")
    args = parser.parse_args(argv)
    try:
        root = repo_root()
    except FileNotFoundError as exc:
        print(exc, file=sys.stderr)
        return 1
    if not args.channel:
        return print_list(root)
    return run_channel(root, args.channel)


if __name__ == "__main__":
    raise SystemExit(main())
