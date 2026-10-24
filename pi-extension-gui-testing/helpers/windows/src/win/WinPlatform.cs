// IPlatform on Windows: session desktop, contained processes, windows,
// captures, input, UI Automation, teardown, probes, and the entry point that
// helper.ps1 calls. Only windows on the session's desktop (and, on a guest's
// interactive desktop, only windows of the session's own processes) are ever
// listed, captured, or sent input; a window ref naming any other window is
// NOT_FOUND.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Windows.Automation;

namespace PiGuiHelper.Win
{
    internal sealed class WinPlatform : IPlatform
    {
        const int ListTimeoutMs = 15000;
        const int CaptureTimeoutMs = 30000;
        const int WalkTimeoutMs = 90000;
        const int ActionTimeoutMs = 15000;
        const int PatternTimeoutMs = 5000;
        const int MaxRecordedProcesses = 256;

        readonly HostConfig _config;
        readonly IDictionary<string, string> _env;
        readonly ILogSink _log;
        readonly string _psVersion;
        readonly object _lock = new object();
        readonly List<WinChild> _children = new List<WinChild>();
        readonly List<string> _jobNames = new List<string>();
        readonly List<KeyValuePair<int, long>> _processes = new List<KeyValuePair<int, long>>();
        WinDesktop _desktop;
        string _desktopName;
        string _tag;
        string _tmpDir;
        string _cmdExe;
        IntPtr _activeWindow;
        bool _wpfWarned;
        bool _tornDown;
        List<Dictionary<string, object>> _finalLeftovers;

        public WinPlatform(HostConfig config, IDictionary<string, string> env, ILogSink log, string psVersion)
        {
            _config = config;
            _env = env;
            _log = log;
            _psVersion = psVersion;
        }

        public string Arch { get { return WinSecurity.Arch(); } }
        public string Fingerprint { get { return WinSecurity.Fingerprint(_psVersion); } }
        public bool A11yAvailable { get { return true; } }

        public IList<string> Capabilities
        {
            get { return new string[] { "a11y-uia", _config.InteractiveDesktop ? "desktop-interactive" : "desktop-private" }; }
        }

        string SessionRecordPath { get { return WinPath.Combine(_config.RuntimeDir, "session.json"); } }

        // ----- lifecycle -----------------------------------------------------

        public void Start()
        {
            bool elevated = WinSecurity.IsCurrentProcessElevated();
            if (_config.AllowElevated && !elevated)
                throw new InvalidOperationException("PI_GUI_ALLOW_ELEVATED=1 needs an elevated helper; the helper never asks for elevation (no UAC prompt)");
            if (!_config.Guest && elevated && !_config.AllowElevated)
                throw new InvalidOperationException("the helper runs elevated: start it from a non-elevated session, without -StdinEnv so it can drop to the Explorer token, or set PI_GUI_ALLOW_ELEVATED=1");
            int build = WinSecurity.OsBuild();
            if (build != 0 && build < 17763) throw new InvalidOperationException("Windows 10 1809 (build 17763) or later is required; this is build " + build);
            if (!Directory.Exists(_config.Workspace)) throw new InvalidOperationException("PI_GUI_WORKSPACE " + _config.Workspace + " is not a directory");
            WinFiles.CheckPrivateDir(_config.RuntimeDir, "PI_GUI_RUNTIME_DIR");
            _tag = WinDesktop.RandomHex(8);
            _cmdExe = WinPath.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
            _tmpDir = WinFiles.CreateSubdir(_config.RuntimeDir, "tmp");
            _desktop = _config.InteractiveDesktop ? WinDesktop.OpenInteractive() : WinDesktop.CreatePrivate(_tag);
            _desktopName = _desktop.Name;
            WriteRecord("running", null);
        }

