"""툴 등록기.

핸들러는 이렇게 쓴다. 인자 모델은 `args` 타입힌트에서 읽고, 요청 사용자는 `user`,
사용자가 앱에 입력한 계정 정보는 `creds`로 받는다. 셋 다 필요한 것만 쓰면 된다.

    @registry.tool(label="설비 현황 조회", description="...")
    async def get_equipment_status(args: DateArgs, user: RequestUser, creds: Credentials) -> Any:
        ...

블로킹 I/O(동기 DB 드라이버 등)를 쓰는 핸들러는 `def`로 선언한다. 스레드에서 실행된다.
"""

from __future__ import annotations

import asyncio
import inspect
import re
from dataclasses import dataclass
from typing import Any, Callable, get_type_hints

from pydantic import BaseModel, ValidationError

from .credentials import Credentials
from .result import ToolError
from .security import RequestUser

NAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,63}$")
RESERVED = frozenset({"whoami", "render_chart", "propose_followups"})
MAX_TOOLS = 64


@dataclass(frozen=True)
class ToolSpec:
    name: str
    label: str | None
    description: str
    args_model: type[BaseModel] | None
    handler: Callable[..., Any]
    wants_user: bool
    wants_creds: bool


def _format_validation_error(exc: ValidationError) -> str:
    parts = []
    for item in exc.errors():
        where = ".".join(str(piece) for piece in item.get("loc", ())) or "인자"
        # pydantic이 붙이는 "Value error, " 접두어는 떼고 우리 문구만 보여준다.
        message = str(item.get("msg", "값이 올바르지 않습니다")).removeprefix("Value error, ")
        parts.append(f"{where}: {message}")
    return "인자가 올바르지 않습니다. " + "; ".join(parts[:5])


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def tool(
        self,
        *,
        description: str,
        label: str | None = None,
        name: str | None = None,
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            tool_name = name or func.__name__
            if not NAME_RE.match(tool_name):
                raise ValueError(f"툴 이름이 규격에 맞지 않습니다: {tool_name} (영문 소문자·숫자·밑줄 3~64자)")
            if tool_name in RESERVED:
                raise ValueError(f"{tool_name}은 앱 내장 툴 이름입니다.")
            if tool_name in self._tools:
                raise ValueError(f"툴 이름이 중복됩니다: {tool_name}")
            if not description.strip():
                raise ValueError(f"{tool_name}: description은 비워둘 수 없습니다.")
            if len(self._tools) >= MAX_TOOLS:
                raise ValueError(f"툴은 최대 {MAX_TOOLS}개까지 등록할 수 있습니다.")

            params = inspect.signature(func).parameters
            hints = get_type_hints(func)

            args_model: type[BaseModel] | None = None
            if "args" in params:
                hint = hints.get("args")
                if not (isinstance(hint, type) and issubclass(hint, BaseModel)):
                    raise ValueError(f"{tool_name}: args 인자는 pydantic BaseModel로 타입힌트해야 합니다.")
                args_model = hint

            unknown = set(params) - {"args", "user", "creds"}
            if unknown:
                raise ValueError(
                    f"{tool_name}: 쓸 수 없는 인자입니다 {sorted(unknown)}. args, user, creds만 받습니다."
                )

            self._tools[tool_name] = ToolSpec(
                name=tool_name,
                label=label,
                description=description.strip(),
                args_model=args_model,
                handler=func,
                wants_user="user" in params,
                wants_creds="creds" in params,
            )
            return func

        return decorator

    def specs(self) -> list[ToolSpec]:
        return list(self._tools.values())

    def get(self, name: str) -> ToolSpec | None:
        return self._tools.get(name)

    async def call(
        self,
        name: str,
        payload: Any,
        user: RequestUser | None,
        credentials: Credentials | None = None,
    ) -> Any:
        spec = self.get(name)
        if spec is None:
            raise KeyError(name)

        kwargs: dict[str, Any] = {}
        if spec.args_model is not None:
            try:
                kwargs["args"] = spec.args_model.model_validate(payload or {})
            except ValidationError as exc:
                raise ToolError(_format_validation_error(exc)) from exc
        if spec.wants_user:
            kwargs["user"] = user
        if spec.wants_creds:
            kwargs["creds"] = credentials if credentials is not None else Credentials()

        # 동기 핸들러(DB 드라이버 등 블로킹 호출)는 스레드에서 돌려 이벤트 루프를 막지 않는다.
        if inspect.iscoroutinefunction(spec.handler):
            return await spec.handler(**kwargs)
        result = await asyncio.to_thread(spec.handler, **kwargs)
        if inspect.isawaitable(result):
            result = await result
        return result
