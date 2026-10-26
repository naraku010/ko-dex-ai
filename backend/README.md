# kodex-channel

`kodex-ai` 데스크톱 앱이 URL로 붙는 채널 서버들. **채널 하나 = 프로젝트 하나**입니다. 한 서버에 다 몰지 않고 따로 뜨고, 따로 배포하고, 따로 API 키를 씁니다.

공통 규격(kodex.channel/v1)은 `packages/channelkit`이 담당하고, 채널 프로젝트는 툴과 프롬프트만 씁니다.

```
packages/channelkit     규격 코어 (manifest·API 키·툴 레지스트리·라우터)
packages/console        채널 관제 (포트 12000)
channels/shop           쇼핑몰 데모 채널 — 12001
templates/channel       새 채널 스캐폴드
```

포트는 관제 12000부터 채널마다 1씩 늘립니다.

## 띄우기

```powershell
cd backend
uv sync --all-packages
uv run kodex-channel            # 채널 목록
uv run kodex-channel shop       # 쇼핑몰 데모 — 12001
.\start-console.ps1           # 관제 — 12000
```

### 쇼핑몰 데모 채널

계정 정보를 요구하지 않고 업스트림도 없어서, 앱을 시연할 때 이 채널만 붙이면 됩니다.

```powershell
Copy-Item channels\shop\.env.example channels\shop\.env
uv run --package shop-channel shop-channel   # http://127.0.0.1:12001
```

제품 24종(의류 12 + 식품 12)과 최근 1년치 재고·판매·소셜·캠페인 데이터를 SQLite로 만들어 조회합니다.
데이터는 씨앗이 고정이라 몇 번 만들어도 같고, 없으면 처음 뜰 때 자동으로 생성됩니다. 끝 날짜가 오늘보다
3일 넘게 밀리면 다시 만들어 데모가 항상 "어제까지"를 보게 합니다. 직접 다시 만들려면 `uv run --package shop-channel shop-seed`.

계절성(겨울 아우터·여름 티셔츠·명절 선물세트·김장), 요일과 급여일, 캠페인 할인, 소셜 반응이 며칠 뒤 매출로
이어지는 관계, 납품 지연으로 인한 품절까지 데이터 안에 들어 있습니다. 데이터 모양을 바꾸려면
`catalog.py`의 기준 수요·계절 계수를, 생성 규칙을 바꾸려면 `seed.py`를 고칩니다.

### 채널 관제

채널은 각각 뜨고, 관제만 한 화면에서 목록·git 갱신·시작/중지를 합니다.

```powershell
.\start-console.ps1   # 0.0.0.0:12000
```

다른 PC에서는 `http://<서버IP>:12000/?token=...` 로 엽니다. `HOST=0.0.0.0`이고 토큰이 비어 있으면 처음 실행할 때 `CONSOLE_TOKEN`을 만들어 `.env`에 넣습니다. 방화벽에서 12000을 열어야 합니다.

```powershell
New-NetFirewallRule -DisplayName 'KODEX console' -Direction Inbound -Protocol TCP -LocalPort 12000 -Action Allow
```

서버에서 관리자 권한으로 띄우면 **업데이트**가 `deploy-channels.ps1`을 그대로 돌립니다(git fetch, 바뀐 채널 NSSM 재시작). 권한이 없으면 git reset과 로컬 프로세스만 재시작합니다.

## 배포 (Windows 서버 + IIS)

채널마다 서비스 하나가 뜹니다. 어디에 바인딩할지는 그 채널 `.env`의 `HOST`로 정합니다.

- `HOST=127.0.0.1` (기본) — 이 서버 안에서만 붙습니다. 앞단 IIS가 TLS를 맡아 경로로 나눠주고,
  앱에 넣는 채널 URL은 `https://<도메인>/shop` 형태가 됩니다.
- `HOST=0.0.0.0` — 프록시 없이 다른 PC에서 바로 붙습니다. 앱에 넣는 URL은 `http://<서버IP>:<PORT>`이고,
  방화벽에서 그 포트를 열어야 합니다.

