// Job Objects and contained process creation (spec section 4.5).
//
// Every app and setup command gets its own kill-on-close Job Object and joins
// it atomically at creation (STARTUPINFOEX + PROC_THREAD_ATTRIBUTE_JOB_LIST).
// The process starts suspended and is resumed only after the job membership,
// the token check, the output pumps, and the session record are in place; any
// failure terminates the job (fail closed). Inherited handles are limited to
// the child's own stdio (PROC_THREAD_ATTRIBUTE_HANDLE_LIST), so an app never
// receives the helper's protocol pipe.
//
// Design adapted from @iiwate/pi-silent-gui 0.2.0 (MIT, Copyright (c) 2026
// IIwate; see ../../THIRD_PARTY_NOTICES.md): suspended start with atomic
// job-list membership and kill/audit by job and PID + creation time.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace PiGuiHelper.Win
{
    internal sealed class WinJob
    {
        readonly object _lock = new object();
        IntPtr _handle;

        WinJob(IntPtr handle, string name)
        {
            _handle = handle;
            Name = name;
        }

        public string Name { get; private set; }
        public IntPtr Handle { get { lock (_lock) { return _handle; } } }

        /// <summary>A new named job; an existing object with that name is refused (no squatting).</summary>
        public static WinJob Create(string name)
        {
            // .NET Framework does not clear the last error before a call: clear it so a stale
            // ERROR_ALREADY_EXISTS cannot be mistaken for a squatted name (or hide one).
            Native.SetLastError(0);
            IntPtr h = Native.CreateJobObjectW(IntPtr.Zero, name);
            int error = Marshal.GetLastWin32Error();
            if (h == IntPtr.Zero) throw new InvalidOperationException(Native.Error("CreateJobObject"));
            if (error == Native.ERROR_ALREADY_EXISTS)
            {
                Native.CloseHandle(h);
                throw new InvalidOperationException("a Job Object named " + name + " already exists; refusing to reuse it");
            }
            var job = new WinJob(h, name);
            try
            {
                // No JOB_OBJECT_UILIMIT_* limits: a job with UI limits cannot join a job hierarchy, and
                // the app's job is nested whenever the helper itself runs in a job (the relay job of
                // an elevated start, a terminal's or CI runner's job). Kill-on-close plus atomic
                // membership at creation are the containment; the private desktop is the UI boundary.
                SetKillOnClose(h);
            }
            catch
            {
                job.Close();
                throw;
            }
            return job;
        }

        /// <summary>Kill-on-close, and no Windows Error Reporting dialog that would block a crashed app.</summary>
        public static void SetKillOnClose(IntPtr job)
        {
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | Native.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new InvalidOperationException(Native.Error("SetInformationJobObject(kill on close)"));
        }

        /// <summary>PIDs currently in the job (bounded to 4096).</summary>
        public List<int> ProcessIds()
        {
            var result = new List<int>();
            IntPtr h = Handle;
            if (h == IntPtr.Zero) return result;
            const int Max = 4096;
            int size = 2 * 4 + IntPtr.Size * Max;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                int returned;
                if (!Native.QueryInformationJobObject(h, Native.JobObjectBasicProcessIdList, buffer, size, out returned)) return result;
                int count = Marshal.ReadInt32(buffer, 4);
                // JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR ids at offset 8.
                for (int i = 0; i < count && i < Max; i++) result.Add((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
            return result;
        }

        public void Terminate()
        {
            IntPtr h = Handle;
            if (h != IntPtr.Zero) Native.TerminateJobObject(h, 1);
        }

        /// <summary>Closes the handle; with kill-on-close this ends every process still in the job.</summary>
        public void Close()
        {
            IntPtr h;
            lock (_lock)
            {
                h = _handle;
                _handle = IntPtr.Zero;
            }
            if (h != IntPtr.Zero) Native.CloseHandle(h);
        }
    }

    /// <summary>A contained process with its job, output pumps, and bounded output tail.</summary>
    internal sealed class WinChild : IChild
    {
        const int TailChars = 8192;
        readonly StringBuilder _tail = new StringBuilder();
        readonly List<Thread> _pumps = new List<Thread>();
        IntPtr _process;

        public WinChild(WinJob job, IntPtr process, int pid, long creationTime)
        {
            Job = job;
            _process = process;
            Pid = pid;
            CreationTime = creationTime;
        }

        public WinJob Job { get; private set; }
        public IntPtr ProcessHandle { get { return _process; } }
        public int Pid { get; private set; }
        public long CreationTime { get; private set; }

        public bool HasExited
        {
            get
            {
                IntPtr p = _process;
                return p == IntPtr.Zero || Native.WaitForSingleObject(p, 0) == Native.WAIT_OBJECT_0;
            }
        }

        int _exitCode = -1;

        /// <summary>The exit code; kept when Close releases the handle, -1 while running or unknown.</summary>
        public int ExitCode
        {
            get
            {
                int code;
                IntPtr p = _process;
                if (p == IntPtr.Zero) return _exitCode;
                if (!Native.GetExitCodeProcess(p, out code) || code == Native.STILL_ACTIVE) return -1;
                return code;
            }
        }

        public void AppendTail(string text)
        {
            lock (_tail)
            {
                _tail.Append(text);
                if (_tail.Length > TailChars) _tail.Remove(0, _tail.Length - TailChars);
            }
        }

        public string OutputTail(int maxChars)
        {
            lock (_tail)
            {
                string s = _tail.ToString();
                return s.Length > maxChars ? s.Substring(s.Length - maxChars) : s;
            }
        }

        public void AddPump(Thread pump) { _pumps.Add(pump); }

        public void KillTree() { Job.Terminate(); }

        public void DrainOutput(int timeoutMs)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            foreach (Thread t in _pumps)
            {
                int left = (int)Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds);
                t.Join(left);
            }
        }

        /// <summary>Kills the job and closes the handles (idempotent).</summary>
        public void Close()
        {
            IntPtr p = _process;
            int code;
            // An exit code that exists before the job is terminated is the process's own.
            if (p != IntPtr.Zero && Native.GetExitCodeProcess(p, out code) && code != Native.STILL_ACTIVE) _exitCode = code;
            Job.Terminate();
            Job.Close();
            _process = IntPtr.Zero;
            if (p != IntPtr.Zero)
            {
                Native.WaitForSingleObject(p, 2000);
                Native.CloseHandle(p);
            }
        }
    }

    internal sealed class LaunchSpec
    {
        public string Application;
        public string CommandLine;
        public string EnvironmentBlock;
        public string Cwd;
        /// <summary>"&lt;window station&gt;\&lt;desktop&gt;".</summary>
        public string Desktop;
        public string JobName;
        public string Source;
        public bool AllowElevated;
        public ILogSink Log;
        /// <summary>Runs while the process is still suspended (session record); throwing aborts the launch.</summary>
        public Action<WinChild> BeforeResume;
    }

    internal static class WinLauncher
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

        /// <summary>True when this helper process already runs inside some Job Object.</summary>
        public static bool InJob()
        {
            bool result;
            return IsProcessInJob(Native.GetCurrentProcess(), IntPtr.Zero, out result) && result;
        }

        /// <summary>The failure text when an app cannot join its job while the helper is in a job itself.</summary>
        public static string NestedJobProblem(string what)
        {
            return what + ": the helper runs inside a Job Object that does not accept a nested job (for example one with UI " +
                "restrictions, set by the terminal, an IDE, a CI runner, or a sandbox that started Pi). Start Pi from a plain " +
                "terminal (Windows Terminal, cmd.exe, or PowerShell) and run /gui-doctor local-windows again";
        }

        static IntPtr InheritableNul()
        {
            var sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            sa.bInheritHandle = 1;
            IntPtr h = Native.CreateFileW("NUL", Native.GENERIC_READ | Native.GENERIC_WRITE, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE,
                ref sa, Native.OPEN_EXISTING, Native.FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (h == Native.INVALID_HANDLE_VALUE) throw new InvalidOperationException(Native.Error("CreateFile(NUL)"));
            return h;
        }

        /// <summary>Pipe whose write end is inheritable and whose read end stays private to the helper.</summary>
        static void OutputPipe(out IntPtr read, out IntPtr write)
        {
            var sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            sa.bInheritHandle = 1;
            if (!Native.CreatePipe(out read, out write, ref sa, 0)) throw new InvalidOperationException(Native.Error("CreatePipe"));
            if (!Native.SetHandleInformation(read, Native.HANDLE_FLAG_INHERIT, 0))
            {
                Native.CloseHandle(read);
                Native.CloseHandle(write);
                throw new InvalidOperationException(Native.Error("SetHandleInformation"));
            }
        }

        static ProtocolException CreateFailure(int error, LaunchSpec spec)
        {
            string message = new System.ComponentModel.Win32Exception(error).Message;
            switch (error)
            {
                case Native.ERROR_FILE_NOT_FOUND:
                case Native.ERROR_PATH_NOT_FOUND:
                    return new ProtocolException("NOT_FOUND", "cannot start " + spec.Application + ": " + message);
                case Native.ERROR_DIRECTORY:
                    return new ProtocolException("NOT_FOUND", "cwd " + spec.Cwd + " does not exist in the session");
                case Native.ERROR_ELEVATION_REQUIRED:
                    return new ProtocolException("BAD_REQUEST", spec.Application + " requires elevation (its manifest asks for administrator rights); the helper never shows a UAC prompt");
                case 193: // ERROR_BAD_EXE_FORMAT
                    return new ProtocolException("BAD_REQUEST", spec.Application + " is not a Windows program");
                default:
                    return new ProtocolException("INTERNAL", "CreateProcess failed for " + spec.Application + ": " + message + " (" + error + ")");
            }
        }

        public static WinChild Start(LaunchSpec spec)
        {
            WinJob job = WinJob.Create(spec.JobName);
            IntPtr nul = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero;
            IntPtr attributes = IntPtr.Zero, handleList = IntPtr.Zero, jobList = IntPtr.Zero, env = IntPtr.Zero;
            bool attributesReady = false;
            var pi = new PROCESS_INFORMATION();
            WinChild child = null;
            try
            {
                nul = InheritableNul();
                OutputPipe(out outRead, out outWrite);
                OutputPipe(out errRead, out errWrite);

                IntPtr size = IntPtr.Zero;
                Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                if (size == IntPtr.Zero) throw new InvalidOperationException(Native.Error("InitializeProcThreadAttributeList(size)"));
                attributes = Marshal.AllocHGlobal(size);
                if (!Native.InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw new InvalidOperationException(Native.Error("InitializeProcThreadAttributeList"));
                attributesReady = true;
                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, nul);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, outWrite);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, errWrite);
                if (!Native.UpdateProcThreadAttribute(attributes, 0, Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                    throw new InvalidOperationException(Native.Error("UpdateProcThreadAttribute(handle list)"));
                jobList = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobList, 0, job.Handle);
                if (!Native.UpdateProcThreadAttribute(attributes, 0, Native.PROC_THREAD_ATTRIBUTE_JOB_LIST, jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    throw new InvalidOperationException(Native.Error("UpdateProcThreadAttribute(job list)") + "; refusing a launch without atomic Job Object membership (needs Windows 10)");

                var si = new STARTUPINFOEX();
                si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                si.StartupInfo.lpDesktop = spec.Desktop;
                si.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES | Native.STARTF_USESHOWWINDOW;
                si.StartupInfo.wShowWindow = Native.SW_SHOWNORMAL;
                si.StartupInfo.hStdInput = nul;
                si.StartupInfo.hStdOutput = outWrite;
                si.StartupInfo.hStdError = errWrite;
                si.lpAttributeList = attributes;
                env = Marshal.StringToHGlobalUni(spec.EnvironmentBlock);
                int flags = Native.CREATE_SUSPENDED | Native.EXTENDED_STARTUPINFO_PRESENT | Native.CREATE_UNICODE_ENVIRONMENT | Native.CREATE_NO_WINDOW;
                var commandLine = new StringBuilder(spec.CommandLine, spec.CommandLine.Length + 1);
                if (!Native.CreateProcessW(spec.Application, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, env, spec.Cwd, ref si, out pi))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == Native.ERROR_ACCESS_DENIED && InJob())
                        throw new ProtocolException("INTERNAL", NestedJobProblem("CreateProcess with a Job Object list failed for " + spec.Application));
                    throw CreateFailure(error, spec);
                }

                // The child holds its own copies now.
                Native.CloseHandle(nul); nul = IntPtr.Zero;
                Native.CloseHandle(outWrite); outWrite = IntPtr.Zero;
                Native.CloseHandle(errWrite); errWrite = IntPtr.Zero;

                child = new WinChild(job, pi.hProcess, pi.dwProcessId, WinSecurity.CreationTime(pi.hProcess));
                pi.hProcess = IntPtr.Zero;

                bool inJob;
                if (!IsProcessInJob(child.ProcessHandle, job.Handle, out inJob) || !inJob)
                    throw new InvalidOperationException(InJob()
                        ? NestedJobProblem("the new process is not in its Job Object; refusing to resume it")
                        : "the new process is not in its Job Object; refusing to resume it");
                if (!spec.AllowElevated && WinSecurity.IsProcessElevated(child.ProcessHandle))
                    throw new InvalidOperationException("the new process runs elevated although PI_GUI_ALLOW_ELEVATED is not set; refusing to resume it");

                child.AddPump(Pump(outRead, "stdout", spec, child)); outRead = IntPtr.Zero;
                child.AddPump(Pump(errRead, "stderr", spec, child)); errRead = IntPtr.Zero;
                if (spec.BeforeResume != null) spec.BeforeResume(child);
                if (Native.ResumeThread(pi.hThread) == -1) throw new InvalidOperationException(Native.Error("ResumeThread"));
                return child;
            }
            catch
            {
                job.Terminate();
                if (child != null) child.Close();
                else job.Close();
                throw;
            }
            finally
            {
                if (pi.hThread != IntPtr.Zero) Native.CloseHandle(pi.hThread);
                if (pi.hProcess != IntPtr.Zero) Native.CloseHandle(pi.hProcess);
                if (attributesReady) Native.DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
                foreach (IntPtr h in new IntPtr[] { nul, outRead, outWrite, errRead, errWrite })
                {
                    if (h != IntPtr.Zero) Native.CloseHandle(h);
                }
            }
        }

        /// <summary>Forwards one output pipe as log events (bounded per event) and keeps a bounded tail.</summary>
        static Thread Pump(IntPtr readHandle, string stream, LaunchSpec spec, WinChild child)
        {
            var file = new FileStream(new SafeFileHandle(readHandle, true), FileAccess.Read, 1, false);
            var thread = new Thread(delegate()
            {
                Decoder decoder = new UTF8Encoding(false, false).GetDecoder();
                var bytes = new byte[16384];
                var chars = new char[16384 + 4];
                try
                {
                    while (true)
                    {
                        int n = file.Read(bytes, 0, bytes.Length);
                        if (n <= 0) break;
                        int c = decoder.GetChars(bytes, 0, n, chars, 0, false);
                        if (c == 0) continue;
                        string text = new string(chars, 0, c);
                        child.AppendTail(text);
                        spec.Log.Log(stream, spec.Source, text);
                    }
                }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                finally
                {
                    file.Dispose();
                }
            });
            thread.IsBackground = true;
            thread.Name = "pump-" + stream;
            thread.Start();
            return thread;
        }
    }
}
