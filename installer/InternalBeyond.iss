; Internal Beyond · Windows installer (Inno Setup 6)
; ---------------------------------------------------------------------------
; P7 · Release packaging. Per-user, no UAC, no admin rights, no Node.js
; prerequisite, no console window, single user-facing entry point.
;
; Build with:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1
; or directly: ISCC.exe /DStagingDir="<abs staging>" /DAppVersion="<x.y.z>" installer\InternalBeyond.iss
;
; Design rules (do not violate):
;   * The payload comes from the whitelist manifest (scripts/release-manifest.js)
;     staged by the build script — never from the repository directly.
;   * No PATH changes, no registry beyond the uninstall entry, no services,
;     no drivers, no firewall rules, no scheduled tasks.
;   * The only user-visible entry point is "InternalBeyond" (Start menu + optional
;     desktop icon). Development .cmd launchers are not packaged.
;   * A running InternalBeyond is stopped through its own control surface first
;     (tools\ib-stop.js); unrelated node.exe processes are never touched.
; ---------------------------------------------------------------------------

; AppVersion has exactly one source: the repository VERSION file. The build
; script reads it and passes /DAppVersion=... so nothing here is hand-written.
; A direct ISCC run without the define fails loudly instead of guessing.
#ifndef AppVersion
  #error AppVersion is not defined. Build with scripts\build-installer.ps1 (reads VERSION), or pass /DAppVersion=<x.y.z>.
#endif
#ifndef StagingDir
  #define StagingDir AddBackslash(SourcePath) + "..\dist\staging"
#endif
#ifndef OutputDir
  #define OutputDir AddBackslash(SourcePath) + "..\dist"
#endif

#define AppName "InternalBeyond"
#define AppPublisher "InternalBeyond"
#define AppURL "https://github.com/yydye/InternalBeyond"
#define StopHelper "ib-stop.js"

[Setup]
; Stable identity: upgrades replace the same install and never create a second
; copy or a second uninstall entry.
AppId={{78B427F6-A48F-4443-86D5-2F50DC899D07}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}

