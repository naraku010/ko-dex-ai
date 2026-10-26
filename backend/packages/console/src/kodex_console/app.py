from __future__ import annotations

import hmac
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .deploy import run_update
from .gitops import GitError, fetch, history, pending_count, status
from .health import check_port
from .inventory import get_channel, list_channels
from .paths import set_env_value
from .services import restart_channel, runtime_of, start_channel, stop_channel

STATIC = Path(__file__).resolve().parent / "static"
BRANCH = os.getenv("CONSOLE_BRANCH", "master").strip() or "master"


def _ok(data: Any) -> dict[str, Any]:
    return {"ok": True, "data": data}


def create_app() -> FastAPI:
    app = FastAPI(title="KODEX 채널 관제", version="1.0.0")

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        if path == "/health" or path.startswith("/static"):
            return await call_next(request)
        if path in {"/", "/admin"}:
            return await call_next(request)
        token = os.getenv("CONSOLE_TOKEN", "").strip()
        host = (request.client.host if request.client else "") or ""
        local = host in {"127.0.0.1", "::1", "localhost", "testclient", ""}
        if token:
            provided = (request.headers.get("X-Console-Token") or request.query_params.get("token") or "").strip()
            if not provided:
                return JSONResponse(
                    {"ok": False, "error": "관제 토큰을 입력해주세요. packages/console/.env의 CONSOLE_TOKEN 값입니다."},
                    status_code=401,
                )
            if not hmac.compare_digest(provided, token):
                return JSONResponse({"ok": False, "error": "관제 토큰이 올바르지 않습니다."}, status_code=401)
        elif not local:
            return JSONResponse({"ok": False, "error": "CONSOLE_TOKEN을 설정해야 외부에서 열 수 있습니다."}, status_code=403)
        return await call_next(request)

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "app": "console"}

    @app.get("/api/state")
    def state() -> dict[str, Any]:
        channels = []
        for item in list_channels():
            runtime = runtime_of(item)
            probe = check_port(item["port"], expect=item["name"]) if item["port"] else {"ok": False, "error": "포트 없음"}
            live = probe.get("data") if isinstance(probe.get("data"), dict) else {}
            if probe.get("ok") and live.get("type") in {"data", "files"}:
                item = {
                    **item,
                    "type": live["type"],
                    "fileManagement": bool(live.get("fileManagement")) and item.get("hasFileStore"),
                }
            channels.append({**item, **runtime, "health": probe, "pending": pending_count(item["name"], BRANCH)})
        return _ok(
            {
                "git": status(BRANCH),
                "channels": channels,
                "branch": BRANCH,
                "tokenRequired": bool(os.getenv("CONSOLE_TOKEN", "").strip()),
            }
        )

    @app.post("/api/git/fetch")
    def git_fetch() -> dict[str, Any]:
        try:
            return _ok(fetch(BRANCH))
        except GitError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/update")
    def update(payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = payload or {}
        channel = str(body.get("channel") or "").strip() or None
        force = bool(body.get("force"))
        result = run_update(branch=BRANCH, channel=channel, force=force)
        return {"ok": result.get("ok", False), "data": result}

    @app.get("/api/channels/{name}/history")
    def channel_history(name: str, limit: int = 40) -> dict[str, Any]:
        try:
            channel = get_channel(name)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        try:
            return _ok(history(channel["name"], BRANCH, max(1, min(limit, 200))))
        except GitError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/channels/{name}/start")
    def start(name: str) -> dict[str, Any]:
        try:
            result = start_channel(name)
            if result.get("ok") is False:
                raise RuntimeError(result.get("error") or "시작에 실패했습니다.")
            return _ok(result)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/channels/{name}/stop")
    def stop(name: str) -> dict[str, Any]:
        try:
            return _ok(stop_channel(name))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/channels/{name}/restart")
    def restart(name: str) -> dict[str, Any]:
        try:
            result = restart_channel(name)
            if result.get("ok") is False:
                raise RuntimeError(result.get("error") or "재시작에 실패했습니다.")
            return _ok(result)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/channels/{name}/profile")
    def profile(name: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            channel = get_channel(name)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        body = payload or {}
        wanted = str(body.get("type") or "").strip().lower()
        if wanted not in {"data", "files"}:
            raise HTTPException(status_code=400, detail="type은 data 또는 files 여야 합니다.")
        if wanted == "files" and not channel.get("hasFileStore"):
            raise HTTPException(status_code=400, detail="이 채널은 문서함 관리 화면이 없어 files 타입을 켤 수 없습니다.")
        env_file = Path(channel["dir"]) / ".env"
        if not env_file.is_file():
            raise HTTPException(status_code=400, detail=".env가 없습니다.")
        set_env_value(env_file, "CHANNEL_TYPE", wanted)
        return _ok({"name": channel["name"], "type": wanted, "fileManagement": wanted == "files"})

    @app.get("/")
    @app.get("/admin")
    def home() -> FileResponse:
        return FileResponse(STATIC / "index.html")

    if STATIC.is_dir():
        app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


app = create_app()
