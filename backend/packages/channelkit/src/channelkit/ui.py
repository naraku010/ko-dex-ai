"""툴 응답에 실어 보내는 표시 지시.

앱은 툴 결과 텍스트와 별개로 이 지시를 읽어 카드·리포트·달력을 그린다. AI가 별도 툴을 부르지 않아도
표시되므로, 이미지·HTML처럼 텍스트로 옮길 수 없는 정보를 보낼 때 쓴다.

    return ToolResult(
        data={"제품": [...]},
        ui=[cards("추천 상품", [card(title="...", image="https://...")])],
    )

규격은 앱 쪽 검증과 짝을 이룬다. 여기서 통과한 것만 앱이 그린다.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping

MAX_BLOCKS = 4
MAX_ITEMS = 12
MAX_FIELDS = 6
MAX_EVENTS = 90
MAX_TEXT = 120
MAX_URL = 500
MAX_HTML = 200_000
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TONES = frozenset({"info", "ok", "warn", "danger"})


def _text(value: object, label: str, *, limit: int = MAX_TEXT, required: bool = False) -> str:
    if value is None:
        text = ""
    elif isinstance(value, str):
        text = value.strip()
    elif isinstance(value, (int, float)):
        text = str(value)
    else:
        raise ValueError(f"ui {label}: 문자열이나 숫자여야 합니다. ({type(value).__name__})")
    if required and not text:
        raise ValueError(f"ui {label}: 비워둘 수 없습니다.")
    return text[:limit]


def _image(value: object) -> str:
    url = _text(value, "image", limit=MAX_URL)
    if url and not url.startswith(("http://", "https://")):
        raise ValueError("ui image: http 또는 https URL이어야 합니다.")
    return url


def card(
    *,
    title: str,
    subtitle: object = "",
    image: object = "",
    badge: object = "",
    fields: Mapping[str, object] | None = None,
) -> dict[str, Any]:
    """카드 한 장. fields는 카드 아래에 라벨·값으로 줄줄이 붙는다."""
    entry: dict[str, Any] = {"title": _text(title, "card.title", required=True)}

    subtitle_text = _text(subtitle, "card.subtitle")
    if subtitle_text:
        entry["subtitle"] = subtitle_text

    image_url = _image(image)
    if image_url:
        entry["image"] = image_url

    badge_text = _text(badge, "card.badge", limit=24)
    if badge_text:
        entry["badge"] = badge_text

    if fields:
        items = list(fields.items())
        if len(items) > MAX_FIELDS:
            raise ValueError(f"ui card.fields: 최대 {MAX_FIELDS}개까지 넣을 수 있습니다.")
        entry["fields"] = [
            {"label": _text(key, "card.fields.label", limit=24, required=True), "value": _text(value, "card.fields.value")}
            for key, value in items
        ]

    return entry


def cards(title: object, items: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """카드 묶음 하나. card()로 만든 것만 넣는다."""
    entries = [dict(item) for item in items]
    if not entries:
        raise ValueError("ui cards: 카드가 비어 있습니다.")
    if len(entries) > MAX_ITEMS:
        raise ValueError(f"ui cards: 카드는 최대 {MAX_ITEMS}장까지 보낼 수 있습니다.")
    return {"type": "cards", "title": _text(title, "cards.title"), "items": entries}


def calendar_event(
    *,
    date: object,
    title: object,
    subtitle: object = "",
    tone: object = "info",
) -> dict[str, Any]:
    """달력 일정 하나. date는 YYYY-MM-DD."""
    day = _text(date, "calendar.date", limit=10, required=True)
    if not DATE_RE.match(day):
        raise ValueError("ui calendar.date: YYYY-MM-DD 형식이어야 합니다.")
    kind = _text(tone, "calendar.tone", limit=16) or "info"
    if kind not in TONES:
        raise ValueError("ui calendar.tone: info, ok, warn, danger 중 하나여야 합니다.")
    entry: dict[str, Any] = {
        "date": day,
        "title": _text(title, "calendar.title", required=True),
        "tone": kind,
    }
    extra = _text(subtitle, "calendar.subtitle")
    if extra:
        entry["subtitle"] = extra
    return entry


def calendar(*, title: object, events: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """월 달력 하나. calendar_event()로 만든 일정을 넣는다."""
    items = [calendar_event(**{
        "date": item.get("date", ""),
        "title": item.get("title", ""),
        "subtitle": item.get("subtitle", ""),
        "tone": item.get("tone", "info"),
    }) for item in events]
    if not items:
        raise ValueError("ui calendar: 일정이 비어 있습니다.")
    if len(items) > MAX_EVENTS:
        raise ValueError(f"ui calendar: 일정은 최대 {MAX_EVENTS}개까지 보낼 수 있습니다.")
    return {
        "type": "calendar",
        "title": _text(title, "calendar.title", required=True),
        "events": items,
    }


def upload(
    *,
    title: object = "파일 추가",
    accept: object = ".pdf",
    path: object = "/files",
    hint: object = "",
) -> dict[str, Any]:
    """앱이 파일 추가 버튼을 띄운다. 고른 파일은 path로 POST 한다."""
    extra = _text(hint, "upload.hint", limit=200)
    block = {
        "type": "upload",
        "title": _text(title, "upload.title", required=True),
        "accept": _text(accept, "upload.accept", limit=80) or ".pdf",
        "path": _text(path, "upload.path", limit=200) or "/files",
        "multiple": True,
    }
    if extra:
        block["hint"] = extra
    return block


def excel(
    *,
    title: object,
    sheet: object,
    rows: object,
    merges: object = None,
    path: object = None,
    styles: object = None,
    widths: object = None,
    borders: object = None,
    heights: object = None,
) -> dict[str, Any]:
    """엑셀 시트 하나. 앱이 격자 뷰어로 그린다."""
    if not isinstance(rows, (list, tuple)) or not rows:
        raise ValueError("ui excel.rows: 행이 있어야 합니다.")
    if len(rows) > 700:
        raise ValueError("ui excel.rows: 700행을 넘을 수 없습니다.")
    grid: list[list[str]] = []
    for row in rows:
        if not isinstance(row, (list, tuple)):
            raise ValueError("ui excel.rows: 각 행은 배열이어야 합니다.")
        grid.append([_text(cell, "excel.cell", limit=80) for cell in list(row)[:12]])
    spans: list[dict[str, int]] = []
    for item in list(merges or [])[:400]:
        if not isinstance(item, Mapping):
            raise ValueError("ui excel.merges: 항목은 object여야 합니다.")
        span = {
            "r": int(item.get("r", 0)),
            "c": int(item.get("c", 0)),
            "rows": int(item.get("rows", 1)),
            "cols": int(item.get("cols", 1)),
        }
        if span["rows"] < 1 or span["cols"] < 1:
            continue
        spans.append(span)
    block = {
        "type": "excel",
        "title": _text(title, "excel.title", required=True),
        "sheet": _text(sheet, "excel.sheet", limit=40) or "Sheet1",
        "rows": grid,
        "merges": spans,
    }
    file_path = _text(path, "excel.path", limit=400)
    if file_path:
        block["path"] = file_path
    style_grid: list[list[str]] = []
    for row in list(styles or [])[: len(grid)]:
        if not isinstance(row, (list, tuple)):
            continue
        style_grid.append([_text(cell, "excel.style", limit=8) for cell in list(row)[:12]])
    if style_grid:
        block["styles"] = style_grid
    border_grid: list[list[str]] = []
    for row in list(borders or [])[: len(grid)]:
        if not isinstance(row, (list, tuple)):
            continue
        border_grid.append([_text(cell, "excel.border", limit=4) for cell in list(row)[:12]])
    if border_grid:
        block["borders"] = border_grid
    height_list: list[float] = []
    for item in list(heights or [])[: len(grid)]:
        try:
            height_list.append(max(8.0, min(80.0, round(float(item), 2))))
        except (TypeError, ValueError):
            continue
    if height_list:
        block["heights"] = height_list
    width_list: list[float] = []
    for item in list(widths or [])[:12]:
        try:
            width_list.append(max(4.0, min(40.0, float(item))))
        except (TypeError, ValueError):
            continue
    if width_list:
        block["widths"] = width_list
    return block


def report(*, title: object, html: object) -> dict[str, Any]:
    """완성된 HTML 문서 하나. 앱이 iframe으로 그린다. 스크립트는 넣지 않는다."""
    document = html if isinstance(html, str) else ""
    document = document.strip()
    if not document:
        raise ValueError("ui report.html: 비워둘 수 없습니다.")
    if len(document) > MAX_HTML:
        raise ValueError(f"ui report.html: {MAX_HTML}자를 넘을 수 없습니다.")
    lowered = document.lower()
    if "<script" in lowered:
        raise ValueError("ui report.html: script 태그는 쓸 수 없습니다.")
    return {
        "type": "report",
        "title": _text(title, "report.title", required=True),
        "html": document,
    }


def validate_blocks(blocks: object) -> list[dict[str, Any]]:
    """채널이 만든 ui 목록을 내보내기 전에 한 번 더 확인한다."""
    if blocks is None:
        return []
    if isinstance(blocks, Mapping):
        blocks = [blocks]
    if not isinstance(blocks, (list, tuple)):
        raise ValueError("ui: 목록이어야 합니다.")
    if len(blocks) > MAX_BLOCKS:
        raise ValueError(f"ui: 블록은 최대 {MAX_BLOCKS}개까지 보낼 수 있습니다.")

    out: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, Mapping):
            raise ValueError("ui: 블록은 object여야 합니다.")
        kind = block.get("type")
        if kind == "cards":
            out.append(cards(block.get("title", ""), block.get("items") or []))
        elif kind == "excel":
            out.append(
                excel(
                    title=block.get("title", ""),
                    sheet=block.get("sheet", ""),
                    rows=block.get("rows") or [],
                    merges=block.get("merges") or [],
                    path=block.get("path", ""),
                    styles=block.get("styles") or [],
                    widths=block.get("widths") or [],
                    borders=block.get("borders") or [],
                    heights=block.get("heights") or [],
                )
            )
        elif kind == "report":
            out.append(report(title=block.get("title", ""), html=block.get("html", "")))
        elif kind == "calendar":
            out.append(calendar(title=block.get("title", ""), events=block.get("events") or []))
        elif kind == "upload":
            out.append(
                upload(
                    title=block.get("title", "파일 추가"),
                    accept=block.get("accept", ".pdf"),
                    path=block.get("path", "/files"),
                    hint=block.get("hint", ""),
                )
            )
        elif kind == "file":
            out.append(_file_block(block))
        else:
            raise ValueError(
                f"ui: 모르는 블록 종류입니다 ({kind}). cards, report, excel, calendar, upload, file만 씁니다."
            )
    return out


TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


def _file_block(block: Mapping[str, Any]) -> dict[str, Any]:
    """publish_file이 만든 내려받기 블록. 이름에서 경로는 떼어낸다."""
    name = _text(block.get("name"), "file.name", required=True)
    name = re.split(r"[\\/]", name)[-1].strip()
    if not name:
        raise ValueError("ui file.name: 파일 이름이 비어 있습니다.")
    token = block.get("token")
    if not isinstance(token, str) or not TOKEN_RE.match(token):
        raise ValueError("ui file.token: publish_file로 만든 토큰이어야 합니다.")
    size = block.get("size")
    entry: dict[str, Any] = {"type": "file", "name": name, "token": token}
    if isinstance(size, int) and size >= 0:
        entry["size"] = size
    return entry