        void WriteRecord(string status, List<Dictionary<string, object>> leftovers)
        {
            var record = new Dictionary<string, object>();
            record["version"] = 1;
            var helper = new Dictionary<string, object>();
            helper["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
            helper["created"] = WinSecurity.CreationTime(Native.GetCurrentProcess()).ToString(CultureInfo.InvariantCulture);
            record["helper"] = helper;
            record["tag"] = _tag;
            record["mode"] = _config.Mode;
            record["windowStation"] = WinDesktop.WindowStationName();
            record["desktop"] = _desktopName;
            record["privateDesktop"] = !_config.InteractiveDesktop;
            lock (_lock)
            {
                record["jobs"] = new List<string>(_jobNames);
                var processes = new List<object>();
                foreach (var p in _processes)
                {
                    var entry = new Dictionary<string, object>();
                    entry["pid"] = p.Key;
                    entry["created"] = p.Value.ToString(CultureInfo.InvariantCulture);
                    processes.Add(entry);
                }
                record["processes"] = processes;
            }
            record["tmpDir"] = _tmpDir;
            record["status"] = status;
            if (leftovers != null) record["leftovers"] = leftovers;
            record["updatedAt"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
            WinFiles.WriteAtomic(SessionRecordPath, Json.Serialize(record));
        }

        static Dictionary<string, object> Leftover(string kind, string id, string detail)
        {
            var l = new Dictionary<string, object>();
            l["kind"] = kind;
            l["id"] = id.Length > 256 ? id.Substring(0, 256) : id;
            if (detail != null) l["detail"] = detail.Length > 1024 ? detail.Substring(0, 1024) : detail;
            return l;
        }

        public List<Dictionary<string, object>> Teardown()
        {
            lock (_lock)
            {
                if (_tornDown) return new List<Dictionary<string, object>>(_finalLeftovers ?? new List<Dictionary<string, object>>());
                _tornDown = true;
            }
            var leftovers = new List<Dictionary<string, object>>();
            List<WinChild> children;
            lock (_lock) { children = new List<WinChild>(_children); }
            foreach (WinChild c in children) c.Job.Terminate();
            var deadline = DateTime.UtcNow.AddSeconds(5);
            foreach (WinChild c in children)
            {
                while (c.Job.ProcessIds().Count > 0 && DateTime.UtcNow < deadline) Thread.Sleep(50);
                List<int> remaining = c.Job.ProcessIds();
                if (remaining.Count > 0)
                {
                    leftovers.Add(Leftover("job", c.Job.Name, remaining.Count + " processes still running after TerminateJobObject"));
                    foreach (int pid in remaining) leftovers.Add(Leftover("process", ProcessIdentity(pid), "in job " + c.Job.Name));
                }
                c.Close();
            }
            lock (_lock) { _children.Clear(); }
            lock (_lock)
            {
                foreach (var p in _processes)
                {
                    if (p.Value != 0 && WinSecurity.SameProcessAlive(p.Key, p.Value))
                    {
                        string id = p.Key.ToString(CultureInfo.InvariantCulture) + ":" + p.Value.ToString(CultureInfo.InvariantCulture);
                        bool listed = false;
                        foreach (var l in leftovers) if ((string)l["id"] == id) listed = true;
                        if (!listed) leftovers.Add(Leftover("process", id, "outlived its Job Object"));
                    }
                }
            }
            if (_desktop != null)
            {
                bool closed = _desktop.Close();
                if (!_config.InteractiveDesktop)
                {
                    var until = DateTime.UtcNow.AddSeconds(2);
                    while (WinDesktop.Exists(_desktopName) && DateTime.UtcNow < until) Thread.Sleep(50);
                    if (!closed || WinDesktop.Exists(_desktopName))
                        leftovers.Add(Leftover("desktop", _desktopName, closed ? "a process outside the session's jobs still uses it" : "CloseDesktop failed"));
                }
                _desktop = null;
            }
            if (_tmpDir != null)
            {
                List<string> problems = WinFiles.DeleteTree(_tmpDir);
                if (problems.Count > 0) leftovers.Add(Leftover("tempdir", _tmpDir, string.Join("; ", problems.ToArray())));
            }
            try
            {
                if (_tag != null) WriteRecord("stopped", leftovers);
            }
            catch (Exception e)
            {
                Diag.Write("could not update the session record: " + e.Message);
            }
            lock (_lock) { _finalLeftovers = leftovers; }
            return new List<Dictionary<string, object>>(leftovers);
        }

        static string ProcessIdentity(int pid)
        {
            IntPtr h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            long created = 0;
            if (h != IntPtr.Zero)
            {
                created = WinSecurity.CreationTime(h);
                Native.CloseHandle(h);
            }
            return pid.ToString(CultureInfo.InvariantCulture) + ":" + created.ToString(CultureInfo.InvariantCulture);
        }

        // ----- processes -----------------------------------------------------

        string RequireCwd(string cwd)
        {
            string normalized;
            try
            {
                normalized = WinPath.NormalizeAbsolute(cwd, "cwd");
            }
            catch (ArgumentException e)
            {
                throw new ProtocolException("BAD_REQUEST", e.Message);
            }
            if (!Directory.Exists(normalized)) throw new ProtocolException("NOT_FOUND", "cwd " + cwd + " does not exist in the session");
            return normalized;
        }

        SortedDictionary<string, string> ChildEnv(IDictionary<string, string> request)
        {
            var forced = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            forced["TEMP"] = _tmpDir;
            forced["TMP"] = _tmpDir;
            forced[HostConfig.TagEnv] = _tag;
            LaunchPolicy.AddRenderingEnv(forced, request, _config.SoftwareRendering);
            var withDefaults = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            withDefaults["PYTHONIOENCODING"] = "utf-8";
            foreach (var pair in request) withDefaults[pair.Key] = pair.Value;
            return ChildEnvironment.Build(_env, withDefaults, forced);
        }

        WinChild StartContained(string application, string commandLine, SortedDictionary<string, string> env, string cwd, string source)
        {
            var spec = new LaunchSpec();
            spec.Application = application;
            spec.CommandLine = commandLine;
            spec.EnvironmentBlock = ChildEnvironment.Block(env);
            spec.Cwd = cwd;
            spec.Desktop = _desktop.FullName;
            spec.JobName = "Local\\pi-gui-testing-" + _tag + "-job-" + WinDesktop.RandomHex(8);
            spec.Source = source;
            spec.AllowElevated = _config.AllowElevated || _config.Guest;
            spec.Log = _log;
            spec.BeforeResume = delegate(WinChild child)
            {
                lock (_lock)
                {
                    _jobNames.Add(child.Job.Name);
                    _processes.Add(new KeyValuePair<int, long>(child.Pid, child.CreationTime));
                    if (_processes.Count > MaxRecordedProcesses) _processes.RemoveAt(0);
                    if (_jobNames.Count > MaxRecordedProcesses) _jobNames.RemoveAt(0);
                    _children.Add(child);
                }
                WriteRecord("running", null);
            };
            lock (_lock)
            {
                if (_tornDown) throw new ProtocolException("CANCELLED", "the session is stopping");
            }
            return WinLauncher.Start(spec);
        }

        public IChild Launch(string cmd, IList<string> args, IDictionary<string, string> env, string cwd)
        {
            string dir = RequireCwd(cwd);
            SortedDictionary<string, string> childEnv = ChildEnv(env);
            string path, pathExt;
            childEnv.TryGetValue("PATH", out path);
            childEnv.TryGetValue("PATHEXT", out pathExt);
            string resolved = CommandLine.Resolve(cmd, dir, path, pathExt, File.Exists);
            if (resolved == null) throw new ProtocolException("NOT_FOUND", "command not found: " + cmd);
            List<string> effective = LaunchPolicy.Args(cmd, args, _config.SoftwareRendering);
            if (CommandLine.IsBatch(resolved))
                return StartContained(_cmdExe, CommandLine.BuildBatch(_cmdExe, resolved, effective), childEnv, dir, "app");
            return StartContained(resolved, CommandLine.Build(resolved, effective), childEnv, dir, "app");
        }

        public IChild StartExec(string command, IDictionary<string, string> env, string cwd)
        {
            string dir = RequireCwd(cwd);
            return StartContained(_cmdExe, CommandLine.BuildShell(_cmdExe, command), ChildEnv(env), dir, "setup");
        }

        public void Forget(IChild child)
        {
            var c = child as WinChild;
            if (c == null) return;
            lock (_lock) { _children.Remove(c); }
            c.Close();
        }

        // ----- windows -------------------------------------------------------

        T OnDesktop<T>(string what, int timeoutMs, RequestContext ctx, Func<T> fn)
        {
            WinDesktop desktop = _desktop;
            if (desktop == null) throw new ProtocolException("CANCELLED", "the session is stopping");
            return desktop.Run(what, timeoutMs, ctx, fn);
        }

        HashSet<int> JobPids()
        {
            var pids = new HashSet<int>();
            List<WinChild> children;
            lock (_lock) { children = new List<WinChild>(_children); }
            foreach (WinChild c in children) foreach (int pid in c.Job.ProcessIds()) pids.Add(pid);
            return pids;
        }

        /// <summary>Session windows in z-order (topmost first). Desktop thread only.</summary>
        List<IntPtr> SessionZOrder(HashSet<int> jobPids)
        {
            List<IntPtr> all = WinWindows.ZOrder(_desktop.Handle);
            if (!_config.InteractiveDesktop) return all;
            var mine = new List<IntPtr>();
            foreach (IntPtr hwnd in all) if (jobPids.Contains(WinWindows.Pid(hwnd))) mine.Add(hwnd);
            return mine;
        }

        List<IntPtr> ListedHwnds(HashSet<int> jobPids)
        {
            var listed = new List<IntPtr>();
            foreach (IntPtr hwnd in SessionZOrder(jobPids))
            {
                if (WinWindows.Listed(hwnd)) listed.Add(hwnd);
            }
            return listed;
        }

        void WarnWpf(List<IntPtr> windows)
        {
            if (_wpfWarned) return;
            foreach (IntPtr hwnd in windows)
            {
                if (WinWindows.ClassName(hwnd).StartsWith("HwndWrapper[", StringComparison.Ordinal))
                {
                    _wpfWarned = true;
                    _log.Log("stderr", "app", "pi-gui-helper: " + LaunchPolicy.WpfWarning + "\n");
                    return;
                }
            }
        }

        public IList<WindowEntry> ListWindows()
        {
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            return OnDesktop("windows", ListTimeoutMs, null, delegate
            {
                List<IntPtr> listed = ListedHwnds(pids);
                WarnWpf(listed);
                var result = new List<WindowEntry>();
                foreach (IntPtr hwnd in listed)
                {
                    Bounds b = WinWindows.Rect(hwnd);
                    if (b != null) result.Add(new WindowEntry(WinWindows.Ref(hwnd), WinWindows.Title(hwnd), b));
                }
                return (IList<WindowEntry>)result;
            });
        }

        /// <summary>The hwnd for a window ref when it is a listed window of this session, else zero. Desktop thread only.</summary>
        IntPtr SessionWindow(string reference, HashSet<int> pids)
        {
            IntPtr hwnd = WinWindows.ParseRef(reference);
            if (hwnd == IntPtr.Zero) return IntPtr.Zero;
            foreach (IntPtr candidate in ListedHwnds(pids)) if (candidate == hwnd) return hwnd;
            return IntPtr.Zero;
        }

        public WindowEntry FindWindow(string windowRef)
        {
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            return OnDesktop("windows", ListTimeoutMs, null, delegate
            {
                IntPtr hwnd = SessionWindow(windowRef, pids);
                if (hwnd == IntPtr.Zero) return null;
                Bounds b = WinWindows.Rect(hwnd);
                return b == null ? null : new WindowEntry(WinWindows.Ref(hwnd), WinWindows.Title(hwnd), b);
            });
        }

        public RgbImage CaptureScreen(out Bounds rect)
        {
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            Bounds screen = null;
            RgbImage image = OnDesktop("screenshot", CaptureTimeoutMs, null, delegate
            {
                screen = WinCapture.VirtualScreen();
                if (_config.InteractiveDesktop) return WinCapture.ScreenRgb(screen);
                return WinCapture.Compose(SessionZOrder(pids), screen);
            });
            rect = screen;
            return image;
        }

        public RgbImage CaptureWindow(WindowEntry window)
        {
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            return OnDesktop("screenshot", CaptureTimeoutMs, null, delegate
            {
                IntPtr hwnd = SessionWindow(window.Ref, pids);
                if (hwnd == IntPtr.Zero) throw new ProtocolException("NOT_FOUND", "window " + window.Ref + " is gone or not visible");
                Bounds b = WinWindows.Rect(hwnd);
                if (b == null) throw new ProtocolException("NOT_FOUND", "window " + window.Ref + " has no size");
                return WinCapture.PrintWindowRgb(hwnd, b.Width, b.Height);
            });
        }

        // ----- accessibility -------------------------------------------------

        public WalkResult Walk(int cap, RequestContext ctx)
        {
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            return OnDesktop("snapshot", WalkTimeoutMs, ctx, delegate { return WinUia.Walk(ListedHwnds(pids), cap, ctx); });
        }

        public bool ElementAlive(object handle)
        {
            var e = (AutomationElement)handle;
            return OnDesktop("element", ActionTimeoutMs, null, delegate { return WinUia.Alive(e); });
        }

        public Bounds ElementBounds(object handle)
        {
            var e = (AutomationElement)handle;
            return OnDesktop("element", ActionTimeoutMs, null, delegate { return WinUia.LiveBounds(e); });
        }

        public bool ElementShowing(object handle)
        {
            var e = (AutomationElement)handle;
            return OnDesktop("element", ActionTimeoutMs, null, delegate { return WinUia.Showing(e); });
        }

        public bool FindText(string value, RequestContext ctx)
        {
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            return OnDesktop("wait", WalkTimeoutMs, ctx, delegate { return WinUia.FindText(ListedHwnds(pids), value, ctx); });
        }

        public bool ElementDefaultAction(object handle)
        {
            var e = (AutomationElement)handle;
            try
            {
                return OnDesktop("invoke", PatternTimeoutMs, null, delegate { return WinUia.DefaultAction(e); });
            }
            catch (ProtocolException ex)
            {
                if (ex.Code != "TIMEOUT") throw;
                // Invoke on a button that opens a modal dialog returns only when the dialog closes.
                Diag.Write("UI Automation action still running after " + (PatternTimeoutMs / 1000) + " s; treating it as delivered");
                return true;
            }
        }

        public void ElementSetValue(object handle, string text)
        {
            var e = (AutomationElement)handle;
            OnDesktop("set_value", ActionTimeoutMs, null, delegate { WinUia.SetValue(e, text); return true; });
        }

        public bool ElementFocus(object handle)
        {
            var e = (AutomationElement)handle;
            return OnDesktop("focus", ActionTimeoutMs, null, delegate { return WinUia.Focus(e); });
        }

        public string ElementWindow(object handle)
        {
            var e = (AutomationElement)handle;
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            return OnDesktop("element", ActionTimeoutMs, null, delegate
            {
                IntPtr top = WinUia.TopWindow(e);
                if (top == IntPtr.Zero) return null;
                string reference = WinWindows.Ref(top);
                return SessionWindow(reference, pids) == IntPtr.Zero ? null : reference;
            });
        }

        // ----- input ---------------------------------------------------------

        public void Pointer(string action, int screenX, int screenY)
        {
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            IntPtr top = OnDesktop("click", ActionTimeoutMs, null, delegate
            {
                List<IntPtr> z = SessionZOrder(pids);
                return _config.SendInput ? WinInput.PointerSendInput(z, action, screenX, screenY) : WinInput.Pointer(z, action, screenX, screenY);
            });
            IntPtr root = Native.GetAncestor(top, Native.GA_ROOT);
            _activeWindow = root != IntPtr.Zero ? root : top;
        }

        public void Scroll(int screenX, int screenY, string direction, int amount)
        {
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            OnDesktop("scroll", ActionTimeoutMs, null, delegate
            {
                if (_config.SendInput) WinInput.ScrollSendInput(screenX, screenY, direction, amount);
                else WinInput.Scroll(SessionZOrder(pids), screenX, screenY, direction, amount);
                return true;
            });
        }

        /// <summary>The window keyboard input goes to: the ref, else the session's active window, else the topmost one. Desktop thread only.</summary>
        IntPtr KeyboardTarget(string windowRef, HashSet<int> pids)
        {
            if (windowRef != null)
            {
                IntPtr hwnd = SessionWindow(windowRef, pids);
                if (hwnd == IntPtr.Zero) throw new ProtocolException("NOT_FOUND", "window " + windowRef + " is gone or not visible");
                return hwnd;
            }
            List<IntPtr> listed = ListedHwnds(pids);
            if (_activeWindow != IntPtr.Zero && listed.Contains(_activeWindow)) return _activeWindow;
            if (listed.Count > 0) return listed[0];
            throw new ProtocolException("NOT_FOUND", "no window to send keys to");
        }

        public void Keys(IList<KeyChord> chords, string windowRef)
        {
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            OnDesktop("key", ActionTimeoutMs + chords.Count * 100, null, delegate
            {
                IntPtr top = KeyboardTarget(windowRef, pids);
                if (_config.SendInput) WinInput.KeysSendInput(top, chords);
                else WinInput.Keys(top, chords);
                return true;
            });
        }

        public void TypeText(string text, string windowRef)
        {
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            OnDesktop("type", ActionTimeoutMs + text.Length / 5, null, delegate
            {
                IntPtr top = KeyboardTarget(windowRef, pids);
                if (_config.SendInput) WinInput.TypeSendInput(top, text);
                else WinInput.Type(top, text);
                return true;
            });
        }

        public void ActivateWindow(string windowRef)
        {
            HashSet<int> pids = _config.InteractiveDesktop ? JobPids() : null;
            _activeWindow = OnDesktop("activate", ActionTimeoutMs, null, delegate
            {
                IntPtr hwnd = SessionWindow(windowRef, pids);
                if (hwnd == IntPtr.Zero) throw new ProtocolException("NOT_FOUND", "window " + windowRef + " is gone or not visible");
                if (_config.SendInput) Native.SetForegroundWindow(hwnd);
                else WinInput.Activate(hwnd);
                return hwnd;
            });
        }
    }

    internal sealed class WinFactory : IPlatformFactory
    {
        readonly string _psVersion;

        public WinFactory(string psVersion) { _psVersion = psVersion; }

        public IPlatform Create(HostConfig config, IDictionary<string, string> env, ILogSink log)
        {
            return new WinPlatform(config, env, log, _psVersion);
        }

        public string LocalTempRoot(IDictionary<string, string> env)
        {
            string local;
            if (!env.TryGetValue("LOCALAPPDATA", out local) || string.IsNullOrEmpty(local)) return null;
            return WinPath.Combine(local, "Temp");
        }

        public Dictionary<string, object> Probe(string name, IDictionary<string, string> env)
        {
            var r = new Dictionary<string, object>();
            r["probe"] = name;
            switch (name)
            {
                case "env": ProbeEnv(r); break;
                case "desktop": ProbeDesktop(r); break;
                case "job": ProbeJob(r); break;
                case "nonelevated": ProbeNonElevated(r); break;
                case "uia": ProbeUia(r); break;
                case "foreground": ProbeForeground(r); break;
                default: throw new ArgumentException("unknown probe '" + name + "' (env, desktop, job, nonelevated, uia, foreground)");
            }
            return r;
        }

        void ProbeEnv(Dictionary<string, object> r)
        {
            int session;
            Native.ProcessIdToSessionId(Native.GetCurrentProcessId(), out session);
            r["ok"] = true;
            r["os"] = "windows";
            r["arch"] = WinSecurity.Arch();
            r["platform"] = WinSecurity.Fingerprint(_psVersion);
            r["build"] = WinSecurity.OsBuild();
            r["elevated"] = WinSecurity.IsCurrentProcessElevated();
            r["sessionId"] = session;
            r["windowStation"] = WinDesktop.WindowStationName();
        }

        static void ProbeDesktop(Dictionary<string, object> r)
        {
            WinDesktop d = WinDesktop.CreatePrivate("probe" + WinDesktop.RandomHex(4));
            string name = d.Name;
            bool closed = d.Close();
            Thread.Sleep(100);
            bool gone = !WinDesktop.Exists(name);
            r["ok"] = closed && gone;
            r["desktop"] = name;
            if (!(closed && gone)) r["error"] = closed ? "the desktop still exists after CloseDesktop" : "CloseDesktop failed";
        }

        /// <summary>A process in a kill-on-close job must die when the job handle closes (check helper.job).</summary>
        static void ProbeJob(Dictionary<string, object> r)
        {
            WinDesktop d = WinDesktop.CreatePrivate("probe" + WinDesktop.RandomHex(4));
            WinChild child = null;
            try
            {
                string cmd = WinPath.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
                var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                env["SystemRoot"] = Environment.GetEnvironmentVariable("SystemRoot") ?? "C:\\Windows";
                var spec = new LaunchSpec();
                spec.Application = cmd;
                spec.CommandLine = CommandLine.BuildShell(cmd, "ping -n 30 127.0.0.1 >NUL");
                spec.EnvironmentBlock = ChildEnvironment.Block(env);
                spec.Cwd = Environment.GetFolderPath(Environment.SpecialFolder.System);
                spec.Desktop = d.FullName;
                spec.JobName = "Local\\pi-gui-testing-probe-job-" + WinDesktop.RandomHex(8);
                spec.Source = "setup";
                spec.AllowElevated = true;
                spec.Log = new NullLog();
                child = WinLauncher.Start(spec);
                Thread.Sleep(300);
                bool runningBefore = !child.HasExited;
                child.Job.Close();
                bool died = Native.WaitForSingleObject(child.ProcessHandle, 5000) == Native.WAIT_OBJECT_0;
                r["ok"] = runningBefore && died;
                if (!runningBefore) r["error"] = "the test process ended before the job closed";
                else if (!died) r["error"] = "the test process survived the closing of its kill-on-close job";
            }
            finally
            {
                if (child != null) child.Close();
                d.Close();
            }
        }

        static void ProbeNonElevated(Dictionary<string, object> r)
        {
            bool elevated = WinSecurity.IsCurrentProcessElevated();
            r["elevated"] = elevated;
            if (!elevated)
            {
                r["ok"] = true;
                r["detail"] = "the helper is not elevated, so apps inherit a non-elevated token";
                return;
            }
            IntPtr token = WinSecurity.ShellToken();
            Native.CloseHandle(token);
            r["ok"] = true;
            r["detail"] = "the helper is elevated; a non-elevated Explorer token of the same user is available";
        }

        /// <summary>
        /// UI Automation on a private desktop: a BUTTON window created on a thread attached to the
        /// desktop must be readable from another thread on that desktop (check helper.uia).
        /// </summary>
        static void ProbeUia(Dictionary<string, object> r)
        {
            const string Title = "pi-gui-testing-probe";
            WinDesktop d = WinDesktop.CreatePrivate("probe" + WinDesktop.RandomHex(4));
            IntPtr hwnd = IntPtr.Zero;
            int uiThread = 0;
            var ready = new ManualResetEvent(false);
            Exception uiError = null;
            var thread = new Thread(delegate()
            {
                try
                {
                    if (!Native.SetThreadDesktop(d.Handle)) throw new InvalidOperationException(Native.Error("SetThreadDesktop"));
                    uiThread = Native.GetCurrentThreadId();
                    hwnd = Native.CreateWindowExW(0, "BUTTON", Title, 0x10CF0000 /* WS_OVERLAPPEDWINDOW | WS_VISIBLE */, 10, 10, 240, 80,
                        IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
                    if (hwnd == IntPtr.Zero) throw new InvalidOperationException(Native.Error("CreateWindowEx"));
                }
                catch (Exception e)
                {
                    uiError = e;
                    ready.Set();
                    return;
                }
                ready.Set();
                MSG msg;
                while (Native.GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0)
                {
                    Native.TranslateMessage(ref msg);
                    Native.DispatchMessageW(ref msg);
                }
                Native.DestroyWindow(hwnd);
            });
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            try
            {
                ready.WaitOne(10000);
                if (uiError != null) throw uiError;
                IntPtr target = hwnd;
                string name = d.Run("uia-probe", 20000, null, delegate { return AutomationElement.FromHandle(target).Current.Name; });
                r["ok"] = name == Title;
                r["name"] = name;
                if (name != Title) r["error"] = "UI Automation returned a different name";
            }
            finally
            {
                if (uiThread != 0) Native.PostThreadMessageW(uiThread, Native.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                thread.Join(5000);
                d.Close();
            }
        }

        /// <summary>The user's foreground window, for the isolation assertion (unchanged before vs after a session).</summary>
        static void ProbeForeground(Dictionary<string, object> r)
        {
            IntPtr hwnd = Native.GetForegroundWindow();
            r["ok"] = true;
            r["hwnd"] = hwnd == IntPtr.Zero ? null : WinWindows.Ref(hwnd);
            r["title"] = hwnd == IntPtr.Zero ? "" : WinWindows.Title(hwnd);
        }

        sealed class NullLog : ILogSink
        {
            public void Log(string stream, string source, string text) { }
        }
    }

    /// <summary>Entry point called by helper.ps1.</summary>
    public static class WinEntry
    {
        public static int Run(string stdinEnv, string probe, string psVersion)
        {
            Dictionary<string, string> env = HelperMain.ProcessEnvironment();
            var factory = new WinFactory(psVersion);
            string mode, allow;
            env.TryGetValue(HostConfig.ModeEnv, out mode);
            env.TryGetValue(HostConfig.AllowElevatedEnv, out allow);
            if (string.IsNullOrEmpty(probe) && string.IsNullOrEmpty(stdinEnv) && mode != "guest" && allow != "1" && WinSecurity.IsCurrentProcessElevated())
            {
                // Before anything reads stdin or writes stdout: the copy inherits both.
                try
                {
                    Diag.Write("the helper is elevated; restarting it with the Explorer token so apps run non-elevated");
                    return WinSecurity.RelaunchNonElevated();
                }
                catch (Exception e)
                {
                    Diag.Write("startup failed: " + e.Message);
                    return 1;
                }
            }
            Stream input = Console.OpenStandardInput();
            Stream output = Console.OpenStandardOutput();
            // Only the protocol writer keeps the real stdout; anything else in this process
            // (and every child) that writes to stdout reaches stderr instead.
            Native.SetStdHandle(Native.STD_OUTPUT_HANDLE, Native.GetStdHandle(Native.STD_ERROR_HANDLE));
            Console.SetOut(Console.Error);
            if (!string.IsNullOrEmpty(probe)) return HelperMain.RunProbe(factory, probe, output, env);
            return HelperMain.Run(factory, stdinEnv, input, output, env);
        }
    }
}
