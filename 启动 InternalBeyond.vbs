' 启动 InternalBeyond.vbs — 傻瓜式单击启动器（Windows）
' 只负责启动编排：定位自身目录、切换工作目录、隐藏窗口、解析 Node 运行时、调用
' launch-internal-beyond.js（唯一真实启动逻辑）。
' 不做任何业务判断（Bridge 检测/健康检查/端口/超时/浏览器打开全部在 JS 内）。
'
' Node 运行时解析顺序（与 runtime\node\README.md 一致）：
'   1. IB_NODE 环境变量（显式覆盖，排障/测试用）
'   2. 随包内置 runtime\node\node.exe（正式安装包的唯一路径）
'   3. PATH 中的 node.exe（仅开发/兼容兜底）
' 内置运行时存在但无法运行时（损坏）会明确报错，不会静默回退到 PATH。
' 控制台模式（cscript）下不弹窗，改为写标准输出并返回退出码，便于自动化测试。
Option Explicit

Dim fso, shell, selfDir, debugOn, arg, cmd, rc, logDir, logPath, winStyle
Dim runtimeDir, bundledExe, versionFile, nodeExe, nodeSrc, nodeErr, nodeVer, nodeMajor
Dim isConsole, envNode, pinnedVer, ts, preflightWhy, pathNode

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' ── 1. 定位自身目录（不依赖当前工作目录；支持中文/空格路径）──
selfDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = selfDir
logDir = selfDir & "\logs"
logPath = logDir & "\launcher.log"
runtimeDir = selfDir & "\runtime\node"
bundledExe = runtimeDir & "\node.exe"
versionFile = runtimeDir & "\VERSION"

isConsole = (InStr(LCase(WScript.FullName), "cscript") > 0)

' ── 2. 解析启动参数 ──
debugOn = False
For Each arg In WScript.Arguments
  If LCase(Trim(CStr(arg))) = "--debug" Then debugOn = True
Next

Call Log("[VBS] launcher invoked from: " & selfDir)
Call Log("[VBS] debug mode: " & CStr(debugOn))
Call Log("[VBS] console mode: " & CStr(isConsole))

' ── 3. 解析 Node 运行时：IB_NODE → 内置 runtime → PATH ──
nodeExe = ""
nodeSrc = ""
nodeErr = ""

' (a) IB_NODE 显式覆盖
On Error Resume Next
envNode = Trim(CStr(shell.ExpandEnvironmentStrings("%IB_NODE%")))
On Error GoTo 0
If envNode = "%IB_NODE%" Then envNode = ""
If envNode <> "" Then
  If fso.FileExists(envNode) Then
    nodeExe = envNode
    nodeSrc = "IB_NODE"
  Else
    nodeErr = "环境变量 IB_NODE 指向的文件不存在：" & envNode
  End If
End If

' (b) 随包内置运行时
If nodeExe = "" And nodeErr = "" Then
  If fso.FileExists(bundledExe) Then
    nodeExe = bundledExe
    nodeSrc = "bundled"
  End If
End If

' (c) PATH 兜底（仅开发/兼容）；解析成绝对路径，后面才能做二进制自检
If nodeExe = "" And nodeErr = "" Then
  pathNode = WhereNodeExe()
  If pathNode <> "" Then
    nodeExe = pathNode
    nodeSrc = "PATH"
  End If
End If

If nodeExe = "" Then
  Call Log("[VBS] ERROR: no usable node runtime. " & nodeErr)
  Call Fatal("未找到可用的 Node.js 运行环境。" & vbCrLf & vbCrLf & _
             "内置运行环境（runtime\node\node.exe）缺失，系统 PATH 中也没有 Node.js。" & vbCrLf & _
             "请重新安装 InternalBeyond。")
End If
Call Log("[VBS] node runtime resolved: src=" & nodeSrc & " path=" & nodeExe)

