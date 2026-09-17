using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

/*
 * InternalBeyond Release Builder · native launcher
 *
 * Why this exists at all, and why it is .NET Framework and not Electron/Tauri/
 * WebView2:
 *
 *   · The repository's product decision is that Node owns the truth and the
 *     system browser only renders; the Release Builder follows the same rule.
 *     That keeps new runtime dependencies at ZERO.
 *   · The GUI therefore needs exactly two things from a launcher: start Node on
 *     the local server, and open the default browser at the printed URL.
 *   · csc.exe ships with Windows (Microsoft.NET\Framework64\v4.0.30319), so the
 *     result is a single double-clickable EXE with no installer, no runtime
 *     prerequisite beyond the .NET Framework that Windows already has, and no
 *     third-party tool such as postject.
 *
 * Responsibilities, in order:
 *   1. find node.exe — IB_NODE, then the repo's own pinned runtime, then PATH;
 *   2. find server.js — beside this executable, or in release-builder/;
 *   3. start it and read the one line it prints: RELEASE-BUILDER-URL <url>;
 *   4. open that URL in the default browser;
 *   5. keep running as the parent, so closing it stops the server, and use a
 *      Windows job object so the server can never be orphaned.
 *
 * It contains no release logic whatsoever. It cannot build, verify, seal or
 * publish anything: it only starts the tool that can.
 */