서버에는 git, Python 3.11+, [NSSM](https://nssm.cc)만 있으면 됩니다. uv는 필요 없고,
의존성은 `requirements.txt`(uv.lock에서 뽑은 고정 버전)로 설치합니다.

Python 없이 올리려면 **OS별 설치 파일**을 씁니다. Windows는 `kodex-channels-setup-<버전>-windows-x64.exe`, Linux는 `kodex-channels-<버전>-linux-x64.run`입니다.
설치 파일이 서비스 등록, API 키 생성, 헬스체크까지 합니다. 사용법과 빌드 방법은 [루트 README](../README.md#채널-서버-배포-windowslinux-설치-파일)에 있습니다.

```powershell
# 설치 파일 만들기 (빌드한 OS용으로 나온다). 결과는 dist\release\
uv run --package channel-exe channel-exe --all --release --version 1.0.0
```

채널 하나만 실행 파일로 만들어 저장소 배포 스크립트로 등록할 수도 있습니다.

```powershell
.\build-exe.ps1 shop
# 또는  uv run --package channel-exe channel-exe shop
.\deploy\windows\install-channel-service.ps1 -Channel shop
```

### 처음 올릴 때

```powershell
# 관리자 PowerShell
git clone https://github.com/naraku010/ko-dex-ai.git C:\kodex-channel
cd C:\kodex-channel

# 이 서버에서 돌릴 채널만 .env를 만든다. CHANNEL_API_KEYS와 PORT는 반드시 채운다.
Copy-Item channels\shop\.env.example channels\shop\.env

.\deploy\windows\deploy-channels.ps1
```

`deploy-channels.ps1`이 venv를 만들고 의존성을 깔고 서비스를 등록한 뒤 `/health`까지 확인합니다.

**어떤 채널을 켤지는 `channels\<이름>\.env` 유무로 정합니다.** `.env`는 git에 올라가지 않으니
서버마다 다르게 켤 수 있고, 포트도 그 `.env`의 `PORT`를 그대로 씁니다. 따로 관리할 목록이 없습니다.
키가 `change-me`인 채널은 아직 설정이 안 끝난 것으로 보고 건너뜁니다.

### 갱신

같은 스크립트를 다시 돌리면 됩니다. 받아올 변경이 없으면 아무것도 건드리지 않습니다.

```powershell
.\deploy\windows\deploy-channels.ps1
```

git에서 받은 뒤, 바뀐 내용에 따라 필요한 일만 합니다.

| 무엇이 바뀌었나 | 하는 일 |
| --- | --- |
| 없음 | 그대로 끝 |
| 배포 스크립트, 문서 같은 파이썬 밖 파일 | 코드만 갱신 (재시작 없음) |
| `channels/<이름>` | 그 채널만 재시작 (패키지가 editable이라 재설치가 필요 없습니다) |
| `packages/` 공용 코드 | 전체 채널 재시작 |
| `requirements*.txt`, `pyproject.toml` | `pip install` 후 전체 재시작 |

돌고 있는 프로세스는 파이썬 코드와 라이브러리를 메모리에 물고 있어서, 재시작하지 않으면 갱신된 코드가
반영되지 않습니다. 그래서 의존성을 새로 깔았거나 공용 코드가 바뀐 경우처럼 영향 범위를 채널 하나로
좁힐 수 없을 때는 켜둔 채널을 전부 재시작합니다.

재시작한 채널이 `/health`에 응답하지 않으면 **이전 커밋으로 되돌리고 다시 띄운 뒤** 실패로 끝냅니다.

자동으로 돌리려면 작업 스케줄러에 등록합니다. SYSTEM 계정으로 실행되고 기록은 `logs\update.log`에 쌓입니다.

```powershell
.\deploy\windows\install-update-task.ps1 -IntervalMinutes 15
```

서비스를 건드리지 않고 코드만 받아보려면 `-NoRestart`, 변경이 없어도 강제로 재설치·재시작하려면
`-Force`를 씁니다. `-NoRestart`는 관리자 권한이나 NSSM 없이도 돌아갑니다.

### 프록시 없이 직접 노출

`.env`의 `HOST`를 `0.0.0.0`으로 바꾸고 배포 스크립트를 다시 돌리면 됩니다. 등록 스크립트가 매번
`.env`를 읽어 서비스 설정을 다시 맞추므로, `HOST`나 `PORT`를 바꿔도 그대로 반영됩니다.

```powershell
notepad channels\shop\.env          # HOST=0.0.0.0
.\deploy\windows\deploy-channels.ps1 -Force
New-NetFirewallRule -DisplayName 'KODEX channel shop' -Direction Inbound -Protocol TCP -LocalPort 12001 -Action Allow
```

이미지를 서비스하는 채널(`shop`)은 `PUBLIC_BASE_URL`도 앱에 등록할 주소와 똑같이 맞춰야 합니다.
여기가 루프백으로 남아 있으면 채널은 정상으로 뜨는데 앱에서 상품 사진만 안 나옵니다.

프록시를 건너뛰면 TLS가 없습니다. `X-Channel-Credentials`는 base64일 뿐이라 사용자 비밀번호가
평문으로 흐르니, 사내망 안에서만 쓰는 구성으로 두세요.

### IIS 리버스 프록시

IIS 쪽은 `deploy\windows\iis-channels.example.config`를 사이트 루트에 `web.config`로 두고,
URL Rewrite와 ARR을 설치한 뒤 서버 수준에서 프록시를 한 번 켜줍니다.

```
%windir%\system32\inetsrv\appcmd.exe set config -section:system.webServer/proxy /enabled:"True" /timeout:"00:02:00" /commit:apphost
```

- http와 https를 모두 받습니다. 사이트 바인딩에 80과 443을 다 넣으면 앱에는 어느 쪽을 등록해도 됩니다.
  다만 `X-Channel-Credentials`는 base64일 뿐 암호화가 아니라 **http로 열면 사용자 비밀번호가 평문으로 흐릅니다.**
  사내망 안에서만 쓸 때의 선택지로 두고, VPN·외부 노출 구간은 https를 쓰세요.
  사설 인증서는 앱(Node fetch)이 거부하니 https를 쓸 때는 정식 인증서나 사내 CA가 필요합니다.
- 방화벽은 쓰는 포트(80/443)만 엽니다. `HOST=127.0.0.1`이면 채널 포트는 루프백이라 프록시를 우회할 수 없습니다.
- `CHANNEL_API_KEYS`가 비면 인증 없이 열립니다. 설치 스크립트가 이걸 막지만, 키는 채널마다 다르게 주세요.
- 워커를 늘리면 업스트림 토큰 캐시가 프로세스마다 생겨 로그인 호출이 그만큼 늘어납니다. 1 워커로 시작하세요.
- 채널 추가는 `.env` 하나와 rewrite 규칙 한 줄이면 끝입니다. 다음 갱신 때 서비스가 알아서 등록됩니다.
- `git reset --hard`로 원격 상태에 맞추므로 서버에서 추적 파일을 직접 고치면 지워집니다.
  `.env`와 `channels\*\data\`는 git 밖이라 그대로 남습니다.
- `deploy\windows\*.ps1`과 `requirements*.txt`는 **BOM 포함 UTF-8**로 저장해야 합니다.
  PowerShell 5.1과 pip은 BOM이 없으면 이 파일들을 시스템 코드페이지(cp949)로 읽어서 한글 주석에서 깨집니다.

## 규격

| 엔드포인트 | 설명 |
| --- | --- |
| `GET /channel.json` | manifest (채널 정보 + 툴 목록 + 요구하는 계정 항목) |
| `POST /credentials/verify` | 사용자가 입력한 계정 정보 확인 |
| `POST /tools/{name}` | 툴 실행. 본문은 인자 JSON |
| `GET /health` | 상태 확인 (키 불필요) |

헤더: `X-Channel-Key`(API 키), `X-User-Id`, `X-User-Name`(퍼센트 인코딩), `X-User-Role`,
`X-Channel-Credentials`(계정 정보, base64(JSON)).
응답: `{"ok": true, "data": ...}` 또는 `{"ok": false, "error": "..."}`.

## 화면에 카드 띄우기

`data`는 AI가 읽는 값이라 이미지처럼 텍스트로 옮길 수 없는 건 담아도 소용이 없습니다. 그럴 때는 `ToolResult`로
표시 지시를 함께 보냅니다. 앱이 툴 응답의 `ui`를 보고 상품 카드를 바로 그리기 때문에, AI가 별도 툴을 부르지
않아도 화면에 나옵니다.

```python
from channelkit import ToolResult, card, cards

return ToolResult(
    data={"제품": [...]},                       # AI가 읽는 값
    ui=[cards("추천 상품", [                     # 앱이 그리는 값
        card(
            title="오버사이즈 코튼 후드",
            subtitle="의류 · 상의",
            image="https://.../images/AP-HOOD-01.jpg",
            badge="AP-HOOD-01",
            fields={"판매가": "59,000원", "현재고": "1,240개"},
        ),
    ])],
)
```

블록 4개, 블록당 카드 12장, 카드당 필드 6개까지입니다. `image`는 `http`/`https`만 되고 앱이 그대로 `<img>`로
받아가니, 프록시 뒤에 있으면 채널이 만드는 이미지 주소를 공개 주소로 맞춰야 합니다(shop 채널의 `PUBLIC_BASE_URL`).
프롬프트에는 이미지 주소를 답변 본문에 쓰지 말라고 적어두는 편이 좋습니다.

HTML 리포트는 `ui=[report(title="일일 현황", html="<!doctype html>...")]` 입니다. 완성된 문서만 넣고
스크립트는 쓰지 않습니다. 앱이 메시지 안 iframe으로 그립니다. HTML은 `data`에 넣지 않습니다.

## 계정 정보

채널 서버는 업스트림 공용 계정을 갖지 않습니다. 필요한 항목을 manifest에 선언하면 앱이 사용자에게 입력받아
요청마다 `X-Channel-Credentials`로 넘깁니다. 채널은 그 계정으로 업스트림에 로그인하고 토큰을 계정별로 캐시합니다.

```python
credentials=(
    CredentialField(key="user_id", label="CLM 아이디", secret=False, hint="그룹웨어 아이디"),
    CredentialField(key="password", label="CLM 비밀번호"),
),
verify_credentials=clm.verify,   # 앱이 저장 전에 한 번 부른다
```

핸들러에서는 `creds` 인자로 받습니다.

```python
async def get_stock(args: DateArgs, user: RequestUser, creds: Credentials) -> Any:
    account = creds.require("user_id")
```

필수 항목이 비어 있으면 라우터가 툴을 부르지 않고 `{"ok": false, "needsCredentials": true}`로 돌려주고,
앱이 사용자에게 다시 입력받습니다.

## 새 채널 만들기

```powershell
Copy-Item -Recurse templates\channel channels\<이름>
```

1. `pyproject.toml`의 `name`, `project.scripts`, `packages` 경로를 바꿉니다.
2. `src/<패키지>/main.py`의 `id`(영문 소문자·숫자·하이픈), `name`, `short`, `PORT`를 정합니다.
3. `tools.py`에 `@registry.tool`로 툴을 추가합니다. 인자는 pydantic 모델로 쓰면 manifest의 `inputSchema`가 자동으로 만들어집니다.
4. 업스트림에 사용자 계정이 필요하면 `main.py`에 `credentials=`를 선언합니다.
5. `uv sync --all-packages` 후 `uv run --package <name> <script>`로 띄웁니다.

툴 인자는 평면 object만 됩니다. 문자열·숫자·불린과 그 배열, `Literal`(enum)까지. 중첩 object는 CLI가 인자를 자주 틀려서 규격에서 제외했습니다.

툴 이름으로 `whoami`, `render_chart`, `propose_followups`는 쓸 수 없습니다. 앱이 항상 올리는 툴입니다.
