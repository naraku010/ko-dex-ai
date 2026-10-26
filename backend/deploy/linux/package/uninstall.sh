#!/usr/bin/env bash
#
# EGI 채널 서버 제거 (Linux)
#
#   sudo /opt/egi-channels/uninstall.sh            # 서비스만 지운다. .env 와 data/ 는 남긴다
#   sudo /opt/egi-channels/uninstall.sh --purge    # 설치 폴더까지 통째로 지운다

set -euo pipefail

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

[[ "$(id -u)" -eq 0 ]] || { echo "오류: sudo 로 실행해주세요." >&2; exit 1; }

PREFIX="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v systemctl >/dev/null 2>&1; then
    for unit in /etc/systemd/system/egi-channel-*.service; do
        [[ -f "$unit" ]] || continue
        # 이 설치 폴더의 채널만 지운다. 저장소에서 직접 등록한 서비스는 건드리지 않는다.
        grep -q "^ExecStart=$PREFIX/" "$unit" || continue
        service="$(basename "$unit" .service)"
        echo "서비스 제거: $service"
        systemctl disable --now "$service" >/dev/null 2>&1 || true
        rm -f "$unit"
    done
    systemctl daemon-reload
fi

if [[ "$PURGE" -eq 1 ]]; then
    echo "설치 폴더 삭제: $PREFIX"
    rm -rf "$PREFIX"
else
    echo "서비스를 지웠습니다. .env 와 데이터는 $PREFIX 에 남아 있습니다 (--purge 로 모두 삭제)."
fi
