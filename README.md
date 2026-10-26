# KODEX AI

이 저장소에는 두 가지가 들어 있습니다. ERP와 사내 문서를 대화로 조회하는 **Windows 데스크톱 비서**, 그리고 그 비서가 쓰는 조회 도구를 제공하는 **채널 서버**입니다.
작업 기록은 [KODEX](https://ko-dex.com/)에 있습니다. 앱 아이콘도 그 홈페이지의 K 마크를 씁니다.

계정 서버 로그인은 쓰지 않습니다. 앱을 열면 이 PC의 로컬 사용자로 바로 들어갑니다.

- [전체 구조](#전체-구조)
- [폴더 구성](#폴더-구성)
- [빠른 시작](#빠른-시작)
- [프론트엔드 (데스크톱 앱)](#프론트엔드-데스크톱-앱)
- [백엔드 (채널 서버)](#백엔드-채널-서버)
- [채널 서버 배포: Windows·Linux 설치 파일](#채널-서버-배포-windowslinux-설치-파일)
- [설치 파일 만들기](#설치-파일-만들기)
- [채널 설정 (.env)](#채널-설정-env)
- [보안](#보안)
- [문제 해결](#문제-해결)
- [깃에 넣지 않는 것](#깃에-넣지-않는-것)

## 전체 구조

앱은 데이터베이스에 직접 붙지 않습니다. 로컬 MCP 도구만 호출하고, 도구 실행은 채널 서버가 맡습니다.

```
사용자 PC                                          채널 서버 (Windows 또는 Linux)
┌──────────────────────────────────────┐          ┌──────────────────────────────────┐
│ 앱 (Tauri + Next.js)                  │          │ 채널마다 프로세스 하나            │
│  └─ Node 사이드카                      │  HTTP    │  ├─ console   관제          12000 │
│       ├─ Claude Code / Codex CLI,     │ ───────▶ │  ├─ shop      쇼핑몰 데모   12001 │
│       │  또는 Anthropic / OpenAI API  │ X-Channel│  └─ (새 채널)               12002~│
│       └─ 로컬 MCP ── 채널 도구 호출    │   -Key   │                                  │
└──────────────────────────────────────┘          └──────────────────────────────────┘
```

1. 사용자가 질문하면 모델(Claude, GPT)이 채널 도구를 고릅니다.
2. 사이드카의 로컬 MCP가 채널 서버의 `POST /tools/{이름}`을 부릅니다. 헤더에 채널 API 키와 사용자 정보가 붙습니다.
3. 채널 서버가 ERP·DB·파일을 조회해 `{"ok": true, "data": ..., "ui": [...]}`로 돌려줍니다.
4. 모델은 `data`를 읽고 답하고, 앱은 `ui`(차트·카드·엑셀·리포트)를 대화 안에 바로 그립니다.

채널 서버는 공용 업스트림 계정을 갖지 않습니다. 사용자 계정이 필요한 채널은 필요한 항목을 manifest에 적어두고, 앱이 사용자에게 입력받아 요청마다 헤더로 넘깁니다.

## 폴더 구성

```
frontend/                     데스크톱 앱
  app/, components/, store/     화면 (Next.js, React, Zustand)
  sidecar/                      Node 사이드카. 모델 연결, 로컬 MCP, 채널 호출
  src-tauri/                    Tauri 셸 (Rust), 아이콘, NSIS 설치 설정
  scripts/                      빌드·릴리스 PowerShell 스크립트

backend/                      채널 서버
  packages/channelkit/          채널 규격 코어. manifest, API 키, 도구 등록, 라우터, 카드/차트 UI
  packages/channel-exe/         채널을 실행 파일과 OS별 설치 패키지로 묶는 빌더
  packages/console/             채널 관제 화면 (12000)
  channels/<이름>/              채널 하나 = 패키지 하나
  templates/channel/            새 채널 뼈대
  deploy/windows/               저장소째 올리는 배포(NSSM, IIS), 설치 패키지 스크립트(package/)
  deploy/linux/                 systemd 등록, 설치 패키지 스크립트(package/)

.github/workflows/
  release-channels.yml          채널 서버 Windows·Linux 설치 파일 빌드와 릴리스
```

## 빠른 시작

시연만 할 때는 쇼핑몰 데모 채널 하나로 충분합니다. 업스트림도 계정도 필요 없습니다.

```powershell
# 1) 채널 서버
cd backend
uv sync --all-packages
Copy-Item channels\shop\.env.example channels\shop\.env   # CHANNEL_API_KEYS 를 원하는 값으로
uv run --package shop-channel shop-channel                # http://127.0.0.1:12001

# 2) 데스크톱 앱 (다른 터미널)
cd frontend
npm install
npm run tauri:dev
```

앱에서 **설정 → 채널 → 채널 추가**에 `http://127.0.0.1:12001`과 `.env`에 넣은 키를 입력합니다.

개발 환경 없이 채널 서버만 올리려면 [설치 파일](#채널-서버-배포-windowslinux-설치-파일)을 씁니다.

## 프론트엔드 (데스크톱 앱)

| | |
| --- | --- |
| 셸 | Tauri 2, Rust, NSIS 설치 파일, 자동 업데이트 |
| 화면 | Next.js 16 (정적 export), React 19, TypeScript, Tailwind CSS 4 |
| 상태 | Zustand, 로컬 SQLite |
| 사이드카 | Node 20 (설치 파일에 포함), esbuild 번들, MCP SDK |
| 모델 | Claude Code CLI, OpenAI Codex CLI, Claude API, OpenAI API |
| 표시 | ECharts 차트, 상품 카드, 엑셀, HTML 리포트, 달력, 파일 |

### 모델 연결

설정에서 연결을 고릅니다.

- **Claude Code**, **OpenAI Codex**: 이 PC에 CLI를 설치하고 계정으로 로그인합니다. 구독 한도를 씁니다.
- **Claude API**, **OpenAI API**: API 키로 호출합니다. 키는 이 PC의 설정 파일에만 저장되고, 화면에는 끝 4자리만 나옵니다.

### 채널 결과 표시

채널 도구의 응답에 `ui`가 같이 오면 모델이 다시 그리지 않아도 대화 안에 차트·카드·엑셀·리포트가 붙습니다. 사용자 계정이 필요한 채널은 앱이 등록할 때 입력 칸을 띄우고, 저장 전에 `POST /credentials/verify`로 한 번 확인합니다.

### 개발과 빌드

Node.js 20 이상, Rust, Windows가 필요합니다.

| 명령 | 하는 일 |
| --- | --- |
| `npm run tauri:dev` | 데스크톱 앱 개발 실행 |
| `npm run dev` | 브라우저로 화면만 확인. 채널 호출과 파일 저장은 사이드카가 있어야 됩니다 |
| `npm run tauri:build` | NSIS 설치 파일 생성 (`src-tauri/target/release/bundle/nsis/`) |
| `npm run release` | 업데이트 서명과 GitHub 릴리스 게시 (`scripts/publish-update.ps1`) |

설치 파일 빌드 전에 `prepare:node`가 포함할 Node 실행 파일을 `src-tauri/binaries/`에 받아 둡니다. 앱의 자동 업데이트는 GitHub 릴리스의 `latest.json`을 봅니다.

## 백엔드 (채널 서버)

| | |
| --- | --- |
| 런타임 | Python 3.11, uv |
| API | FastAPI, Pydantic, Uvicorn |
| 규격 | `kodex.channel/v1`. `packages/channelkit`이 manifest, API 키, 도구 등록, 라우터를 맡습니다 |
| 배포 | OS별 설치 파일(Python 불필요), 또는 저장소째 올리고 NSSM/systemd 등록 |

### 채널 규격

채널 하나의 규격은 같습니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/channel.json` | 채널 이름, 도구 목록과 입력 스키마, 필요한 계정 항목 |
| POST | `/credentials/verify` | 사용자가 입력한 계정 확인 |
| POST | `/tools/{name}` | 도구 실행. 본문은 인자 JSON |
| GET | `/health` | 상태. API 키 없이 확인 |

요청 헤더는 `X-Channel-Key`(API 키), `X-User-Id`, `X-User-Name`(퍼센트 인코딩), `X-User-Role`, `X-Channel-Credentials`(계정 정보, base64(JSON))입니다.
응답은 `{"ok": true, "data": ...}` 또는 `{"ok": false, "error": "..."}`이고, 계정이 비면 `{"ok": false, "needsCredentials": true}`가 옵니다.

### 채널과 포트

포트는 관제 12000부터 채널마다 하나씩 올립니다.

| 채널 | 포트 | 하는 일 |
| --- | --- | --- |
| console | 12000 | 채널 목록, 시작과 중지, git 갱신 |
| shop | 12001 | 계정 없이 붙는 쇼핑몰 데모. 상품 24종과 1년치 재고·판매·캠페인 데이터 |

새 채널은 12002부터 씁니다. 만드는 방법은 [`backend/README.md`](backend/README.md#새-채널-만들기)에 있습니다. 설치 파일에는 빌드할 때 `backend/channels/` 아래에 있는 채널이 모두 들어갑니다.

### 개발 실행

```powershell
cd backend
uv sync --all-packages
uv run kodex-channel            # 채널 목록
uv run kodex-channel shop       # .env 가 없으면 .env.example 로 만들고 띄운다
.\start-console.ps1           # 관제 (12000)
```

새 채널 만들기, 카드·리포트 응답, 계정 항목 선언은 [`backend/README.md`](backend/README.md)에 있습니다.

## 채널 서버 배포: Windows·Linux 설치 파일

채널 서버는 OS별로 나눈 설치 파일로 배포합니다. Python이나 uv 없이 돌고, 채널마다 서비스로 등록됩니다. 파일은 GitHub 릴리스(`channels-v*` 태그)에서 받습니다.

| OS | 파일 | 형태 |
| --- | --- | --- |
| Windows x64 | `kodex-channels-setup-<버전>-windows-x64.exe` | 설치 마법사 |
| Windows x64 | `kodex-channels-<버전>-windows-x64.zip` | 압축 + `install.ps1` |
| Linux x64 | `kodex-channels-<버전>-linux-x64.run` | 단일 파일 자동 설치 |
| Linux x64 | `kodex-channels-<버전>-linux-x64.tar.gz` | 압축 + `install.sh` |

두 OS 모두 설치할 때 하는 일은 같습니다.

1. 채널 실행 파일을 설치 폴더에 복사합니다.
2. 채널마다 `.env`가 없으면 `.env.example`로 만들고 **API 키를 새로 생성**해 넣습니다.
3. 채널마다 서비스를 등록하고 `/health` 응답까지 확인합니다.
4. 앱에 넣을 주소와 키를 `install-summary.txt`에 남깁니다.

다시 설치하면 갱신입니다. 실행 파일만 바꾸고 `.env`와 `data/`는 그대로 둡니다.

### Windows

요구 사항: Windows 10 / Server 2016 이상 x64, 관리자 권한.

1. `kodex-channels-setup-<버전>-windows-x64.exe`를 실행합니다.
2. 설치 폴더를 고릅니다. 기본은 `C:\Program Files\KODEX Channels`입니다.
3. 옵션을 고릅니다.
   - **Windows 서비스로 등록하고 시작**: 기본으로 켜져 있습니다. 끄면 `.env`만 만들어 둡니다.
   - **다른 PC에서 바로 접속 허용**: `HOST=0.0.0.0`으로 두고 방화벽 포트를 엽니다. 프록시를 둘 거면 끈 채로 둡니다.
4. 끝나면 콘솔 창에 채널별 주소와 키가 나오고, 완료 화면에서 `install-summary.txt`를 열 수 있습니다.

| 항목 | 위치 |
| --- | --- |
| 서비스 | `KodexChannel-<채널>` (자동 시작, 죽으면 5초 뒤 재시작) |
| 설정 | `<설치 폴더>\channels\<채널>\.env` |
| 데이터 | `<설치 폴더>\channels\<채널>\data\` |
| 로그 | `<설치 폴더>\logs\<채널>.out.log`, `.err.log` (10MB마다 교체) |
| 제거 | 제어판 → 프로그램 제거 → KODEX 채널 서버. 서비스와 방화벽 규칙을 지우고 `.env`와 데이터는 남깁니다 |

zip으로 받았으면 원하는 폴더에 풀고 관리자 PowerShell에서 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Channel shop -BindHost 0.0.0.0 -OpenFirewall
powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoService      # .env 만 준비
```

서비스 관리는 다음과 같습니다.

```powershell
Get-Service KodexChannel-*
Restart-Service KodexChannel-shop          # .env 를 고친 뒤
Get-Content "C:\Program Files\KODEX Channels\logs\shop.err.log" -Tail 50 -Wait
```

### Linux

요구 사항: x64, systemd, glibc 2.31 이상 (Ubuntu 20.04+, Debian 11+, Rocky/RHEL 9+), root 권한.

```bash
sudo sh kodex-channels-<버전>-linux-x64.run                       # 기본 설치 (/opt/kodex-channels)
sudo sh kodex-channels-<버전>-linux-x64.run --host 0.0.0.0        # 다른 PC에서 바로 접속
sudo sh kodex-channels-<버전>-linux-x64.run --channel shop        # 채널 골라서
sh kodex-channels-<버전>-linux-x64.run --extract ./kodex            # 풀기만
```

tar.gz로 받았으면 `tar xzf kodex-channels-<버전>-linux-x64.tar.gz && sudo ./kodex-channels-<버전>-linux-x64/install.sh`입니다.

| 옵션 | 설명 |
| --- | --- |
| `--prefix DIR` | 설치 폴더. 기본 `/opt/kodex-channels` |
| `--channel NAME` | 이 채널만. 여러 번 쓰거나 쉼표로 잇습니다 |
| `--host ADDR` | 새로 만드는 `.env`의 `HOST`. `0.0.0.0`이면 `PUBLIC_BASE_URL`도 서버 IP로 맞춥니다 |
| `--user NAME` | 서비스 실행 계정. 기본 `kodex-channel` (없으면 로그인 불가 시스템 계정으로 생성) |
| `--no-service` | 파일과 `.env`만 준비 |

| 항목 | 위치 |
| --- | --- |
| 서비스 | `kodex-channel-<채널>.service` (부팅 시 시작, 죽으면 5초 뒤 재시작) |
| 설정 | `/opt/kodex-channels/channels/<채널>/.env` (권한 600, 서비스 계정 소유) |
| 데이터 | `/opt/kodex-channels/channels/<채널>/data/` |
| 로그 | `journalctl -u kodex-channel-<채널> -f` |
| 제거 | `sudo /opt/kodex-channels/uninstall.sh` (서비스만), `--purge` (폴더까지) |

`HOST=0.0.0.0`이면 방화벽에서 포트를 엽니다. 예: `sudo ufw allow 12001/tcp`, `sudo firewall-cmd --add-port=12001/tcp --permanent && sudo firewall-cmd --reload`.

### 앱에 연결

`install-summary.txt`의 주소와 키를 앱의 **설정 → 채널 → 채널 추가**에 넣습니다.

- 같은 PC: `http://127.0.0.1:<PORT>`
- 직접 노출(`HOST=0.0.0.0`): `http://<서버IP>:<PORT>`
- 프록시 뒤: `https://<도메인>/<채널>` (IIS 예시는 `backend/deploy/windows/iis-channels.example.config`)

## 설치 파일 만들기

PyInstaller는 교차 빌드가 안 됩니다. Windows 파일은 Windows에서, Linux 파일은 Linux에서 만듭니다. 보통은 CI가 둘 다 만듭니다.

### CI (권장)

```bash
git tag channels-v1.0.0
git push origin channels-v1.0.0
```

`.github/workflows/release-channels.yml`이 다음 순서로 진행합니다.

1. Windows(`windows-latest`)와 Linux(`python:3.11-bullseye` 컨테이너, glibc 2.31) 빌드를 동시에 돌립니다.
2. Windows 빌드는 NSSM을 패키지에 넣고 Inno Setup으로 `setup.exe`를 만듭니다.
3. 각 OS에서 shop 실행 파일을 띄워 `/health`와 상품 이미지 응답까지 확인합니다.
4. 네 파일과 `SHA256SUMS.txt`를 GitHub 릴리스에 올립니다.

이 릴리스는 **latest로 표시하지 않습니다.** 데스크톱 앱 자동 업데이트가 `releases/latest/download/latest.json`을 보기 때문에, 채널 릴리스가 latest가 되면 앱 업데이트가 끊깁니다.

태그 없이 Actions 화면에서 직접 실행하면 릴리스 없이 아티팩트로만 남습니다.

### 로컬

```powershell
cd backend
uv sync --all-packages
uv run --package channel-exe channel-exe shop                       # 실행 파일만 → dist\shop-channel\
uv run --package channel-exe channel-exe --all --release --version 1.0.0
```

`--release`의 결과는 `backend/dist/release/`에 생깁니다.

| 빌드한 OS | 결과 |
| --- | --- |
| Windows | `.zip`. [Inno Setup 6](https://jrsoftware.org/isinfo.php)이 있으면 `setup.exe`도 만듭니다 (`--iscc`로 경로 지정 가능) |
| Linux | `.tar.gz`와 `.run` |

Windows 패키지에 넣을 `nssm.exe`는 `--nssm C:\tools\nssm.exe`로 줍니다. 없으면 PATH에서 찾고, 그래도 없으면 빼고 만듭니다. 이 경우 설치하는 PC에 NSSM이 있어야 합니다.

패키지 안의 모양은 두 OS가 같습니다.

```
kodex-channels-<버전>-<os>-x64/
  VERSION, README.txt
  install.ps1, uninstall.ps1, tools/nssm.exe     Windows
  install.sh, uninstall.sh                       Linux
  channels/<채널>/
    <채널>-channel[.exe]   실행 파일
    _internal/             Python 런타임과 라이브러리
    assets/, templates/    채널이 쓰는 파일 (있을 때)
    .env.example
```

설치 스크립트 원본은 `backend/deploy/windows/package/`, `backend/deploy/linux/package/`에 있습니다. Windows 스크립트(`.ps1`, `.iss`)는 BOM 포함 UTF-8로 저장해야 PowerShell 5.1과 Inno Setup이 한글을 제대로 읽습니다. Linux 스크립트는 `.gitattributes`로 LF를 유지합니다.

## 채널 설정 (.env)

채널마다 `.env` 하나입니다. 공통 항목은 다음과 같습니다.

| 키 | 설명 |
| --- | --- |
| `CHANNEL_API_KEYS` | 앱이 `X-Channel-Key`로 보낼 키. 쉼표로 여러 개. 비우면 인증 없이 열리므로 설치 스크립트가 막고 새로 생성합니다 |
| `HOST` | `127.0.0.1`(이 서버 안에서만, 프록시가 외부 노출) 또는 `0.0.0.0`(포트 직접 노출) |
| `PORT` | 채널마다 다르게 |
| `PUBLIC_BASE_URL` | shop 채널. 앱이 상품 사진을 받아갈 주소로, 앱에 등록한 채널 주소와 같아야 합니다 |
| `SHOP_DB_PATH` | shop 채널. 데모 DB 위치. 비우면 `data/demo.db` |

채널별 항목(ERP 접속 정보 등)은 각 채널의 `.env.example`에 설명이 있습니다. `.env`를 고친 뒤에는 서비스를 재시작합니다. 실행 파일은 자기 옆의 `.env`를 먼저 읽습니다.

## 보안

- 채널 키는 채널마다 다르게 줍니다. 설치 스크립트가 만든 키는 24바이트 난수입니다.
- `X-Channel-Credentials`는 base64일 뿐 암호화가 아닙니다. `HOST=0.0.0.0`으로 직접 노출하면 TLS가 없어서 사용자 계정 정보가 평문으로 흐릅니다. 사내망 밖에서 쓰면 TLS 프록시를 앞에 둡니다.
- 앱(Node fetch)은 사설 인증서를 거부합니다. https에는 정식 인증서나 사내 CA가 필요합니다.
- Linux에서 서비스는 로그인할 수 없는 시스템 계정으로 돌고, `.env`와 `install-summary.txt`는 권한 600입니다.
- `.env`와 `install-summary.txt`에는 키가 들어 있으니 공유 폴더나 깃에 올리지 않습니다.

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| 설치 끝에 `/health가 응답하지 않습니다` | Windows `logs\<채널>.err.log`, Linux `journalctl -u kodex-channel-<채널> -n 50`. 포트 충돌이면 `.env`의 `PORT`를 바꾸고 다시 설치합니다 |
| 처음 시작이 느림 | shop은 처음 뜰 때 1년치 데모 DB를 만듭니다. 최대 1분 정도 걸립니다 |
| 앱에서 채널은 붙는데 상품 사진만 안 보임 | `PUBLIC_BASE_URL`이 `127.0.0.1`로 남아 있습니다. 앱에 등록한 주소로 바꾸고 재시작합니다 |
| 다른 PC에서 안 붙음 | `HOST=0.0.0.0`인지, 방화벽 포트가 열렸는지 확인합니다 |
| 401 / 키 오류 | 앱에 넣은 키가 `.env`의 `CHANNEL_API_KEYS` 중 하나와 같은지 확인합니다 |
| Windows 설치 중 `NSSM을 찾을 수 없습니다` | `tools\nssm.exe`가 빠진 패키지입니다. `winget install NSSM.NSSM` 후 다시 실행합니다 |
| Linux에서 `GLIBC_2.xx not found` | glibc 2.31 미만 배포판입니다. 지원 배포판을 쓰거나 저장소째 배포(`backend/deploy/linux/install-channel-service.sh`)를 씁니다 |

## 깃에 넣지 않는 것

루트 `.gitignore`가 의존성과 비밀, 로컬 데이터를 제외합니다.

- `node_modules`, `.next`, Tauri `target`, 사이드카 번들과 `.data`
- Python `.venv`, `__pycache__`, `dist`, `build` (설치 파일 빌드 결과 포함)
- `.env` (`.env.example`은 포함)
- 채널이 만든 `channels/*/data`, 로그
- 포함된 Node 실행 파일 `src-tauri/binaries/*.exe`

첫 커밋 전에 예제 파일이 아닌 `.env`가 스테이징되지 않았는지 확인합니다.