' ── 3.5 交给 Windows 之前先自检二进制（P7 修复）──
' 损坏 / 被截断的 node.exe 会让 Windows 自己弹出「不支持的 16 位应用程序」这类
' 系统错误框：普通用户看不懂，也没法自助恢复。这里只做两个廉价判断——文件大小
' 是否合理、开头两个字节是否是 PE 可执行文件的 MZ 头——不通过就用产品语言直接报错，
' 绝不把坏文件交给系统加载器。
If Not RuntimeLooksValid(nodeExe, preflightWhy) Then
  Call Log("[VBS] ERROR: runtime binary rejected by preflight. src=" & nodeSrc & " why=" & preflightWhy)
  If nodeSrc = "bundled" Then
    Call Fatal("内置 Node.js 运行环境损坏（" & preflightWhy & "）。" & vbCrLf & vbCrLf & _
               "请重新安装 InternalBeyond；如果刚装好就是这样，请把 logs\launcher.log 发给支持人员。")
  ElseIf nodeSrc = "IB_NODE" Then
    Call Fatal("IB_NODE 指定的 Node.js 程序无法使用（" & preflightWhy & "）：" & nodeExe)
  Else
    Call Fatal("系统 PATH 中的 Node.js 程序无法使用（" & preflightWhy & "）：" & nodeExe)
  End If
End If

' ── 4. 校验 Node 可运行且版本不低于 18 ──
nodeVer = NodeVersion(nodeExe)
If nodeVer = "" Then
  If nodeSrc = "bundled" Then
    Call Log("[VBS] ERROR: bundled node.exe failed to run")
    Call Fatal("内置 Node.js 运行环境损坏（runtime\node\node.exe 无法运行）。" & vbCrLf & vbCrLf & _
               "请重新安装 InternalBeyond。")
  ElseIf nodeSrc = "IB_NODE" Then
    Call Log("[VBS] ERROR: IB_NODE target failed to run")
    Call Fatal("IB_NODE 指向的 Node.js 无法运行：" & nodeExe)
  Else
    Call Log("[VBS] ERROR: PATH node.exe failed to run")
    Call Fatal("系统 PATH 中的 Node.js 无法运行，请检查安装。")
  End If
End If
Call Log("[VBS] node version: " & nodeVer)

nodeMajor = MajorOf(nodeVer)
If nodeMajor < 18 Then
  Call Log("[VBS] ERROR: node version too old: " & nodeVer)
  Call Fatal("Node.js 版本过低（当前 " & nodeVer & "，需要 18 或更高）。" & vbCrLf & vbCrLf & _
             "请重新安装 InternalBeyond。")
End If

' 内置运行时：与 VERSION 记录比对，不一致只告警不阻断（便于本地替换排查）
If nodeSrc = "bundled" And fso.FileExists(versionFile) Then
  pinnedVer = ""
  On Error Resume Next
  Set ts = fso.OpenTextFile(versionFile, 1)
  pinnedVer = Trim(ts.ReadAll)
  ts.Close
  On Error GoTo 0
  If pinnedVer <> "" And ("v" & pinnedVer) <> nodeVer Then
    Call Log("[VBS] WARN: bundled version mismatch. pinned=v" & pinnedVer & " actual=" & nodeVer)
  End If
End If

' ── 5. 调用 launch-internal-beyond.js（默认隐藏，--debug 显示）──
winStyle = 0
If debugOn Then winStyle = 1
Dim runDesc
If debugOn Then runDesc = " (debug, visible)" Else runDesc = " (hidden)"
cmd = """" & nodeExe & """ """ & selfDir & "\runtime\launch-internal-beyond.js"""
Call Log("[VBS] running: " & nodeSrc & " node," & runDesc)
rc = shell.Run(cmd, winStyle, True)
Call Log("[VBS] launch-internal-beyond.js exited with code " & rc)
WScript.Quit rc

