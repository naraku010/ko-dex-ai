from __future__ import annotations

import subprocess
from typing import Any

from .inventory import get_channel
from .procs import local_pid, start_local, stop_local


def _sc_query(name: str) -> str | None:
    result = subprocess.run(
        ["sc", "query", name],
        capture_output=True,
        text=True,
        encoding="oem",
        errors="replace",
    )
    text = f"{result.stdout}\n{result.stderr}"
    if result.returncode != 0 or "1060" in text or "존재하지" in text or "does not exist" in text.lower():
        return None
    if "RUNNING" in text:
        return "running"
    if "START_PENDING" in text:
        return "starting"
    if "STOP_PENDING" in text:
        return "stopping"
    if "STOPPED" in text:
        return "stopped"
    return "unknown"


def _ps_service(action: str, name: str) -> None:
    cmd = {
        "start": f"Start-Service -Name '{name}'",
        "stop": f"Stop-Service -Name '{name}' -Force",
        "restart": f"Restart-Service -Name '{name}' -Force",
    }[action]
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", cmd],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip() or f"{action} 실패"
        raise RuntimeError(err)


def service_state(name: str) -> str | None:
    return _sc_query(name)


def start_channel(name: str) -> dict[str, Any]:
    channel = get_channel(name)
    if not channel["ready"]:
        raise RuntimeError(channel["skip"] or "채널 설정이 끝나지 않았습니다.")
    svc = channel["service"]
    state = service_state(svc)
    if state == "running":
        return {"ok": True, "via": "service", "state": state}
    if state is not None:
        _ps_service("start", svc)
        return {"ok": True, "via": "service", "state": service_state(svc)}
    return start_local(channel["name"])


def stop_channel(name: str) -> dict[str, Any]:
    channel = get_channel(name)
    svc = channel["service"]
    state = service_state(svc)
    if state is not None:
        if state != "stopped":
            _ps_service("stop", svc)
        return {"ok": True, "via": "service", "state": service_state(svc)}
    return stop_local(channel["name"])


def restart_channel(name: str) -> dict[str, Any]:
    channel = get_channel(name)
    svc = channel["service"]
    state = service_state(svc)
    if state is not None:
        _ps_service("restart", svc)
        return {"ok": True, "via": "service", "state": service_state(svc)}
    stop_local(channel["name"])
    return start_local(channel["name"])


def runtime_of(channel: dict[str, Any]) -> dict[str, Any]:
    try:
        svc = service_state(channel["service"])
    except OSError:
        svc = None
    try:
        pid = local_pid(channel["name"])
    except (OSError, SystemError):
        pid = None
    if svc:
        mode = "service"
        running = svc == "running"
    elif pid:
        mode = "local"
        running = True
    else:
        mode = "off"
        running = False
    return {"service": svc, "pid": pid, "mode": mode, "running": running}
