"""채널이 사용자에게 요구하는 계정 정보.

채널 서버에 공용 서비스 계정을 두지 않는다. 필요한 항목을 manifest로 선언하면
앱이 사용자에게 받아서 요청마다 헤더로 넘긴다.

    X-Channel-Credentials: base64(JSON)   예: {"user_id": "hong", "password": "..."}
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Any

from fastapi import Request

from .result import ToolError

HEADER = "X-Channel-Credentials"
KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
MAX_FIELDS = 6
MAX_VALUE_LENGTH = 512


@dataclass(frozen=True)
class CredentialField:
    """앱 설정 화면에 그려질 입력칸 하나."""

    key: str
    label: str
    secret: bool = True
    required: bool = True
    hint: str = ""

    def __post_init__(self) -> None:
        if not KEY_RE.match(self.key):
            raise ValueError(f"계정 항목 key는 영문 소문자·숫자·밑줄 1~32자여야 합니다: {self.key}")
        if not self.label.strip():
            raise ValueError(f"{self.key}: label은 비워둘 수 없습니다.")

    def to_manifest(self) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "key": self.key,
            "label": self.label.strip(),
            "secret": self.secret,
            "required": self.required,
        }
        if self.hint.strip():
            entry["hint"] = self.hint.strip()
        return entry


class Credentials(Mapping[str, str]):
    def __init__(self, values: Mapping[str, str] | None = None) -> None:
        self._values = {
            str(key): str(value)[:MAX_VALUE_LENGTH]
            for key, value in (values or {}).items()
            if str(value).strip() != ""
        }

    def __getitem__(self, key: str) -> str:
        return self._values[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)

    def get(self, key: str, default: str = "") -> str:  # type: ignore[override]
        return self._values.get(key, default)

    def require(self, key: str) -> str:
        value = self._values.get(key, "")
        if not value:
            raise ToolError(f"계정 정보({key})가 없습니다. 앱 설정 → 채널에서 입력해주세요.")
        return value

    def __repr__(self) -> str:  # 값이 로그에 찍히지 않게 키만 남긴다.
        return f"Credentials(keys={sorted(self._values)})"


def parse_credentials(request: Request) -> Credentials:
    raw = (request.headers.get(HEADER) or "").strip()
    if not raw:
        return Credentials()
    try:
        decoded = base64.b64decode(raw, validate=True).decode("utf-8")
        data = json.loads(decoded)
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise ToolError("계정 정보를 읽을 수 없습니다. 앱 설정 → 채널에서 다시 입력해주세요.") from exc
    if not isinstance(data, dict):
        raise ToolError("계정 정보 형식이 올바르지 않습니다.")
    return Credentials(data)


def validate_fields(fields: list[CredentialField] | tuple[CredentialField, ...]) -> tuple[CredentialField, ...]:
    if len(fields) > MAX_FIELDS:
        raise ValueError(f"계정 항목은 최대 {MAX_FIELDS}개까지 요구할 수 있습니다.")
    seen: set[str] = set()
    for field in fields:
        if field.key in seen:
            raise ValueError(f"계정 항목 key가 중복됩니다: {field.key}")
        seen.add(field.key)
    return tuple(fields)


def missing_required(
    fields: tuple[CredentialField, ...],
    credentials: Credentials,
) -> list[CredentialField]:
    return [field for field in fields if field.required and not credentials.get(field.key)]
