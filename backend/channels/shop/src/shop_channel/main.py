from __future__ import annotations

import os
from pathlib import Path

from channelkit import create_channel_app
from dotenv import load_dotenv
from fastapi.responses import FileResponse, Response

from . import db, tools
from .prompt import SYSTEM_PROMPT


def load_channel_env() -> None:
    here = Path(__file__).resolve().parents[2]
    for path in (here / ".env", Path.cwd() / ".env"):
        if path.is_file():
            load_dotenv(path, override=True)
            return
    load_dotenv(override=True)


load_channel_env()

IMAGE_DIR = Path(__file__).resolve().parents[2] / "assets" / "products"
IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


async def _startup() -> None:
    db.ensure_ready()


async def _shutdown() -> None:
    db.close()


app = create_channel_app(
    id="shop",
    name="쇼핑몰",
    short="쇼핑",
    description="의류·식품 쇼핑몰의 재고·판매·마케팅·제품정보 조회",
    version="1.2.0",
    channel_type="data",
    icon="shop",
    system_prompt=SYSTEM_PROMPT,
    tools=tools.registry,
    on_startup=_startup,
    on_shutdown=_shutdown,
)


# 제품 사진. 앱이 카드에 바로 띄우므로 API 키 없이 열어둔다.
@app.get("/images/{filename}")
async def product_image(filename: str) -> Response:
    name = Path(filename).name  # 경로 이탈 방지
    media_type = IMAGE_TYPES.get(Path(name).suffix.lower())
    path = IMAGE_DIR / name
    if media_type is None or not path.is_file():
        return Response(status_code=404, content=b"")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})


def run() -> None:
    import uvicorn

    # 기본은 루프백. 외부 노출은 앞단 프록시(TLS)가 맡는다. 직접 열려면 HOST=0.0.0.0.
    uvicorn.run(
        "shop_channel.main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "12001")),
        reload=os.getenv("RELOAD", "").lower() in {"1", "true", "yes"},
    )


if __name__ == "__main__":
    run()
