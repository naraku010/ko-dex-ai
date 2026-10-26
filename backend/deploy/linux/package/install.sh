#!/usr/bin/env bash
#
# EGI 채널 서버 설치 (Linux x64, Python 필요 없음)
#
# 하는 일
#   1. 패키지의 채널들을 설치 폴더(기본 /opt/egi-channels)에 복사한다
#   2. 채널마다 .env 가 없으면 .env.example 로 만들고 API 키를 새로 뽑아 넣는다
#   3. systemd 서비스 egi-channel-<채널> 로 등록하고 /health 응답까지 확인한다
#   4. 앱에 넣을 주소와 키를 install-summary.txt 에 남긴다
#
# 다시 실행하면 갱신이다. 실행 파일만 바꾸고 .env 와 data/ 는 그대로 둔다.
#
# 사용
#   sudo ./install.sh
#   sudo ./install.sh --channel shop --host 0.0.0.0
#   sudo ./install.sh --prefix /srv/egi --user egi --no-service
#
# 옵션
#   --prefix DIR      설치 폴더 (기본 /opt/egi-channels)
#   --channel NAME    이 채널만 설치. 여러 번 쓰거나 쉼표로 이을 수 있다
#   --host ADDR       새로 만드는 .env 의 HOST. 0.0.0.0 이면 다른 PC에서 바로 붙는다
#   --user NAME       서비스를 돌릴 계정 (기본 egi-channel, 없으면 시스템 계정으로 만든다)
#   --no-service      파일과 .env 만 준비하고 서비스는 등록하지 않는다

set -euo pipefail

PREFIX="/opt/egi-channels"
RUN_USER="egi-channel"
BIND_HOST=""
NO_SERVICE=0
ONLY=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --prefix)     PREFIX="$2"; shift 2 ;;
        --channel)    IFS=',' read -r -a parts <<< "$2"; ONLY+=("${parts[@]}"); shift 2 ;;
        --host)       BIND_HOST="$2"; shift 2 ;;
        --user)       RUN_USER="$2"; shift 2 ;;
        --no-service) NO_SERVICE=1; shift ;;
        -h|--help)    grep '^#' "$0" | sed -e '1d' -e 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "알 수 없는 인자: $1 (--help 참고)" >&2; exit 2 ;;
    esac
done

die()  { echo "오류: $*" >&2; exit 1; }
note() { echo "경고: $*" >&2; }
line() { echo "$*"; }

[[ "$(id -u)" -eq 0 ]] || die "root 권한이 필요합니다. sudo 로 다시 실행해주세요."
[[ "$(uname -s)" == "Linux" ]] || die "Linux 전용 패키지입니다."

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(cat "$SRC/VERSION" 2>/dev/null || echo unknown)"
[[ -d "$SRC/channels" ]] || die "패키지에 channels 폴더가 없습니다: $SRC"

# .env 에서 값 하나를 읽는다. 주석·앞뒤 공백·따옴표를 걷어낸다.
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

# .env 의 KEY=값 줄을 바꾼다. 줄이 없으면 끝에 붙인다.
set_env() {
    local file="$1" key="$2" value="$3"
    if grep -qE "^[[:space:]]*#?[[:space:]]*$key[[:space:]]*=" "$file"; then
        sed -i -E "0,/^[[:space:]]*#?[[:space:]]*$key[[:space:]]*=.*/s||$key=$value|" "$file"
    else
        printf '\n%s=%s\n' "$key" "$value" >> "$file"
    fi
}

new_key() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 24
    else
        head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

