from __future__ import annotations

import os
import subprocess
from typing import Any

from .gitops import GitError, fetch, status
from .inventory import deploy_script
from .paths import repo_root
from .services import restart_channel


def _is_admin() -> bool:
    if os.name != "nt":
        return False
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def run_update(*, branch: str = "master", channel: str | None = None, force: bool = False) -> dict[str, Any]:
    script = deploy_script()
    root = repo_root()
    before = status(branch)
    if script.is_file() and _is_admin():
        args = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            "-Root",
            str(root),
            "-Branch",
            branch,
        ]
        if channel:
            args.extend(["-Channel", channel])
        if force:
            args.append("-Force")
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        result = subprocess.run(
            args,
            cwd=str(root),
            capture_output=True,
            timeout=15 * 60,
            env=env,
        )

        def _decode(raw: bytes | None) -> str:
            data = raw or b""
            for enc in ("utf-8", "cp949", "oem"):
                try:
                    text = data.decode(enc)
                except UnicodeDecodeError:
                    continue
                if "�" not in text:
                    return text
            return data.decode("utf-8", errors="replace")

        log = (_decode(result.stdout) + "\n" + _decode(result.stderr)).strip()
        after = status(branch)
        return {
            "ok": result.returncode == 0,
            "via": "deploy-channels.ps1",
            "code": result.returncode,
            "log": log[-8000:],
            "before": before,
            "git": after,
        }

    fetched = fetch(branch)
    if fetched.get("behind", 0) == 0 and not force:
        return {
            "ok": True,
            "via": "git",
            "log": "원격과 같습니다. 코드 갱신이 없습니다.",
            "before": before,
            "git": fetched,
        }

    try:
        from .gitops import reset_to_origin

        reset_to_origin(branch)
    except GitError as exc:
        return {"ok": False, "via": "git", "log": str(exc), "before": before, "git": status(branch)}

    restarted: list[str] = []
    errors: list[str] = []
    from .inventory import list_channels

    targets = [item for item in list_channels() if item["ready"] and (not channel or item["name"] == channel)]
    for item in targets:
        try:
            restart_channel(item["name"])
            restarted.append(item["name"])
        except Exception as exc:
            errors.append(f"{item['name']}: {exc}")

    after = status(branch)
    log_lines = [
        "관리자 권한이 없어 deploy-channels.ps1 대신 git reset과 로컬 재시작을 했습니다.",
        f"재시작: {', '.join(restarted) or '(없음)'}",
    ]
    if errors:
        log_lines.extend(errors)
    return {
        "ok": not errors,
        "via": "git-local",
        "log": "\n".join(log_lines),
        "before": before,
        "git": after,
        "restarted": restarted,
        "errors": errors,
    }
