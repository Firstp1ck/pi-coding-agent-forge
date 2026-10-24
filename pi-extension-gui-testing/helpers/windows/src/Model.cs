// Boundary between the protocol core and the platform layer.
//
// The core (Json, Framing, Dispatch, Imaging, Policy, Handlers, HelperMain)
// is pure managed code. Everything that touches Win32, UI Automation, or the
// file system's security lives behind IPlatform (src/win/*.cs), so the core is
// compiled and tested on any host with a fake platform
// (tests/helper-windows/FakePlatform.cs).
using System.Collections.Generic;

namespace PiGuiHelper
{
    /// <summary>Screen rectangle in physical pixels.</summary>
    public sealed class Bounds
    {
        public Bounds(int x, int y, int width, int height)
        {
            X = x;
            Y = y;
            Width = width;
            Height = height;
        }

        public int X { get; private set; }
        public int Y { get; private set; }
        public int Width { get; private set; }
        public int Height { get; private set; }

        public int CenterX { get { return X + Width / 2; } }
        public int CenterY { get { return Y + Height / 2; } }

        public bool Contains(int x, int y)
        {
            return x >= X && y >= Y && x < X + Width && y < Y + Height;
        }

        /// <summary>Intersection with another rectangle, or null when empty.</summary>
        public Bounds Intersect(Bounds other)
        {
            int x0 = System.Math.Max(X, other.X);
            int y0 = System.Math.Max(Y, other.Y);
            int x1 = System.Math.Min(X + Width, other.X + other.Width);
            int y1 = System.Math.Min(Y + Height, other.Y + other.Height);
            if (x1 <= x0 || y1 <= y0) return null;
            return new Bounds(x0, y0, x1 - x0, y1 - y0);
        }

        public Dictionary<string, object> ToJson()
        {
            var d = new Dictionary<string, object>();
            d["x"] = X;
            d["y"] = Y;
            d["width"] = Width;
            d["height"] = Height;
            return d;
        }
    }

    /// <summary>A top-level window of the session. Ref: "win:0x&lt;hwnd hex&gt;".</summary>
    public sealed class WindowEntry
    {
        public WindowEntry(string windowRef, string title, Bounds bounds)
        {
            Ref = windowRef;
            Title = title ?? "";
            Bounds = bounds;
        }

        public string Ref { get; private set; }
        public string Title { get; private set; }
        public Bounds Bounds { get; private set; }

        public Dictionary<string, object> ToJson()
        {
            var d = new Dictionary<string, object>();
            d["ref"] = Ref;
            d["title"] = Title;
            d["bounds"] = Bounds.ToJson();
            return d;
        }
    }

    /// <summary>One accessibility element found by a walk; Handle is opaque to the core.</summary>
    public sealed class ElementNode
    {
        public ElementNode()
        {
            States = new List<string>();
            Parent = -1;
            Window = -1;
        }

        public string Role { get; set; }
        public string Name { get; set; }
        public string Value { get; set; }
        public Bounds Bounds { get; set; }
        public List<string> States { get; private set; }
        /// <summary>Index of the parent node in the walk, or -1 for a root.</summary>
        public int Parent { get; set; }
        /// <summary>Index of the window (in the walk's window list) this node belongs to.</summary>
        public int Window { get; set; }
        public object Handle { get; set; }
    }

    public sealed class WalkResult
    {
        public WalkResult(List<ElementNode> nodes, int windowCount)
        {
            Nodes = nodes;
            WindowCount = windowCount;
        }

        public List<ElementNode> Nodes { get; private set; }
        public int WindowCount { get; private set; }
    }

    /// <summary>A process started by launch or exec, contained in the session's Job Objects.</summary>
    public interface IChild
    {
        int Pid { get; }
        bool HasExited { get; }
        /// <summary>Exit code once exited (-1 when unknown).</summary>
        int ExitCode { get; }
        /// <summary>Last output characters (bounded), for error messages.</summary>
        string OutputTail(int maxChars);
        /// <summary>Kills this child's whole job (the child and everything it started).</summary>
        void KillTree();
        /// <summary>Waits up to timeoutMs for the output pumps to drain.</summary>
        void DrainOutput(int timeoutMs);
    }