mapfile -t PACKAGED < <(find "$SRC/channels" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
[[ ${#PACKAGED[@]} -gt 0 ]] || die "패키지에 채널이 없습니다."

if [[ ${#ONLY[@]} -gt 0 ]]; then
    for name in "${ONLY[@]}"; do
        [[ -d "$SRC/channels/$name" ]] || die "패키지에 없는 채널입니다: $name (있는 채널: ${PACKAGED[*]})"
    done
    TARGETS=("${ONLY[@]}")
else
    TARGETS=("${PACKAGED[@]}")
fi

HAS_SYSTEMD=1
command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] || HAS_SYSTEMD=0
if [[ "$NO_SERVICE" -eq 0 && "$HAS_SYSTEMD" -eq 0 ]]; then
    note "systemd 가 없어 서비스 등록은 건너뜁니다. 실행 파일을 직접 띄우세요."
    NO_SERVICE=1
fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
    line "서비스 계정을 만듭니다: $RUN_USER"
    useradd --system --no-create-home --home-dir "$PREFIX" --shell /usr/sbin/nologin "$RUN_USER" \
        || die "계정을 만들지 못했습니다: $RUN_USER"
fi

line "EGI 채널 서버 $VERSION 설치 → $PREFIX"
mkdir -p "$PREFIX/channels"
for file in install.sh uninstall.sh README.txt VERSION; do
    [[ -f "$SRC/$file" ]] && install -m 0755 "$SRC/$file" "$PREFIX/$file"
done
chmod 0644 "$PREFIX/README.txt" "$PREFIX/VERSION" 2>/dev/null || true

SUMMARY=()
FAILED=()

install_one() {
    local name="$1"
    local from="$SRC/channels/$name"
    local dir="$PREFIX/channels/$name"
    local bin="$dir/$name-channel"
    local service="egi-channel-$name"
    local env_file="$dir/.env"

    if [[ "$NO_SERVICE" -eq 0 ]] && systemctl is-active --quiet "$service"; then
        line "[$name] 실행 중인 서비스를 멈춥니다."
        systemctl stop "$service"
    fi

    # 실행 파일만 갈아 끼운다. .env 와 data/ 는 건드리지 않는다.
    mkdir -p "$dir"
    rm -rf "$dir/_internal" "$dir/templates" "$dir/assets" "$bin"
    cp -a "$from/." "$dir/"
    chmod 0755 "$bin"

    local created=0
    if [[ ! -f "$env_file" ]]; then
        [[ -f "$dir/.env.example" ]] || die "[$name] .env.example 이 없습니다."
        cp "$dir/.env.example" "$env_file"
        created=1
    fi
    local key
    key="$(get_env "$env_file" CHANNEL_API_KEYS)"
    if [[ -z "$key" || "$key" == "change-me" ]]; then
        key="$(new_key)"
        set_env "$env_file" CHANNEL_API_KEYS "$key"
        line "[$name] API 키를 새로 만들었습니다."
    fi
    if [[ "$created" -eq 1 && -n "$BIND_HOST" ]]; then
        set_env "$env_file" HOST "$BIND_HOST"
        # 직접 노출이면 이미지 주소도 이 서버 IP로 맞춘다. 루프백으로 남으면 앱에서 사진이 안 보인다.
        local ip public
        ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
        public="$(get_env "$env_file" PUBLIC_BASE_URL)"
        if [[ -n "$ip" && ( "$public" == *127.0.0.1* || "$public" == *localhost* ) ]]; then
            set_env "$env_file" PUBLIC_BASE_URL "http://$ip:$(get_env "$env_file" PORT)"
        fi
    fi

    mkdir -p "$dir/data"
    chown -R "$RUN_USER:" "$dir"
    chmod 0600 "$env_file"

    local port host
    port="$(get_env "$env_file" PORT)"
    host="$(get_env "$env_file" HOST)"
    [[ -n "$host" ]] || host="127.0.0.1"
    [[ "$port" =~ ^[0-9]+$ ]] || die "[$name] $env_file 의 PORT 가 비었거나 숫자가 아닙니다."

    if [[ "$NO_SERVICE" -eq 0 ]]; then
        cat > "/etc/systemd/system/$service.service" <<EOF
[Unit]
Description=EGI 채널 - $name (egi.channel/v1, ${host}:${port})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$dir
ExecStart=$bin
Restart=always
RestartSec=5
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable "$service" >/dev/null 2>&1 || true
        systemctl restart "$service"

        line "[$name] 기동 확인 중 (http://127.0.0.1:$port/health)..."
        local health="" i
        for i in $(seq 1 60); do
            sleep 1
            health="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/health" 2>/dev/null || true)"
            [[ -n "$health" ]] && break
        done
        if [[ -z "$health" ]]; then
            note "[$name] /health 가 응답하지 않습니다. journalctl -u $service -n 50"
            FAILED+=("$name")
        else
            line "[$name] 정상 $health"
        fi
    fi

    local url="http://127.0.0.1:$port"
    if [[ "$host" != "127.0.0.1" && "$host" != "localhost" ]]; then
        url="http://<서버IP>:$port"
        local public
        public="$(get_env "$env_file" PUBLIC_BASE_URL)"
        if [[ "$public" == *127.0.0.1* || "$public" == *localhost* ]]; then
            note "[$name] PUBLIC_BASE_URL 이 $public 입니다. 앱에서 이미지가 보이려면 공개 주소로 바꾸세요."
        fi
    fi
    SUMMARY+=("$name  주소 $url  키 $key  ($host:$port)")
}

for name in "${TARGETS[@]}"; do
    install_one "$name"
done

{
    echo "EGI 채널 서버 $VERSION"
    echo "설치 폴더: $PREFIX"
    echo
    echo "앱 설정 → 채널 → 채널 추가 에 아래 주소와 키를 넣습니다."
    for item in "${SUMMARY[@]}"; do echo "  $item"; done
} > "$PREFIX/install-summary.txt"
chmod 0600 "$PREFIX/install-summary.txt"

line ""
cat "$PREFIX/install-summary.txt"
line ""
line "설정 바꾸기 : sudo nano $PREFIX/channels/<채널>/.env 후 sudo systemctl restart egi-channel-<채널>"
line "로그        : journalctl -u egi-channel-<채널> -f"
line "제거        : sudo $PREFIX/uninstall.sh"
line "요약 파일   : $PREFIX/install-summary.txt (키가 들어 있어 root만 읽습니다)"

if [[ ${#FAILED[@]} -gt 0 ]]; then
    die "응답하지 않는 채널: ${FAILED[*]}"
fi
