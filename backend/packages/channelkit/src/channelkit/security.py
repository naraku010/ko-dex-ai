"""API 키 검증과 요청 사용자 파싱."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from urllib.parse import unquote

from fastapi import HTTPException, Request

DEFAULT_AUTH_HEADER = "X-Channel-Key"


@dataclass(frozen=True)
class RequestUser:
    """앱이 X-User-* 헤더로 알려준 사용자. 업스트림 권한 분기에 쓴다."""

    id: str
    name: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def parse_user(request: Request) -> RequestUser | None:
    user_id = (request.headers.get("X-User-Id") or "").strip()
    if not user_id:
        return None
    # 한글 이름은 헤더에 담을 수 없어서 앱이 퍼센트 인코딩해 보낸다.
    name = unquote(request.headers.get("X-User-Name") or "").strip()
    role = (request.headers.get("X-User-Role") or "").strip() or "manager"
    return RequestUser(id=user_id, name=name, role=role)


def check_api_key(request: Request, keys: frozenset[str], header: str) -> None:
    if not keys:
        return
    provided = (request.headers.get(header) or "").strip()
    if not provided or not any(secrets.compare_digest(provided, key) for key in keys):
        raise HTTPException(status_code=401, detail="API 키가 올바르지 않습니다.")
