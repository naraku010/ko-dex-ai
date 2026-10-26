"""채널 사용자들이 같이 쓰는 프로젝트 저장소.

앱이 프로젝트를 만들면 여기 둔다. 같은 채널을 쓰는 사람은 모두 보고, 대화만 각자 PC에 남긴다.
- 문서 파일: 원본은 서버. 앱은 열 때 크기·수정 시각이 다른 파일만 받아 PC 캐시에 둔다.
- 색인: 한 사람이 AI로 만든 결과(파일별 JSON)를 올리고, 다른 사람은 받아서 쓴다.
- 잠금: 두 사람이 동시에 색인하지 않게 프로젝트마다 하나만 건다. 하트비트가 끊기면 풀린다.

    mount_projects(app, keys, auth_header, root)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterator
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from .result import ToolError, error, ok
from .security import RequestUser, check_api_key, parse_user

MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_FILES = 500
MAX_ENTRY_BYTES = 5 * 1024 * 1024
LOCK_TTL_SECONDS = 180
TRASH_DAYS = 30
ID_RE = re.compile(r"^[a-zA-Z0-9-]{8,64}$")
KEY_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
STATE_NAMES = frozenset({"scope"})

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  datasheet TEXT,
  skip_images INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  project_id TEXT NOT NULL,
  rel TEXT NOT NULL COLLATE NOCASE,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  sha1 TEXT NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, rel)
);
CREATE TABLE IF NOT EXISTS entries (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, kind, key)
);
CREATE TABLE IF NOT EXISTS locks (
  project_id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  holder_name TEXT,
  purpose TEXT,
  expires_at TEXT NOT NULL
);
"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _stamp(at: datetime | None = None) -> str:
    return (at or _now()).isoformat(timespec="seconds")


class ProjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.blobs = root / "blobs"
        self.blobs.mkdir(parents=True, exist_ok=True)
        # 본문 쓰기→행 기록과 정리(_sweep)가 겹치면 아직 행이 없는 본문을 지운다. 한 번에 하나씩.
        self.blob_lock = threading.Lock()
        with self._db() as conn:
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(projects)")}
            for column in ("deleted_at", "deleted_by"):
                if column not in columns:
                    conn.execute(f"ALTER TABLE projects ADD COLUMN {column} TEXT")

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.root / "projects.db", check_same_thread=False, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.executescript(SCHEMA)
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    # ---------- 프로젝트 ----------

    def _public(self, conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        stats = conn.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files WHERE project_id=?", (row["id"],)
        ).fetchone()
        return {
            "id": row["id"],
            "name": row["name"],
            "datasheet": row["datasheet"],
            "skipImages": bool(row["skip_images"]),
            "createdBy": row["created_by_name"] or row["created_by"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "fileCount": stats["n"],
            "totalBytes": stats["bytes"],
            "lock": self._lock(conn, row["id"]),
        }

    def _row(self, conn: sqlite3.Connection, project_id: str, trashed: bool = False) -> sqlite3.Row:
        if not ID_RE.match(project_id or ""):
            raise ToolError("프로젝트 id가 올바르지 않습니다.")
        row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is None or bool(row["deleted_at"]) != trashed:
            if trashed:
                raise ToolError("휴지통에 없는 프로젝트입니다.")
            raise ToolError("프로젝트를 찾지 못했습니다. 다른 사람이 지웠을 수 있습니다.")
        return row

    def _touch(self, conn: sqlite3.Connection, project_id: str) -> None:
        conn.execute("UPDATE projects SET updated_at=? WHERE id=?", (_stamp(), project_id))

    def list(self) -> list[dict[str, Any]]:
        self._purge()
        with self._db() as conn:
            rows = conn.execute("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at DESC").fetchall()
            return [self._public(conn, row) for row in rows]

    def create(self, body: dict[str, Any], user: RequestUser) -> dict[str, Any]:
        name = str(body.get("name") or "").strip()[:60]
        if not name:
            raise ToolError("프로젝트 이름을 알려주세요.")
        project_id = str(body.get("id") or uuid4())
        if not ID_RE.match(project_id):
            raise ToolError("프로젝트 id가 올바르지 않습니다.")
        now = _stamp()
        with self._db() as conn:
            if conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise ToolError("이미 서버에 있는 프로젝트입니다.")
            conn.execute(
                """INSERT INTO projects (id, name, datasheet, skip_images, created_by, created_by_name, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    project_id,
                    name,
                    _clean_rel(body["datasheet"]) if body.get("datasheet") else None,
                    1 if body.get("skipImages") else 0,
                    user.id,
                    user.name,
                    now,
                    now,
                ),
            )
            return self._public(conn, self._row(conn, project_id))

    def detail(self, project_id: str) -> dict[str, Any]:
        with self._db() as conn:
            project = self._public(conn, self._row(conn, project_id))
            files = conn.execute(
                "SELECT rel, size, mtime, sha1, uploaded_by, uploaded_at FROM files WHERE project_id=? ORDER BY rel",
                (project_id,),
            ).fetchall()
            entries = conn.execute(
                "SELECT kind, key, updated_at FROM entries WHERE project_id=?", (project_id,)
            ).fetchall()
        return {
            "project": project,
            "files": [dict(row) for row in files],
            "entries": {f"{row['kind']}:{row['key']}": row["updated_at"] for row in entries},
        }

    def update(self, project_id: str, body: dict[str, Any]) -> dict[str, Any]:
        with self._db() as conn:
            self._row(conn, project_id)
            if "name" in body and str(body["name"] or "").strip():
                conn.execute("UPDATE projects SET name=? WHERE id=?", (str(body["name"]).strip()[:60], project_id))
            if "datasheet" in body:
                value = _clean_rel(body["datasheet"]) if body["datasheet"] else None
                conn.execute("UPDATE projects SET datasheet=? WHERE id=?", (value, project_id))
            if "skipImages" in body:
                conn.execute("UPDATE projects SET skip_images=? WHERE id=?", (1 if body["skipImages"] else 0, project_id))
            self._touch(conn, project_id)
            return self._public(conn, self._row(conn, project_id))

    def delete(self, project_id: str, user: RequestUser) -> dict[str, Any]:
        """휴지통으로 옮긴다. TRASH_DAYS가 지나면 _purge가 파일까지 지운다."""
        with self._db() as conn:
            self._row(conn, project_id)
            held = self._lock(conn, project_id)
            if held and held["holderId"] != user.id:
                raise ToolError(f"{held['holder']}님이 {held['purpose'] or '작업'} 중이라 지울 수 없습니다. 끝난 뒤에 다시 해 주세요.")
            conn.execute("DELETE FROM locks WHERE project_id=?", (project_id,))
            conn.execute(
                "UPDATE projects SET deleted_at=?, deleted_by=? WHERE id=?",
                (_stamp(), user.name or user.id, project_id),
            )
        return {"trashed": project_id, "keepDays": TRASH_DAYS}

    def trash(self) -> list[dict[str, Any]]:
        self._purge()
        with self._db() as conn:
            rows = conn.execute(
                "SELECT * FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
            ).fetchall()
            items = []
            for row in rows:
                item = self._public(conn, row)
                deleted = datetime.fromisoformat(row["deleted_at"])
                item.update(
                    deletedAt=row["deleted_at"],
                    deletedBy=row["deleted_by"],
                    purgeAt=_stamp(deleted + timedelta(days=TRASH_DAYS)),
                )
                items.append(item)
            return items

    def restore(self, project_id: str) -> dict[str, Any]:
        with self._db() as conn:
            self._row(conn, project_id, trashed=True)
            conn.execute("UPDATE projects SET deleted_at=NULL, deleted_by=NULL WHERE id=?", (project_id,))
            self._touch(conn, project_id)
            return self._public(conn, self._row(conn, project_id))

    def _purge(self) -> None:
        limit = _stamp(_now() - timedelta(days=TRASH_DAYS))
        with self._db() as conn:
            ids = [
                row[0]
                for row in conn.execute(
                    "SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?", (limit,)
                )
            ]
            for project_id in ids:
                for table in ("files", "entries", "locks", "projects"):
                    column = "id" if table == "projects" else "project_id"
                    conn.execute(f"DELETE FROM {table} WHERE {column}=?", (project_id,))
        for project_id in ids:
            shutil.rmtree(self.blobs / project_id, ignore_errors=True)

    # ---------- 파일 ----------

    def _blob(self, project_id: str, sha1: str) -> Path:
        return self.blobs / project_id / sha1

    def put_file(self, project_id: str, rel: str, mtime: int, data: bytes, user: RequestUser) -> dict[str, Any]:
        rel = _clean_rel(rel)
        if len(data) > MAX_FILE_BYTES:
            raise ToolError(f"'{rel}' 은 50MB를 넘어 올릴 수 없습니다.")
        sha1 = hashlib.sha1(data).hexdigest()
        with self.blob_lock:
            with self._db() as conn:
                self._row(conn, project_id)
                exists = conn.execute("SELECT 1 FROM files WHERE project_id=? AND rel=?", (project_id, rel)).fetchone()
                count = conn.execute("SELECT COUNT(*) FROM files WHERE project_id=?", (project_id,)).fetchone()[0]
                if not exists and count >= MAX_FILES:
                    raise ToolError(f"프로젝트 파일은 {MAX_FILES}개까지입니다.")
                blob = self._blob(project_id, sha1)
                if not blob.is_file():
                    blob.parent.mkdir(parents=True, exist_ok=True)
                    temp = blob.with_suffix(".part")
                    temp.write_bytes(data)
                    temp.replace(blob)
                conn.execute(
                    """INSERT INTO files (project_id, rel, size, mtime, sha1, uploaded_by, uploaded_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(project_id, rel) DO UPDATE SET
                         rel=excluded.rel, size=excluded.size, mtime=excluded.mtime, sha1=excluded.sha1,
                         uploaded_by=excluded.uploaded_by, uploaded_at=excluded.uploaded_at""",
                    (project_id, rel, len(data), int(mtime), sha1, user.name or user.id, _stamp()),
                )
                self._touch(conn, project_id)
            self._sweep(project_id)
        return {"rel": rel, "size": len(data), "mtime": int(mtime), "sha1": sha1}

    def file_path(self, project_id: str, rel: str) -> tuple[Path, dict[str, Any]]:
        rel = _clean_rel(rel)
        with self._db() as conn:
            self._row(conn, project_id)
            row = conn.execute(
                "SELECT rel, size, mtime, sha1 FROM files WHERE project_id=? AND rel=?", (project_id, rel)
            ).fetchone()
        if row is None:
            raise ToolError(f"'{rel}' 파일이 서버에 없습니다.")
        blob = self._blob(project_id, row["sha1"])
        if not blob.is_file():
            raise ToolError(f"'{rel}' 파일 본문이 서버에 없습니다.")
        return blob, dict(row)

    def delete_file(self, project_id: str, rel: str) -> dict[str, Any]:
        rel = _clean_rel(rel)
        with self.blob_lock:
            with self._db() as conn:
                self._row(conn, project_id)
                conn.execute("DELETE FROM files WHERE project_id=? AND rel=?", (project_id, rel))
                self._touch(conn, project_id)
            self._sweep(project_id)
        return {"deleted": rel}

    def _sweep(self, project_id: str) -> None:
        """어느 파일도 가리키지 않는 본문을 지운다."""
        folder = self.blobs / project_id
        if not folder.is_dir():
            return
        with self._db() as conn:
            used = {row[0] for row in conn.execute("SELECT sha1 FROM files WHERE project_id=?", (project_id,))}
        for blob in folder.iterdir():
            if blob.is_file() and blob.name not in used and not blob.name.endswith(".part"):
                blob.unlink(missing_ok=True)

    # ---------- 색인·판단 ----------

    def entries(self, project_id: str, kind: str) -> dict[str, Any]:
        with self._db() as conn:
            self._row(conn, project_id)
            rows = conn.execute(
                "SELECT key, body FROM entries WHERE project_id=? AND kind=?", (project_id, kind)
            ).fetchall()
        return {row["key"]: json.loads(row["body"]) for row in rows}

    def put_entry(self, project_id: str, kind: str, key: str, value: Any, user: RequestUser) -> dict[str, Any]:
        if not KEY_RE.match(key or ""):
            raise ToolError("색인 키가 올바르지 않습니다.")
        body = json.dumps(value, ensure_ascii=False)
        if len(body.encode("utf-8")) > MAX_ENTRY_BYTES:
            raise ToolError("색인 결과가 너무 큽니다.")
        now = _stamp()
        with self._db() as conn:
            self._row(conn, project_id)
            conn.execute(
                """INSERT INTO entries (project_id, kind, key, body, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(project_id, kind, key) DO UPDATE SET
                     body=excluded.body, updated_by=excluded.updated_by, updated_at=excluded.updated_at""",
                (project_id, kind, key, body, user.name or user.id, now),
            )
        return {"key": key, "updatedAt": now}

    def delete_entry(self, project_id: str, kind: str, key: str) -> dict[str, Any]:
        with self._db() as conn:
            self._row(conn, project_id)
            conn.execute("DELETE FROM entries WHERE project_id=? AND kind=? AND key=?", (project_id, kind, key))
        return {"deleted": key}

    # ---------- 잠금 ----------

    def _lock(self, conn: sqlite3.Connection, project_id: str) -> dict[str, Any] | None:
        row = conn.execute("SELECT * FROM locks WHERE project_id=?", (project_id,)).fetchone()
        if row is None or row["expires_at"] < _stamp():
            return None
        return {"holderId": row["holder_id"], "holder": row["holder_name"] or row["holder_id"], "purpose": row["purpose"], "expiresAt": row["expires_at"]}

    def acquire(self, project_id: str, purpose: str, user: RequestUser) -> dict[str, Any]:
        with self._db() as conn:
            self._row(conn, project_id)
            held = self._lock(conn, project_id)
            if held and held["holderId"] != user.id:
                raise ToolError(f"{held['holder']}님이 {held['purpose'] or '작업'} 중입니다. 끝난 뒤에 다시 해 주세요.")
            expires = _stamp(_now() + timedelta(seconds=LOCK_TTL_SECONDS))
            conn.execute(
                """INSERT INTO locks (project_id, holder_id, holder_name, purpose, expires_at) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(project_id) DO UPDATE SET
                     holder_id=excluded.holder_id, holder_name=excluded.holder_name,
                     purpose=excluded.purpose, expires_at=excluded.expires_at""",
                (project_id, user.id, user.name, str(purpose or "")[:40], expires),
            )
            return self._lock(conn, project_id) or {}

    def release(self, project_id: str, user: RequestUser) -> dict[str, Any]:
        with self._db() as conn:
            conn.execute("DELETE FROM locks WHERE project_id=? AND holder_id=?", (project_id, user.id))
        return {"released": project_id}


