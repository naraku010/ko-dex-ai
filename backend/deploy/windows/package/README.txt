KODEX 채널 서버 - Windows x64
===========================

Python 없이 도는 채널 서버 실행 파일 묶음입니다. 채널마다 Windows 서비스 하나(KodexChannel-<채널>)로 뜹니다.
Windows 10 / Server 2016 이상, 관리자 권한이 필요합니다.

설치
----
  setup.exe 로 받았으면 실행해서 다음만 누르면 됩니다.
    - "Windows 서비스로 등록"      기본 켜짐. 끄면 .env 만 만들어 둡니다.
    - "다른 PC에서 바로 접속 허용"  HOST=0.0.0.0 으로 두고 방화벽 포트를 엽니다.

  zip 으로 받았으면 원하는 폴더에 풀고 관리자 PowerShell 에서:
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Channel shop -BindHost 0.0.0.0 -OpenFirewall

설치가 끝나면 채널 주소와 API 키가 install-summary.txt 에 나옵니다.
앱의 설정 → 채널 → 채널 추가에 그대로 넣습니다.

설정
----
  <설치 폴더>\channels\<채널>\.env
    CHANNEL_API_KEYS  앱이 보낼 키. 쉼표로 여러 개
    HOST              127.0.0.1(이 PC만) 또는 0.0.0.0(다른 PC에서 바로)
    PORT              채널마다 다르게
    PUBLIC_BASE_URL   shop 채널 상품 사진 주소. 앱에 등록한 주소와 같게

  바꾼 뒤: Restart-Service KodexChannel-<채널>
  HOST/PORT 를 바꿨으면 install.ps1 을 다시 실행하면 서비스 설명과 방화벽까지 다시 맞춥니다.

갱신
----
  새 버전 setup.exe 를 그대로 실행합니다. .env 와 data\ 는 남습니다.

로그 / 제거
-----------
  <설치 폴더>\logs\<채널>.out.log, <채널>.err.log
  제어판 → 프로그램 제거 → "KODEX 채널 서버". 서비스와 방화벽 규칙을 지우고, .env 와 데이터는 남깁니다.

문의
----
  설치나 사용 중 문제가 있으면 naraku010@gmail.com 로 보내주세요.
  버전(VERSION 파일)과 로그를 함께 보내주시면 빠르게 확인할 수 있습니다.
