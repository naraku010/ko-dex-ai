"""pydantic 모델 → egi.channel/v1 manifest.

앱은 평면 object 스키마만 받는다(문자열·숫자·불린, 그리고 그 배열).
pydantic이 만드는 anyOf/$ref/$defs/const를 여기서 평평하게 펴서 내보낸다.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from .credentials import CredentialField
from .registry import ToolRegistry, ToolSpec

SPEC = "egi.channel/v1"
PRIMITIVES = frozenset({"string", "number", "integer", "boolean"})
CHANNEL_TYPES = frozenset({"data", "files"})
CHANNEL_ICONS = frozenset({"files", "database", "factory", "shop", "cog"})


def _unwrap(node: dict[str, Any], defs: dict[str, Any], depth: int = 0) -> dict[str, Any]:
    if depth > 6 or not isinstance(node, dict):
        return node if isinstance(node, dict) else {}

    if "$ref" in node:
        ref = str(node["$ref"]).rsplit("/", 1)[-1]
        merged = {**defs.get(ref, {}), **{k: v for k, v in node.items() if k != "$ref"}}
        return _unwrap(merged, defs, depth + 1)

    branches = node.get("anyOf") or node.get("oneOf")
    if isinstance(branches, list):
        picked = next((b for b in branches if isinstance(b, dict) and b.get("type") != "null"), None)
        if picked is not None:
            merged = _unwrap(dict(picked), defs, depth + 1)
            if node.get("description"):
                merged = {**merged, "description": node["description"]}
            return merged

    return node


def _property_schema(raw: dict[str, Any], defs: dict[str, Any], where: str) -> dict[str, Any]:
    node = _unwrap(dict(raw), defs)

    values = node.get("enum")
    if "const" in node:
        values = [node["const"]]

    out: dict[str, Any] = {}
    node_type = node.get("type")

    if node_type == "array":
        items = _unwrap(dict(node.get("items") or {"type": "string"}), defs)
        item_type = items.get("type", "string")
        item_enum = items.get("enum")
        if "const" in items:
            item_enum = [items["const"]]
        if item_type not in PRIMITIVES and not item_enum:
            raise ValueError(f"{where}: 배열 항목은 문자열·숫자·불린만 쓸 수 있습니다.")
        out["type"] = "array"
        item_out: dict[str, Any] = {"type": item_type if item_type in PRIMITIVES else "string"}
        if isinstance(item_enum, list) and item_enum:
            item_out["enum"] = [str(value) for value in item_enum]
        out["items"] = item_out
    elif isinstance(values, list) and values:
        out["type"] = node_type if node_type in PRIMITIVES else "string"
        out["enum"] = [str(value) for value in values]
    elif node_type in PRIMITIVES:
        out["type"] = node_type
    elif node_type is None:
        out["type"] = "string"
    else:
        raise ValueError(f"{where}: 지원하지 않는 타입입니다 ({node_type}). 중첩 object는 쓸 수 없습니다.")

    description = node.get("description") or raw.get("description")
    if description:
        out["description"] = str(description)
    return out


def input_schema(model: type[BaseModel] | None, where: str = "inputSchema") -> dict[str, Any]:
    if model is None:
        return {"type": "object", "properties": {}, "required": []}

    raw = model.model_json_schema()
    defs = raw.get("$defs", {})
    properties = {
        key: _property_schema(value, defs, f"{where}.{key}")
        for key, value in (raw.get("properties") or {}).items()
    }
    required = [name for name in raw.get("required", []) if name in properties]
    return {"type": "object", "properties": properties, "required": required}


def tool_manifest(spec: ToolSpec) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "name": spec.name,
        "description": spec.description,
        "inputSchema": input_schema(spec.args_model, spec.name),
    }
    if spec.label:
        entry["label"] = spec.label
    return entry


def build_manifest(
    *,
    channel_id: str,
    name: str,
    short: str,
    description: str,
    version: str,
    system_prompt: str,
    auth_type: str,
    auth_header: str,
    tools: ToolRegistry,
    credentials: tuple[CredentialField, ...] = (),
    channel_type: str = "data",
    icon: str = "cog",
) -> dict[str, Any]:
    kind = channel_type if channel_type in CHANNEL_TYPES else "data"
    mark = icon if icon in CHANNEL_ICONS else "cog"
    return {
        "spec": SPEC,
        "id": channel_id,
        "name": name,
        "short": short,
        "description": description,
        "version": version,
        "type": kind,
        "fileManagement": kind == "files",
        "files": {
            "upload": "/files",
            "accept": "application/pdf,.pdf",
            "maxBytes": 20 * 1024 * 1024,
        }
        if kind == "files"
        else None,
        "icon": mark,
        "systemPrompt": system_prompt,
        "auth": {"type": auth_type, "header": auth_header},
        # 업스트림 계정은 채널 서버가 갖지 않는다. 앱이 사용자에게 받아서 요청마다 넘긴다.
        "credentials": [field.to_manifest() for field in credentials],
        "tools": [tool_manifest(spec) for spec in tools.specs()],
    }