def _clean_rel(raw: Any) -> str:
    """앱이 보내는 상대 경로. '/'로 맞추고 폴더 밖이나 절대 경로는 막는다."""
    text = str(raw or "").replace("\\", "/").strip().strip("/")
    path = PurePosixPath(text)
    if not text or path.is_absolute() or ".." in path.parts or ":" in path.parts[0] or len(text) > 400:
        raise ToolError("파일 경로가 올바르지 않습니다.")
    return str(path)


def mount_projects(app: FastAPI, keys: frozenset[str], auth_header: str, root: Path) -> ProjectStore:
    store = ProjectStore(root)

    async def handle(request: Request, work: Callable[[RequestUser], Any]) -> Any:
        """키·사용자를 확인하고 work(user)를 스레드에서 돌린다. 실패는 {ok:false}로 준다."""
        try:
            check_api_key(request, keys, auth_header)
            user = parse_user(request)
            if user is None:
                raise ToolError("로그인 사용자 정보가 없습니다.")
            return ok(await asyncio.to_thread(work, user))
        except ToolError as exc:
            return JSONResponse(status_code=200, content=error(exc))
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            print(f"[projects] 요청 실패: {exc!r}")
            return JSONResponse(status_code=200, content=error("프로젝트 서버에서 처리하지 못했습니다."))

    async def body_of(request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return {}
        return body if isinstance(body, dict) else {}

    @app.get("/projects")
    async def list_projects(request: Request) -> Any:
        return await handle(request, lambda user: store.list())

    @app.post("/projects")
    async def create_project(request: Request) -> Any:
        body = await body_of(request)
        return await handle(request, lambda user: store.create(body, user))

    @app.get("/projects/trash")
    async def list_trash(request: Request) -> Any:
        return await handle(request, lambda user: store.trash())

    @app.post("/projects/{project_id}/restore")
    async def restore_project(project_id: str, request: Request) -> Any:
        return await handle(request, lambda user: store.restore(project_id))

    @app.get("/projects/{project_id}")
    async def project_detail(project_id: str, request: Request) -> Any:
        return await handle(request, lambda user: store.detail(project_id))

    @app.patch("/projects/{project_id}")
    async def update_project(project_id: str, request: Request) -> Any:
        body = await body_of(request)
        return await handle(request, lambda user: store.update(project_id, body))

    @app.delete("/projects/{project_id}")
    async def delete_project(project_id: str, request: Request) -> Any:
        return await handle(request, lambda user: store.delete(project_id, user))

    @app.put("/projects/{project_id}/files")
    async def put_file(project_id: str, rel: str, mtime: int, request: Request) -> Any:
        data = await request.body()
        return await handle(request, lambda user: store.put_file(project_id, rel, mtime, data, user))

    @app.get("/projects/{project_id}/files")
    async def get_file(project_id: str, rel: str, request: Request) -> Any:
        check_api_key(request, keys, auth_header)
        try:
            blob, meta = await asyncio.to_thread(store.file_path, project_id, rel)
        except ToolError as exc:
            return JSONResponse(status_code=404, content=error(exc))
        return FileResponse(
            blob,
            media_type="application/octet-stream",
            headers={"X-File-Mtime": str(meta["mtime"]), "X-File-Sha1": meta["sha1"]},
        )

    @app.delete("/projects/{project_id}/files")
    async def delete_file(project_id: str, rel: str, request: Request) -> Any:
        return await handle(request, lambda user: store.delete_file(project_id, rel))

    @app.get("/projects/{project_id}/index")
    async def get_index(project_id: str, request: Request) -> Any:
        return await handle(request, lambda user: store.entries(project_id, "index"))

    @app.put("/projects/{project_id}/index/{key}")
    async def put_index(project_id: str, key: str, request: Request) -> Any:
        value = await request.json()
        return await handle(request, lambda user: store.put_entry(project_id, "index", key, value, user))

    @app.delete("/projects/{project_id}/index/{key}")
    async def delete_index(project_id: str, key: str, request: Request) -> Any:
        return await handle(request, lambda user: store.delete_entry(project_id, "index", key))

    @app.get("/projects/{project_id}/state/{name}")
    async def get_state(project_id: str, name: str, request: Request) -> Any:
        if name not in STATE_NAMES:
            return JSONResponse(status_code=404, content=error("없는 항목입니다."))
        return await handle(request, lambda user: store.entries(project_id, "state").get(name))

    @app.put("/projects/{project_id}/state/{name}")
    async def put_state(project_id: str, name: str, request: Request) -> Any:
        if name not in STATE_NAMES:
            return JSONResponse(status_code=404, content=error("없는 항목입니다."))
        value = await request.json()
        return await handle(request, lambda user: store.put_entry(project_id, "state", name, value, user))

    @app.post("/projects/{project_id}/lock")
    async def acquire_lock(project_id: str, request: Request) -> Any:
        purpose = str((await body_of(request)).get("purpose") or "")
        return await handle(request, lambda user: store.acquire(project_id, purpose, user))

    @app.delete("/projects/{project_id}/lock")
    async def release_lock(project_id: str, request: Request) -> Any:
        return await handle(request, lambda user: store.release(project_id, user))

    return store


