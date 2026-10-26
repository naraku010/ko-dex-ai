KODEX 채널 서버 - Linux x64
=========================

Python 없이 도는 채널 서버 실행 파일 묶음입니다. 채널마다 systemd 서비스 하나로 뜹니다.
glibc 2.31 이상이 필요합니다 (Ubuntu 20.04+, Debian 11+, Rocky/RHEL 9+).

설치
----
  sudo ./install.sh                     # 이 폴더에서
  sudo sh kodex-channels-<버전>-linux-x64.run   # 단일 파일로 받았을 때

  다른 PC에서 바로 붙게 하려면 --host 0.0.0.0, 채널을 고르려면 --channel shop.
  자세한 옵션은 ./install.sh --help.

설치가 끝나면 채널 주소와 API 키가 화면과 /opt/kodex-channels/install-summary.txt 에 나옵니다.
앱의 설정 → 채널 → 채널 추가에 그대로 넣습니다.

설정
----
  /opt/kodex-channels/channels/<채널>/.env
    CHANNEL_API_KEYS  앱이 보낼 키. 쉼표로 여러 개
    HOST              127.0.0.1(이 서버만) 또는 0.0.0.0(다른 PC에서 바로)
    PORT              채널마다 다르게
    PUBLIC_BASE_URL   shop 채널 상품 사진 주소. 앱에 등록한 주소와 같게

  바꾼 뒤: sudo systemctl restart kodex-channel-<채널>
  HOST=0.0.0.0 이면 방화벽에서 PORT를 엽니다. 예) sudo ufw allow 12001/tcp

갱신
----
  새 버전 설치 파일을 그대로 다시 실행합니다. .env 와 data/ 는 남습니다.

로그 / 제거
-----------
  journalctl -u kodex-channel-<채널> -f
  sudo /opt/kodex-channels/uninstall.sh          # 서비스만 제거
  sudo /opt/kodex-channels/uninstall.sh --purge  # 폴더까지 삭제