; per-user / lowest privileges / no UAC prompt
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
DefaultDirName={localappdata}\Programs\InternalBeyond
DisableDirPage=no
UsePreviousAppDir=yes
DefaultGroupName={#AppName}
AllowNoIcons=yes
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableReadyPage=no

; A running instance is stopped by our own helper (friendly, IB-specific);
; Restart Manager's generic "close these programs" dialog is disabled so users
; never see an internal process name.
CloseApplications=no
RestartApplications=no
SetupMutex=InternalBeyondSetupMutex

; Windows 10+ (bundled Node.js 24 requires it); x64 runtime
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

LicenseFile=..\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename={#AppName}-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
Uninstallable=yes
UninstallDisplayName={#AppName} {#AppVersion}
UninstallDisplayIcon={app}\assets\icons\IB-icon.ico
SetupIconFile=..\assets\icons\IB-icon.ico
ChangesAssociations=no
ChangesEnvironment=no
AllowUNCPath=no
CreateUninstallRegKey=yes

[Languages]
; Chinese first: this is the language ordinary users of this build see by
; default. The .isl is the upstream user-contributed translation, vendored at
; installer\languages\ (see its README for provenance); Default.isl supplies
; any message the translation does not define.
Name: "chinesesimplified"; MessagesFile: "compiler:Default.isl,{#SourcePath}\languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Whole whitelisted payload (already audited by the build script).
Source: "{#StagingDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Same helper again, extracted on demand by [Code] before files are replaced.
Source: "{#StagingDir}\tools\{#StopHelper}"; DestDir: "{tmp}"; Flags: dontcopy

[Icons]
; The ONLY user-facing entry point. Users never choose between .cmd / .vbs / .js.
Name: "{group}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\启动 InternalBeyond.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\icons\IB-icon.ico"; Comment: "启动 InternalBeyond"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"; Comment: "卸载 InternalBeyond（个人数据会保留）"
Name: "{autodesktop}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\启动 InternalBeyond.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\icons\IB-icon.ico"; Comment: "启动 InternalBeyond"; Tasks: desktopicon

[Run]
; Finish page: launch through the same silent chain as the shortcuts.
Filename: "{sys}\wscript.exe"; Parameters: """{app}\启动 InternalBeyond.vbs"""; WorkingDir: "{app}"; Description: "启动 {#AppName}"; Flags: nowait postinstall skipifsilent
; Zero-touch update (U-D5): the updater helper has already exited and the old
; instance was stopped by StopInternalBeyond above, so the installer is the only
; thing that can put InternalBeyond back. Gated on the /IBRELAUNCH=1 parameter
; the updater passes (U-D3): an ordinary interactive or silent install passes no
; such parameter and therefore launches nothing here, exactly as before.
Filename: "{sys}\wscript.exe"; Parameters: """{app}\启动 InternalBeyond.vbs"""; WorkingDir: "{app}"; Flags: nowait; Check: WantsRelaunch

[UninstallRun]
; Stop our own instance before program files (including the bundled node.exe)
; are removed. Runs before file deletion; never matches by image name.
Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\tools\{#StopHelper}"" --root ""{app}"""; Flags: runhidden skipifdoesntexist; RunOnceId: "StopInternalBeyond"

[Code]
var
  { Set when a verified-broken install must not be launched automatically. See
    WantsRelaunch below. Empty means "nothing is known to be wrong". }
  RelaunchBlocked: String;

{ ── Relaunch after a zero-touch update (U-D5) ───────────────────────────
  /IBRELAUNCH=1 is passed by the updater helper (U-D3). It is the ONLY way an
  install started by the updater brings the app back, because a silent install
  suppresses the finish-page [Run] entry above. A never-verified runtime is not
  relaunched: the user has just been told the install is broken, and opening an
  app that cannot start would only add a second, more confusing error. }
function WantsRelaunch(): Boolean;
begin
  Result := (ExpandConstant('{param:IBRELAUNCH|0}') = '1') and (RelaunchBlocked = '');
end;

{ ── Product ports ───────────────────────────────────────────────────────
  Defaults are the shipping ports. The IB_* overrides exist so an automated
  smoke run can move the installer's own identity probe onto isolated ports:
  without them the probe would read the developer's instance on 23120/23116
  (harmless but noisy, and impossible to distinguish from the run's own copy). }
function OptionPort(const Name: String; Fallback: Integer): Integer;
var
  Raw: String;
  N: Integer;
begin
  Raw := GetEnv(Name);
  N := StrToIntDef(Raw, 0);
  if (N >= 1) and (N <= 65535) then
    Result := N
  else
    Result := Fallback;
end;

function WebPort(): Integer;
begin
  Result := OptionPort('IB_WEB_PORT', 23120);
end;

function RestartPort(): Integer;
begin
  Result := OptionPort('IB_RESTART_PORT', 23116);
end;

{ ── Locate a usable Node.js: installed runtime first, then PATH ────────── }
function FindNode(): String;
var
  Candidate: String;
begin
  Result := '';
  Candidate := ExpandConstant('{app}\runtime\node\node.exe');
  if FileExists(Candidate) then
  begin
    Result := Candidate;
    exit;
  end;
  Candidate := FileSearch('node.exe', GetEnv('PATH'));
  if Candidate <> '' then
    Result := Candidate;
end;

{ ── Does an InternalBeyond instance answer on its own ports? ───────────── }
function IbIdentityAt(Port: Integer; const Needle: String): Boolean;
var
  Http: Variant;
  Body: String;
begin
  Result := False;
  try
    Http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Http.SetTimeouts(700, 700, 700, 700);
    Http.Open('GET', 'http://127.0.0.1:' + IntToStr(Port) + '/health', False);
    Http.Send('');
    Body := Http.ResponseText;
    Result := Pos(Needle, Body) > 0;
  except
    Result := False;
  end;
end;

function IbRunning(): Boolean;
begin
  Result := IbIdentityAt(WebPort(), 'InternalBeyond Web') or IbIdentityAt(RestartPort(), 'InternalBeyond Restart');
end;

{ ── Wait until the bundled runtime can actually be replaced ──────────────
  An in-place upgrade must not race a dying process: Windows keeps node.exe
  mapped for a moment after the process exits, and continuing too early ends in
  "DeleteFile failed; code 5". The shipped helper's --wait-unlock mode opens the
  file for writing, which fails while it is still mapped. Bounded, no guessing. }
function WaitForRuntimeReplaceable(const NodeExe: String; TimeoutMs: Integer): Boolean;
var
  Code: Integer;
  Params, ProbeExe, Helper: String;
begin
  Result := True;
  if not FileExists(NodeExe) then exit;   { fresh install: nothing to unlock }
  Helper := ExpandConstant('{tmp}\{#StopHelper}');
  Params := '"' + Helper + '" --wait-unlock "' + NodeExe + '"'
    + ' --timeout-ms ' + IntToStr(TimeoutMs);

  { The probe must not run from the very file it probes: a running image locks
    itself, which would report "still locked" forever. Run a temp copy. }
  ProbeExe := ExpandConstant('{tmp}\ib-unlock-probe.exe');
  DeleteFile(ProbeExe);
  if FileCopy(NodeExe, ProbeExe, False) then
  begin
    if not Exec(ProbeExe, Params, ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code) then
      Result := False
    else
      Result := (Code = 0);
    DeleteFile(ProbeExe);
    exit;
  end;

  { No temp copy possible: fall back to any other Node on PATH. }
  ProbeExe := FileSearch('node.exe', GetEnv('PATH'));
  if ProbeExe = '' then
  begin
    Result := False;
    exit;
  end;
  if not Exec(ProbeExe, Params, ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code) then
    Result := False
  else
    Result := (Code = 0);
end;

{ ── Stop our own instance through its control surface ───────────────────
  Returns '' when it is safe to continue, otherwise a user-facing reason. }
function StopInternalBeyond(): String;
var
  Node, Params: String;
  Code: Integer;
begin
  Result := '';
  Node := FindNode();
  if Node = '' then
  begin
    { No runtime available at all (very old copy). If nothing of ours answers,
      there is nothing to stop; otherwise ask the user to close it. }
    if IbRunning() then
      Result := '检测到 InternalBeyond 正在运行，但安装程序找不到可用的运行环境来安全地关闭它。'
        + #13#10#13#10 + '请先手动退出 InternalBeyond（关闭所有 InternalBeyond 窗口，'
        + '并在任务栏右下角确认没有后台进程），然后点击“重试”。'
        + #13#10#13#10 + '安装程序不会强制结束其他程序的进程。';
    exit;
  end;

  ExtractTemporaryFile('{#StopHelper}');
  Params := '"' + ExpandConstant('{tmp}\{#StopHelper}') + '"'
    + ' --root "' + ExpandConstant('{app}') + '"'
    + ' --json --timeout-ms 15000';

  if not Exec(Node, Params, ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    Result := '无法运行停止助手，安装程序没有继续（不会强制结束任何进程）。'
      + #13#10#13#10 + '请先手动退出 InternalBeyond，然后点击“重试”。';
    exit;
  end;

  if Code <> 0 then
  begin
    Result := 'InternalBeyond 似乎仍在运行，自动关闭没有完全成功。'
      + #13#10#13#10 + '请手动退出 InternalBeyond（包括后台进程），然后点击“重试”。'
      + #13#10#13#10 + '安装程序不会结束其他程序的进程，因此需要您确认一次。';
    exit;
  end;

  { Our instance is down, but the file handle may outlive it for a moment.
    Wait (bounded) until runtime\node\node.exe is genuinely replaceable; if it
    still is not, stop here with a clear message instead of continuing into a
    "DeleteFile failed; code 5" rollback. }
  if not WaitForRuntimeReplaceable(ExpandConstant('{app}\runtime\node\node.exe'), 20000) then
    Result := 'InternalBeyond 的运行环境仍被占用，安装程序没有继续。'
      + #13#10#13#10 + '请关闭 InternalBeyond（包括后台进程），然后点击“重试”。'
      + #13#10#13#10 + '安装程序不会强制覆盖正在使用中的文件。';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  NeedsRestart := False;
  Result := StopInternalBeyond();
end;

{ ── Tell the user their data was kept (uninstall never deletes it) ─────── }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    SuppressibleMsgBox('InternalBeyond 已卸载。' + #13#10#13#10
      + '您的个人数据（角色、API 配置、Memory、Diary、朋友圈等）已全部保留，'
      + '不会因为卸载而丢失。' + #13#10#13#10
      + '如需彻底删除，请手动删除此文件夹：' + #13#10
      + ExpandConstant('{localappdata}\InternalBeyond'),
      mbInformation, MB_OK, IDOK);
end;

{ ── Post-install runtime validation (B) ─────────────────────────────────
  The bundled runtime must be present AND runnable before the user is ever told
  to start InternalBeyond: a corrupt runtime must fail loudly here instead of
  half-starting later. Never falls back to a system Node. Returns '' when fine,
  otherwise a user-facing reason; a marker file is left for diagnostics. }
{ ── Post-install runtime validation (B) ─────────────────────────────────
  The bundled runtime must be present AND runnable before the user is ever told
  to start InternalBeyond: a corrupt runtime must fail loudly here instead of
  half-starting later. Never falls back to a system Node. Returns '' when fine,
  otherwise a user-facing reason; a marker file is left for diagnostics. }
function ReadFirstLine(const FileName: String): String;
var
  Lines: TArrayOfString;
begin
  Result := '';
  if LoadStringsFromFile(FileName, Lines) and (GetArrayLength(Lines) > 0) then
    Result := Trim(Lines[0]);
end;

function ValidateBundledRuntime(): String;
var
  Node, CmdFile, OutFile, Reported, Pinned: String;
  Code: Integer;
begin
  Result := '';
  Node := ExpandConstant('{app}\runtime\node\node.exe');
  if not FileExists(Node) then
  begin
    Result := '安装完成后找不到内置运行环境（runtime\node\node.exe），安装包可能不完整。';
    exit;
  end;

  CmdFile := ExpandConstant('{tmp}\ib-runtime-check.bat');
  OutFile := ExpandConstant('{tmp}\ib-runtime-check.txt');
  SaveStringToFile(CmdFile,
    '@echo off' + #13#10 +
    '"' + Node + '" --version > "' + OutFile + '" 2>&1' + #13#10, False);
  if (not Exec(ExpandConstant('{cmd}'), '/c "' + CmdFile + '"', ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Code))
     or (Code <> 0) then
  begin
    Result := '内置运行环境无法启动，安装包可能已损坏。';
    exit;
  end;

  Reported := ReadFirstLine(OutFile);
  Pinned := ReadFirstLine(ExpandConstant('{app}\runtime\node\VERSION'));
  if (Pinned <> '') and (Reported <> ('v' + Pinned)) then
    Result := '内置运行环境版本异常（期望 v' + Pinned + '，实际 ' + Reported + '）。';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Problem: String;
begin
  if CurStep = ssPostInstall then
  begin
    Problem := ValidateBundledRuntime();
    if Problem <> '' then
    begin
      RelaunchBlocked := Problem;
      ForceDirectories(ExpandConstant('{app}\logs'));
      SaveStringToFile(ExpandConstant('{app}\logs\runtime-invalid.txt'),
        Problem + #13#10 + '请重新下载安装包后再试。' + #13#10, False);
      SuppressibleMsgBox(Problem + #13#10#13#10 +
        '请重新下载安装包后再试；如果问题重复出现，请联系支持。',
        mbError, MB_OK, IDOK);
    end;
  end;
end;
