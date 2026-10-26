"""빌드한 채널들을 OS별 설치 패키지로 묶는다.

Windows  egi-channels-<버전>-windows-x64.zip
         egi-channels-setup-<버전>-windows-x64.exe   (Inno Setup이 있을 때)
Linux    egi-channels-<버전>-linux-x64.tar.gz
         egi-channels-<버전>-linux-x64.run           (자동 설치 단일 파일)

패키지 안의 모양은 두 OS가 같다.

  egi-channels-<버전>-<os>-x64/
    VERSION
    README.txt
    install.* / uninstall.*
    channels/<채널>/<채널>-channel[.exe], _internal/, assets/, .env.example
    tools/nssm.exe                                    (Windows, 있을 때)
"""

from __future__ import annotations

import os
import platform
import shutil
import stat
import subprocess
import tarfile
import tomllib
import zipfile
from pathlib import Path

from .build import IS_WINDOWS

PRODUCT = "egi-channels"


def os_tag() -> str:
    return "windows" if IS_WINDOWS else "linux"


def arch_tag() -> str:
    machine = platform.machine().lower()
    if machine in {"amd64", "x86_64"}:
        return "x64"
    if machine in {"arm64", "aarch64"}:
        return "arm64"
    return machine or "unknown"


def project_version(root: Path) -> str:
    data = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    return str(data["project"]["version"])


def _package_dir(root: Path) -> Path:
    return root / "deploy" / os_tag() / "package"


def make_release(
    root: Path,
    channels: list[str],
    version: str,
    nssm: Path | None = None,
    iscc: str | None = None,
) -> list[Path]:
    """dist/<채널>-channel 폴더들을 모아 설치 패키지를 만든다. 만든 파일 목록을 돌려준다."""
    version = version.lstrip("v")
    base = f"{PRODUCT}-{version}-{os_tag()}-{arch_tag()}"
    out = root / "dist" / "release"
    stage = out / base
    if stage.exists():
        shutil.rmtree(stage)
    (stage / "channels").mkdir(parents=True)

    for name in channels:
        built = root / "dist" / f"{name}-channel"
        if not built.is_dir():
            raise FileNotFoundError(f"빌드 결과가 없습니다: {built}. 먼저 채널을 빌드하세요.")
        shutil.copytree(built, stage / "channels" / name)

    package = _package_dir(root)
    if not package.is_dir():
        raise FileNotFoundError(f"설치 스크립트 폴더가 없습니다: {package}")
    for path in package.iterdir():
        # 설치 마법사 스크립트와 .run 머리는 패키지 안에 넣지 않는다.
        if not path.is_file() or path.suffix == ".iss" or path.name == "run-header.sh":
            continue
        if path.suffix == ".sh":
            # Windows에서 체크아웃해 CRLF가 됐어도 bash가 읽게 LF로 맞춘다.
            (stage / path.name).write_bytes(path.read_bytes().replace(b"\r\n", b"\n"))
        else:
            shutil.copy2(path, stage / path.name)
    (stage / "VERSION").write_text(version + "\n", encoding="utf-8")

    if IS_WINDOWS:
        nssm = nssm or _find_nssm()
        if nssm:
            (stage / "tools").mkdir()
            shutil.copy2(nssm, stage / "tools" / "nssm.exe")
        else:
            print("경고: nssm.exe를 찾지 못해 패키지에 넣지 않았습니다. 설치하는 PC에 NSSM이 있어야 합니다.")
        return [_zip(stage, out), *_inno(root, stage, out, version, iscc)]

    for path in stage.glob("*.sh"):
        _chmod_x(path)
    archive = _tar(stage, out)
    return [archive, _run_file(root, archive, out / f"{base}.run")]


def _find_nssm() -> Path | None:
    found = shutil.which("nssm")
    if not found:
        return None
    path = Path(found).resolve()
    # chocolatey 심(shim)은 진짜 nssm이 아니라서 복사하면 다른 PC에서 안 돈다.
    if "chocolatey" in str(path).lower() and path.parent.name.lower() == "bin":
        return None
    return path


def _chmod_x(path: Path) -> None:
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _zip(stage: Path, out: Path) -> Path:
    target = out / f"{stage.name}.zip"
    target.unlink(missing_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(stage.rglob("*")):
            zf.write(path, Path(stage.name) / path.relative_to(stage))
    return target


def _tar(stage: Path, out: Path) -> Path:
    target = out / f"{stage.name}.tar.gz"
    target.unlink(missing_ok=True)
    with tarfile.open(target, "w:gz") as tf:
        tf.add(stage, arcname=stage.name)
    return target


def _run_file(root: Path, archive: Path, target: Path) -> Path:
    """sh 머리 + tar.gz 를 이어 붙여 혼자 풀리고 설치되는 파일을 만든다."""
    header = (root / "deploy" / "linux" / "package" / "run-header.sh").read_bytes()
    header = header.replace(b"\r\n", b"\n")
    if not header.endswith(b"\n"):
        header += b"\n"
    with target.open("wb") as fh:
        fh.write(header)
        fh.write(archive.read_bytes())
    _chmod_x(target)
    return target


def _find_iscc(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    found = shutil.which("iscc")
    if found:
        return found
    for env in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if not base:
            continue
        for sub in ("Inno Setup 6", r"Programs\Inno Setup 6"):
            candidate = Path(base) / sub / "ISCC.exe"
            if candidate.is_file():
                return str(candidate)
    return None


def _inno(root: Path, stage: Path, out: Path, version: str, iscc: str | None) -> list[Path]:
    compiler = _find_iscc(iscc)
    if not compiler:
        print("경고: Inno Setup(ISCC.exe)이 없어 setup.exe는 건너뜁니다. zip만 만들었습니다.")
        return []
    script = _package_dir(root) / "installer.iss"
    name = f"{PRODUCT}-setup-{version}-{os_tag()}-{arch_tag()}"
    subprocess.run(
        [
            compiler,
            "/Qp",
            f"/DAppVersion={version}",
            f"/DSourceDir={stage}",
            f"/DOutputDir={out}",
            f"/DOutputName={name}",
            str(script),
        ],
        check=True,
    )
    setup = out / f"{name}.exe"
    if not setup.is_file():
        raise RuntimeError(f"설치 파일이 만들어지지 않았습니다: {setup}")
    return [setup]
