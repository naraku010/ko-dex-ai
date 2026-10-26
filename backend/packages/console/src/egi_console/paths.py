from __future__ import annotations

import os
from pathlib import Path


def repo_root() -> Path:
    explicit = os.getenv("EGI_ROOT", "").strip()
    if explicit:
        return Path(explicit).resolve()
    here = Path(__file__).resolve()
    for path in (here, *here.parents):
        if (path / "channels").is_dir() and (path / "packages").is_dir():
            return path
    raise FileNotFoundError("저장소 루트를 찾지 못했습니다. EGI_ROOT를 지정해주세요.")


def set_env_value(path: Path, key: str, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    prefix = f"{key}="
    replaced = False
    out: list[str] = []
    for raw in lines:
        stripped = raw.split("#", 1)[0].strip()
        if stripped.startswith(prefix):
            out.append(f"{key}={value}")
            replaced = True
        else:
            out.append(raw)
    if not replaced:
        if out and out[-1].strip():
            out.append("")
        out.append(f"{key}={value}")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def env_value(path: Path, key: str) -> str:
    if not path.is_file():
        return ""
    prefix = f"{key}="
    last = ""
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line.startswith(prefix):
            continue
        last = line[len(prefix) :].strip().strip('"').strip("'")
    return last
