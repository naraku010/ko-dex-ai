; KODEX 채널 서버 설치 마법사 (Inno Setup 6)
;
; 직접 부르지 않는다. channel-exe --release 가 아래 값을 넘겨 컴파일한다.
;   /DAppVersion=1.0.0 /DSourceDir=<패키지 폴더> /DOutputDir=<출력 폴더> /DOutputName=<파일 이름>

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #error SourceDir 를 넘겨주세요 (/DSourceDir=...)
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
#ifndef OutputName
  #define OutputName "kodex-channels-setup"
#endif
#define AppIcon AddBackslash(SourcePath) + "..\..\..\..\frontend\src-tauri\icons\icon.ico"

[Setup]
AppId={{5B7E2C14-3A9D-4F61-8C2E-9D0A6B1F7E43}
AppName=KODEX 채널 서버
AppVersion={#AppVersion}
AppVerName=KODEX 채널 서버 {#AppVersion}
AppPublisher=KODEX
DefaultDirName={commonpf64}\KODEX Channels
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
UninstallDisplayName=KODEX 채널 서버
#if FileExists(AppIcon)
SetupIconFile={#AppIcon}
#endif

[Languages]
#if FileExists(AddBackslash(CompilerPath) + "Languages\Korean.isl")
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
#else
Name: "english"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "service"; Description: "채널을 Windows 서비스로 등록하고 시작 (부팅 시 자동 실행)"
Name: "external"; Description: "다른 PC에서 바로 접속 허용 (HOST=0.0.0.0, 방화벽 포트 열기)"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Dirs]
Name: "{app}\logs"

[Run]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install.ps1"" -Pause{code:InstallArgs}"; \
  StatusMsg: "채널 설정과 서비스 등록 중..."; Flags: waituntilterminated
Filename: "{app}\install-summary.txt"; Description: "접속 주소와 API 키 보기"; \
  Flags: postinstall shellexec skipifsilent skipifdoesntexist

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"""; \
  Flags: runhidden waituntilterminated; RunOnceId: "RemoveServices"

[UninstallDelete]
Type: files; Name: "{app}\install-summary.txt"

[Code]
function InstallArgs(Param: String): String;
begin
  Result := '';
  if not WizardIsTaskSelected('service') then
    Result := Result + ' -NoService';
  if WizardIsTaskSelected('external') then
    Result := Result + ' -BindHost 0.0.0.0 -OpenFirewall';
end;

{ 갱신 설치: 실행 중인 서비스가 exe를 잡고 있으면 덮어쓰지 못한다. 복사 전에 멈춘다. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Script: String;
  Code: Integer;
begin
  Result := '';
  Script := ExpandConstant('{app}\uninstall.ps1');
  if FileExists(Script) then
    Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '" -Upgrade',
      '', SW_HIDE, ewWaitUntilTerminated, Code);
end;
