#!/bin/sh
#
# EGI 채널 서버 자동 설치 파일 (Linux x64)
#
# 이 파일 뒤쪽에 설치 패키지(tar.gz)가 붙어 있다. 임시 폴더에 풀고 install.sh를 부른다.
#
#   sudo sh egi-channels-<버전>-linux-x64.run                 # 기본 설치 (/opt/egi-channels)
#   sudo sh egi-channels-<버전>-linux-x64.run --host 0.0.0.0  # 다른 PC에서 바로 붙게
#   sh egi-channels-<버전>-linux-x64.run --extract ./egi      # 풀기만
#   sh egi-channels-<버전>-linux-x64.run --help
#
# --extract 외의 인자는 모두 install.sh로 넘어간다.

set -eu

SELF="$0"
LINE=$(awk '/^__EGI_PAYLOAD_BELOW__$/ { print NR + 1; exit 0 }' "$SELF")

if [ "${1:-}" = "--extract" ]; then
    DEST="${2:-.}"
    mkdir -p "$DEST"
    tail -n +"$LINE" "$SELF" | tar -xzf - -C "$DEST"
    echo "풀었습니다: $DEST"
    exit 0
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/egi-channels.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM
tail -n +"$LINE" "$SELF" | tar -xzf - -C "$TMP"

PKG=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -n "$PKG" ] || { echo "오류: 설치 패키지를 풀지 못했습니다." >&2; exit 1; }

set +e
bash "$PKG/install.sh" "$@"
CODE=$?
exit "$CODE"
__EGI_PAYLOAD_BELOW__
