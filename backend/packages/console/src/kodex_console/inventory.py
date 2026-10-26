from __future__ import annotations

from pathlib import Path
from typing import Any

from .paths import env_value, repo_root


def service_name(channel: str) -> str:
    return f"KodexChannel-{channel}"


def package_name(channel: str) -> str:
    return f"{channel}-channel"


def list_channels() -> list[dict[str, Any]]:
    root = repo_root()
    folder = root / "channels"
    if not folder.is_dir():
        return []

    seen_ports: dict[int, str] = {}
    items: list[dict[str, Any]] = []
    for path in sorted(folder.iterdir(), key=lambda p: p.name):
        if not path.is_dir() or not (path / "src").is_dir():
            continue
        env_file = path / ".env"
        port_raw = env_value(env_file, "PORT") if env_file.is_file() else ""
        keys = env_value(env_file, "CHANNEL_API_KEYS") if env_file.is_file() else ""
        skip = ""
        port = 0
        if not env_file.is_file():
            skip = ".env가 없습니다. example을 복사해 채워주세요."
        elif not port_raw:
            skip = "PORT가 없습니다. 채널마다 다른 포트를 지정해주세요."
        elif not port_raw.isdigit():
            skip = f"PORT가 숫자가 아닙니다: {port_raw}"
        elif not keys:
            skip = "CHANNEL_API_KEYS가 비어 있습니다."
        elif keys == "change-me":
            skip = "CHANNEL_API_KEYS가 예시값(change-me)입니다."
        if port_raw.isdigit():
            port = int(port_raw)
            other = seen_ports.get(port)
            if other:
                skip = skip or f"포트 {port}가 {other}와 겹칩니다."
            else:
                seen_ports[port] = path.name
        has_file_store = (path / "templates" / "manage.html").is_file()
        raw_type = env_value(env_file, "CHANNEL_TYPE").strip().lower() if env_file.is_file() else ""
        channel_type = raw_type if raw_type in {"data", "files"} else ("files" if has_file_store else "data")
        items.append(
            {
                "name": path.name,
                "dir": str(path),
                "env": env_file.is_file(),
                "port": port,
                "package": package_name(path.name),
                "service": service_name(path.name),
                "ready": not skip,
                "skip": skip,
                "hasKey": bool(keys) and keys != "change-me",
                "type": channel_type,
                "hasFileStore": has_file_store,
                "fileManagement": channel_type == "files" and has_file_store,
            }
        )
    return items


def get_channel(name: str) -> dict[str, Any]:
    wanted = name.strip().lower()
    for item in list_channels():
        if item["name"] == wanted:
            return item
    raise KeyError(f"채널 '{name}' 을 찾지 못했습니다.")


def deploy_script() -> Path:
    return repo_root() / "deploy" / "windows" / "deploy-channels.ps1"
