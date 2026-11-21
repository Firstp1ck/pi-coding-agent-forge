// Tokens, elevation, process identity, and the non-elevated relaunch.
//
// Non-elevated by default (spec section 4.5): when the helper runs elevated in
// local mode without PI_GUI_ALLOW_ELEVATED=1, it starts a copy of itself with
// the user's Explorer token (CreateProcessWithTokenW), kept in a
// kill-on-close Job Object, and only relays its exit code. The copy then
// creates the desktop and launches apps with the atomic job-list path, so
// every app runs non-elevated. No runas, no UAC prompt.
//
// Design adapted from @iiwate/pi-silent-gui 0.2.0 (MIT, Copyright (c) 2026
// IIwate; see ../../THIRD_PARTY_NOTICES.md): a launcher that is elevated
// relaunches its broker with the Explorer shell token and refuses a
// non-atomic job fallback.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace PiGuiHelper.Win
{
    internal static class WinSecurity
    {
        public static bool IsTokenElevated(IntPtr token)
        {
            int elevated, length;
            if (!Native.GetTokenInformation(token, Native.TokenElevation, out elevated, 4, out length))
                throw new InvalidOperationException(Native.Error("GetTokenInformation(TokenElevation)"));
            return elevated != 0;
        }

        public static bool IsCurrentProcessElevated()
        {
            IntPtr token;
            if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_QUERY, out token))
                throw new InvalidOperationException(Native.Error("OpenProcessToken(current)"));
            try { return IsTokenElevated(token); }
            finally { Native.CloseHandle(token); }
        }

        /// <summary>True when the (suspended) process runs with an elevated token.</summary>
        public static bool IsProcessElevated(IntPtr process)
        {
            IntPtr token;
            if (!Native.OpenProcessToken(process, Native.TOKEN_QUERY, out token))
                throw new InvalidOperationException(Native.Error("OpenProcessToken(app)"));
            try { return IsTokenElevated(token); }
            finally { Native.CloseHandle(token); }
        }

        public static SecurityIdentifier CurrentUser()
        {
            using (WindowsIdentity id = WindowsIdentity.GetCurrent()) return id.User;
        }

        /// <summary>
        /// Primary token of the Explorer shell of this session: non-elevated and the same user as the
        /// helper, or an exception (fail closed). The caller closes the handle.
        /// </summary>
        public static IntPtr ShellToken()
        {
            IntPtr shell = Native.GetShellWindow();
            if (shell == IntPtr.Zero) throw new InvalidOperationException("no Explorer shell in this session, so no non-elevated token is available; run Pi from a normal (non-elevated) user session");
            int pid;
            Native.GetWindowThreadProcessId(shell, out pid);
            IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) throw new InvalidOperationException(Native.Error("OpenProcess(Explorer)"));
            IntPtr token = IntPtr.Zero, primary = IntPtr.Zero;
            try
            {
                if (!Native.OpenProcessToken(process, Native.TOKEN_QUERY | Native.TOKEN_DUPLICATE | Native.TOKEN_ASSIGN_PRIMARY, out token))
                    throw new InvalidOperationException(Native.Error("OpenProcessToken(Explorer)"));
                if (!Native.DuplicateTokenEx(token, Native.MAXIMUM_ALLOWED, IntPtr.Zero, Native.SecurityImpersonation, Native.TokenPrimary, out primary))
                    throw new InvalidOperationException(Native.Error("DuplicateTokenEx(Explorer)"));
            }
            finally
            {
                if (token != IntPtr.Zero) Native.CloseHandle(token);
                Native.CloseHandle(process);
            }
            try
            {
                if (IsTokenElevated(primary)) throw new InvalidOperationException("the Explorer shell token is elevated (UAC is off?); refusing to start apps elevated");
                SecurityIdentifier shellUser;
                using (var id = new WindowsIdentity(primary)) shellUser = id.User;
                if (shellUser != CurrentUser()) throw new InvalidOperationException("the Explorer shell belongs to another user than the helper; refusing to start apps as that user");
            }
            catch
            {
                Native.CloseHandle(primary);
                throw;
            }
            return primary;
        }

        /// <summary>Creation time (FILETIME ticks) of a process handle: with the PID, the identity used for audits.</summary>
        public static long CreationTime(IntPtr process)
        {
            long creation, exit, kernel, user;
            if (!Native.GetProcessTimes(process, out creation, out exit, out kernel, out user)) return 0;
            return creation;
        }

        /// <summary>True when PID still names the process created at creationTime and it is running.</summary>
        public static bool SameProcessAlive(int pid, long creationTime)
        {
            IntPtr h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION | Native.SYNCHRONIZE, false, pid);
            if (h == IntPtr.Zero) return false;
            try
            {
                if (CreationTime(h) != creationTime) return false;
                return Native.WaitForSingleObject(h, 0) == Native.WAIT_TIMEOUT;
            }
            finally { Native.CloseHandle(h); }
        }

        public static string CurrentExecutable()
        {
            var name = new StringBuilder(32768);
            int size = name.Capacity;
            if (!Native.QueryFullProcessImageNameW(Native.GetCurrentProcess(), 0, name, ref size))
                throw new InvalidOperationException(Native.Error("QueryFullProcessImageName"));
            return name.ToString(0, size);
        }

        /// <summary>CREATE_UNICODE_ENVIRONMENT block of the current environment (HGlobal; the caller frees it).</summary>
        public static IntPtr CurrentEnvironmentBlock()
        {
            var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry e in Environment.GetEnvironmentVariables())
            {
                var k = e.Key as string;
                var v = e.Value as string;
                if (k != null && v != null) env[k] = v;
            }
            return Marshal.StringToHGlobalUni(ChildEnvironment.Block(env));
        }

        /// <summary>
        /// Runs this same PowerShell command line again with the Explorer token, in a kill-on-close
        /// job, with the same stdin/stdout/stderr, and returns its exit code. The copy is created
        /// suspended and joins the job before it runs any code.
        ///
        /// The relay job has no UI limits and no breakaway: every app the copy starts is nested in
        /// it (Windows 8+ nested jobs) under its own session job, so closing the relay job (this
        /// process ending) still ends everything. Nesting needs every job in the hierarchy to be
        /// free of UI limits, which is why the session jobs set none either (WinJob.Create).
        /// </summary>
        public static int RelaunchNonElevated()
        {
            IntPtr token = ShellToken();
            IntPtr env = IntPtr.Zero;
            IntPtr job = IntPtr.Zero;
            var pi = new PROCESS_INFORMATION();
            try
            {
                job = Native.CreateJobObjectW(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw new InvalidOperationException(Native.Error("CreateJobObject(relay)"));
                WinJob.SetKillOnClose(job);
                var std = new IntPtr[] { Native.GetStdHandle(Native.STD_INPUT_HANDLE), Native.GetStdHandle(Native.STD_OUTPUT_HANDLE), Native.GetStdHandle(Native.STD_ERROR_HANDLE) };
                foreach (IntPtr h in std)
                {
                    if (h != IntPtr.Zero && h != Native.INVALID_HANDLE_VALUE) Native.SetHandleInformation(h, Native.HANDLE_FLAG_INHERIT, Native.HANDLE_FLAG_INHERIT);
                }
                var si = new STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                si.lpDesktop = WinDesktop.WindowStationName() + "\\Default";
                si.dwFlags = Native.STARTF_USESTDHANDLES;
                si.hStdInput = std[0];
                si.hStdOutput = std[1];
                si.hStdError = std[2];
                env = CurrentEnvironmentBlock();
                string exe = CurrentExecutable();
                var commandLine = new StringBuilder(Marshal.PtrToStringUni(Native.GetCommandLineW()));
                int flags = Native.CREATE_SUSPENDED | Native.CREATE_NO_WINDOW | Native.CREATE_UNICODE_ENVIRONMENT;
                if (!Native.CreateProcessWithTokenW(token, Native.LOGON_WITH_PROFILE, exe, commandLine, flags, env, Environment.CurrentDirectory, ref si, out pi))
                    throw new InvalidOperationException(Native.Error("CreateProcessWithTokenW(non-elevated helper)"));
                if (!Native.AssignProcessToJobObject(job, pi.hProcess))
                {
                    bool denied = Marshal.GetLastWin32Error() == Native.ERROR_ACCESS_DENIED;
                    string error = Native.Error("AssignProcessToJobObject(non-elevated helper)");
                    if (denied && WinLauncher.InJob()) error = WinLauncher.NestedJobProblem(error);
                    Native.TerminateProcess(pi.hProcess, 1);
                    throw new InvalidOperationException(error);
                }
                if (Native.ResumeThread(pi.hThread) == -1)
                {
                    string error = Native.Error("ResumeThread(non-elevated helper)");
                    Native.TerminateJobObject(job, 1);
                    throw new InvalidOperationException(error);
                }
                Native.WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
                int code;
                if (!Native.GetExitCodeProcess(pi.hProcess, out code)) code = 1;
                return code;
            }
            finally
            {
                if (pi.hThread != IntPtr.Zero) Native.CloseHandle(pi.hThread);
                if (pi.hProcess != IntPtr.Zero) Native.CloseHandle(pi.hProcess);
                if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
                Native.CloseHandle(token);
                // Closing the relay job kills the copy and its jobs if this process ends first.
                if (job != IntPtr.Zero) Native.CloseHandle(job);
            }
        }

        public static string Arch()
        {
            try
            {
                ushort process, native;
                if (Native.IsWow64Process2(Native.GetCurrentProcess(), out process, out native))
                {
                    switch (native)
                    {
                        case 0x8664: return "x64";
                        case 0xAA64: return "arm64";
                        case 0x014C: return "x86";
                    }
                }
            }
            catch (EntryPointNotFoundException) { }
            string arch = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITEW6432") ?? Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "";
            switch (arch.ToUpperInvariant())
            {
                case "AMD64": return "x64";
                case "ARM64": return "arm64";
                case "X86": return "x86";
                default: return Environment.Is64BitOperatingSystem ? "x64" : "x86";
            }
        }

        /// <summary>"Windows 10.0.22631 x64; .NET Framework 4.0.30319.42000; PowerShell host" (at most 256 characters).</summary>
        public static string Fingerprint(string psVersion)
        {
            var v = new OSVERSIONINFOEX();
            v.dwOSVersionInfoSize = Marshal.SizeOf(typeof(OSVERSIONINFOEX));
            string os = Native.RtlGetVersion(ref v) == 0
                ? string.Format(CultureInfo.InvariantCulture, "Windows {0}.{1}.{2}", v.dwMajorVersion, v.dwMinorVersion, v.dwBuildNumber)
                : "Windows " + Environment.OSVersion.Version;
            string text = os + " " + Arch() + "; .NET Framework " + Environment.Version + "; PowerShell " + (psVersion ?? "?");
            return text.Length > 256 ? text.Substring(0, 256) : text;
        }

        public static int OsBuild()
        {
            var v = new OSVERSIONINFOEX();
            v.dwOSVersionInfoSize = Marshal.SizeOf(typeof(OSVERSIONINFOEX));
            return Native.RtlGetVersion(ref v) == 0 ? v.dwBuildNumber : 0;
        }
    }
}
