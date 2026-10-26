"""저장소 루트에서 채널 실행 파일과 설치 패키지를 만든다. 빌드한 OS용으로 나온다.

  uv run --package channel-exe channel-exe shop
  uv run --package channel-exe channel-exe --all
  uv run --package channel-exe channel-exe --all --release --version 1.0.0
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from .build import build_channel, list_channels, repo_root
from .release import make_release, project_version


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="egi 채널을 실행 파일로 묶습니다 (Windows exe / Linux 바이너리).")
    parser.add_argument("channel", nargs="?", help="channels 아래 폴더 이름. 예: shop")
    parser.add_argument("--all", action="store_true", help="channels 아래 채널을 모두 묶습니다.")
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="저장소 루트. 비우면 channels/ 가 있는 위치를 찾습니다.",
    )
    parser.add_argument(
        "--release",
        action="store_true",
        help="빌드한 채널을 설치 패키지로 묶습니다 (Windows: zip + setup.exe, Linux: tar.gz + .run).",
    )
    parser.add_argument("--version", default=None, help="패키지 버전. 비우면 루트 pyproject.toml 버전.")
    parser.add_argument("--nssm", type=Path, default=None, help="Windows 패키지에 넣을 nssm.exe 경로.")
    parser.add_argument("--iscc", default=None, help="Inno Setup 컴파일러(ISCC.exe) 경로.")
    args = parser.parse_args(argv)

    try:
        root = repo_root(args.root)
        names = list_channels(root) if args.all else [args.channel]
        if not names or names == [None]:
            parser.error("채널 이름을 주거나 --all 을 쓰세요.")
        names = [str(name).strip().lower() for name in names]
        last = None
        for name in names:
            last = build_channel(root, name)
            print(f"완료: {last}")
        if args.release:
            version = args.version or project_version(root)
            for path in make_release(root, names, version, nssm=args.nssm, iscc=args.iscc):
                print(f"패키지: {path}")
        elif last:
            print(f"서버에 올릴 때: {last.parent} 폴더와 .env 를 같이 복사합니다.")
    except (FileNotFoundError, RuntimeError, ValueError, subprocess.CalledProcessError) as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
