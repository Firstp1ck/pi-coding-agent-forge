// Scripted IPlatform for the Windows helper's protocol tests. It replaces the
// Win32 layer (helpers/windows/src/win) so the real core (framing, dispatch,
// handlers, imaging, policy) runs on any host with PowerShell 7.
//
// Scripted commands for launch: "fake-app" (opens window "Fake App"),
// "handoff" (exits 0 without a window), "crash" (exits 3), "windowless"
// (runs, never opens a window), "missing" (NOT_FOUND), "black-app" (window
// whose capture is all black), "many-windows" (1200 windows), "big-tree" (a
// window whose tree holds 1100 nodes with 64 Ki-character names), "unhealthy"
// (the platform reports the session unusable). exec: "exit N", "echo TEXT", "sleep MS",
// "big N" (N bytes of output), "ntstatus" (exits 0xC0000005).
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

namespace PiGuiHelper.Tests
{
    public sealed class FakeChild : IChild
    {
        readonly ManualResetEvent _exited = new ManualResetEvent(false);
        readonly StringBuilder _tail = new StringBuilder();
        int _exitCode = -1;

        public FakeChild(int pid) { Pid = pid; }

        public int Pid { get; private set; }
        public bool HasExited { get { return _exited.WaitOne(0); } }
        /// <summary>Like a closed process handle: after Forget the exit code can no longer be read.</summary>
        public int ExitCode { get { return HasExited && !Forgotten ? _exitCode : -1; } }
        public bool Forgotten { get; set; }
        public bool Killed { get; private set; }

        public void Exit(int code)
        {
            _exitCode = code;
            _exited.Set();
        }

        public void ExitAfter(int ms, int code)
        {
            var t = new Thread(delegate() { if (!_exited.WaitOne(ms)) Exit(code); });
            t.IsBackground = true;
            t.Start();
        }

        public void AddOutput(string text) { lock (_tail) { _tail.Append(text); } }

        public string OutputTail(int maxChars)
        {
            lock (_tail)
            {
                string s = _tail.ToString();
                return s.Length > maxChars ? s.Substring(s.Length - maxChars) : s;
            }
        }

        public void KillTree()
        {
            Killed = true;
            if (!HasExited) Exit(1);
        }

        public void DrainOutput(int timeoutMs) { }
    }

    public sealed class FakeElement
    {
        public string Role;
        public string Name;
        public string Value;
        public Bounds Bounds;
        public int Parent = -1;
        public bool Alive = true;
        public string Window;
    }

    public sealed class FakePlatform : IPlatform
    {
        readonly HostConfig _config;
        readonly ILogSink _log;
        readonly IDictionary<string, string> _env;
        readonly List<WindowEntry> _windows = new List<WindowEntry>();
        readonly List<FakeElement> _elements = new List<FakeElement>();
        readonly List<string> _events = new List<string>();
        readonly object _lock = new object();
        int _nextPid = 4000;
        int _nextWindow = 0x1001;
        bool _tornDown;
        bool _blackWindow;
        string _label = "Not pressed";

        public FakePlatform(HostConfig config, IDictionary<string, string> env, ILogSink log)
        {
            _config = config;
            _env = env;
            _log = log;
        }

        public string Arch { get { return "x64"; } }
        public string Fingerprint { get { return "Windows 10.0.19045 x64; fake platform; .NET test"; } }
        public IList<string> Capabilities { get { return new string[] { "a11y-uia", "desktop-private" }; } }
        public bool A11yAvailable { get { return true; } }

        void Event(string text)
        {
            lock (_lock) { _events.Add(text); }
            // Tests observe calls through stderr diagnostics.
            Diag.Write("fake: " + text);
        }

        public void Start()
        {
            string fail;
            if (_env.TryGetValue("FAKE_START_FAIL", out fail) && fail == "1") throw new InvalidOperationException("fake desktop creation failed");
            Event("start mode=" + _config.Mode);
        }

