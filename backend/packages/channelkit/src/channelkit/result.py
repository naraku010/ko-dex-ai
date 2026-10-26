"""툴 응답 형태. 규격은 {"ok": true, "data": ...} 또는 {"ok": false, "error": "..."}."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class ToolError(Exception):
    """사용자에게 그대로 보여줄 오류. 앱 대화창에 이 문구가 나온다."""


@dataclass
class ToolResult:
    """표시 지시를 함께 보내야 할 때 툴이 반환하는 형태.

    data는 AI가 읽는 값이고 ui는 앱이 그리는 값이다. ui가 필요 없으면 그냥 dict를 반환하면 된다.
    """

    data: Any
    ui: list[dict[str, Any]] = field(default_factory=list)


def ok(data: Any) -> dict[str, Any]:
    return {"ok": True, "data": data}


def error(message: object) -> dict[str, Any]:
    return {"ok": False, "error": str(message)}
