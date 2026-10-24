// Unit tests for the Windows helper's pure core (no Win32): JSON, framing,
// imaging, environment contract, command lines, keys, roles, coverage.
// Compiled at C# 5 by run-core-tests.ps1 and run with PowerShell 7 on any host.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace PiGuiHelper.Tests
{
    public static class CoreTests
    {
        static int _failed;
        static int _passed;

        static void Check(bool condition, string name)
        {
            if (condition) { _passed++; Console.WriteLine("ok - " + name); }
            else { _failed++; Console.WriteLine("not ok - " + name); }
        }

        static void Throws<T>(Action action, string name) where T : Exception
        {
            try
            {
                action();
                Check(false, name + " (no exception)");
            }
            catch (T)
            {
                Check(true, name);
            }
            catch (Exception e)
            {
                Check(false, name + " (" + e.GetType().Name + ": " + e.Message + ")");
            }
        }

        static void ThrowsCode(string code, Action action, string name)
        {
            try
            {
                action();
                Check(false, name + " (no exception)");
            }
            catch (ProtocolException e)
            {
                Check(e.Code == code, name + " (" + e.Code + ")");
            }
        }

        /// <summary>CommandLineToArgvW rules for the arguments after the program name.</summary>
        static List<string> ParseArgs(string commandLine)
        {
            int i = 0;
            // Program name: quoted or up to whitespace, no escapes.
            if (commandLine[0] == '"')
            {
                i = commandLine.IndexOf('"', 1) + 1;
            }
            else
            {
                while (i < commandLine.Length && commandLine[i] != ' ' && commandLine[i] != '\t') i++;
            }
            var args = new List<string>();
            while (true)
            {
                while (i < commandLine.Length && (commandLine[i] == ' ' || commandLine[i] == '\t')) i++;
                if (i >= commandLine.Length) break;
                var arg = new StringBuilder();
                bool quoted = false;
                while (i < commandLine.Length && (quoted || (commandLine[i] != ' ' && commandLine[i] != '\t')))
                {
                    int backslashes = 0;
                    while (i < commandLine.Length && commandLine[i] == '\\') { backslashes++; i++; }
                    if (i < commandLine.Length && commandLine[i] == '"')
                    {
                        arg.Append('\\', backslashes / 2);
                        if (backslashes % 2 == 1) { arg.Append('"'); i++; }
                        else if (quoted && i + 1 < commandLine.Length && commandLine[i + 1] == '"') { arg.Append('"'); i += 2; }
                        else { quoted = !quoted; i++; }
                    }
                    else
                    {
                        arg.Append('\\', backslashes);
                        if (i < commandLine.Length && (quoted || (commandLine[i] != ' ' && commandLine[i] != '\t'))) { arg.Append(commandLine[i]); i++; }
                    }
                }
                args.Add(arg.ToString());
            }
            return args;
        }

        static Dictionary<string, string> Env(params string[] pairs)
        {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < pairs.Length; i += 2) d[pairs[i]] = pairs[i + 1];
            return d;
        }

        const string Temp = "C:\\Users\\u\\AppData\\Local\\Temp";

        public static int Main()
        {
            JsonTests();
            FramingTests();
            ImagingTests();
            ConfigTests();
            PathTests();
            CommandLineTests();
            EnvironmentTests();
            LaunchPolicyTests();
            KeyTests();
            RoleAndCoverageTests();
            Console.WriteLine("# passed " + _passed + ", failed " + _failed);
            return _failed == 0 ? 0 : 1;
        }

        static void JsonTests()
        {
            var o = (Dictionary<string, object>)Json.Parse("{\"id\":7,\"x\":-1.5e2,\"s\":\"a\\u00e9\\n\\\"\",\"b\":true,\"n\":null,\"l\":[1,[2]]}");
            Check(o["id"] is long && (long)o["id"] == 7, "json: integer parses as long");
            Check(o["x"] is double && (double)o["x"] == -150.0, "json: exponent parses as double");
            Check((string)o["s"] == "a" + (char)0xE9 + "\n\"", "json: string escapes");
            Check((bool)o["b"] && o["n"] == null && ((List<object>)o["l"]).Count == 2, "json: literals and arrays");
            Check(Json.Parse("12345678901234567890") is double, "json: integer beyond long becomes double");
            Throws<JsonException>(delegate { Json.Parse("{\"a\":1,}"); }, "json: trailing comma refused");
            Throws<JsonException>(delegate { Json.Parse("[1] x"); }, "json: trailing data refused");
            Throws<JsonException>(delegate { Json.Parse(new string('[', 100) + new string(']', 100)); }, "json: nesting bound");
            Throws<JsonException>(delegate { Json.Parse("\"a\u0001\""); }, "json: raw control character refused");
            string lone = "x" + (char)0xD800 + "y";
            Check(Json.Serialize(lone) == "\"x" + (char)0xFFFD + "y\"", "json: lone surrogate serialized as U+FFFD");
            Check(Json.Serialize("a" + (char)0x2028) == "\"a\\u2028\"", "json: U+2028 escaped");
            Check(Json.Serialize(1.0) == "1" && Json.Serialize(0.5) == "0.5", "json: double formatting");
            Throws<JsonException>(delegate { Json.Serialize(double.NaN); }, "json: NaN refused");
            var round = Json.Serialize(Json.Parse("{\"k\":[\"v\",{\"z\":false}]}"));
            Check(round == "{\"k\":[\"v\",{\"z\":false}]}", "json: round trip");
        }

        static void FramingTests()
        {
            string token = "0123456789abcdef0123456789abcdef";
            Check(Protocol.ValidToken(token) && !Protocol.ValidToken(token + "0") && !Protocol.ValidToken("0123456789abcdef0123456789abcdeg"), "framing: token validation");
            Check(Framing.ParseLine(Encoding.UTF8.GetBytes("noise"), token) == null, "framing: noise line ignored");
            Check(Framing.ParseLine(Encoding.UTF8.GetBytes(token + "x {}"), token) == null, "framing: prefix needs a space");
            var m = Framing.ParseLine(Encoding.UTF8.GetBytes(token + " {\"id\":1}\r"), token);
            Check(m != null && (long)m["id"] == 1, "framing: protocol line with CR");
            Throws<FramingException>(delegate { Framing.ParseLine(Encoding.UTF8.GetBytes(token + " [1]"), token); }, "framing: non-object payload refused");
            Throws<FramingException>(delegate { Framing.ParseLine(Encoding.UTF8.GetBytes(token + " {oops"), token); }, "framing: invalid JSON refused");
            string text = new string('a', 70000) + (char)0xE9 + new string('b', 70000);
            List<string> pieces = Framing.SplitUtf8(text, 65536);
            bool bounded = true;
            foreach (string p in pieces) if (Encoding.UTF8.GetByteCount(p) > 65536) bounded = false;
            Check(bounded && string.Concat(pieces.ToArray()) == text && pieces.Count == 3, "framing: log split bounded, lossless, on code points");
            var input = new MemoryStream(Encoding.ASCII.GetBytes("one\n" + new string('x', 300) + "\ntwo\nlast"));
            var reader = new LineReader(input, 100);
            Check(Encoding.ASCII.GetString(reader.ReadLine()) == "one" && !reader.Oversized, "framing: line reader first line");
            byte[] skipped = reader.ReadLine();
            Check(skipped.Length == 0 && reader.Oversized, "framing: oversized line skipped");
            Check(Encoding.ASCII.GetString(reader.ReadLine()) == "two", "framing: next line after oversized");
            Check(Encoding.ASCII.GetString(reader.ReadLine()) == "last" && reader.ReadLine() == null, "framing: unterminated last line, then EOF");
            Check(Protocol.HeartbeatTimeoutMs(Env("PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS", "1500")) == 1500 &&
                  Protocol.HeartbeatTimeoutMs(Env("PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS", "-3")) == 60000, "framing: heartbeat override");
        }

        static void ImagingTests()
        {
            Check(Imaging.Crc32(Encoding.ASCII.GetBytes("123456789"), 0, 9) == 0xCBF43926u, "imaging: CRC-32 check value");
            Check(Imaging.Adler32(Encoding.ASCII.GetBytes("Wikipedia")) == 0x11E60398u, "imaging: Adler-32 check value");
            double scale;
            int w, h;
            Imaging.ScaledSize(1600, 900, 1280, out scale, out w, out h);
            Check(scale == 0.8 && w == 1280 && h == 720, "imaging: scaled size");
            Imaging.ScaledSize(640, 480, 1280, out scale, out w, out h);
            Check(scale == 1 && w == 640 && h == 480, "imaging: never upscales");
            var img = new RgbImage(4, 2, new byte[] { 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0 });
            RgbImage half = Imaging.Resize(img, 2, 1);
            Check(half.Rgb[0] == 255 && half.Rgb[3] == 0, "imaging: box filter keeps uniform blocks");
            RgbImage mix = Imaging.Resize(new RgbImage(2, 1, new byte[] { 255, 10, 0, 0, 20, 0 }), 1, 1);
            Check(mix.Rgb[0] == 128 && mix.Rgb[1] == 15 && mix.Rgb[2] == 0, "imaging: box filter averages with rounding");
            byte[] png = Imaging.EncodePng(img);
            Check(png[0] == 0x89 && png[1] == 0x50 && png[12] == (byte)'I' && png[16] == 0 && png[19] == 4 && png[23] == 2, "imaging: PNG signature and IHDR");
            Check(Imaging.AllBlack(new byte[12]) && !Imaging.AllBlack(new byte[] { 0, 1, 0 }), "imaging: all black");
            RgbImage crop = Imaging.Crop(img, 2, 1, 2, 1);
            Check(crop.Width == 2 && crop.Rgb.Length == 6 && crop.Rgb[0] == 0, "imaging: crop");
            Dictionary<string, object> cap = Imaging.BuildCapture(new RgbImage(2, 2, new byte[12]), 1280);
            Check(cap.ContainsKey("allBlack") && (double)cap["scale"] == 1 && ((string)cap["sha256"]).Length == 64, "imaging: capture fields");
            Throws<ArgumentException>(delegate { new RgbImage(2, 2, new byte[11]); }, "imaging: buffer size checked");
        }

        static void ConfigTests()
        {
            string runtime = Temp + "\\pi-gui-testing-abc";
            HostConfig c = HostConfig.FromEnv(Env("PI_GUI_WORKSPACE", "C:/work/proj/", "PI_GUI_RUNTIME_DIR", runtime), Temp);
            Check(c.Mode == "local" && c.Workspace == "C:\\work\\proj" && !c.AllowExec && c.SoftwareRendering && !c.InteractiveDesktop, "config: local defaults");
            Throws<ArgumentException>(delegate { HostConfig.FromEnv(Env("PI_GUI_RUNTIME_DIR", runtime), Temp); }, "config: workspace required");
            Throws<ArgumentException>(delegate { HostConfig.FromEnv(Env("PI_GUI_WORKSPACE", "C:\\w"), Temp); }, "config: runtime dir required");
            Throws<ArgumentException>(delegate { HostConfig.FromEnv(Env("PI_GUI_WORKSPACE", "C:\\w", "PI_GUI_RUNTIME_DIR", "C:\\other\\pi-gui-testing-x"), Temp); }, "config: local runtime dir under LOCALAPPDATA\\Temp");
            Throws<ArgumentException>(delegate { HostConfig.FromEnv(Env("PI_GUI_WORKSPACE", "C:\\w", "PI_GUI_RUNTIME_DIR", Temp + "\\other"), Temp); }, "config: runtime dir name prefix");
            Throws<ArgumentException>(delegate { HostConfig.FromEnv(Env("PI_GUI_WORKSPACE", "C:\\w", "PI_GUI_RUNTIME_DIR", runtime, "PI_GUI_HELPER_MODE", "host"), Temp); }, "config: unknown mode refused");
            Throws<ArgumentException>(delegate { HostConfig.FromEnv(Env("PI_GUI_WORKSPACE", "C:\\w", "PI_GUI_RUNTIME_DIR", runtime, "PI_GUI_WIN_DESKTOP", "interactive"), Temp); }, "config: interactive desktop refused in local mode");
            Throws<ArgumentException>(delegate { HostConfig.FromEnv(Env("PI_GUI_WORKSPACE", "C:\\w", "PI_GUI_RUNTIME_DIR", "D:\\s\\pi-gui-testing-1", "PI_GUI_HELPER_MODE", "guest", "PI_GUI_WIN_INPUT", "sendinput"), Temp); }, "config: sendinput needs the interactive desktop");
            Throws<ArgumentException>(delegate { HostConfig.FromEnv(Env("PI_GUI_WORKSPACE", "C:\\w", "PI_GUI_RUNTIME_DIR", runtime, "PI_GUI_ALLOW_EXEC", "yes"), Temp); }, "config: flags are 1 or 0");
            HostConfig g = HostConfig.FromEnv(Env("PI_GUI_WORKSPACE", "C:\\w", "PI_GUI_RUNTIME_DIR", "D:\\s\\pi-gui-testing-1", "PI_GUI_HELPER_MODE", "guest",
                "PI_GUI_WIN_DESKTOP", "interactive", "PI_GUI_WIN_INPUT", "sendinput", "PI_GUI_ALLOW_EXEC", "1", "PI_GUI_DEPS_DIR", "D:\\deps"), null);
            Check(g.Guest && g.InteractiveDesktop && g.SendInput && g.AllowExec && g.Warnings.Count == 1, "config: guest options and deps warning");
        }

        static void PathTests()
        {
            Check(WinPath.NormalizeAbsolute("c:/a/b\\", "p") == "C:\\a\\b", "path: normalize slashes and drive letter");
            Throws<ArgumentException>(delegate { WinPath.NormalizeAbsolute("relative\\x", "p"); }, "path: relative refused");
            Throws<ArgumentException>(delegate { WinPath.NormalizeAbsolute("\\\\server\\share\\x", "p"); }, "path: UNC refused");
            Throws<ArgumentException>(delegate { WinPath.NormalizeAbsolute("\\\\?\\C:\\x", "p"); }, "path: device path refused");
            Throws<ArgumentException>(delegate { WinPath.NormalizeAbsolute("C:\\a\\..\\b", "p"); }, "path: dot-dot refused");
            Throws<ArgumentException>(delegate { WinPath.NormalizeAbsolute("C:\\a\\b:stream", "p"); }, "path: ADS refused");
            Throws<ArgumentException>(delegate { WinPath.NormalizeAbsolute("C:\\a\\b.", "p"); }, "path: trailing dot refused");
            Check(WinPath.Parent("C:\\a\\b") == "C:\\a" && WinPath.Parent("C:\\a") == "C:\\" && WinPath.FileName("C:\\a\\b") == "b", "path: parent and name");
            Check(WinPath.Stem("C:\\x\\Electron.EXE") == "electron" && WinPath.Stem("npx.cmd") == "npx", "path: stem");
        }

        static void CommandLineTests()
        {
            var samples = new List<string> { "plain", "with space", "", "quote\"inside", "trail\\", "trail space\\", "back\\\\\"slash", "\\\\server\\share", "tab\there", "\"", "a\\\\b" };
            string line = CommandLine.Build("C:\\Program Files\\app.exe", samples);
            List<string> parsed = ParseArgs(line);
            bool same = parsed.Count == samples.Count;
            for (int i = 0; same && i < samples.Count; i++) same = parsed[i] == samples[i];
            Check(same, "cmdline: CommandLineToArgvW round trip");
            Check(line.StartsWith("\"C:\\Program Files\\app.exe\" plain ", StringComparison.Ordinal), "cmdline: program quoted");
            ThrowsCode("BAD_REQUEST", delegate { CommandLine.QuoteArg("a\0b"); }, "cmdline: NUL refused");
            ThrowsCode("BAD_REQUEST", delegate { CommandLine.Build("C:\\a.exe", new List<string> { new string('x', 40000) }); }, "cmdline: length bound");
            string bat = CommandLine.BuildBatch("C:\\Windows\\System32\\cmd.exe", "C:\\n\\npx.cmd", new List<string> { "electron", "C:\\app dir" });
            Check(bat == "\"C:\\Windows\\System32\\cmd.exe\" /d /s /c \"\"C:\\n\\npx.cmd\" \"electron\" \"C:\\app dir\"\"", "cmdline: batch line");
            foreach (string bad in new string[] { "a&\"b", "%PATH%", "!x!", "a\nb" })
                ThrowsCode("BAD_REQUEST", delegate { CommandLine.BuildBatch("cmd.exe", "C:\\x.bat", new List<string> { bad }); }, "cmdline: batch argument refused: " + bad.Replace("\n", "\\n"));
            Check(CommandLine.BuildShell("C:\\cmd.exe", "npm ci && npm run build") == "\"C:\\cmd.exe\" /d /s /c \"npm ci && npm run build\"", "cmdline: shell line");
            Check(CommandLine.IsBatch("x.CMD") && CommandLine.IsBatch("y.bat") && !CommandLine.IsBatch("z.exe"), "cmdline: batch detection");

            var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "C:\\bin\\tool.exe", "C:\\node\\npx.cmd", "C:\\work\\app\\run.exe", ".\\evil.exe", "C:\\work\\evil.exe" };
            Func<string, bool> exists = delegate(string p) { return files.Contains(p); };
            Check(CommandLine.Resolve("tool", "C:\\work", ".;C:\\bin;C:\\node", ".EXE;.CMD", exists) == "C:\\bin\\tool.exe", "resolve: PATH + PATHEXT");
            Check(CommandLine.Resolve("npx", "C:\\work", "C:\\bin;C:\\node", ".EXE;.CMD", exists) == "C:\\node\\npx.cmd", "resolve: batch via PATHEXT");
            Check(CommandLine.Resolve("evil", "C:\\work", ".;relative;C:\\bin", ".EXE", exists) == null, "resolve: cwd and relative PATH entries never searched");
            Check(CommandLine.Resolve("app\\run.exe", "C:\\work", "", ".EXE", exists) == "C:\\work\\app\\run.exe", "resolve: relative path against cwd");
            Check(CommandLine.Resolve("C:\\bin\\tool", "C:\\x", "", ".EXE", exists) == "C:\\bin\\tool.exe", "resolve: absolute without extension");
            Check(CommandLine.Resolve("missing", "C:\\x", "C:\\bin", ".EXE", exists) == null, "resolve: not found");
        }

        static void EnvironmentTests()
        {
            var baseEnv = Env("Path", "C:\\bin", "PI_GUI_TESTING_TOKEN", "secret", "PI_GUI_RUNTIME_DIR", "x", "TEMP", "C:\\user\\temp");
            var forced = Env("TEMP", "C:\\rt\\tmp", "TMP", "C:\\rt\\tmp", "PI_GUI_TAG", "abcd");
            var request = Env("FOO", "bar", "temp", "C:\\evil", "PI_GUI_ALLOW_EXEC", "1");
            SortedDictionary<string, string> env = ChildEnvironment.Build(baseEnv, request, forced);
            Check(!env.ContainsKey("PI_GUI_TESTING_TOKEN") && !env.ContainsKey("PI_GUI_RUNTIME_DIR") && !env.ContainsKey("PI_GUI_ALLOW_EXEC"), "env: contract variables never reach a child");
            Check(env["TEMP"] == "C:\\rt\\tmp" && env["PI_GUI_TAG"] == "abcd" && env["FOO"] == "bar" && env["PATH"] == "C:\\bin", "env: forced values win, case-insensitive names");
            ThrowsCode("BAD_REQUEST", delegate { ChildEnvironment.Build(baseEnv, Env("A=B", "x"), forced); }, "env: '=' in a name refused");
            ThrowsCode("BAD_REQUEST", delegate { ChildEnvironment.Build(baseEnv, Env("A", "x\0y"), forced); }, "env: NUL in a value refused");
            string block = ChildEnvironment.Block(env);
            Check(block.EndsWith("\0\0", StringComparison.Ordinal) && block.IndexOf("FOO=bar\0", StringComparison.Ordinal) >= 0, "env: block format");
            Check(block.IndexOf("FOO=", StringComparison.Ordinal) < block.IndexOf("Path=", StringComparison.Ordinal) &&
                  block.IndexOf("Path=", StringComparison.Ordinal) < block.IndexOf("PI_GUI_TAG=", StringComparison.Ordinal), "env: block sorted case-insensitively");
        }

        static void LaunchPolicyTests()
        {
            List<string> args = LaunchPolicy.Args("C:\\app\\Electron.exe", new List<string> { "." }, true);
            Check(args.Count == 3 && args.Contains("--force-renderer-accessibility") && args.Contains("--disable-gpu"), "launch: electron gets a11y + disable-gpu");
            Check(LaunchPolicy.Args("electron", new List<string>(), false).Count == 1, "launch: no --disable-gpu when software rendering is off");
            Check(LaunchPolicy.IsChromiumLike("npx", new List<string> { "electron", "." }) && LaunchPolicy.IsChromiumLike("node", new List<string> { "C:/x/node_modules/electron/cli.js" }), "launch: npx/node electron");
            Check(!LaunchPolicy.IsChromiumLike("python", new List<string> { "app.py" }), "launch: python untouched");
            Check(LaunchPolicy.Args("msedge", new List<string> { "--disable-gpu" }, true).Count == 2, "launch: flags not duplicated");
            var forced = new Dictionary<string, string>();
            LaunchPolicy.AddRenderingEnv(forced, new Dictionary<string, string>(), true);
            Check(forced["QT_OPENGL"] == "software" && forced["QT_QUICK_BACKEND"] == "software" && forced["FLUTTER_ENGINE_SWITCH_1"] == "enable-software-rendering", "launch: rendering env");
            var forced2 = new Dictionary<string, string>();
            LaunchPolicy.AddRenderingEnv(forced2, Env("FLUTTER_ENGINE_SWITCHES", "2"), true);
            Check(!forced2.ContainsKey("FLUTTER_ENGINE_SWITCHES"), "launch: request's Flutter switches kept");
            var forced3 = new Dictionary<string, string>();
            LaunchPolicy.AddRenderingEnv(forced3, null, false);
            Check(forced3.Count == 0, "launch: rendering env off");
        }

        static void KeyTests()
        {
            List<KeyChord> chords = KeySyntax.Parse("ctrl+a BackSpace Return shift+Tab F5 A comma ctrl+shift+Z");
            Check(chords.Count == 8, "keys: chord count");
            Check(chords[0].Modifiers.Count == 1 && chords[0].Modifiers[0] == 0x11 && chords[0].Vk == 'A', "keys: ctrl+a");
            Check(chords[1].Vk == 0x08 && chords[2].Vk == 0x0D && chords[4].Vk == 0x74, "keys: named keys");
            Check(chords[5].Vk == 'A' && chords[5].Modifiers.Contains(0x10), "keys: uppercase letter adds shift");
            Check(chords[6].Vk == 0 && chords[6].Char == ',', "keys: punctuation mapped by the platform");
            Check(chords[7].Modifiers.Count == 2 && chords[7].Vk == 'Z', "keys: two modifiers");
            ThrowsCode("BAD_REQUEST", delegate { KeySyntax.Parse("hyper+a"); }, "keys: unknown modifier");
            ThrowsCode("BAD_REQUEST", delegate { KeySyntax.Parse("NoSuchKey"); }, "keys: unknown key");
            ThrowsCode("BAD_REQUEST", delegate { KeySyntax.Parse("ctrl+"); }, "keys: empty key");
            ThrowsCode("BAD_REQUEST", delegate { KeySyntax.Parse("  "); }, "keys: empty text");
            string dir;
            int amount;
            KeySyntax.ParseScroll("", out dir, out amount);
            Check(dir == "down" && amount == 1, "scroll: default");
            KeySyntax.ParseScroll("left 7", out dir, out amount);
            Check(dir == "left" && amount == 7, "scroll: direction and amount");
            ThrowsCode("BAD_REQUEST", delegate { KeySyntax.ParseScroll("down 101", out dir, out amount); }, "scroll: amount bound");
            ThrowsCode("BAD_REQUEST", delegate { KeySyntax.ParseScroll("sideways", out dir, out amount); }, "scroll: direction checked");
        }

        static ElementNode Node(string role, int parent, int window)
        {
            var n = new ElementNode();
            n.Role = role;
            n.Name = role;
            n.Parent = parent;
            n.Window = window;
            return n;
        }

        static void RoleAndCoverageTests()
        {
            Check(Roles.FromControlType("ControlType.Button") == "push button" && Roles.FromControlType("ControlType.Edit") == "text" &&
                  Roles.FromControlType("ControlType.NewThing") == "newthing" && Roles.FromControlType(null) == "unknown", "roles: mapping");
            // Tk-like window: only frame, title bar, and its buttons.
            var tk = new List<ElementNode> { Node("frame", -1, 0), Node("title bar", 0, 0), Node("push button", 1, 0), Node("panel", 0, 0) };
            Check(Coverage.Compute(new WalkResult(tk, 1)) == "none", "coverage: title-bar buttons alone are none");
            var mixed = new List<ElementNode>(tk);
            mixed.Add(Node("frame", -1, 1));
            mixed.Add(Node("push button", 4, 1));
            Check(Coverage.Compute(new WalkResult(mixed, 2)) == "partial", "coverage: one of two windows is partial");
            var full = new List<ElementNode> { Node("frame", -1, 0), Node("text", 0, 0) };
            Check(Coverage.Compute(new WalkResult(full, 1)) == "full", "coverage: full");
            Check(Coverage.Compute(new WalkResult(new List<ElementNode>(), 0)) == "none", "coverage: empty");
            Check(Handlers.ReportedExitCode(unchecked((int)0xC0000005)) == 1000 && Handlers.ReportedExitCode(-1) == -1 && Handlers.ReportedExitCode(3) == 3, "exec: exit code mapping");
            Check(Handlers.IsWindowRef("win:0x1a2b") && !Handlers.IsWindowRef("win:0x") && !Handlers.IsWindowRef("win:0xABC") && !Handlers.IsWindowRef("s1:2"), "refs: window ref syntax");
        }
    }
}
