// Pure policy for the Windows helper: the environment contract, command-line
// quoting, command resolution, child environments, software rendering, key
// syntax, role names, and coverage. No Win32 calls; every rule here is unit
// tested on any host (tests/helper-windows).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace PiGuiHelper
{
    /// <summary>
    /// Environment contract of the Windows helper (docs/protocol.md "Windows helper").
    ///
    /// PI_GUI_HELPER_MODE=local|guest (default local)
    ///     local: on the user's machine; the app always runs on a private desktop.
    ///     guest: inside a dedicated VM or sandbox session; same containment, and
    ///     PI_GUI_WIN_DESKTOP=interactive may use that guest's own desktop.
    /// PI_GUI_WORKSPACE=&lt;abs dir&gt;            default cwd of launch and exec (required)
    /// PI_GUI_RUNTIME_DIR=&lt;abs dir&gt;          client-created session dir named pi-gui-testing-*;
    ///     in local mode directly under %LOCALAPPDATA%\Temp (required)
    /// PI_GUI_ALLOW_EXEC=1                     allows exec (default off)
    /// PI_GUI_ALLOW_ELEVATED=1                 apps run elevated; only valid when the helper is elevated
    /// PI_GUI_WIN_DESKTOP=private|interactive  default private; interactive only in guest mode
    /// PI_GUI_WIN_INPUT=messages|sendinput     default messages; sendinput only with the interactive desktop
    /// PI_GUI_WIN_SOFTWARE_RENDERING=1|0       default 1 (force software rendering where a framework allows it)
    /// PI_GUI_WIN_TAG=&lt;16 hex&gt;               session tag chosen by the client (default random); every job
    ///     and the private desktop carry it, so the client can tell the session's objects from others
    /// PI_GUI_TESTING_TOKEN, PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS as on Linux.
    /// </summary>
    public sealed class HostConfig
    {
        public const string ModeEnv = "PI_GUI_HELPER_MODE";
        public const string WorkspaceEnv = "PI_GUI_WORKSPACE";
        public const string RuntimeEnv = "PI_GUI_RUNTIME_DIR";
        public const string AllowExecEnv = "PI_GUI_ALLOW_EXEC";
        public const string AllowElevatedEnv = "PI_GUI_ALLOW_ELEVATED";
        public const string DesktopEnv = "PI_GUI_WIN_DESKTOP";
        public const string InputEnv = "PI_GUI_WIN_INPUT";
        public const string SoftwareRenderingEnv = "PI_GUI_WIN_SOFTWARE_RENDERING";
        public const string DepsEnv = "PI_GUI_DEPS_DIR";
        public const string TagEnv = "PI_GUI_TAG";
        public const string SessionTagEnv = "PI_GUI_WIN_TAG";
        public const string RuntimePrefix = "pi-gui-testing-";

        /// <summary>Variables the client may send as stdin lines (-StdinEnv); values never appear in argv.</summary>
        public static readonly string[] StdinEnvNames = new string[] {
            ModeEnv, WorkspaceEnv, RuntimeEnv, AllowExecEnv, AllowElevatedEnv, DesktopEnv, InputEnv,
            SoftwareRenderingEnv, DepsEnv, SessionTagEnv, Protocol.TokenEnv, Protocol.HeartbeatTestEnv,
        };

        public string Mode { get; private set; }
        public string Workspace { get; private set; }
        public string RuntimeDir { get; private set; }
        public bool AllowExec { get; private set; }
        public bool AllowElevated { get; private set; }
        public bool InteractiveDesktop { get; private set; }
        public bool SendInput { get; private set; }
        public bool SoftwareRendering { get; private set; }
        /// <summary>The client's session tag (16 lower-case hex digits), or null: the helper picks one.</summary>
        public string SessionTag { get; private set; }
        public List<string> Warnings { get; private set; }

        public bool Guest { get { return Mode == "guest"; } }

        static string Get(IDictionary<string, string> env, string name)
        {
            string value;
            return env.TryGetValue(name, out value) ? value : null;
        }

        static bool Flag(IDictionary<string, string> env, string name, bool fallback)
        {
            string value = Get(env, name);
            if (string.IsNullOrEmpty(value)) return fallback;
            if (value == "1") return true;
            if (value == "0") return false;
            throw new ArgumentException(name + " must be 1 or 0");
        }

        /// <summary>Parses and checks the contract. Throws ArgumentException with a user-facing message.</summary>
        public static HostConfig FromEnv(IDictionary<string, string> env, string localTempRoot)
        {
            var c = new HostConfig();
            c.Warnings = new List<string>();
            string mode = Get(env, ModeEnv);
            c.Mode = string.IsNullOrEmpty(mode) ? "local" : mode;
            if (c.Mode != "local" && c.Mode != "guest") throw new ArgumentException(ModeEnv + " must be local or guest");

            string workspace = Get(env, WorkspaceEnv);
            if (string.IsNullOrEmpty(workspace)) throw new ArgumentException(WorkspaceEnv + " is required");
            c.Workspace = WinPath.NormalizeAbsolute(workspace, WorkspaceEnv);

            string runtime = Get(env, RuntimeEnv);
            if (string.IsNullOrEmpty(runtime)) throw new ArgumentException(RuntimeEnv + " is required");
            c.RuntimeDir = WinPath.NormalizeAbsolute(runtime, RuntimeEnv);
            string name = WinPath.FileName(c.RuntimeDir);
            if (!name.StartsWith(RuntimePrefix, StringComparison.OrdinalIgnoreCase) || name.Length <= RuntimePrefix.Length)
                throw new ArgumentException(RuntimeEnv + " must be a directory named " + RuntimePrefix + "<session>");
            if (c.Mode == "local")
            {
                if (string.IsNullOrEmpty(localTempRoot)) throw new ArgumentException("LOCALAPPDATA is not set, so the local runtime dir cannot be checked");
                string root = WinPath.NormalizeAbsolute(localTempRoot, "LOCALAPPDATA\\Temp");
                if (!string.Equals(WinPath.Parent(c.RuntimeDir), root, StringComparison.OrdinalIgnoreCase))
                    throw new ArgumentException(RuntimeEnv + " must be directly under " + root + " in local mode");
            }

            c.AllowExec = Flag(env, AllowExecEnv, false);
            c.AllowElevated = Flag(env, AllowElevatedEnv, false);
            c.SoftwareRendering = Flag(env, SoftwareRenderingEnv, true);

            string desktop = Get(env, DesktopEnv);
            if (string.IsNullOrEmpty(desktop) || desktop == "private") c.InteractiveDesktop = false;
            else if (desktop == "interactive") c.InteractiveDesktop = true;
            else throw new ArgumentException(DesktopEnv + " must be private or interactive");
            if (c.InteractiveDesktop && !c.Guest)
                throw new ArgumentException(DesktopEnv + "=interactive is only allowed in guest mode; local mode always uses a private desktop");

            string input = Get(env, InputEnv);
            if (string.IsNullOrEmpty(input) || input == "messages") c.SendInput = false;
            else if (input == "sendinput") c.SendInput = true;
            else throw new ArgumentException(InputEnv + " must be messages or sendinput");
            if (c.SendInput && !c.InteractiveDesktop)
                throw new ArgumentException(InputEnv + "=sendinput needs " + DesktopEnv + "=interactive in guest mode");

            string tag = Get(env, SessionTagEnv);
            if (!string.IsNullOrEmpty(tag))
            {
                if (tag.Length != 16) throw new ArgumentException(SessionTagEnv + " must be 16 lower-case hex digits");
                foreach (char ch in tag)
                {
                    if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) throw new ArgumentException(SessionTagEnv + " must be 16 lower-case hex digits");
                }
                c.SessionTag = tag;
            }

            if (!string.IsNullOrEmpty(Get(env, DepsEnv)))
                c.Warnings.Add(DepsEnv + " is ignored: the Windows helper has no dependency-cache methods (hello omits \"deps\")");
            return c;
        }
    }

    /// <summary>Windows path rules that need no file system (the platform checks reparse points and owners).</summary>
    public static class WinPath
    {
        /// <summary>
        /// Normalizes "C:\a\b" (forward slashes allowed). Refuses relative, UNC, device (\\?\, \\.\),
        /// empty, "." and ".." components, and characters Windows file names cannot hold.
        /// </summary>
        public static string NormalizeAbsolute(string path, string what)
        {
            if (path == null) throw new ArgumentException(what + " is missing");
            string p = path.Replace('/', '\\');
            if (p.Length < 3 || !IsDriveLetter(p[0]) || p[1] != ':' || p[2] != '\\')
                throw new ArgumentException(what + " must be an absolute local path like C:\\dir");
            while (p.Length > 3 && p.EndsWith("\\", StringComparison.Ordinal)) p = p.Substring(0, p.Length - 1);
            string rest = p.Substring(3);
            if (rest.Length > 0)
            {
                foreach (string part in rest.Split('\\'))
                {
                    if (part.Length == 0 || part == "." || part == "..") throw new ArgumentException(what + " has an empty, '.' or '..' component");
                    foreach (char ch in part)
                    {
                        if (ch < 0x20 || "<>:\"|?*".IndexOf(ch) >= 0) throw new ArgumentException(what + " has a character Windows paths cannot hold");
                    }
                    if (part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal))
                        throw new ArgumentException(what + " has a component ending in '.' or ' '");
                }
            }
            return char.ToUpperInvariant(p[0]) + p.Substring(1);
        }

        static bool IsDriveLetter(char c)
        {
            return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
        }

        public static string FileName(string normalized)
        {
            int i = normalized.LastIndexOf('\\');
            return i < 0 ? normalized : normalized.Substring(i + 1);
        }

        public static string Parent(string normalized)
        {
            int i = normalized.LastIndexOf('\\');
            if (i <= 2) return normalized.Substring(0, 3);
            return normalized.Substring(0, i);
        }

        public static bool IsRooted(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string p = path.Replace('/', '\\');
            return (p.Length >= 3 && IsDriveLetter(p[0]) && p[1] == ':' && p[2] == '\\') || p.StartsWith("\\\\", StringComparison.Ordinal);
        }

        public static string Combine(string dir, string name)
        {
            return dir.EndsWith("\\", StringComparison.Ordinal) ? dir + name : dir + "\\" + name;
        }

        /// <summary>Lowercase base name without directory and without .exe/.cmd/.bat/.com.</summary>
        public static string Stem(string path)
        {
            string p = (path ?? "").Replace('/', '\\');
            int i = p.LastIndexOf('\\');
            string name = (i < 0 ? p : p.Substring(i + 1)).ToLowerInvariant();
            foreach (string ext in new string[] { ".exe", ".cmd", ".bat", ".com" })
            {
                if (name.EndsWith(ext, StringComparison.Ordinal)) return name.Substring(0, name.Length - ext.Length);
            }
            return name;
        }
    }

    /// <summary>Command lines as CreateProcess and the Microsoft C runtime parse them.</summary>
    public static class CommandLine
    {
        public const int MaxChars = 32766;

        /// <summary>Quotes one argument so CommandLineToArgvW returns it unchanged.</summary>
        public static string QuoteArg(string arg)
        {
            if (arg == null) arg = "";
            if (arg.IndexOf('\0') >= 0) throw new ProtocolException("BAD_REQUEST", "arguments cannot contain NUL");
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            var b = new StringBuilder();
            b.Append('"');
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"') b.Append('\\', backslashes * 2 + 1);
                else b.Append('\\', backslashes);
                backslashes = 0;
                b.Append(c);
            }
            b.Append('\\', backslashes * 2);
            b.Append('"');
            return b.ToString();
        }

        /// <summary>Program path (always quoted; Windows paths cannot contain '"') followed by the quoted arguments.</summary>
        public static string Build(string program, IList<string> args)
        {
            if (program.IndexOf('"') >= 0 || program.IndexOf('\0') >= 0) throw new ProtocolException("BAD_REQUEST", "invalid program path");
            var b = new StringBuilder();
            b.Append('"').Append(program).Append('"');
            foreach (string a in args)
            {
                b.Append(' ').Append(QuoteArg(a));
            }
            if (b.Length > MaxChars) throw new ProtocolException("BAD_REQUEST", "command line is longer than Windows allows");
            return b.ToString();
        }

        /// <summary>
        /// cmd.exe line for a batch file: cmd /d /s /c ""bat" "arg" ...". cmd.exe expands %VAR% and
        /// !VAR! even inside quotes and does not honour backslash escapes, so arguments with
        /// '"', '%', '!', or line breaks are refused instead of escaped (cf. CVE-2024-24576).
        /// </summary>
        public static string BuildBatch(string cmdExe, string batchPath, IList<string> args)
        {
            var parts = new List<string>();
            parts.Add(batchPath);
            parts.AddRange(args);
            var inner = new StringBuilder();
            for (int i = 0; i < parts.Count; i++)
            {
                string p = parts[i];
                if (p.IndexOfAny(new char[] { '"', '%', '!', '\r', '\n', '\0' }) >= 0)
                    throw new ProtocolException("BAD_REQUEST", (i == 0 ? "batch file path" : "argument " + i) +
                        " for a .cmd/.bat command cannot contain '\"', '%', '!', or a line break; run the program directly instead");
                if (i > 0) inner.Append(' ');
                inner.Append('"').Append(p).Append('"');
            }
            string line = "\"" + cmdExe + "\" /d /s /c \"" + inner + "\"";
            if (line.Length > MaxChars) throw new ProtocolException("BAD_REQUEST", "command line is longer than Windows allows");
            return line;
        }

        /// <summary>cmd.exe line for a setup command (the Windows counterpart of sh -c).</summary>
        public static string BuildShell(string cmdExe, string command)
        {
            if (command.IndexOf('\0') >= 0) throw new ProtocolException("BAD_REQUEST", "cmd cannot contain NUL");
            string line = "\"" + cmdExe + "\" /d /s /c \"" + command + "\"";
            if (line.Length > MaxChars) throw new ProtocolException("BAD_REQUEST", "setup command is longer than Windows allows");
            return line;
        }

        public static bool IsBatch(string path)
        {
            string lower = path.ToLowerInvariant();
            return lower.EndsWith(".cmd", StringComparison.Ordinal) || lower.EndsWith(".bat", StringComparison.Ordinal);
        }

        /// <summary>
        /// Resolves cmd to a file. A path (with '\', '/' or ':') is taken relative to cwd. A bare
        /// name is searched only in the absolute directories of PATH, never in cwd or relative
        /// PATH entries. Without an extension, PATHEXT extensions are tried. Returns null when not found.
        /// </summary>
        public static string Resolve(string cmd, string cwd, string pathVar, string pathExt, Func<string, bool> fileExists)
        {
            if (string.IsNullOrEmpty(cmd) || cmd.IndexOf('\0') >= 0) return null;
            string c = cmd.Replace('/', '\\');
            var exts = new List<string>();
            foreach (string e in (string.IsNullOrEmpty(pathExt) ? ".COM;.EXE;.BAT;.CMD" : pathExt).Split(';'))
            {
                string t = e.Trim();
                if (t.StartsWith(".", StringComparison.Ordinal) && t.Length > 1) exts.Add(t.ToLowerInvariant());
            }
            bool hasPath = c.IndexOf('\\') >= 0 || c.IndexOf(':') >= 0;
            var candidates = new List<string>();
            if (hasPath)
            {
                string full = WinPath.IsRooted(c) ? c : WinPath.Combine(cwd, c);
                candidates.Add(full);
            }
            else
            {
                foreach (string dir in (pathVar ?? "").Split(';'))
                {
                    string d = dir.Trim().Trim('"');
                    if (d.Length == 0 || !WinPath.IsRooted(d)) continue;
                    candidates.Add(WinPath.Combine(d.Replace('/', '\\'), c));
                }
            }
            string stem = WinPath.FileName(c);
            bool hasExt = stem.IndexOf('.') > 0;
            foreach (string candidate in candidates)
            {
                if (hasExt && fileExists(candidate)) return candidate;
                foreach (string ext in exts)
                {
                    if (fileExists(candidate + ext)) return candidate + ext;
                }
            }
            return null;
        }
    }

    /// <summary>Environment blocks for child processes. Windows variable names are case-insensitive.</summary>
    public static class ChildEnvironment
    {
        /// <summary>
        /// Base environment (the helper's own, without contract variables), plus the request's env,
        /// plus forced values the request cannot override. Throws BAD_REQUEST for invalid names or values.
        /// </summary>
        public static SortedDictionary<string, string> Build(IDictionary<string, string> baseEnv, IDictionary<string, string> request,
            IDictionary<string, string> forced)
        {
            var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in baseEnv)
            {
                if (IsContractName(pair.Key)) continue;
                env[pair.Key] = pair.Value;
            }
            if (request != null)
            {
                foreach (var pair in request)
                {
                    if (pair.Key.Length == 0 || pair.Key.IndexOf('=') >= 0 || pair.Key.IndexOf('\0') >= 0)
                        throw new ProtocolException("BAD_REQUEST", "env name '" + pair.Key + "' is not a valid Windows variable name");
                    if (pair.Value.IndexOf('\0') >= 0) throw new ProtocolException("BAD_REQUEST", "env value of " + pair.Key + " contains NUL");
                    if (IsContractName(pair.Key) || forced.ContainsKey(pair.Key)) continue;
                    env[pair.Key] = pair.Value;
                }
            }
            foreach (var pair in forced) env[pair.Key] = pair.Value;
            return env;
        }

        /// <summary>Helper contract variables (PI_GUI_*, including the token) never reach a child.</summary>
        public static bool IsContractName(string name)
        {
            return name.StartsWith("PI_GUI_", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>CREATE_UNICODE_ENVIRONMENT block: "k=v\0" entries sorted case-insensitively, then "\0".</summary>
        public static string Block(SortedDictionary<string, string> env)
        {
            var b = new StringBuilder();
            foreach (var pair in env)
            {
                if (pair.Key.IndexOf('\0') >= 0 || pair.Value.IndexOf('\0') >= 0) continue;
                b.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
            }
            if (b.Length == 0) b.Append('\0');
            b.Append('\0');
            return b.ToString();
        }
    }

    /// <summary>Launch adjustments: accessibility and software rendering (spec section 4.5).</summary>
    public static class LaunchPolicy
    {
        static readonly string[] ChromiumNames = new string[] { "electron", "chromium", "chrome", "msedge" };
        public const string AccessibilityFlag = "--force-renderer-accessibility";
        public const string DisableGpuFlag = "--disable-gpu";

        /// <summary>Electron/Chromium binaries, including "npx electron" and "node ...\electron\cli.js".</summary>
        public static bool IsChromiumLike(string cmd, IList<string> args)
        {
            string stem = WinPath.Stem(cmd);
            if (Array.IndexOf(ChromiumNames, stem) >= 0) return true;
            if ((stem == "npx" || stem == "node") && args.Count > 0)
            {
                string first = args[0].Replace('/', '\\').ToLowerInvariant();
                return Array.IndexOf(ChromiumNames, WinPath.Stem(first)) >= 0 || first.EndsWith("electron\\cli.js", StringComparison.Ordinal);
            }
            return false;
        }

        public static List<string> Args(string cmd, IList<string> args, bool softwareRendering)
        {
            var result = new List<string>(args);
            if (IsChromiumLike(cmd, args))
            {
                if (!result.Contains(AccessibilityFlag)) result.Add(AccessibilityFlag);
                if (softwareRendering && !result.Contains(DisableGpuFlag)) result.Add(DisableGpuFlag);
            }
            return result;
        }

        /// <summary>Forced child variables for software rendering (Qt, Qt Quick, Flutter engine switches).</summary>
        public static void AddRenderingEnv(IDictionary<string, string> forced, IDictionary<string, string> request, bool softwareRendering)
        {
            if (!softwareRendering) return;
            forced["QT_OPENGL"] = "software";
            forced["QT_QUICK_BACKEND"] = "software";
            // Flutter engine switches from the environment; honoured by non-release engines only.
            bool requestSetsFlutter = false;
            if (request != null)
            {
                foreach (string key in request.Keys)
                {
                    if (key.StartsWith("FLUTTER_ENGINE_SWITCH", StringComparison.OrdinalIgnoreCase)) requestSetsFlutter = true;
                }
            }
            if (!requestSetsFlutter)
            {
                forced["FLUTTER_ENGINE_SWITCHES"] = "1";
                forced["FLUTTER_ENGINE_SWITCH_1"] = "enable-software-rendering";
            }
        }

        public const string WpfWarning = "WPF window detected: WPF renders with the GPU unless hardware acceleration is turned off " +
            "per user (HKCU\\Software\\Microsoft\\Avalon.Graphics\\DisableHWAcceleration); the helper does not change it, " +
            "so screenshots of this app may be black (allBlack).";
    }

    /// <summary>Key syntax of act key: xdotool-style names separated by spaces, chords joined with '+'.</summary>
    public static class KeySyntax
    {
        public const int MaxChords = 200;
        static readonly Dictionary<string, int> Modifiers = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) {
            { "ctrl", 0x11 }, { "control", 0x11 }, { "control_l", 0x11 }, { "control_r", 0x11 }, { "ctrl_l", 0x11 }, { "ctrl_r", 0x11 },
            { "shift", 0x10 }, { "shift_l", 0x10 }, { "shift_r", 0x10 },
            { "alt", 0x12 }, { "alt_l", 0x12 }, { "alt_r", 0x12 }, { "meta", 0x12 },
            { "super", 0x5B }, { "super_l", 0x5B }, { "super_r", 0x5C }, { "win", 0x5B },
        };

        static readonly Dictionary<string, int> Named = BuildNamed();
        static readonly Dictionary<string, char> Punctuation = new Dictionary<string, char>(StringComparer.OrdinalIgnoreCase) {
            { "comma", ',' }, { "period", '.' }, { "minus", '-' }, { "plus", '+' }, { "equal", '=' }, { "slash", '/' },
            { "backslash", '\\' }, { "semicolon", ';' }, { "apostrophe", '\'' }, { "quotedbl", '"' }, { "bracketleft", '[' },
            { "bracketright", ']' }, { "grave", '`' }, { "asciitilde", '~' }, { "exclam", '!' }, { "at", '@' },
            { "numbersign", '#' }, { "dollar", '$' }, { "percent", '%' }, { "asciicircum", '^' }, { "ampersand", '&' },
            { "asterisk", '*' }, { "parenleft", '(' }, { "parenright", ')' }, { "underscore", '_' }, { "colon", ':' },
            { "less", '<' }, { "greater", '>' }, { "question", '?' }, { "bar", '|' }, { "braceleft", '{' }, { "braceright", '}' },
        };

        static Dictionary<string, int> BuildNamed()
        {
            var d = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) {
                { "Return", 0x0D }, { "Enter", 0x0D }, { "KP_Enter", 0x0D }, { "Tab", 0x09 }, { "Escape", 0x1B }, { "Esc", 0x1B },
                { "BackSpace", 0x08 }, { "Delete", 0x2E }, { "Del", 0x2E }, { "Insert", 0x2D }, { "Home", 0x24 }, { "End", 0x23 },
                { "Left", 0x25 }, { "Up", 0x26 }, { "Right", 0x27 }, { "Down", 0x28 }, { "Page_Up", 0x21 }, { "Prior", 0x21 },
                { "PageUp", 0x21 }, { "Page_Down", 0x22 }, { "Next", 0x22 }, { "PageDown", 0x22 }, { "space", 0x20 },
                { "Menu", 0x5D }, { "Apps", 0x5D }, { "Print", 0x2C }, { "Pause", 0x13 }, { "Caps_Lock", 0x14 },
                { "Num_Lock", 0x90 }, { "Scroll_Lock", 0x91 },
            };
            for (int n = 1; n <= 24; n++) d["F" + n.ToString(CultureInfo.InvariantCulture)] = 0x70 + n - 1;
            return d;
        }

        /// <summary>Parses "ctrl+a BackSpace Return". Throws BAD_REQUEST for unknown names.</summary>
        public static List<KeyChord> Parse(string text)
        {
            var chords = new List<KeyChord>();
            foreach (string token in (text ?? "").Split(new char[] { ' ', '\t', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (chords.Count >= MaxChords) throw new ProtocolException("BAD_REQUEST", "key text has more than " + MaxChords + " chords");
                string[] parts = token.Split('+');
                var chord = new KeyChord();
                chord.Text = token;
                for (int i = 0; i < parts.Length - 1; i++)
                {
                    int vk;
                    if (!Modifiers.TryGetValue(parts[i], out vk)) throw new ProtocolException("BAD_REQUEST", "unknown modifier '" + parts[i] + "' in '" + token + "'");
                    if (!chord.Modifiers.Contains(vk)) chord.Modifiers.Add(vk);
                }
                string key = parts[parts.Length - 1];
                if (key.Length == 0) throw new ProtocolException("BAD_REQUEST", "empty key in '" + token + "' (use 'plus' for '+')");
                ResolveKey(key, chord, token);
                chords.Add(chord);
            }
            if (chords.Count == 0) throw new ProtocolException("BAD_REQUEST", "key needs text, e.g. 'ctrl+a BackSpace'");
            return chords;
        }

        static void ResolveKey(string key, KeyChord chord, string token)
        {
            int vk;
            if (Named.TryGetValue(key, out vk)) { chord.Vk = vk; return; }
            if (Modifiers.TryGetValue(key, out vk)) { chord.Vk = vk; return; }
            if (key.Equals("ISO_Left_Tab", StringComparison.OrdinalIgnoreCase))
            {
                if (!chord.Modifiers.Contains(0x10)) chord.Modifiers.Add(0x10);
                chord.Vk = 0x09;
                return;
            }
            char p;
            if (Punctuation.TryGetValue(key, out p)) { chord.Char = p; return; }
            if (key.Length == 1)
            {
                char c = key[0];
                if (c >= 'a' && c <= 'z') { chord.Vk = char.ToUpperInvariant(c); return; }
                if (c >= 'A' && c <= 'Z')
                {
                    if (!chord.Modifiers.Contains(0x10)) chord.Modifiers.Add(0x10);
                    chord.Vk = c;
                    return;
                }
                if (c >= '0' && c <= '9') { chord.Vk = c; return; }
                chord.Char = c;
                return;
            }
            throw new ProtocolException("BAD_REQUEST", "unknown key name '" + key + "' in '" + token + "'");
        }

        /// <summary>Scroll text "up|down|left|right [1-100]" (default "down 1").</summary>
        public static void ParseScroll(string text, out string direction, out int amount)
        {
            direction = "down";
            amount = 1;
            string[] parts = (text ?? "").Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) return;
            if (parts.Length > 2) throw new ProtocolException("BAD_REQUEST", "scroll text is 'up|down|left|right [1-100]'");
            string d = parts[0].ToLowerInvariant();
            if (d != "up" && d != "down" && d != "left" && d != "right") throw new ProtocolException("BAD_REQUEST", "scroll direction must be up, down, left, or right");
            direction = d;
            if (parts.Length == 2)
            {
                if (!int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out amount) || amount < 1 || amount > 100)
                    throw new ProtocolException("BAD_REQUEST", "scroll amount must be 1..100");
            }
        }
    }

    /// <summary>UI Automation control types mapped to the role names the Linux helper reports (AT-SPI style).</summary>
    public static class Roles
    {
        static readonly Dictionary<string, string> Map = new Dictionary<string, string>(StringComparer.Ordinal) {
            { "Button", "push button" }, { "SplitButton", "push button" }, { "Text", "label" }, { "Edit", "text" },
            { "CheckBox", "check box" }, { "RadioButton", "radio button" }, { "ComboBox", "combo box" }, { "List", "list" },
            { "ListItem", "list item" }, { "Menu", "menu" }, { "MenuBar", "menu bar" }, { "MenuItem", "menu item" },
            { "Window", "frame" }, { "Pane", "panel" }, { "Tab", "page tab list" }, { "TabItem", "page tab" }, { "Tree", "tree" },
            { "TreeItem", "tree item" }, { "Hyperlink", "link" }, { "Image", "image" }, { "Document", "document" },
            { "Group", "grouping" }, { "ProgressBar", "progress bar" }, { "Slider", "slider" }, { "Spinner", "spin button" },
            { "StatusBar", "status bar" }, { "ToolBar", "tool bar" }, { "ToolTip", "tool tip" }, { "ScrollBar", "scroll bar" },
            { "Table", "table" }, { "DataGrid", "table" }, { "DataItem", "table row" }, { "Header", "header" },
            { "HeaderItem", "column header" }, { "TitleBar", "title bar" }, { "Calendar", "calendar" }, { "Separator", "separator" },
            { "Thumb", "thumb" }, { "Custom", "unknown" }, { "AppBar", "tool bar" }, { "SemanticZoom", "panel" },
        };

        /// <summary>"ControlType.Button" (ProgrammaticName) -> "push button"; unknown types -> lowercase name.</summary>
        public static string FromControlType(string programmaticName)
        {
            string name = programmaticName ?? "";
            if (name.StartsWith("ControlType.", StringComparison.Ordinal)) name = name.Substring("ControlType.".Length);
            string role;
            if (Map.TryGetValue(name, out role)) return role;
            return name.Length == 0 ? "unknown" : name.ToLowerInvariant();
        }

        /// <summary>Roles that alone do not make a window's tree useful: containers and window chrome.</summary>
        public static bool IsStructural(string role)
        {
            return role == "panel" || role == "frame" || role == "title bar" || role == "scroll bar" || role == "thumb" || role == "unknown";
        }
    }

    public static class Coverage
    {
        /// <summary>
        /// "none": no window has a useful tree (Tk, custom-drawn apps) or nothing is open;
        /// "partial": some windows do; "full": every window does. A useful tree holds at least one
        /// element that is not structural and not part of the title bar UI Automation adds to
        /// every standard window.
        /// </summary>
        public static string Compute(WalkResult walk)
        {
            if (walk.WindowCount == 0 || walk.Nodes.Count == 0) return "none";
            var useful = new HashSet<int>();
            for (int i = 0; i < walk.Nodes.Count; i++)
            {
                ElementNode n = walk.Nodes[i];
                if (n.Parent < 0 || n.Window < 0 || Roles.IsStructural(n.Role)) continue;
                if (InTitleBar(walk.Nodes, i)) continue;
                useful.Add(n.Window);
            }
            if (useful.Count == 0) return "none";
            return useful.Count < walk.WindowCount ? "partial" : "full";
        }

        static bool InTitleBar(List<ElementNode> nodes, int index)
        {
            int guard = 0;
            for (int i = nodes[index].Parent; i >= 0 && guard < 4096; i = nodes[i].Parent, guard++)
            {
                if (nodes[i].Role == "title bar") return true;
            }
            return false;
        }
    }
}
