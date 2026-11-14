// Protocol method handlers (docs/protocol.md "Methods"), ported from
// helpers/linux/pi_gui_helper/methods.py. Handlers run on the sequential
// queue, so per-session state (latest snapshot, latest capture) needs no lock.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace PiGuiHelper
{
    public sealed class Handlers
    {
        static readonly string[] Actions = new string[] { "click", "double_click", "right_click", "type", "key", "scroll", "set_value" };
        static readonly string[] WaitKinds = new string[] { "window", "text", "ref", "idle" };
        static readonly string[] BaseCapabilities = new string[] { "launch", "wait", "snapshot", "snapshotFull", "screenshot", "act", "windows" };
        static readonly string[] DepsMethods = new string[] { "depsPack", "depsRead", "depsReceive", "depsWrite", "depsUnpack", "depsDiscard" };

        public const int LaunchWindowWaitMs = 20000;
        public const int HandoffGraceMs = 2000;
        public const int DefaultExecTimeoutMs = 30 * 60 * 1000;
        public const int DefaultWaitTimeoutMs = 10000;
        public const int MaxWaitTimeoutMs = 10 * 60 * 1000;
        public const int DefaultMaxNodes = 500;
        /// <summary>Upper bound for nodes in one walk (the client accepts 200 000).</summary>
        public const int WalkCap = 20000;
        // Client limits (src/backends/response.ts RESPONSE_LIMITS, src/protocol.ts MAX_LINE_BYTES),
        // enforced here so a result is never rejected as a whole by the client.
        /// <summary>Windows in one result (RESPONSE_LIMITS.windows).</summary>
        public const int MaxWindows = 1000;
        /// <summary>Characters of one window title (RESPONSE_LIMITS.textChars).</summary>
        public const int MaxTitleChars = 64 * 1024;
        /// <summary>Encoded bytes of one window list (titles and envelope), well below the 64 MiB line limit.</summary>
        public const long MaxWindowsJsonBytes = 16L * 1024 * 1024;
        /// <summary>Allowance per window entry for its keys, bounds, and separators.</summary>
        public const int WindowEntryOverheadBytes = 256;
        /// <summary>Byte budget of one walk's JSON; the client unpacks at most 256 MiB (treeJsonBytes).</summary>
        public const long MaxTreeJsonBytes = 128L * 1024 * 1024;
        /// <summary>Base64 text of one gzip tree dump (treeGzBase64Chars).</summary>
        public const int MaxTreeGzBase64Chars = 48 * 1024 * 1024;
        /// <summary>Inline snapshot tree bytes, well below the 64 MiB line limit.</summary>
        public const long MaxInlineTreeBytes = 32L * 1024 * 1024;
        public const int MaxTypeChars = 100000;
        const int PollMs = 250;
        const int IdleStableSamples = 3;

        readonly IPlatform _platform;
        readonly HostConfig _config;
        readonly Action<string> _requestExit;
        readonly ILogSink _log;
        int _snapshotCounter;
        string _snapshotId;
        List<ElementNode> _snapshotNodes = new List<ElementNode>();
        byte[] _snapshotJson;
        int _captureCounter;
        string _captureId;
        Bounds _captureRect;

        public Handlers(IPlatform platform, HostConfig config, ILogSink log, Action<string> requestExit)
        {
            _platform = platform;
            _config = config;
            _log = log;
            _requestExit = requestExit;
        }

        public Dictionary<string, Handler> Table()
        {
            var t = new Dictionary<string, Handler>(StringComparer.Ordinal);
            t["hello"] = Hello;
            t["ping"] = Ping;
            t["launch"] = Launch;
            t["wait"] = Wait;
            t["snapshot"] = Snapshot;
            t["snapshotFull"] = SnapshotFull;
            t["screenshot"] = Screenshot;
            t["act"] = Act;
            t["windows"] = Windows;
            t["exec"] = Exec;
            t["stop"] = Stop;
            foreach (string name in DepsMethods) t[name] = NoDeps;
            return t;
        }

        // ----- parameters ----------------------------------------------------

        static string Str(Dictionary<string, object> p, string key, bool required)
        {
            object v;
            if (!p.TryGetValue(key, out v) || v == null)
            {
                if (required) throw new ProtocolException("BAD_REQUEST", key + " is required");
                return null;
            }
            var s = v as string;
            if (s == null) throw new ProtocolException("BAD_REQUEST", key + " must be a string");
            return s;
        }

        static int Int(Dictionary<string, object> p, string key, int fallback, int minimum, int maximum)
        {
            object v;
            if (!p.TryGetValue(key, out v) || v == null) return fallback;
            double d;
            if (v is long) d = (long)v;
            else if (v is double) d = (double)v;
            else throw new ProtocolException("BAD_REQUEST", key + " must be a number");
            if (double.IsNaN(d)) throw new ProtocolException("BAD_REQUEST", key + " must be a number");
            d = Math.Truncate(d);
            if (d < minimum) throw new ProtocolException("BAD_REQUEST", key + " must be at least " + minimum);
            if (d > maximum) d = maximum;
            return (int)d;
        }

        static Dictionary<string, string> Env(Dictionary<string, object> p)
        {
            var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            object v;
            if (!p.TryGetValue("env", out v) || v == null) return env;
            var d = v as Dictionary<string, object>;
            if (d == null) throw new ProtocolException("BAD_REQUEST", "env must be an object of strings");
            foreach (var pair in d)
            {
                var s = pair.Value as string;
                if (s == null) throw new ProtocolException("BAD_REQUEST", "env must be an object of strings");
                env[pair.Key] = s;
            }
            return env;
        }

        static List<string> Args(Dictionary<string, object> p)
        {
            var args = new List<string>();
            object v;
            if (!p.TryGetValue("args", out v) || v == null) return args;
            var list = v as List<object>;
            if (list == null) throw new ProtocolException("BAD_REQUEST", "args must be an array of strings");
            foreach (object item in list)
            {
                var s = item as string;
                if (s == null) throw new ProtocolException("BAD_REQUEST", "args must be an array of strings");
                args.Add(s);
            }
            return args;
        }

        string Cwd(Dictionary<string, object> p)
        {
            string cwd = Str(p, "cwd", false);
            return string.IsNullOrEmpty(cwd) ? _config.Workspace : cwd;
        }

        static long ElapsedMs(Stopwatch sw) { return sw.ElapsedMilliseconds; }

        // ----- session -------------------------------------------------------

        object Hello(RequestContext ctx, Dictionary<string, object> p)
        {
            object protocol;
            p.TryGetValue("protocol", out protocol);
            if (!(protocol is long) || (long)protocol != Protocol.Version)
            {
                ctx.After = delegate { _requestExit("protocol mismatch"); };
                throw new ProtocolException("PROTOCOL_MISMATCH", "helper speaks protocol " + Protocol.Version + ", client sent " + Json.Serialize(protocol));
            }
            var caps = new List<object>();
            foreach (string c in BaseCapabilities) caps.Add(c);
            if (_config.AllowExec) caps.Add("exec");
            foreach (string c in _platform.Capabilities) caps.Add(c);
            var r = new Dictionary<string, object>();
            r["protocol"] = Protocol.Version;
            r["helperVersion"] = Protocol.HelperVersion;
            r["os"] = "windows";
            r["arch"] = _platform.Arch;
            r["capabilities"] = caps;
            string fingerprint = _platform.Fingerprint ?? "";
            r["platform"] = fingerprint.Length > 256 ? fingerprint.Substring(0, 256) : fingerprint;
            return r;
        }

        object Ping(RequestContext ctx, Dictionary<string, object> p) { return Results.Ok(); }

        object NoDeps(RequestContext ctx, Dictionary<string, object> p)
        {
            throw new ProtocolException("BAD_REQUEST", "the Windows helper has no dependency cache (hello omits \"deps\")");
        }

        object Stop(RequestContext ctx, Dictionary<string, object> p)
        {
            List<Dictionary<string, object>> leftovers = _platform.Teardown();
            ctx.After = delegate { _requestExit("stop"); };
            var r = new Dictionary<string, object>();
            r["ok"] = leftovers.Count == 0;
            r["leftovers"] = leftovers;
            return r;
        }

        // ----- processes -----------------------------------------------------

        object Exec(RequestContext ctx, Dictionary<string, object> p)
        {
            if (!_config.AllowExec)
                throw new ProtocolException("BAD_REQUEST", "exec is disabled: this backend never runs setup commands (the client did not set PI_GUI_ALLOW_EXEC=1)");
            string cmd = Str(p, "cmd", true);
            int timeoutMs = Int(p, "timeoutMs", DefaultExecTimeoutMs, 1, int.MaxValue);
            Dictionary<string, string> env = Env(p);
            string cwd = Cwd(p);
            var sw = Stopwatch.StartNew();
            IChild child = _platform.StartExec(cmd, env, cwd);
            int code;
            try
            {
                while (!child.HasExited)
                {
                    if (sw.ElapsedMilliseconds >= timeoutMs)
                    {
                        child.KillTree();
                        child.DrainOutput(2000);
                        throw new ProtocolException("TIMEOUT", "setup command exceeded " + timeoutMs + " ms");
                    }
                    try
                    {
                        ctx.Sleep(50);
                    }
                    catch (ProtocolException)
                    {
                        child.KillTree();
                        child.DrainOutput(2000);
                        throw;
                    }
                }
                // Read before KillTree and Forget: Forget closes the process handle, after which the
                // exit code is gone, and KillTree must not overwrite it.
                code = child.ExitCode;
                // Background processes the command left in its job must not outlive the step.
                child.KillTree();
                child.DrainOutput(2000);
            }
            finally
            {
                _platform.Forget(child);
            }
            int reported = ReportedExitCode(code);
            if (reported != code)
                _log.Log("stderr", "setup", "pi-gui-helper: setup command exited with code " + code.ToString(CultureInfo.InvariantCulture) +
                    " (0x" + code.ToString("X8", CultureInfo.InvariantCulture) + "); reported as " + reported + "\n");
            var r = new Dictionary<string, object>();
            r["exitCode"] = reported;
            r["elapsedMs"] = ElapsedMs(sw);
            return r;
        }

        /// <summary>The client accepts exit codes in -1000..1000; Windows NTSTATUS-style codes are reported as 1000.</summary>
        public static int ReportedExitCode(int code)
        {
            return code < -1000 || code > 1000 ? 1000 : code;
        }

        HashSet<string> WindowRefs()
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            foreach (WindowEntry w in _platform.ListWindows()) set.Add(w.Ref);
            return set;
        }

        object Launch(RequestContext ctx, Dictionary<string, object> p)
        {
            string cmd = Str(p, "cmd", true);
            List<string> args = Args(p);
            Dictionary<string, string> env = Env(p);
            string cwd = Cwd(p);
            HashSet<string> before = WindowRefs();
            IChild child = _platform.Launch(cmd, args, env, cwd);
            var sw = Stopwatch.StartNew();
            long exitedAt = -1;
            while (sw.ElapsedMilliseconds < LaunchWindowWaitMs)
            {
                bool cut;
                List<object> windows = WindowsJson(_platform.ListWindows(), delegate(WindowEntry w) { return !before.Contains(w.Ref); }, out cut);
                if (windows.Count > 0) return LaunchResult(child, windows, cut);
                if (child.HasExited)
                {
                    if (exitedAt < 0) exitedAt = sw.ElapsedMilliseconds;
                    else if (sw.ElapsedMilliseconds - exitedAt >= HandoffGraceMs)
                    {
                        int code = child.ExitCode;
                        child.DrainOutput(1000);
                        _platform.Forget(child);
                        if (code == 0) throw new ProtocolException("HANDOFF", "app exited without opening a window; it probably handed off to another instance");
                        throw new ProtocolException("INTERNAL", "app exited with code " + code + " before opening a window; output tail:\n" + child.OutputTail(1000));
                    }
                }
                ctx.Sleep(100);
            }
            // Still running without a window: report it and let the client wait.
            return LaunchResult(child, new List<object>(), false);
        }

        static Dictionary<string, object> LaunchResult(IChild child, List<object> windows, bool truncated)
        {
            var r = new Dictionary<string, object>();
            r["pid"] = child.Pid;
            r["windows"] = windows;
            if (truncated) r["truncated"] = true;
            return r;
        }

        // ----- inspection ----------------------------------------------------

        object Windows(RequestContext ctx, Dictionary<string, object> p)
        {
            var r = new Dictionary<string, object>();
            bool cut;
            r["windows"] = WindowsJson(_platform.ListWindows(), null, out cut);
            if (cut) r["truncated"] = true;
            return r;
        }

        object Snapshot(RequestContext ctx, Dictionary<string, object> p)
        {
            int maxNodes = Int(p, "maxNodes", DefaultMaxNodes, 0, int.MaxValue);
            WalkResult walk = _platform.A11yAvailable ? _platform.Walk(new TreeBudget(WalkCap, MaxTreeJsonBytes), ctx) : new WalkResult(new List<ElementNode>(), 0);
            if (walk.Truncated)
                Diag.Write("the accessibility tree exceeds the walk budget; the snapshot holds its first " + walk.Nodes.Count + " nodes");
            _snapshotCounter++;
            string sid = "s" + _snapshotCounter.ToString(CultureInfo.InvariantCulture);
            var nodes = new List<object>();
            for (int i = 0; i < walk.Nodes.Count; i++) nodes.Add(NodeJson(sid, walk.Nodes[i], i));
            _snapshotId = sid;
            _snapshotNodes = walk.Nodes;
            // Keep only the latest full tree: snapshotFull follows right after snapshot.
            _snapshotJson = Encoding.UTF8.GetBytes(Json.Serialize(nodes));
            int limit = InlineCount(walk.Nodes, maxNodes, MaxInlineTreeBytes);
            var r = new Dictionary<string, object>();
            r["snapshotId"] = sid;
            r["coverage"] = _platform.A11yAvailable ? Coverage.Compute(walk) : "none";
            r["tree"] = nodes.Count > limit ? nodes.GetRange(0, limit) : nodes;
            // Cut by the walk budget or by the inline bounds: either way the tree is not the whole tree.
            r["truncated"] = walk.Truncated || nodes.Count > limit;
            return r;
        }

        /// <summary>How many leading nodes the inline tree holds: at most maxNodes and maxBytes (estimated).</summary>
        public static int InlineCount(List<ElementNode> nodes, int maxNodes, long maxBytes)
        {
            var budget = new TreeBudget(Math.Max(0, maxNodes), maxBytes);
            int count = 0;
            while (count < nodes.Count && budget.Admit(nodes[count])) count++;
            return count;
        }

        /// <summary>Gzip + base64 of a tree dump; TOO_LARGE when the text would exceed maxBase64Chars.</summary>
        public static string TreeDump(byte[] json, int maxBase64Chars)
        {
            var output = new MemoryStream();
            using (var gz = new GZipStream(output, CompressionMode.Compress, true))
            {
                gz.Write(json, 0, json.Length);
            }
            long chars = (output.Length + 2) / 3 * 4;
            if (chars > maxBase64Chars)
                throw new ProtocolException("TOO_LARGE", "the full accessibility tree is too large to transfer (" + chars + " base64 characters, at most " + maxBase64Chars +
                    "); use the inline snapshot (maxNodes) or a screenshot");
            return Convert.ToBase64String(output.GetBuffer(), 0, (int)output.Length);
        }

        /// <summary>
        /// Windows as JSON within the client's bounds (it refuses a longer list, or a longer title, as a
        /// whole): at most MaxWindows entries, titles of at most MaxTitleChars, and at most
        /// MaxWindowsJsonBytes of encoded JSON. truncated tells whether a window or a title was cut.
        /// </summary>
        public static List<object> WindowsJson(IEnumerable<WindowEntry> windows, Func<WindowEntry, bool> include, out bool truncated)
        {
            return WindowsJson(windows, include, MaxWindowsJsonBytes, out truncated);
        }

        public static List<object> WindowsJson(IEnumerable<WindowEntry> windows, Func<WindowEntry, bool> include, long maxBytes, out bool truncated)
        {
            var list = new List<object>();
            truncated = false;
            long bytes = 2;
            foreach (WindowEntry w in windows)
            {
                if (include != null && !include(w)) continue;
                if (list.Count >= MaxWindows)
                {
                    truncated = true;
                    break;
                }
                Dictionary<string, object> entry = w.ToJson();
                string title = w.Title;
                if (title.Length > MaxTitleChars)
                {
                    int keep = MaxTitleChars;
                    if (char.IsHighSurrogate(title[keep - 1])) keep--;
                    entry["title"] = title.Substring(0, keep);
                    truncated = true;
                }
                long size = Json.EncodedLength(w.Ref) + Json.EncodedLength((string)entry["title"]) + WindowEntryOverheadBytes;
                if (bytes + size > maxBytes)
                {
                    truncated = true;
                    break;
                }
                bytes += size;
                list.Add(entry);
            }
            if (truncated) Diag.Write("the window list exceeds the result bounds; it holds the first " + list.Count + " windows (titles of at most " + MaxTitleChars + " characters)");
            return list;
        }

        static Dictionary<string, object> NodeJson(string sid, ElementNode n, int index)
        {
            var d = new Dictionary<string, object>();
            d["ref"] = sid + ":" + index.ToString(CultureInfo.InvariantCulture);
            d["role"] = Clip(n.Role ?? "unknown", 256);
            d["name"] = n.Name ?? "";
            if (n.Value != null) d["value"] = n.Value;
            if (n.Bounds != null) d["bounds"] = n.Bounds.ToJson();
            var states = new List<object>();
            foreach (string s in n.States)
            {
                if (states.Count >= 64) break;
                states.Add(Clip(s, 256));
            }
            d["states"] = states;
            if (n.Parent >= 0) d["parent"] = sid + ":" + n.Parent.ToString(CultureInfo.InvariantCulture);
            return d;
        }

        static string Clip(string s, int max)
        {
            return s.Length > max ? s.Substring(0, max) : s;
        }

        object SnapshotFull(RequestContext ctx, Dictionary<string, object> p)
        {
            string sid = Str(p, "snapshotId", true);
            if (_snapshotId == null || sid != _snapshotId)
                throw new ProtocolException("STALE_REF", "unknown or stale snapshotId '" + sid + "', take a new snapshot");
            var r = new Dictionary<string, object>();
            r["tree_gz_base64"] = TreeDump(_snapshotJson, MaxTreeGzBase64Chars);
            return r;
        }

        /// <summary>The element for a snapshot ref, or STALE_REF / NOT_FOUND / BAD_REQUEST.</summary>
        object Resolve(string reference)
        {
            int colon = reference.LastIndexOf(':');
            int index;
            if (colon <= 0 || !int.TryParse(reference.Substring(colon + 1), NumberStyles.None, CultureInfo.InvariantCulture, out index))
                throw new ProtocolException("BAD_REQUEST", "malformed ref '" + reference + "'");
            if (!_platform.A11yAvailable)
                throw new ProtocolException("NOT_FOUND", "no accessibility tree in this session; use screenshots and coordinates");
            if (reference.Substring(0, colon) != _snapshotId) throw new ProtocolException("STALE_REF", "stale ref, take a new snapshot");
            if (index >= _snapshotNodes.Count) throw new ProtocolException("NOT_FOUND", "ref " + reference + " is not in the snapshot");
            object handle = _snapshotNodes[index].Handle;
            if (!_platform.ElementAlive(handle)) throw new ProtocolException("STALE_REF", "element no longer exists, take a new snapshot");
            return handle;
        }

        public static bool IsWindowRef(string reference)
        {
            if (reference == null || !reference.StartsWith("win:0x", StringComparison.Ordinal) || reference.Length <= 6 || reference.Length > 22) return false;
            for (int i = 6; i < reference.Length; i++)
            {
                char c = reference[i];
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            }
            return true;
        }

        WindowEntry RequireWindow(string reference)
        {
            WindowEntry w = _platform.FindWindow(reference);
            if (w == null) throw new ProtocolException("NOT_FOUND", "window " + reference + " is gone or not visible");
            return w;
        }

        object Screenshot(RequestContext ctx, Dictionary<string, object> p)
        {
            string reference = Str(p, "window", false);
            int maxEdge = Int(p, "maxEdge", Imaging.DefaultMaxEdge, 16, Imaging.MaxEdgePixels);
            RgbImage image;
            Bounds rect;
            string target = "screen";
            if (string.IsNullOrEmpty(reference))
            {
                image = _platform.CaptureScreen(out rect);
            }
            else if (IsWindowRef(reference))
            {
                WindowEntry w = RequireWindow(reference);
                image = _platform.CaptureWindow(w);
                rect = new Bounds(w.Bounds.X, w.Bounds.Y, image.Width, image.Height);
                target = reference;
            }
            else
            {
                object handle = Resolve(reference);
                Bounds element = _platform.ElementBounds(handle);
                if (element == null) throw new ProtocolException("NOT_FOUND", "element " + reference + " has no on-screen bounds");
                Bounds screen;
                RgbImage full = _platform.CaptureScreen(out screen);
                Bounds clip = element.Intersect(screen);
                if (clip == null) throw new ProtocolException("NOT_FOUND", reference + " is entirely off screen");
                image = Imaging.Crop(full, clip.X - screen.X, clip.Y - screen.Y, clip.Width, clip.Height);
                rect = clip;
                target = reference;
            }
            if (image.Width > Imaging.MaxEdgePixels || image.Height > Imaging.MaxEdgePixels)
                throw new ProtocolException("INTERNAL", "capture of " + image.Width + "x" + image.Height + " exceeds the protocol's pixel bound");
            Dictionary<string, object> result = Imaging.BuildCapture(image, maxEdge);
            _captureCounter++;
            _captureId = "c" + _captureCounter.ToString(CultureInfo.InvariantCulture);
            _captureRect = new Bounds(rect.X, rect.Y, image.Width, image.Height);
            result["captureId"] = _captureId;
            result["target"] = target;
            var origin = new Dictionary<string, object>();
            origin["x"] = rect.X;
            origin["y"] = rect.Y;
            result["origin"] = origin;
            return result;
        }

        // ----- actions -------------------------------------------------------

        void CapturePoint(Dictionary<string, object> p, out int sx, out int sy)
        {
            string captureId = Str(p, "captureId", false);
            if (_captureId == null || captureId != _captureId) throw new ProtocolException("STALE_REF", "stale captureId, take a new screenshot");
            double x = Coordinate(p, "x"), y = Coordinate(p, "y");
            if (!(x >= 0 && x < _captureRect.Width && y >= 0 && y < _captureRect.Height))
                throw new ProtocolException("BAD_REQUEST", "x,y outside the " + _captureRect.Width + "x" + _captureRect.Height + " capture");
            sx = _captureRect.X + (int)x;
            sy = _captureRect.Y + (int)y;
        }

        static double Coordinate(Dictionary<string, object> p, string key)
        {
            object v;
            p.TryGetValue(key, out v);
            if (v is long) return (long)v;
            if (v is double && !double.IsNaN((double)v)) return (double)v;
            throw new ProtocolException("BAD_REQUEST", "x and y must be numbers");
        }

        object Act(RequestContext ctx, Dictionary<string, object> p)
        {
            string action = Str(p, "action", true);
            if (Array.IndexOf(Actions, action) < 0) throw new ProtocolException("BAD_REQUEST", "unknown action '" + action + "'");
            string text = Str(p, "text", false) ?? "";
            if (text.Length > MaxTypeChars) throw new ProtocolException("BAD_REQUEST", "text is longer than " + MaxTypeChars + " characters");
            string reference = Str(p, "ref", false);
            object captureId;
            p.TryGetValue("captureId", out captureId);
            if (reference == null && captureId != null)
            {
                int sx, sy;
                CapturePoint(p, out sx, out sy);
                ActAt(action, sx, sy, text, null);
                return Results.Ok();
            }
            if (reference == null)
            {
                if (action == "type" || action == "key")
                {
                    Keyboard(action, text, null);
                    return Results.Ok();
                }
                throw new ProtocolException("BAD_REQUEST", "act needs ref, or captureId with x and y");
            }
            if (IsWindowRef(reference))
            {
                WindowEntry w = RequireWindow(reference);
                _platform.ActivateWindow(reference);
                ActAt(action, w.Bounds.CenterX, w.Bounds.CenterY, text, reference);
                return Results.Ok();
            }
            ActElement(action, reference, text);
            return Results.Ok();
        }

        void Keyboard(string action, string text, string windowRef)
        {
            if (action == "type") _platform.TypeText(text, windowRef);
            else _platform.Keys(KeySyntax.Parse(text), windowRef);
        }

        void ActAt(string action, int sx, int sy, string text, string windowRef)
        {
            switch (action)
            {
                case "click":
                case "double_click":
                case "right_click":
                    _platform.Pointer(action, sx, sy);
                    break;
                case "type":
                case "key":
                    if (action == "key") KeySyntax.Parse(text); // refuse bad key text before clicking
                    _platform.Pointer("click", sx, sy);
                    Keyboard(action, text, windowRef);
                    break;
                case "scroll":
                    string direction;
                    int amount;
                    KeySyntax.ParseScroll(text, out direction, out amount);
                    _platform.Scroll(sx, sy, direction, amount);
                    break;
                default:
                    throw new ProtocolException("BAD_REQUEST", "set_value needs an element ref, not coordinates");
            }
        }

        void ActElement(string action, string reference, string text)
        {
            object handle = Resolve(reference);
            if (action == "set_value")
            {
                _platform.ElementSetValue(handle, text);
                return;
            }
            if (action == "click" && _platform.ElementDefaultAction(handle)) return;
            Bounds bounds = _platform.ElementBounds(handle);
            if (action == "type" || action == "key")
            {
                if (action == "key") KeySyntax.Parse(text);
                if (!_platform.ElementFocus(handle) && bounds != null) _platform.Pointer("click", bounds.CenterX, bounds.CenterY);
                Keyboard(action, text, _platform.ElementWindow(handle));
                return;
            }
            if (bounds == null) throw new ProtocolException("NOT_FOUND", "element " + reference + " has no usable action and no on-screen bounds");
            ActAt(action, bounds.CenterX, bounds.CenterY, text, _platform.ElementWindow(handle));
        }

        // ----- waiting -------------------------------------------------------

        object Wait(RequestContext ctx, Dictionary<string, object> p)
        {
            string kind = Str(p, "for", true);
            if (Array.IndexOf(WaitKinds, kind) < 0) throw new ProtocolException("BAD_REQUEST", "for must be one of " + string.Join(", ", WaitKinds));
            string value = Str(p, "value", false);
            if ((kind == "text" || kind == "ref") && string.IsNullOrEmpty(value)) throw new ProtocolException("BAD_REQUEST", "wait for " + kind + " needs value");
            int timeoutMs = Int(p, "timeoutMs", DefaultWaitTimeoutMs, 0, MaxWaitTimeoutMs);
            var sw = Stopwatch.StartNew();
            Func<bool> probe = WaitProbe(kind, value, ctx);
            while (true)
            {
                if (probe())
                {
                    return WaitResult(true, sw);
                }
                long left = timeoutMs - sw.ElapsedMilliseconds;
                if (left <= 0) return WaitResult(false, sw);
                ctx.Sleep((int)Math.Min(PollMs, left));
            }
        }

        static Dictionary<string, object> WaitResult(bool matched, Stopwatch sw)
        {
            var r = new Dictionary<string, object>();
            r["matched"] = matched;
            r["elapsedMs"] = sw.ElapsedMilliseconds;
            return r;
        }

        Func<bool> WaitProbe(string kind, string value, RequestContext ctx)
        {
            if (kind == "window")
            {
                return delegate
                {
                    foreach (WindowEntry w in _platform.ListWindows())
                    {
                        if (string.IsNullOrEmpty(value) || value == w.Ref || w.Title.IndexOf(value, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                    }
                    return false;
                };
            }
            if (kind == "text")
            {
                if (!_platform.A11yAvailable) return delegate { return false; };
                return delegate { return _platform.FindText(value, ctx); };
            }
            if (kind == "ref")
            {
                return delegate
                {
                    if (IsWindowRef(value)) return _platform.FindWindow(value) != null;
                    object handle = Resolve(value);
                    return _platform.ElementShowing(handle);
                };
            }
            var hashes = new List<string>();
            return delegate
            {
                Bounds rect;
                hashes.Add(Imaging.Sha256Hex(_platform.CaptureScreen(out rect).Rgb));
                if (hashes.Count < IdleStableSamples) return false;
                for (int i = hashes.Count - IdleStableSamples + 1; i < hashes.Count; i++)
                {
                    if (hashes[i] != hashes[hashes.Count - IdleStableSamples]) return false;
                }
                return true;
            };
        }
    }
}