internal static class Program
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine();
        Console.Error.WriteLine("InternalBeyond Release Builder 无法启动：");
        Console.Error.WriteLine("  " + message);
        Console.Error.WriteLine();
        Console.Error.WriteLine("按任意键关闭。");
        try { Console.ReadKey(true); } catch (Exception) { }
        return 2;
    }

    private static string FindNode(string baseDir)
    {
        string explicitPath = Environment.GetEnvironmentVariable("IB_NODE");
        if (!string.IsNullOrEmpty(explicitPath) && File.Exists(explicitPath)) return explicitPath;

        // The tool's own directory, then the repository layout it normally sits
        // in: <repo>\tools\IB-Release-Builder.exe → <repo>\runtime\node\node.exe
        string[] candidates = new string[]
        {
            Path.Combine(baseDir, "node.exe"),
            Path.Combine(baseDir, "runtime", "node", "node.exe"),
            Path.Combine(baseDir, "..", "runtime", "node", "node.exe"),
            Path.Combine(baseDir, "..", "..", "runtime", "node", "node.exe")
        };
        foreach (string c in candidates)
        {
            try { if (File.Exists(c)) return Path.GetFullPath(c); }
            catch (Exception) { }
        }

        string path = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(path))
        {
            foreach (string dir in path.Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                try
                {
                    string p = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(p)) return p;
                }
                catch (Exception) { }
            }
        }
        return null;
    }

    private static string FindServer(string baseDir)
    {
        string[] candidates = new string[]
        {
            Path.Combine(baseDir, "release-builder", "server.js"),
            Path.Combine(baseDir, "server.js"),
            Path.Combine(baseDir, "tools", "release-builder", "server.js")
        };
        foreach (string c in candidates)
        {
            try { if (File.Exists(c)) return Path.GetFullPath(c); }
            catch (Exception) { }
        }
        return null;
    }

    private static string FindRepoRoot(string serverPath)
    {
        // server.js lives at <repo>\tools\release-builder\server.js
        try
        {
            DirectoryInfo dir = new FileInfo(serverPath).Directory;
            for (int i = 0; i < 4 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir.FullName, "VERSION")) &&
                    File.Exists(Path.Combine(dir.FullName, "scripts", "build-installer.ps1")))
                {
                    return dir.FullName;
                }
                dir = dir.Parent;
            }
        }
        catch (Exception) { }
        return null;
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)length))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
        }
        finally { Marshal.FreeHGlobal(ptr); }
        return job;
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);

        string baseDir;
        try { baseDir = AppDomain.CurrentDomain.BaseDirectory; }
        catch (Exception) { baseDir = Directory.GetCurrentDirectory(); }

        string node = FindNode(baseDir);
        if (node == null)
        {
            return Fail("找不到 node.exe。\n" +
                        "  期望位置：<仓库>\\runtime\\node\\node.exe（内置运行时）\n" +
                        "  也可以设置环境变量 IB_NODE 指向 node.exe。");
        }

        string server = FindServer(baseDir);
        if (server == null)
        {
            return Fail("找不到 release-builder\\server.js。\n" +
                        "  这个 EXE 必须与 tools\\release-builder\\ 一起使用（同目录或子目录）。");
        }

        string repoRoot = FindRepoRoot(server);
        string arguments = "\"" + server + "\"";
        if (repoRoot != null) arguments += " --root=\"" + repoRoot + "\"";
        int port = 0;
        if (Environment.GetEnvironmentVariable("IB_RELEASE_PORT") != null)
        {
            int.TryParse(Environment.GetEnvironmentVariable("IB_RELEASE_PORT"), out port);
        }
        if (port > 0) arguments += " --port=" + port;

        Console.WriteLine("InternalBeyond Release Builder");
        Console.WriteLine("  node   : " + node);
        Console.WriteLine("  server : " + server);
        Console.WriteLine("  repo   : " + (repoRoot == null ? "(will be discovered by the tool)" : repoRoot));
        Console.WriteLine();
        Console.WriteLine("启动本地服务（仅监听 127.0.0.1）…");
        Console.WriteLine("关闭这个窗口即可停止 Release Builder。");
        Console.WriteLine();

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = arguments;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.WorkingDirectory = repoRoot ?? Path.GetDirectoryName(server);
        psi.StandardOutputEncoding = new UTF8Encoding(false);
        psi.StandardErrorEncoding = new UTF8Encoding(false);

        IntPtr job = CreateKillOnCloseJob();
        Process child = new Process();
        child.StartInfo = psi;

        string url = null;
        StringBuilder tail = new StringBuilder();

        child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            Console.WriteLine(e.Data);
            if (e.Data.StartsWith("RELEASE-BUILDER-URL ", StringComparison.Ordinal))
            {
                url = e.Data.Substring("RELEASE-BUILDER-URL ".Length).Trim();
                try { OpenBrowser(url); }
                catch (Exception ex) { Console.Error.WriteLine("无法自动打开浏览器：" + ex.Message); }
            }
        };
        child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            Console.Error.WriteLine(e.Data);
            if (tail.Length < 8000) tail.AppendLine(e.Data);
        };

        try
        {
            child.Start();
        }
        catch (Exception ex)
        {
            return Fail("无法启动 node.exe：" + ex.Message);
        }

        if (job != IntPtr.Zero) AssignProcessToJobObject(job, child.Handle);

        child.BeginOutputReadLine();
        child.BeginErrorReadLine();

        DateTime deadline = DateTime.UtcNow.AddSeconds(20);
        while (url == null && !child.HasExited && DateTime.UtcNow < deadline)
        {
            Thread.Sleep(120);
        }

        if (url == null && !child.HasExited)
        {
            Console.Error.WriteLine("服务在 20 秒内没有报告地址；请查看上方输出。");
        }

        child.WaitForExit();

        if (job != IntPtr.Zero)
        {
            CloseHandle(job); // kills any surviving child in the job
            job = IntPtr.Zero;
        }

        int code = 0;
        try { code = child.ExitCode; } catch (Exception) { }
        if (code != 0)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("Release Builder 服务以退出码 " + code + " 结束。");
            if (tail.Length > 0)
            {
                Console.Error.WriteLine("最后输出：");
                Console.Error.WriteLine(tail.ToString());
            }
            Console.Error.WriteLine("按任意键关闭。");
            try { Console.ReadKey(true); } catch (Exception) { }
        }
        return code;
    }

    private static void OpenBrowser(string url)
    {
        /* A headless check (CI, or a test proving the EXE starts) sets
           IB_RELEASE_NO_BROWSER=1 and the EXE stays a pure server host. The guard
           is decided FIRST: printing "已用系统默认浏览器打开" and then declining to
           open one would make the log lie about what happened, and a test that
           watches for a browser open would be unable to trust either line. */
        if (Environment.GetEnvironmentVariable("IB_RELEASE_NO_BROWSER") == "1")
        {
            Console.WriteLine("[IB_RELEASE_NO_BROWSER=1] 未打开浏览器");
            Console.WriteLine("请在浏览器中打开下面这个地址：");
            Console.WriteLine("  " + url);
            return;
        }
        Console.WriteLine("[已用系统默认浏览器打开] " + url);
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = "cmd.exe";
        psi.Arguments = "/c start \"\" \"" + url.Replace("\"", "") + "\"";
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        Process.Start(psi);
    }
}
