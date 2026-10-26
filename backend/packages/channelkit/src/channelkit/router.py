"""채널 하나를 서비스하는 FastAPI 앱. 채널마다 자기 루트에 규격을 노출한다.

    GET  /channel.json        manifest
    POST /credentials/verify  사용자가 입력한 계정 정보 확인
    POST /tools/{name}        툴 실행
    GET  /downloads/{token}   툴이 만든 파일 내려받기
    GET  /health              상태 확인 (키 없이)
"""

from __future__ import annotations

import mimetypes
import os
import re
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from . import downloads
from .credentials import (
    CredentialField,
    Credentials,
    missing_required,
    parse_credentials,
    validate_fields,
)
from .manifest import CHANNEL_ICONS, CHANNEL_TYPES, build_manifest
from .registry import ToolRegistry
from .result import ToolError, ToolResult, error, ok
from .security import DEFAULT_AUTH_HEADER, check_api_key, parse_user
from .ui import validate_blocks

ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
Hook = Callable[[], Awaitable[None]]
VerifyFn = Callable[[Credentials], Awaitable[Any]]


def api_keys_from_env(env_name: str = "CHANNEL_API_KEYS") -> frozenset[str]:
    raw = os.getenv(env_name, "")
    return frozenset(part.strip() for part in raw.split(",") if part.strip())


def create_channel_app(
    *,
    id: str,
    name: str,
    short: str,
    description: str = "",
    version: str = "1.0.0",
    system_prompt: str = "",
    tools: ToolRegistry,
    credentials: list[CredentialField] | tuple[CredentialField, ...] = (),
    verify_credentials: VerifyFn | None = None,
    api_keys: frozenset[str] | set[str] | None = None,
    auth_header: str = DEFAULT_AUTH_HEADER,
    on_startup: Hook | None = None,
    on_shutdown: Hook | None = None,
    channel_type: str = "data",
    icon: str = "cog",
) -> FastAPI:
    if not ID_RE.match(id):
        raise ValueError(f"채널 id는 영문 소문자·숫자·하이픈 2~32자여야 합니다: {id}")
    if not tools.specs():
        raise ValueError("채널에 등록된 툴이 없습니다.")
    if channel_type not in CHANNEL_TYPES:
        raise ValueError(f"채널 type은 data 또는 files여야 합니다: {channel_type}")
    if icon not in CHANNEL_ICONS:
        raise ValueError(f"채널 icon이 허용 목록에 없습니다: {icon}")

    env_type = os.getenv("CHANNEL_TYPE", "").strip().lower()
    if env_type in CHANNEL_TYPES:
        channel_type = env_type
    keys = frozenset(api_keys) if api_keys is not None else api_keys_from_env()
    cred_fields = validate_fields(credentials)
    manifest = build_manifest(
        channel_id=id,
        name=name,
        short=short or name[:2],
        description=description,
        version=version,
        system_prompt=system_prompt.strip(),
        auth_type="apiKey" if keys else "none",
        auth_header=auth_header,
        tools=tools,
        credentials=cred_fields,
        channel_type=channel_type,
        icon=icon,
    )
    file_management = manifest["type"] == "files"

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if on_startup is not None:
            await on_startup()
        try:
            yield
        finally:
            if on_shutdown is not None:
                await on_shutdown()

    app = FastAPI(title=f"{name} 채널", version=version, lifespan=lifespan)
    app.state.manifest = manifest
    app.state.tools = tools

    if not keys:
        print(f"[{id}] CHANNEL_API_KEYS가 비어 있습니다. 인증 없이 열립니다.")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "channel": id,
            "version": version,
            "type": manifest["type"],
            "fileManagement": file_management,
            "tools": len(manifest["tools"]),
        }

    @app.get("/channel.json")
    async def channel_json(request: Request) -> dict[str, Any]:
        check_api_key(request, keys, auth_header)
        return manifest

    # 앱이 계정 정보를 저장하기 전에 여기로 한 번 확인한다.
    @app.post("/credentials/verify")
    async def verify(request: Request) -> Any:
        check_api_key(request, keys, auth_header)
        try:
            creds = parse_credentials(request)
            missing = missing_required(cred_fields, creds)
            if missing:
                labels = ", ".join(field.label for field in missing)
                return JSONResponse(
                    status_code=200, content=error(f"다음 항목을 입력해주세요: {labels}")
                )
            if verify_credentials is not None:
                detail = await verify_credentials(creds)
                return ok(detail if detail is not None else {"확인": "계정 정보가 유효합니다."})
            return ok({"확인": "계정 정보를 받았습니다."})
        except ToolError as exc:
            return JSONResponse(status_code=200, content=error(exc))
        except Exception as exc:
            print(f"[{id}] 계정 확인 실패: {exc!r}")
            return JSONResponse(status_code=200, content=error("계정 정보를 확인하는 중 오류가 발생했습니다."))

    @app.post("/tools/{tool_name}")
    async def run_tool(tool_name: str, request: Request) -> Any:
        check_api_key(request, keys, auth_header)

        if tools.get(tool_name) is None:
            return JSONResponse(status_code=404, content=error(f"{tool_name} 툴이 없습니다."))

        try:
            payload = await request.json()
        except ValueError:
            payload = {}
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            return JSONResponse(status_code=400, content=error("본문은 JSON object여야 합니다."))

        user = parse_user(request)
        try:
            creds = parse_credentials(request)
            # 계정 정보가 비어 있으면 툴을 부르지 않고 앱이 다시 물어보게 한다.
            missing = missing_required(cred_fields, creds)
            if missing:
                labels = ", ".join(field.label for field in missing)
                return JSONResponse(
                    status_code=200,
                    content={
                        **error(f"{name} 채널을 쓰려면 계정 정보({labels})가 필요합니다. 앱 설정 → 채널에서 입력해주세요."),
                        "needsCredentials": True,
                    },
                )
            result = await tools.call(tool_name, payload, user, creds)
            # 툴이 표시 지시를 함께 보냈으면 data와 나눠서 담는다. 앱은 ui만 그리고 AI는 data만 읽는다.
            if isinstance(result, ToolResult):
                body = ok(result.data)
                blocks = validate_blocks(result.ui)
                if blocks:
                    body["ui"] = blocks
                return body
            return ok(result)
        except ToolError as exc:
            return JSONResponse(status_code=200, content=error(exc))
        except HTTPException:
            raise
        except Exception as exc:  # 예상 못한 오류도 규격 형태로 돌려준다.
            print(f"[{id}] {tool_name} 실패: {exc!r}")
            return JSONResponse(status_code=200, content=error("툴 실행 중 오류가 발생했습니다."))

    @app.get("/downloads/{token}")
    async def download(token: str, request: Request) -> Any:
        check_api_key(request, keys, auth_header)
        found = downloads.resolve(token)
        if found is None:
            return JSONResponse(
                status_code=404, content=error("파일이 만료됐거나 없습니다. 툴을 다시 실행해주세요.")
            )
        path, filename = found
        media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        return FileResponse(path, filename=filename, media_type=media_type)

    return app