    /// <summary>A key chord: modifier virtual keys plus one key (virtual key, or a character the platform maps).</summary>
    public sealed class KeyChord
    {
        public KeyChord()
        {
            Modifiers = new List<int>();
        }

        public List<int> Modifiers { get; private set; }
        /// <summary>Virtual-key code, or 0 when Char must be mapped by the platform.</summary>
        public int Vk { get; set; }
        public char Char { get; set; }
        public string Text { get; set; }
    }

    public interface IPlatform
    {
        string Arch { get; }
        /// <summary>hello.platform: OS build, architecture, runtime (at most 256 characters).</summary>
        string Fingerprint { get; }
        /// <summary>Platform capabilities appended to hello.capabilities (e.g. "a11y-uia", "desktop-private").</summary>
        IList<string> Capabilities { get; }
        /// <summary>Whether snapshots have an accessibility tree at all.</summary>
        bool A11yAvailable { get; }

        /// <summary>Creates the desktop, job, and temp dirs. Throws on any failure (fail closed).</summary>
        void Start();

        /// <summary>Starts an app. Throws ProtocolException NOT_FOUND (command, cwd) or BAD_REQUEST.</summary>
        IChild Launch(string cmd, IList<string> args, IDictionary<string, string> env, string cwd);
        /// <summary>Starts a setup command (cmd.exe /d /s /c) whose output goes to setup log events.</summary>
        IChild StartExec(string command, IDictionary<string, string> env, string cwd);
        void Forget(IChild child);

        IList<WindowEntry> ListWindows();
        /// <summary>The window for a window ref, or null when it is gone or not visible.</summary>
        WindowEntry FindWindow(string windowRef);

        /// <summary>Whole-desktop capture; rect is its position and size on the virtual screen.</summary>
        RgbImage CaptureScreen(out Bounds rect);
        /// <summary>Full window-rect capture (PrintWindow with PW_RENDERFULLCONTENT).</summary>
        RgbImage CaptureWindow(WindowEntry window);

        WalkResult Walk(int cap, RequestContext ctx);
        /// <summary>False when the element no longer exists.</summary>
        bool ElementAlive(object handle);
        Bounds ElementBounds(object handle);
        bool ElementShowing(object handle);
        bool FindText(string value, RequestContext ctx);

        /// <summary>click, double_click, right_click at a screen point.</summary>
        void Pointer(string action, int screenX, int screenY);
        void Scroll(int screenX, int screenY, string direction, int amount);
        /// <summary>Key chords to the focused control of the window (null: the session's active window).</summary>
        void Keys(IList<KeyChord> chords, string windowRef);
        void TypeText(string text, string windowRef);
        /// <summary>Makes the window active on the session's desktop (never the user's desktop).</summary>
        void ActivateWindow(string windowRef);
        /// <summary>Invoke, Toggle, SelectionItem, ExpandCollapse in that order; false when none applies.</summary>
        bool ElementDefaultAction(object handle);
        /// <summary>Value or RangeValue pattern. Throws BAD_REQUEST when neither is available.</summary>
        void ElementSetValue(object handle, string text);
        bool ElementFocus(object handle);
        /// <summary>Window ref of the top-level window that holds the element, or null.</summary>
        string ElementWindow(object handle);

        /// <summary>Idempotent teardown. Returns leftovers ({kind, id, detail?}).</summary>
        List<Dictionary<string, object>> Teardown();
    }

    public interface IPlatformFactory
    {
        IPlatform Create(HostConfig config, IDictionary<string, string> env, ILogSink log);
        /// <summary>Client checks without the protocol (--probe NAME): one JSON object.</summary>
        Dictionary<string, object> Probe(string name, IDictionary<string, string> env);
        /// <summary>%LOCALAPPDATA%\Temp, the required parent of a local-mode runtime dir (null when unknown).</summary>
        string LocalTempRoot(IDictionary<string, string> env);
    }
}
