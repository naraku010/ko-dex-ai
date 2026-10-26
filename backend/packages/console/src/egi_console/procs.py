from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

from .health import check_port
from .inventory import package_name
from .paths import repo_root

CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000


def _store() -> Path:
    path = repo_root() / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path / "console-procs.json"


def _load() -> dict[str, int]:
    path = _store()
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict[str, int] = {}
    if isinstance(raw, dict):
        for key, value in raw.items():
            try:
                out[str(key)] = int(value)
            except (TypeError, ValueError):
                continue
    return out


def _save(data: dict[str, int]) -> None:
    _store().write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, int(pid))
        if handle:
            kernel32.CloseHandle(handle)
            return True
        # 5 = Access Denied → 프로세스는 있음
        return kernel32.GetLastError() == 5
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def local_pid(name: str) -> int | None:
    pid = _load().get(name)
    if pid and _alive(pid):
        return pid
    if pid:
        forget(name)
    return None


def remember(name: str, pid: int) -> None:
    data = _load()
    data[name] = pid
    _save(data)


def forget(name: str) -> None:
    data = _load()
    data.pop(name, None)
    _save(data)


# 채널 exe에 꼭 들어 있어야 하는 라이브러리. 빠지면 venv 실행으로 대신한다. 예: "erp": "pymssql"
_DIST_MUST_HAVE: dict[str, str] = {}


def _standalone_ready(name: str, exe: Path) -> bool:
    marker = _DIST_MUST_HAVE.get(name)
    if not marker:
        return True
    return (exe.parent / "_internal" / marker).exists()


def _launch_cmd(name: str) -> tuple[list[str], str, Path]:
    root = repo_root()
    channel_dir = _channel_dir(name)
    pkg = package_name(name)
    standalone = root / "dist" / pkg / f"{pkg}.exe"
    # 콘솔용 venv 런처(python.exe)는 창이 뜬다. dist(noconsole)나 pythonw만 쓴다.
    if standalone.is_file() and _standalone_ready(name, standalone):
        workdir = standalone.parent if (standalone.parent / ".env").is_file() else channel_dir
        return [str(standalone)], str(standalone), workdir
    pythonw = root / ".venv" / "Scripts" / "pythonw.exe"
    if pythonw.is_file():
        return [str(pythonw), "-m", f"{name}_channel.main"], "pythonw", channel_dir
    raise RuntimeError("창 없이 켤 pythonw.exe 가 없습니다. uv sync --all-packages 를 실행하세요.")


def _channel_dir(name: str) -> Path:
    return repo_root() / "channels" / name


def _read_dotenv(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.split("#", 1)[0].strip().strip('"').strip("'")
        if key:
            out[key] = value
    return out


def _child_env(name: str, workdir: Path) -> dict[str, str]:
    env = os.environ.copy()
    # 관제가 PORT=12000을 들고 있으면 채널이 같은 포트를 쓰려다 바로 죽는다.
    for key in ("PORT", "HOST", "CHANNEL_API_KEYS", "CONSOLE_TOKEN", "RELOAD"):
        env.pop(key, None)
    merged: dict[str, str] = {}
    merged.update(_read_dotenv(_channel_dir(name) / ".env"))
    merged.update(_read_dotenv(workdir / ".env"))
    env.update(merged)
    env["EGI_ROOT"] = str(repo_root())
    return env


def _port_of(name: str, env: dict[str, str]) -> int:
    raw = env.get("PORT", "")
    return int(raw) if raw.isdigit() else 0


def _listening(name: str, port: int) -> bool:
    if not port:
        return False
    return bool(check_port(port, expect=name).get("ok"))


def start_local(name: str) -> dict[str, Any]:
    root = repo_root()
    cmd, via, workdir = _launch_cmd(name)
    env = _child_env(name, workdir)
    port = _port_of(name, env)
    existing = local_pid(name)
    if existing and _listening(name, port):
        return {"ok": True, "pid": existing, "via": "already"}
    if existing:
        stop_local(name)

    log = root / "logs" / f"{name}.out.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    out = open(log, "ab", buffering=0)

    flags = 0
    startup = None
    if os.name == "nt":
        flags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = 0
    proc = subprocess.Popen(
        cmd,
        cwd=str(workdir),
        env=env,
        stdout=out,
        stderr=out,
        stdin=subprocess.DEVNULL,
        creationflags=flags,
        startupinfo=startup,
        start_new_session=os.name != "nt",
    )
    remember(name, proc.pid)

    if port:
        for _ in range(12):
            time.sleep(0.5)
            if _listening(name, port):
                return {"ok": True, "pid": proc.pid, "via": via, "port": port}
        tail = ""
        try:
            tail = log.read_text(encoding="utf-8", errors="replace")[-800:]
        except OSError:
            pass
        return {
            "ok": False,
            "pid": proc.pid,
            "via": via,
            "error": f"{port}번에 안 붙습니다. logs/{name}.out.log 를 보세요.",
            "log": tail,
        }
    return {"ok": True, "pid": proc.pid, "via": via}


def stop_local(name: str) -> dict[str, Any]:
    pid = local_pid(name)
    if not pid:
        forget(name)
        return {"ok": True, "pid": None}
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                check=False,
            )
        else:
            os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    forget(name)
    return {"ok": True, "pid": pid}
