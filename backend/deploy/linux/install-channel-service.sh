#!/usr/bin/env bash
#
# 채널을 리눅스 systemd 서비스로 등록한다.
#
# 하는 일
#   1. venv를 만들고 channelkit과 channels/ 아래 채널 패키지를 모두 설치한다
#   2. .env가 준비된 채널만 systemd 유닛(egi-channel-<채널>.service)으로 띄운다
#   3. http://127.0.0.1:<PORT>/health 로 실제 응답까지 확인한다
#
# .env가 없는 채널은 패키지만 깔고 서비스는 만들지 않는다.
#
# 사용
#   sudo ./install-channel-service.sh
#   sudo ./install-channel-service.sh --channel shop
#   sudo ./install-channel-service.sh --user egi --python python3.11
#
# 외부 노출은 각 채널 .env의 HOST로 정한다.
#   127.0.0.1  → 이 서버 안에서만. 외부 노출은 앞단 프록시가 맡는다.
#   0.0.0.0    → 포트를 직접 연다. 방화벽에서 그 포트를 열어줘야 한다.

set -euo pipefail

ROOT=""
PYTHON="python3"
RUN_USER=""
BIND_HOST=""
PORT=""
ONLY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --channel)     ONLY="$2"; shift 2 ;;
        --root)        ROOT="$2"; shift 2 ;;
        --python)      PYTHON="$2"; shift 2 ;;
        --user)        RUN_USER="$2"; shift 2 ;;
        --host)        BIND_HOST="$2"; shift 2 ;;
        --port)        PORT="$2"; shift 2 ;;
        -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
    esac
done

die()  { echo "오류: $*" >&2; exit 1; }
note() { echo "경고: $*" >&2; }
line() { echo "$*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$ROOT" ]]; then ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"; fi
ROOT="$(cd "$ROOT" && pwd)"

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || die "root 권한이 필요합니다. sudo로 다시 실행해주세요."
    SUDO="sudo"
fi
if [[ -z "$RUN_USER" ]]; then RUN_USER="${SUDO_USER:-$(id -un)}"; fi
id "$RUN_USER" >/dev/null 2>&1 || die "사용자를 찾을 수 없습니다: $RUN_USER"

# .env에서 값 하나를 읽는다. 주석·앞뒤 공백·따옴표를 걷어낸다.
get_env() {
    local file="$1" key="$2" v
    [[ -f "$file" ]] || return 0
    v="$(grep -E "^[[:space:]]*$key[[:space:]]*=" "$file" | tail -n1 || true)"
    [[ -z "$v" ]] && return 0
    v="${v#*=}"
    v="${v%%#*}"
    v="$(echo "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
    printf '%s' "$v"
}

list_channels() {
    local dir name
    for dir in "$ROOT"/channels/*; do
        [[ -d "$dir/src" && -f "$dir/pyproject.toml" ]] || continue
        name="$(basename "$dir")"
        printf '%s\n' "$name"
    done
}

mapfile -t ALL < <(list_channels | sort)
[[ ${#ALL[@]} -gt 0 ]] || die "channels/ 아래에 채널이 없습니다."

if [[ -n "$ONLY" ]]; then
    found=0
    for name in "${ALL[@]}"; do
        [[ "$name" == "$ONLY" ]] && found=1
    done
    [[ "$found" -eq 1 ]] || die "채널 폴더가 없습니다: $ROOT/channels/$ONLY"
fi

VENV="$ROOT/.venv"
VENV_PY="$VENV/bin/python"
if [[ ! -x "$VENV_PY" ]]; then
    line "venv를 만듭니다: $VENV"
    "$PYTHON" -m venv "$VENV"
fi

INSTALL_ARGS=(-r "$ROOT/requirements.lock.txt" -e "$ROOT/packages/channelkit")
for name in "${ALL[@]}"; do
    INSTALL_ARGS+=(-e "$ROOT/channels/$name")
done

line "채널 패키지를 설치합니다: ${ALL[*]}"
"$VENV_PY" -m pip install --quiet --upgrade pip
"$VENV_PY" -m pip install --quiet --disable-pip-version-check "${INSTALL_ARGS[@]}"

ready=()
skipped=()
if [[ -n "$ONLY" ]]; then
    targets=("$ONLY")
else
    targets=("${ALL[@]}")
fi

for name in "${targets[@]}"; do
    env_file="$ROOT/channels/$name/.env"
    example="$ROOT/channels/$name/.env.example"
    if [[ ! -f "$env_file" ]]; then
        if [[ -f "$example" ]]; then
            cp "$example" "$env_file"
            skipped+=("$name (.env를 만들었으니 CHANNEL_API_KEYS를 채운 뒤 다시 실행)")
        else
            skipped+=("$name (.env 없음)")
        fi
        continue
    fi
    keys="$(get_env "$env_file" CHANNEL_API_KEYS)"
    port="$(get_env "$env_file" PORT)"
    if [[ -z "$keys" || "$keys" == "change-me" ]]; then
        skipped+=("$name (CHANNEL_API_KEYS 미설정)")
        continue
    fi
    if [[ -z "$port" || ! "$port" =~ ^[0-9]+$ ]]; then
        skipped+=("$name (PORT 없음)")
        continue
    fi
    ready+=("$name")
done

[[ ${#ready[@]} -gt 0 ]] || die "띄울 채널이 없습니다. channels/<이름>/.env 의 CHANNEL_API_KEYS와 PORT를 채우세요."

start_one() {
    local name="$1"
    local channel_dir="$ROOT/channels/$name"
    local env_file="$channel_dir/.env"
    local package="$name-channel"
    local exe="$VENV/bin/$package"
    local service="egi-channel-$name"
    local unit="/etc/systemd/system/$service.service"
    local bind_host port

    [[ -x "$exe" ]] || die "실행 파일이 없습니다: $exe"

    if [[ -n "$ONLY" && -n "$PORT" ]]; then
        port="$PORT"
    else
        port="$(get_env "$env_file" PORT)"
    fi
    if [[ -n "$ONLY" && -n "$BIND_HOST" ]]; then
        bind_host="$BIND_HOST"
    else
        bind_host="$(get_env "$env_file" HOST)"
        [[ -n "$bind_host" ]] || bind_host="127.0.0.1"
    fi

    line "systemd 유닛을 씁니다: $unit"
    local tmp
    tmp="$(mktemp)"
    cat > "$tmp" <<EOF
[Unit]
Description=EGI 채널 - $name (egi.channel/v1 채널 서버, ${bind_host}:${port})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$channel_dir
Environment=HOST=$bind_host
Environment=PORT=$port
ExecStart=$exe
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    $SUDO install -m 0644 "$tmp" "$unit"
    rm -f "$tmp"
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable "$service" >/dev/null 2>&1 || true
    $SUDO systemctl restart "$service"

    line "기동 확인 중 (http://127.0.0.1:$port/health)..."
    local health="" i
    for i in $(seq 1 60); do
        sleep 1
        if health="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/health" 2>/dev/null)"; then
            break
        fi
        health=""
    done
    [[ -n "$health" ]] || die "$name 서비스는 떴지만 /health 가 응답하지 않습니다. journalctl -u $service -n 50"
    line "정상: $name  $health  (${bind_host}:${port})"
}

for name in "${ready[@]}"; do
    start_one "$name"
done

line ""
line "설치한 패키지: ${ALL[*]}"
line "띄운 서비스  : ${ready[*]}"
if [[ ${#skipped[@]} -gt 0 ]]; then
    line "건너뜀:"
    for item in "${skipped[@]}"; do
        line "  - $item"
    done
fi
