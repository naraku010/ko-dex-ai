from __future__ import annotations

import argparse
import os
import secrets
import webbrowser
from pathlib import Path

from dotenv import load_dotenv


def _env_file() -> Path:
    return Path(__file__).resolve().parents[2] / ".env"


def _load_env() -> None:
    path = _env_file()
    if path.is_file():
        load_dotenv(path, override=False)
    cwd = Path.cwd() / ".env"
    if cwd.is_file() and cwd.resolve() != path.resolve():
        load_dotenv(cwd, override=False)


def _ensure_token(host: str) -> str:
    token = os.getenv("CONSOLE_TOKEN", "").strip()
    loopback = host in {"127.0.0.1", "localhost", "::1"}
    if token or loopback:
        return token
    token = secrets.token_urlsafe(18)
    path = _env_file()
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    if "CONSOLE_TOKEN=" in text:
        lines = []
        for line in text.splitlines():
            if line.startswith("CONSOLE_TOKEN="):
                lines.append(f"CONSOLE_TOKEN={token}")
            else:
                lines.append(line)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    else:
        extra = f"\nCONSOLE_TOKEN={token}\n"
        path.write_text((text.rstrip() + extra) if text.strip() else extra.lstrip(), encoding="utf-8")
    os.environ["CONSOLE_TOKEN"] = token
    print(f"외부 접속용 토큰을 만들었습니다. {path}")
    print(f"CONSOLE_TOKEN={token}")
    return token


def main() -> None:
    _load_env()
    parser = argparse.ArgumentParser(description="EGI 채널 관제")
    parser.add_argument("--host", default=os.getenv("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "12000")))
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    token = _ensure_token(args.host)
    if token:
        os.environ["CONSOLE_TOKEN"] = token

    print(f"관제: http://<서버주소>:{args.port}/")
    if token:
        print(f"토큰을 넣어 여세요. 예: http://<서버주소>:{args.port}/?token={token}")

    if not args.no_browser:
        query = f"?token={token}" if token else ""
        webbrowser.open(f"http://127.0.0.1:{args.port}/{query}")

    import uvicorn

    uvicorn.run("egi_console.app:app", host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()
