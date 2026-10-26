from __future__ import annotations

import os

from channelkit import create_channel_app
from dotenv import load_dotenv

from . import tools
from .prompt import SYSTEM_PROMPT

load_dotenv()

app = create_channel_app(
    id="example",
    name="예시 채널",
    short="EX",
    description="무엇을 조회하는 채널인지 한 줄로",
    version="1.0.0",
    channel_type="data",
    icon="cog",
    system_prompt=SYSTEM_PROMPT,
    tools=tools.registry,
    # 업스트림에 사용자 계정이 필요하면 여기에 선언한다. 앱이 사용자에게 받아서 요청마다 넘긴다.
    # credentials=(
    #     CredentialField(key="user_id", label="아이디", secret=False),
    #     CredentialField(key="password", label="비밀번호"),
    # ),
    # verify_credentials=my_verify,   # 저장 전에 로그인해 보고 싶으면
)


def run() -> None:
    import uvicorn

    # 기본은 루프백. 외부 노출은 앞단 프록시(TLS)가 맡는다. 직접 열려면 HOST=0.0.0.0.
    uvicorn.run(
        "example_channel.main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8802")),
        reload=os.getenv("RELOAD", "").lower() in {"1", "true", "yes"},
    )


if __name__ == "__main__":
    run()
