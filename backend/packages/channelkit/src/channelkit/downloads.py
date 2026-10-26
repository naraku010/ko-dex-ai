"""툴이 만든 파일을 앱이 내려받게 한다.

채널 서버의 경로는 사용자 PC에서 열 수 없다. 툴은 파일을 만든 뒤 publish_file로 등록하고
돌려받은 블록을 ui에 싣는다. 앱은 GET /downloads/{token}으로 받아 사용자 PC에 저장한다.

    dest = make_report(...)
    return ToolResult(data={"파일": dest.name}, ui=[publish_file(dest)])
"""

from __future__ import annotations

import secrets
import threading
import time
from pathlib import Path
from typing import Any

TTL_SECONDS = 24 * 3600
MAX_ENTRIES = 500

_lock = threading.Lock()
_entries: dict[str, tuple[Path, str, float]] = {}


def _prune(now: float) -> None:
    for token in [key for key, (_, _, expires) in _entries.items() if expires <= now]:
        del _entries[token]
    while len(_entries) >= MAX_ENTRIES:
        del _entries[min(_entries, key=lambda key: _entries[key][2])]


def publish_file(path: str | Path, name: str | None = None) -> dict[str, Any]:
    """파일을 내려받기 목록에 올리고 ui file 블록을 돌려준다. 토큰은 TTL_SECONDS 동안 유효하다."""
    target = Path(path).resolve()
    if not target.is_file():
        raise ValueError(f"내려보낼 파일이 없습니다: {target.name}")
    filename = (name or target.name).strip() or target.name
    token = secrets.token_urlsafe(24)
    now = time.time()
    with _lock:
        _prune(now)
        _entries[token] = (target, filename, now + TTL_SECONDS)
    return {"type": "file", "name": filename, "token": token, "size": target.stat().st_size}


def resolve(token: str) -> tuple[Path, str] | None:
    now = time.time()
    with _lock:
        entry = _entries.get(token)
        if entry is None or entry[2] <= now:
            _entries.pop(token, None)
            return None
    path, name, _ = entry
    return (path, name) if path.is_file() else None
