// Support code for the S1 harness (run-s1.ps1), compiled by Windows
// PowerShell 5.1 with Add-Type: process runs with correct Windows command-line
// quoting, a minimal protocol client for helpers/windows/helper.ps1, the
// user's foreground window, and a minimal UI Automation probe that reads a
// window on another (private) desktop.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

namespace PiGuiS1
{
    public sealed class RunResult
    {
        public int ExitCode;
        public string Stdout;
        public string Stderr;
        public long ElapsedMs;
        public bool TimedOut;
    }

    public static class S1Native
    {
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenDesktopW(string name, int flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);

        /// <summary>Quotes one argument for CommandLineToArgvW (Windows PowerShell 5.1 mangles embedded quotes itself).</summary>
        public static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            var b = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { backslashes++; continue; }
                b.Append('\\', c == '"' ? backslashes * 2 + 1 : backslashes);
                backslashes = 0;
                b.Append(c);
            }
            b.Append('\\', backslashes * 2).Append('"');
            return b.ToString();
        }

        public static RunResult Run(string exe, string[] args, IDictionary<string, string> env, string cwd, int timeoutMs)
        {
            var psi = new ProcessStartInfo(exe);
            var parts = new List<string>();
            foreach (string a in args) parts.Add(Quote(a));
            psi.Arguments = string.Join(" ", parts.ToArray());
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.RedirectStandardInput = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            if (cwd != null) psi.WorkingDirectory = cwd;
            if (env != null) foreach (var pair in env) psi.EnvironmentVariables[pair.Key] = pair.Value;
            var sw = Stopwatch.StartNew();
            using (var p = Process.Start(psi))
            {
                p.StandardInput.Close();
                var stdout = p.StandardOutput.ReadToEndAsync();
                var stderr = p.StandardError.ReadToEndAsync();
                var r = new RunResult();
                if (!p.WaitForExit(timeoutMs))
                {
                    r.TimedOut = true;
                    try { p.Kill(); } catch (InvalidOperationException) { }
                    p.WaitForExit(5000);
                }
                r.ExitCode = p.HasExited ? p.ExitCode : -1;
                r.Stdout = stdout.Wait(5000) ? stdout.Result : "";
                r.Stderr = stderr.Wait(5000) ? stderr.Result : "";
                r.ElapsedMs = sw.ElapsedMilliseconds;
                return r;
            }
        }

        public static string Foreground()
        {
            IntPtr h = GetForegroundWindow();
            var b = new StringBuilder(512);
            if (h != IntPtr.Zero) GetWindowTextW(h, b, b.Capacity);
            return "0x" + h.ToInt64().ToString("x") + " " + b;
        }

        /// <summary>
        /// Minimal UIA probe: on a thread attached to the named desktop, reads the window and looks
        /// for an element named "Press me". Returns "found", "window-only", or an error text.
        /// </summary>
        public static string UiaProbe(string desktopName, long hwnd, int timeoutMs)
        {
            string result = "timeout";
            var thread = new Thread(delegate()
            {
                IntPtr desk = IntPtr.Zero;
                try
                {
                    if (!string.IsNullOrEmpty(desktopName))
                    {
                        desk = OpenDesktopW(desktopName, 0, false, 0x000F01FF);
                        if (desk == IntPtr.Zero) { result = "OpenDesktop failed: " + Marshal.GetLastWin32Error(); return; }
                        if (!SetThreadDesktop(desk)) { result = "SetThreadDesktop failed: " + Marshal.GetLastWin32Error(); return; }
                    }
                    AutomationElement root = AutomationElement.FromHandle(new IntPtr(hwnd));
                    AutomationElement button = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, "Press me"));
                    result = button != null ? "found" : "window-only";
                }
                catch (Exception e)
                {
                    result = e.GetType().Name + ": " + e.Message;
                }
            });
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
            thread.Join(timeoutMs);
            return result;
        }

        public static string RandomHex(int bytes)
        {
            var data = new byte[bytes];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(data);
            var b = new StringBuilder();
            foreach (byte x in data) b.Append(x.ToString("x2"));
            return b.ToString();
        }
    }

    /// <summary>Minimal protocol-v2 client for helpers/windows/helper.ps1 over stdio.</summary>
    public sealed class HelperClient : IDisposable
    {
        readonly Process _process;
        readonly string _token;
        readonly BlockingCollection<string> _lines = new BlockingCollection<string>();
        readonly StringBuilder _stderr = new StringBuilder();
        readonly ManualResetEvent _ready = new ManualResetEvent(false);
        int _next = 1;

        public long ReadyMs { get; private set; }
        public int Events { get; private set; }

        HelperClient(Process process, string token)
        {
            _process = process;
            _token = token;
        }

        public static HelperClient Start(string powershell, string helperScript, IDictionary<string, string> env, int readyTimeoutMs)
        {
            string token = S1Native.RandomHex(16);
            var psi = new ProcessStartInfo(powershell);
            psi.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + S1Native.Quote(helperScript);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardInput = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            foreach (var pair in env) psi.EnvironmentVariables[pair.Key] = pair.Value;
            psi.EnvironmentVariables["PI_GUI_TESTING_TOKEN"] = token;
            var sw = Stopwatch.StartNew();
            var process = new Process();
            process.StartInfo = psi;
            var client = new HelperClient(process, token);
            process.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data == null) { client._lines.CompleteAdding(); return; }
                if (e.Data == "PI-GUI-TESTING-READY " + token) { client.ReadyMs = sw.ElapsedMilliseconds; client._ready.Set(); return; }
                if (!e.Data.StartsWith(token + " ", StringComparison.Ordinal)) return;
                string json = e.Data.Substring(token.Length + 1);
                if (json.StartsWith("{\"event\"", StringComparison.Ordinal)) { client.Events++; return; }
                client._lines.Add(json);
            };
            process.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) lock (client._stderr) { if (client._stderr.Length < 200000) client._stderr.AppendLine(e.Data); }
            };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            if (!client._ready.WaitOne(readyTimeoutMs)) client.ReadyMs = -1;
            return client;
        }

        public bool IsReady { get { return ReadyMs >= 0; } }

        public string Stderr { get { lock (_stderr) { return _stderr.ToString(); } } }

        /// <summary>Sends a request (params as JSON text) and returns the response JSON, or null on timeout.</summary>
        public string Call(string method, string paramsJson, int timeoutMs)
        {
            int id = _next++;
            _process.StandardInput.Write(_token + " {\"id\":" + id + ",\"method\":\"" + method + "\",\"params\":" + paramsJson + "}\n");
            _process.StandardInput.Flush();
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            var prefix = new Regex("^\\{\"id\":" + id + ",");
            while (true)
            {
                int left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                if (left <= 0) return null;
                string line;
                if (!_lines.TryTake(out line, left)) return null;
                if (prefix.IsMatch(line)) return line;
            }
        }

        public int WaitExit(int timeoutMs)
        {
            try { _process.StandardInput.Close(); } catch (Exception) { }
            if (!_process.WaitForExit(timeoutMs))
            {
                try { _process.Kill(); } catch (InvalidOperationException) { }
                return -999;
            }
            return _process.ExitCode;
        }

        public void Dispose()
        {
            try { if (!_process.HasExited) _process.Kill(); } catch (InvalidOperationException) { }
            _process.Dispose();
        }
    }
}