        public IChild Launch(string cmd, IList<string> args, IDictionary<string, string> env, string cwd)
        {
            if (cmd == "missing") throw new ProtocolException("NOT_FOUND", "command not found: " + cmd);
            if (cmd == "unhealthy") throw new UnhealthyException("launch was refused: 2 earlier operations are still stuck in a hung app");
            if (cwd.IndexOf("missing", StringComparison.Ordinal) >= 0) throw new ProtocolException("NOT_FOUND", "cwd " + cwd + " does not exist in the session");
            var child = new FakeChild(Interlocked.Increment(ref _nextPid));
            List<string> effective = LaunchPolicy.Args(cmd, args, _config.SoftwareRendering);
            Event("launch " + cmd + " args=" + string.Join("|", effective.ToArray()));
            switch (cmd)
            {
                case "fake-app":
                case "black-app":
                case "electron":
                    _blackWindow = cmd == "black-app";
                    AddWindow(cmd == "black-app" ? "Black App" : "Fake App");
                    _log.Log("stderr", "app", "fake app started\n");
                    break;
                case "many-windows":
                    for (int i = 0; i < 1200; i++) AddWindow("Window " + i);
                    break;
                case "big-tree":
                    AddWindow("Big Tree");
                    lock (_lock)
                    {
                        string name = new string('x', 65536);
                        for (int i = 0; i < 1100; i++)
                            _elements.Add(new FakeElement { Role = "paragraph", Name = name, Parent = 0, Bounds = new Bounds(20, 30, 30, 6), Window = _windows[_windows.Count - 1].Ref });
                    }
                    break;
                case "handoff":
                    child.ExitAfter(50, 0);
                    break;
                case "crash":
                    child.AddOutput("boom: fatal error");
                    child.ExitAfter(50, 3);
                    break;
                default:
                    break;
            }
            return child;
        }

        void AddWindow(string title)
        {
            lock (_lock)
            {
                string reference = "win:0x" + (_nextWindow++).ToString("x");
                _windows.Add(new WindowEntry(reference, title, new Bounds(10, 20, 64, 40)));
                _elements.Clear();
                _elements.Add(new FakeElement { Role = "frame", Name = title, Bounds = new Bounds(10, 20, 64, 40), Window = reference });
                _elements.Add(new FakeElement { Role = "title bar", Name = title, Parent = 0, Bounds = new Bounds(10, 20, 64, 8), Window = reference });
                _elements.Add(new FakeElement { Role = "push button", Name = "Close", Parent = 1, Bounds = new Bounds(60, 20, 8, 8), Window = reference });
                _elements.Add(new FakeElement { Role = "push button", Name = "Press me", Parent = 0, Bounds = new Bounds(20, 40, 20, 10), Window = reference });
                _elements.Add(new FakeElement { Role = "label", Name = _label, Parent = 0, Bounds = new Bounds(20, 52, 30, 6), Window = reference });
                _elements.Add(new FakeElement { Role = "text", Name = "Input", Value = "", Parent = 0, Bounds = new Bounds(20, 30, 30, 6), Window = reference });
            }
        }

        public IChild StartExec(string command, IDictionary<string, string> env, string cwd)
        {
            var child = new FakeChild(Interlocked.Increment(ref _nextPid));
            Event("exec " + command);
            string[] parts = command.Split(new char[] { ' ' }, 2);
            string arg = parts.Length > 1 ? parts[1] : "";
            switch (parts[0])
            {
                case "exit": child.Exit(int.Parse(arg)); break;
                case "ntstatus": child.Exit(unchecked((int)0xC0000005)); break;
                case "echo":
                    _log.Log("stdout", "setup", arg + "\n");
                    child.Exit(0);
                    break;
                case "big":
                    _log.Log("stdout", "setup", new string('x', int.Parse(arg)));
                    child.Exit(0);
                    break;
                case "sleep": child.ExitAfter(int.Parse(arg), 0); break;
                default: child.Exit(127); break;
            }
            return child;
        }

        public void Forget(IChild child)
        {
            var c = child as FakeChild;
            if (c != null) c.Forgotten = true;
        }

        public IList<WindowEntry> ListWindows()
        {
            lock (_lock) { return new List<WindowEntry>(_windows); }
        }

        public WindowEntry FindWindow(string windowRef)
        {
            lock (_lock)
            {
                foreach (WindowEntry w in _windows) if (w.Ref == windowRef) return w;
            }
            return null;
        }

        static RgbImage Pattern(int width, int height, bool black)
        {
            var rgb = new byte[width * height * 3];
            if (!black)
            {
                for (int i = 0; i < rgb.Length; i++) rgb[i] = (byte)((i * 7) & 0xFF);
            }
            return new RgbImage(width, height, rgb);
        }

        public RgbImage CaptureScreen(out Bounds rect)
        {
            int w = 1600, h = 900;
            string size;
            if (_env.TryGetValue("FAKE_SCREEN", out size))
            {
                string[] p = size.Split('x');
                w = int.Parse(p[0]);
                h = int.Parse(p[1]);
            }
            rect = new Bounds(0, 0, w, h);
            return Pattern(w, h, false);
        }

        public RgbImage CaptureWindow(WindowEntry window)
        {
            return Pattern(window.Bounds.Width, window.Bounds.Height, _blackWindow);
        }

