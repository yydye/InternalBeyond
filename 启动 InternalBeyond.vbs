' 启动 InternalBeyond.vbs — 傻瓜式单击启动器（Windows）
' 只负责启动编排：定位自身目录、切换工作目录、隐藏窗口、检测 Node、调用
' launch-internal-beyond.js（唯一真实启动逻辑）。
' 不做任何业务判断（Bridge 检测/健康检查/端口/超时/浏览器打开全部在 JS 内）。
Option Explicit

Dim fso, shell, selfDir, debugOn, arg, cmd, rc, nodeOk, logDir, logPath, winStyle
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' ── 1. 定位自身目录（不依赖当前工作目录；支持中文/空格路径）──
selfDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = selfDir
logDir = selfDir & "\logs"
logPath = logDir & "\launcher.log"

' ── 2. 解析启动参数 ──
debugOn = False
For Each arg In WScript.Arguments
  If LCase(Trim(CStr(arg))) = "--debug" Then debugOn = True
Next

Call Log("[VBS] launcher invoked from: " & selfDir)
Call Log("[VBS] debug mode: " & CStr(debugOn))

' ── 3. Node.js 环境检测（找不到就原生提示并退出）──
nodeOk = (shell.Run("cmd /c where node.exe >nul 2>nul", 0, True) = 0)
If Not nodeOk Then
  Call Log("[VBS] ERROR: node.exe not found on PATH")
  MsgBox "未检测到 Node.js 18 或更高版本。" & vbCrLf & vbCrLf & _
         "请先安装 Node.js，然后重新双击「启动 InternalBeyond.vbs」。", 16, "Internal Beyond 启动器"
  WScript.Quit 1
End If
Call Log("[VBS] node detected on PATH")

' ── 4. 调用 launch-internal-beyond.js（默认隐藏，--debug 显示）──
winStyle = 0
If debugOn Then winStyle = 1
Dim runDesc
If debugOn Then runDesc = " (debug, visible)" Else runDesc = " (hidden)"
cmd = "node.exe launch-internal-beyond.js"
Call Log("[VBS] running: " & cmd & runDesc)
rc = shell.Run(cmd, winStyle, True)
Call Log("[VBS] launch-internal-beyond.js exited with code " & rc)
WScript.Quit rc

' ── 日志辅助（不记录任何密钥/Token，只记阶段与成败）──
Sub Log(line)
  On Error Resume Next
  If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
  Dim f
  Set f = fso.OpenTextFile(logPath, 8, True)
  f.WriteLine Now & "  " & line
  f.Close
  On Error GoTo 0
End Sub
