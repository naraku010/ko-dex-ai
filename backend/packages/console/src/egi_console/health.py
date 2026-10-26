from __future__ import annotations

from typing import Any

import httpx


def check_port(port: int, expect: str | None = None) -> dict[str, Any]:
    if not port:
        return {"ok": False, "error": "포트가 없습니다."}
    try:
        with httpx.Client(timeout=2.0) as client:
            res = client.get(f"http://127.0.0.1:{port}/health")
            payload = res.json() if "json" in res.headers.get("content-type", "") else {}
            if not res.is_success:
                return {"ok": False, "status": res.status_code, "error": f"HTTP {res.status_code}"}
            if payload.get("app") == "console":
                return {
                    "ok": False,
                    "error": f"{port}번은 관제 포트입니다. 채널 .env의 PORT를 다른 번호로 바꾸세요.",
                }
            got = str(payload.get("channel") or "")
            if expect and got and got != expect:
                return {"ok": False, "error": f"{port}번에 {got}가 떠 있습니다."}
            return {"ok": True, "status": res.status_code, "data": payload}
    except (httpx.ConnectError, ConnectionRefusedError):
        return {"ok": False, "error": f"{port}번이 닫혀 있습니다. 시작을 눌러 주세요."}
    except Exception as exc:
        text = str(exc)
        if "10061" in text or "Connection refused" in text:
            return {"ok": False, "error": f"{port}번이 닫혀 있습니다. 시작을 눌러 주세요."}
        return {"ok": False, "error": text}