        public WalkResult Walk(TreeBudget budget, RequestContext ctx)
        {
            lock (_lock)
            {
                var nodes = new List<ElementNode>();
                for (int i = 0; i < _elements.Count && !budget.Exhausted; i++)
                {
                    FakeElement e = _elements[i];
                    var n = new ElementNode();
                    n.Role = e.Role;
                    n.Name = e.Role == "label" ? _label : e.Name;
                    n.Value = e.Value;
                    n.Bounds = e.Bounds;
                    n.Parent = e.Parent;
                    n.Window = 0;
                    n.States.Add("enabled");
                    n.States.Add("showing");
                    n.Handle = e;
                    if (!budget.Admit(n)) break;
                    nodes.Add(n);
                }
                return new WalkResult(nodes, _windows.Count, budget.Exhausted);
            }
        }

        public bool ElementAlive(object handle) { return ((FakeElement)handle).Alive; }
        public Bounds ElementBounds(object handle) { return ((FakeElement)handle).Bounds; }
        public bool ElementShowing(object handle) { return ((FakeElement)handle).Alive; }

        public bool FindText(string value, RequestContext ctx)
        {
            lock (_lock)
            {
                if (_label.IndexOf(value, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                foreach (FakeElement e in _elements)
                {
                    if (e.Name != null && e.Name.IndexOf(value, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                }
            }
            return false;
        }

        public void Pointer(string action, int screenX, int screenY)
        {
            Event("pointer " + action + " " + screenX + "," + screenY);
            lock (_lock)
            {
                foreach (FakeElement e in _elements)
                {
                    if (e.Name == "Press me" && e.Bounds.Contains(screenX, screenY) && action == "click") _label = "Pressed";
                }
            }
        }

        public void Scroll(int screenX, int screenY, string direction, int amount) { Event("scroll " + direction + " " + amount + " at " + screenX + "," + screenY); }

        public void Keys(IList<KeyChord> chords, string windowRef)
        {
            var parts = new List<string>();
            foreach (KeyChord c in chords) parts.Add(string.Join("+", c.Modifiers.ConvertAll(m => "0x" + m.ToString("x2")).ToArray()) + ":" + (c.Vk != 0 ? "0x" + c.Vk.ToString("x2") : "char " + c.Char));
            Event("keys " + string.Join(" ", parts.ToArray()) + " to " + (windowRef ?? "active"));
        }

        public void TypeText(string text, string windowRef) { Event("type " + text.Length + " chars to " + (windowRef ?? "active")); }

        public void ActivateWindow(string windowRef) { Event("activate " + windowRef); }

        public bool ElementDefaultAction(object handle)
        {
            var e = (FakeElement)handle;
            Event("invoke " + e.Name);
            if (e.Name == "Press me")
            {
                lock (_lock) { _label = "Pressed"; }
                return true;
            }
            return false;
        }

        public void ElementSetValue(object handle, string text)
        {
            var e = (FakeElement)handle;
            if (e.Role != "text") throw new ProtocolException("BAD_REQUEST", "element supports neither Value nor RangeValue");
            e.Value = text;
            Event("set_value " + text);
        }

        public bool ElementFocus(object handle) { Event("focus " + ((FakeElement)handle).Name); return true; }

        public string ElementWindow(object handle) { return ((FakeElement)handle).Window; }

        public List<Dictionary<string, object>> Teardown()
        {
            var leftovers = new List<Dictionary<string, object>>();
            lock (_lock)
            {
                if (_tornDown) return leftovers;
                _tornDown = true;
            }
            Event("teardown");
            string leftover;
            if (_env.TryGetValue("FAKE_LEFTOVER", out leftover) && leftover == "1")
            {
                var l = new Dictionary<string, object>();
                l["kind"] = "process";
                l["id"] = "4242:132000000000000000";
                l["detail"] = "fake survivor";
                leftovers.Add(l);
            }
            return leftovers;
        }
    }

    public sealed class FakeFactory : IPlatformFactory
    {
        public IPlatform Create(HostConfig config, IDictionary<string, string> env, ILogSink log)
        {
            return new FakePlatform(config, env, log);
        }

        public Dictionary<string, object> Probe(string name, IDictionary<string, string> env)
        {
            var r = new Dictionary<string, object>();
            r["probe"] = name;
            r["ok"] = name == "desktop";
            return r;
        }

        public string LocalTempRoot(IDictionary<string, string> env)
        {
            string root;
            return env.TryGetValue("FAKE_LOCAL_TEMP", out root) ? root : "C:\\Users\\tester\\AppData\\Local\\Temp";
        }
    }

    public static class FakeEntry
    {
        public static int Main(string stdinEnv, string probe)
        {
            Stream input = Console.OpenStandardInput();
            Stream output = Console.OpenStandardOutput();
            Console.SetOut(Console.Error);
            Dictionary<string, string> env = HelperMain.ProcessEnvironment();
            if (!string.IsNullOrEmpty(probe)) return HelperMain.RunProbe(new FakeFactory(), probe, output, env);
            return HelperMain.Run(new FakeFactory(), stdinEnv, input, output, env);
        }
    }
}
