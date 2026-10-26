from __future__ import annotations

import os
import subprocess
from typing import Any

from .paths import repo_root


class GitError(RuntimeError):
    pass


def _run(*args: str) -> str:
    root = repo_root()
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip() or f"git {' '.join(args)} 실패"
        raise GitError(err)
    return (result.stdout or "").strip()


def _remote() -> str:
    """서버는 origin으로 클론하지만 개발 PC는 다른 이름일 수 있다."""
    wanted = os.getenv("CONSOLE_REMOTE", "").strip()
    if wanted:
        return wanted
    try:
        names = _run("remote").split()
    except GitError:
        return "origin"
    return "origin" if "origin" in names or not names else names[0]


def status(branch: str = "master") -> dict[str, Any]:
    try:
        head = _run("rev-parse", "HEAD")
    except GitError as exc:
        return {"ok": False, "error": str(exc)}

    current = _run("rev-parse", "--abbrev-ref", "HEAD")
    subject = ""
    try:
        subject = _run("log", "-1", "--pretty=%s")
    except GitError:
        pass

    ahead = 0
    behind = 0
    remote = ""
    try:
        remote = _run("rev-parse", f"{_remote()}/{branch}")
        counts = _run("rev-list", "--left-right", "--count", f"HEAD...{_remote()}/{branch}")
        parts = counts.split()
        if len(parts) == 2:
            ahead, behind = int(parts[0]), int(parts[1])
    except GitError:
        remote = ""

    commits: list[dict[str, str]] = []
    try:
        raw = _run("log", "-8", "--pretty=%h\t%s")
        for line in raw.splitlines():
            sha, _, title = line.partition("\t")
            if sha:
                commits.append({"sha": sha, "title": title})
    except GitError:
        pass

    return {
        "ok": True,
        "branch": current,
        "track": branch,
        "head": head,
        "short": head[:7],
        "subject": subject,
        "remote": remote,
        "ahead": ahead,
        "behind": behind,
        "commits": commits,
    }


SHARED_PATHS = ("packages/channelkit",)


def _channel_paths(channel: str) -> list[str]:
    return [f"channels/{channel}", *SHARED_PATHS]


def _remote_ref(branch: str) -> str | None:
    ref = f"{_remote()}/{branch}"
    try:
        _run("rev-parse", "--verify", "--quiet", ref)
        return ref
    except GitError:
        return None


def pending_count(channel: str, branch: str = "master") -> int:
    """원격에는 있고 아직 받지 않은, 이 채널에 영향을 주는 커밋 수."""
    ref = _remote_ref(branch)
    if not ref:
        return 0
    try:
        return int(_run("rev-list", "--count", "--no-merges", f"HEAD..{ref}", "--", *_channel_paths(channel)) or 0)
    except (GitError, ValueError):
        return 0


def history(channel: str, branch: str = "master", limit: int = 40) -> dict[str, Any]:
    """채널 폴더와 공통 패키지를 건드린 커밋. 받지 않은 원격 커밋과 올리지 않은 로컬 커밋을 구분한다."""
    paths = _channel_paths(channel)
    ref = _remote_ref(branch)
    refs = ["HEAD", ref] if ref else ["HEAD"]
    pending: set[str] = set()
    local: set[str] = set()
    if ref:
        pending = set(_run("rev-list", "--no-merges", f"HEAD..{ref}", "--", *paths).split())
        local = set(_run("rev-list", "--no-merges", f"{ref}..HEAD", "--", *paths).split())

    raw = _run(
        "log", *refs, f"-{int(limit)}", "--no-merges", "--date-order", "--name-only",
        "--pretty=format:\x1e%H\x1f%h\x1f%aI\x1f%an\x1f%s", "--", *paths,
    )
    prefix = f"channels/{channel}/"
    commits: list[dict[str, Any]] = []
    for block in raw.split("\x1e"):
        lines = [line for line in block.strip().splitlines() if line.strip()]
        if not lines:
            continue
        parts = lines[0].split("\x1f")
        if len(parts) < 5:
            continue
        sha, short, when, author, title = parts[:5]
        files = lines[1:]
        own = [f[len(prefix):] for f in files if f.startswith(prefix)]
        shared = [f for f in files if not f.startswith(prefix)]
        commits.append(
            {
                "sha": sha,
                "short": short,
                "date": when,
                "author": author,
                "title": title,
                "files": own,
                "shared": shared,
                "state": "pending" if sha in pending else "local" if sha in local else "applied",
            }
        )
    return {"channel": channel, "remote": ref, "pending": len(pending), "local": len(local), "commits": commits}


def fetch(branch: str = "master") -> dict[str, Any]:
    _run("fetch", "--prune", _remote(), branch)
    return status(branch)


def reset_to_origin(branch: str = "master") -> dict[str, Any]:
    _run("fetch", "--prune", _remote(), branch)
    _run("reset", "--hard", f"{_remote()}/{branch}")
    return status(branch)