' ── 二进制自检：文件存在 + 大小合理 + MZ 头 ──
' 返回 False 时 why 里是产品语言的失败原因（供 Fatal 直接拼接）。
' 读不了文件（被占用等）时不武断，交给第 4 步的真实运行探测。
Function RuntimeLooksValid(exePath, ByRef why)
  Dim f, ts2, head, sz
  RuntimeLooksValid = False
  why = ""
  On Error Resume Next
  If Not fso.FileExists(exePath) Then
    why = "文件不存在"
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  Set f = fso.GetFile(exePath)
  sz = f.Size
  If Err.Number <> 0 Or sz < 1048576 Then
    why = "文件大小异常（" & sz & " 字节）"
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  Set ts2 = fso.OpenTextFile(exePath, 1, False)
  If Err.Number <> 0 Then
    Err.Clear
    RuntimeLooksValid = True
    On Error GoTo 0
    Exit Function
  End If
  head = ts2.Read(2)
  ts2.Close
  If Err.Number <> 0 Then
    Err.Clear
    RuntimeLooksValid = True
    On Error GoTo 0
    Exit Function
  End If
  If head = "MZ" Then
    RuntimeLooksValid = True
  Else
    why = "文件头不是 Windows 可执行文件（缺少 MZ）"
  End If
  Err.Clear
  On Error GoTo 0
End Function

' ── 解析 PATH 里的 node.exe 绝对路径（找不到返回空串）──
Function WhereNodeExe()
  Dim ex, txt
  WhereNodeExe = ""
  On Error Resume Next
  Set ex = shell.Exec("cmd /c where node.exe")
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  txt = Trim(ex.StdOut.ReadAll)
  If InStr(txt, vbCrLf) > 0 Then txt = Split(txt, vbCrLf)(0)
  txt = Trim(txt)
  If txt <> "" Then
    If fso.FileExists(txt) Then WhereNodeExe = txt
  End If
  Err.Clear
  On Error GoTo 0
End Function

' ── 读取 node --version；失败返回空串。全程隐藏窗口，不写任何密钥 ──
' 说明：WScript.Shell.Run 不做 shell 重定向（直接拼 "cmd /c ... > file" 会返回 rc=9），
' 因此这里生成一个临时 .cmd 由 cmd 解析重定向，再以隐藏窗口执行。
Function NodeVersion(exe)
  Dim stamp, tf, cf, rc2, txt, tfObj, f
  NodeVersion = ""
  On Error Resume Next
  stamp = CStr(Int(Timer * 1000))
  tf = fso.GetSpecialFolder(2) & "\ib_node_ver_" & stamp & ".txt"
  cf = fso.GetSpecialFolder(2) & "\ib_node_ver_" & stamp & ".cmd"
  Set f = fso.CreateTextFile(cf, True)
  f.WriteLine "@echo off"
  f.WriteLine Chr(34) & exe & Chr(34) & " --version > " & Chr(34) & tf & Chr(34) & " 2>&1"
  f.Close
  rc2 = shell.Run("cmd /c " & Chr(34) & cf & Chr(34), 0, True)
  If fso.FileExists(tf) Then
    Set tfObj = fso.OpenTextFile(tf, 1)
    txt = Trim(tfObj.ReadAll)
    tfObj.Close
  End If
  If fso.FileExists(cf) Then fso.DeleteFile cf, True
  If fso.FileExists(tf) Then fso.DeleteFile tf, True
  If InStr(txt, vbCrLf) > 0 Then txt = Split(txt, vbCrLf)(0)
  txt = Trim(txt)
  If Left(txt, 1) = "v" Then NodeVersion = txt
  On Error GoTo 0
End Function

' ── 主版本号 ──
' 注意：VBScript 函数参数默认 ByRef，这里必须 ByVal，否则会改写调用方的 nodeVer。
Function MajorOf(ByVal ver)
  Dim parts
  MajorOf = 0
  On Error Resume Next
  ver = Replace(Replace(ver, "v", ""), "V", "")
  parts = Split(ver, ".")
  If UBound(parts) >= 0 Then MajorOf = CInt(parts(0))
  On Error GoTo 0
End Function

' ── 致命错误：控制台模式写 stdout，GUI 模式原生弹窗 ──
Sub Fatal(msg)
  If isConsole Then
    WScript.Echo "ERROR: " & msg
  Else
    MsgBox msg, 16, "Internal Beyond 启动器"
  End If
  WScript.Quit 1
End Sub

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