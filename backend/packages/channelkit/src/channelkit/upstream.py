"""업스트림 HTTP 클라이언트.

계정마다 토큰을 따로 캐시한다(`auth_key`). 401이 오면 그 계정만 한 번 다시 로그인한다.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import httpx

from .result import ToolError

LoginFn = Callable[[httpx.AsyncClient, Any], Awaitable[str]]
DEFAULT_KEY = "__default__"


class Upstream:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 20.0,
        headers: dict[str, str] | None = None,
        login: LoginFn | None = None,
    ) -> None:
        self._login = login
        self._tokens: dict[str, str] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            headers={"Accept": "application/json", **(headers or {})},
        )

    async def aclose(self) -> None:
        self._tokens.clear()
        await self._client.aclose()

    def forget(self, auth_key: str | None = None) -> None:
        self._tokens.pop(auth_key or DEFAULT_KEY, None)

    async def _access_token(
        self,
        auth_key: str | None,
        auth_context: Any,
        *,
        force: bool = False,
    ) -> str | None:
        if self._login is None:
            return None
        key = auth_key or DEFAULT_KEY
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            if force:
                self._tokens.pop(key, None)
            token = self._tokens.get(key)
            if not token:
                token = await self._login(self._client, auth_context)
                self._tokens[key] = token
            return token

    @staticmethod
    def _clean(params: dict[str, Any] | None) -> dict[str, Any]:
        return {key: value for key, value in (params or {}).items() if value not in (None, "")}

    @staticmethod
    def _payload(res: httpx.Response) -> Any:
        if not res.content:
            return None
        try:
            return res.json()
        except ValueError:
            return None

    async def _send(
        self,
        method: str,
        path: str,
        params: dict[str, Any],
        json: Any,
        token: str | None,
    ) -> httpx.Response:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            return await self._client.request(method, path, params=params, json=json, headers=headers)
        except httpx.TimeoutException as exc:
            raise ToolError("업스트림 응답이 시간을 초과했습니다.") from exc
        except httpx.HTTPError as exc:
            raise ToolError(f"업스트림에 연결할 수 없습니다: {exc}") from exc

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        auth_key: str | None = None,
        auth_context: Any = None,
    ) -> Any:
        query = self._clean(params)
        token = await self._access_token(auth_key, auth_context)
        res = await self._send(method, path, query, json, token)

        if res.status_code == 401 and self._login is not None:
            token = await self._access_token(auth_key, auth_context, force=True)
            res = await self._send(method, path, query, json, token)

        payload = self._payload(res)
        if res.status_code >= 400:
            detail = None
            if isinstance(payload, dict):
                detail = payload.get("detail") or payload.get("message")
            if not isinstance(detail, str):
                detail = f"업스트림 요청이 실패했습니다. (HTTP {res.status_code})"
            raise ToolError(detail)
        return payload

    async def get(
        self,
        path: str,
        params: dict[str, Any] | None = None,
        *,
        auth_key: str | None = None,
        auth_context: Any = None,
    ) -> Any:
        return await self.request("GET", path, params=params, auth_key=auth_key, auth_context=auth_context)

    async def post(
        self,
        path: str,
        json: Any = None,
        params: dict[str, Any] | None = None,
        *,
        auth_key: str | None = None,
        auth_context: Any = None,
    ) -> Any:
        return await self.request(
            "POST", path, params=params, json=json, auth_key=auth_key, auth_context=auth_context
        )
