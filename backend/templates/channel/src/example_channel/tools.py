"""이 채널이 제공하는 툴. 인자 모델이 그대로 manifest의 inputSchema가 된다."""

from __future__ import annotations

from typing import Any, Literal

from channelkit import RequestUser, ToolRegistry
from pydantic import BaseModel, Field

registry = ToolRegistry()


class SearchArgs(BaseModel):
    keyword: str = Field(description="찾을 단어")
    scope: Literal["all", "mine"] | None = Field(default=None, description="범위 (기본 all)")


@registry.tool(label="예시 조회", description="예시 데이터를 조회한다. 무엇을 언제 기준으로 주는지 여기에 자세히 적는다.")
async def search_example(args: SearchArgs, user: RequestUser) -> Any:
    return {
        "요청자": user.name if user else "알 수 없음",
        "검색어": args.keyword,
        "범위": args.scope or "all",
        "결과": [],
    }
