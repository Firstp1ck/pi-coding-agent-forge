// Helper entry: environment, framing setup, startup, request loop, and exit
// paths (docs/protocol.md "Heartbeat and teardown"): stop, stdin EOF, Ctrl+C,
// heartbeat timeout, and a mismatched hello. Each runs the same idempotent
// IPlatform.Teardown and then returns the exit code to helper.ps1, which exits
// the process hard (worker threads may sit in blocking UI Automation calls).
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

namespace PiGuiHelper
{
    public static class HelperMain
    {
        sealed class Shutdown
        {
            readonly ManualResetEvent _event = new ManualResetEvent(false);
            readonly object _lock = new object();
            string _reason;

            public string Reason { get { lock (_lock) { return _reason; } } }
            public WaitHandle Handle { get { return _event; } }

            public void Request(string reason)
            {
                lock (_lock)
                {
                    if (_reason == null) _reason = reason;
                }
                _event.Set();
            }
        }

        /// <summary>The process environment as a case-insensitive dictionary.</summary>
        public static Dictionary<string, string> ProcessEnvironment()
        {
            var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (DictionaryEntry e in Environment.GetEnvironmentVariables())
            {
                var k = e.Key as string;
                var v = e.Value as string;
                if (k != null && v != null) env[k] = v;
            }
            return env;
        }

        /// <summary>
        /// Reads one stdin line per name in stdinEnv (comma-separated, from the allow-list) before
        /// the protocol starts, so transports without an environment (cua sandbox exec) never put
        /// a value in argv. A missing line, a CR, or an unknown name fails startup.
        /// </summary>
        public static void ReadStdinEnv(string stdinEnv, LineReader reader, IDictionary<string, string> env)
        {
            if (string.IsNullOrEmpty(stdinEnv)) return;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (string raw in stdinEnv.Split(','))
            {
                string name = raw.Trim();
                if (Array.IndexOf(HostConfig.StdinEnvNames, name) < 0) throw new ArgumentException("-StdinEnv names an unknown variable '" + name + "'");
                if (!seen.Add(name)) throw new ArgumentException("-StdinEnv names " + name + " twice");
                byte[] line = reader.ReadLine();
                if (line == null || reader.Oversized) throw new ArgumentException("stdin ended before the value of " + name);
                string value = new UTF8Encoding(false, true).GetString(line);
                if (value.IndexOf('\r') >= 0 || value.IndexOf('\0') >= 0) throw new ArgumentException("the stdin value of " + name + " holds a CR or NUL");
                env[name] = value;
            }
        }

        /// <summary>--probe NAME: one JSON line on stdout, no protocol, exit 0 when "ok" is true.</summary>
        public static int RunProbe(IPlatformFactory factory, string name, Stream output, IDictionary<string, string> env)
        {
            Dictionary<string, object> result;
            try
            {
                result = factory.Probe(name, env);
            }
            catch (Exception e)
            {
                result = new Dictionary<string, object>();
                result["probe"] = name;
                result["ok"] = false;
                result["error"] = e.GetType().Name + ": " + e.Message;
            }
            byte[] line = Encoding.UTF8.GetBytes(Json.Serialize(result) + "\n");
            output.Write(line, 0, line.Length);
            output.Flush();
            object ok;
            return result.TryGetValue("ok", out ok) && ok is bool && (bool)ok ? 0 : 1;
        }

        /// <summary>Runs one helper session. Returns the process exit code (0 after a clean teardown).</summary>
        public static int Run(IPlatformFactory factory, string stdinEnv, Stream input, Stream output, IDictionary<string, string> env)
        {
            var reader = new LineReader(input, Protocol.MaxLineBytes);
            try
            {
                ReadStdinEnv(stdinEnv, reader, env);
            }
            catch (ArgumentException e)
            {
                Diag.Write(e.Message);
                return 2;
            }
            string token;
            env.TryGetValue(Protocol.TokenEnv, out token);
            if (!Protocol.ValidToken(token))
            {
                Diag.Write(Protocol.TokenEnv + " must hold 32 hex characters");
                return 2;
            }
            HostConfig config;
            try
            {
                config = HostConfig.FromEnv(env, factory.LocalTempRoot(env));
            }
            catch (ArgumentException e)
            {
                Diag.Write("startup failed: " + e.Message);
                return 1;
            }
            foreach (string warning in config.Warnings) Diag.Write(warning);

            var writer = new ProtocolWriter(output, token);
            var shutdown = new Shutdown();
            ConsoleCancelEventHandler onCancel = delegate(object sender, ConsoleCancelEventArgs e)
            {
                e.Cancel = true;
                shutdown.Request("console " + e.SpecialKey);
            };
            try { Console.CancelKeyPress += onCancel; }
            catch (Exception) { /* no console: nothing to hook */ }

            IPlatform platform = null;
            try
            {
                platform = factory.Create(config, env, writer);
                platform.Start();
            }
            catch (Exception e)
            {
                Diag.Write("startup failed: " + e.Message);
                if (platform != null)
                {
                    try { platform.Teardown(); }
                    catch (Exception t) { Diag.Write("teardown after failed startup: " + t.Message); }
                }
                return 1;
            }

            var handlers = new Handlers(platform, config, writer, shutdown.Request);
            var dispatcher = new Dispatcher(writer, handlers.Table());
            var watchdog = new Watchdog(Protocol.HeartbeatTimeoutMs(env), delegate { shutdown.Request("heartbeat timeout"); });
            writer.Ready();
            watchdog.Start();
            var thread = new Thread(delegate() { ReadLoop(reader, token, dispatcher, watchdog, shutdown); });
            thread.IsBackground = true;
            thread.Name = "reader";
            thread.Start();

            shutdown.Handle.WaitOne();
            Diag.Write("tearing down: " + shutdown.Reason);
            watchdog.Stop();
            dispatcher.Close();
            List<Dictionary<string, object>> leftovers;
            try
            {
                leftovers = platform.Teardown();
            }
            catch (Exception e)
            {
                Diag.Write("teardown failed: " + e.Message);
                return 1;
            }
            if (leftovers.Count > 0) Diag.Write("leftovers after teardown: " + Json.Serialize(leftovers));
            try { Console.CancelKeyPress -= onCancel; }
            catch (Exception) { }
            return 0;
        }

        static void ReadLoop(LineReader reader, string token, Dispatcher dispatcher, Watchdog watchdog, Shutdown shutdown)
        {
            try
            {
                while (true)
                {
                    byte[] line = reader.ReadLine();
                    if (line == null) break;
                    watchdog.Touch();
                    if (reader.Oversized)
                    {
                        Diag.Write("dropping a line longer than 64 MiB");
                        continue;
                    }
                    Dictionary<string, object> message;
                    try
                    {
                        message = Framing.ParseLine(line, token);
                    }
                    catch (FramingException e)
                    {
                        Diag.Write("bad protocol line: " + e.Message);
                        continue;
                    }
                    if (message != null) dispatcher.Submit(message);
                }
            }
            catch (Exception e)
            {
                Diag.Write("stdin reader failed: " + e.Message);
                shutdown.Request("stdin error");
                return;
            }
            shutdown.Request("stdin EOF");
        }
    }
}
