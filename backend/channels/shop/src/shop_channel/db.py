"""데모 DB 접근. 읽기 전용으로 열고, 파일이 없거나 오래되면 다시 만든다."""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from channelkit import ToolError

from . import seed

# channels/shop/data/demo.db
CHANNEL_ROOT = Path(__file__).resolve().parents[2]
DB_PATH = Path(os.getenv("SHOP_DB_PATH") or CHANNEL_ROOT / "data" / "demo.db")

# 데이터 끝이 오늘에서 이만큼 넘게 밀리면 데모가 낡아 보이니 다시 만든다.
STALE_DAYS = 3

_conn: sqlite3.Connection | None = None
_range: tuple[str, str] | None = None


def _open() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _meta(conn: sqlite3.Connection) -> dict[str, str]:
    return {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM meta")}


def _is_stale() -> bool:
    if not DB_PATH.exists():
        return True
    try:
        conn = _open()
    except sqlite3.Error:
        return True
    try:
        meta = _meta(conn)
    except sqlite3.Error:
        return True
    finally:
        conn.close()

    if meta.get("schema_version") != str(seed.SCHEMA_VERSION):
        return True
    end = meta.get("end_date")
    if not end:
        return True
    return (date.today() - date.fromisoformat(end)).days > STALE_DAYS


def ensure_ready() -> dict[str, str]:
    """채널이 뜰 때 한 번 부른다. 없거나 낡았으면 만들고 연결을 준비한다."""
    global _conn, _range

    if _is_stale():
        print(f"[shop] 데모 데이터를 생성합니다: {DB_PATH}")
        info = seed.build(DB_PATH)
        print(f"[shop] {info['start_date']} ~ {info['end_date']}, 판매 {info['sales_rows']}행")

    if _conn is not None:
        _conn.close()
    _conn = _open()
    meta = _meta(_conn)
    _range = (meta["start_date"], meta["end_date"])
    return meta


def close() -> None:
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


def conn() -> sqlite3.Connection:
    if _conn is None:
        raise ToolError("데이터가 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.")
    return _conn


def query(sql: str, params: Any = ()) -> list[dict[str, Any]]:
    return [dict(row) for row in conn().execute(sql, params)]


def one(sql: str, params: Any = ()) -> dict[str, Any] | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def data_range() -> tuple[str, str]:
    if _range is None:
        raise ToolError("데이터가 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.")
    return _range


def last_day() -> str:
    return data_range()[1]


def resolve_period(start: str | None, end: str | None, default_days: int = 30) -> tuple[str, str]:
    """기간 인자를 데이터가 있는 범위 안으로 맞춘다. 비어 있으면 최근 default_days일."""
    first, final = data_range()
    end_day = end or final
    if start:
        start_day = start
    else:
        start_day = (date.fromisoformat(end_day) - timedelta(days=default_days - 1)).isoformat()

    if start_day > end_day:
        raise ToolError(f"시작일({start_day})이 종료일({end_day})보다 늦습니다.")

    clamped_start = max(start_day, first)
    clamped_end = min(end_day, final)
    if clamped_start > clamped_end:
        raise ToolError(f"데이터는 {first} ~ {final} 범위만 있습니다. 요청한 기간에는 데이터가 없습니다.")
    return clamped_start, clamped_end


def resolve_day(day: str | None) -> str:
    first, final = data_range()
    target = day or final
    if target < first or target > final:
        raise ToolError(f"데이터는 {first} ~ {final} 범위만 있습니다. ({target} 요청)")
    return target


def parse_attrs(raw: str) -> list[tuple[str, str]]:
    try:
        return [(str(pair[0]), str(pair[1])) for pair in json.loads(raw)]
    except (ValueError, TypeError, IndexError):
        return []


def image_url(sku: str) -> str:
    """앱이 카드에 띄울 이미지 주소. 프록시 뒤에 두면 PUBLIC_BASE_URL을 맞춰야 한다."""
    base = (os.getenv("PUBLIC_BASE_URL") or f"http://127.0.0.1:{os.getenv('PORT', '8803')}").rstrip("/")
    return f"{base}/images/{sku}.jpg"


def won(value: object) -> str:
    try:
        return f"{int(value):,}원"
    except (TypeError, ValueError):
        return "-"
