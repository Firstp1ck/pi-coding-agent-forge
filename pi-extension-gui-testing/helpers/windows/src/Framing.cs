// Line framing for the helper protocol (docs/protocol.md "Framing").
//
// The token arrives in PI_GUI_TESTING_TOKEN (32 hex characters). The helper
// prints "PI-GUI-TESTING-READY <token>" once; after that every protocol line
// in either direction is "<token> <json>\n". Lines without the prefix are noise.
// Pure managed code (no Win32), shared by the Windows helper and its tests.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace PiGuiHelper
{
    public static class Protocol
    {
        public const int Version = 2;
        public const string HelperVersion = "0.1.0";
        public const string TokenEnv = "PI_GUI_TESTING_TOKEN";
        public const string ReadyPrefix = "PI-GUI-TESTING-READY";
        public const string HeartbeatTestEnv = "PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS";
        public const int MaxLineBytes = 64 * 1024 * 1024;
        public const int MaxLogEventBytes = 64 * 1024;
        public const int DefaultHeartbeatTimeoutMs = 60000;

        public static readonly string[] ErrorCodes = new string[] {
            "STALE_REF", "NOT_FOUND", "TIMEOUT", "HANDOFF", "PROTOCOL_MISMATCH", "CANCELLED",
            "BAD_REQUEST", "INTERNAL", "ARCHIVE_REJECTED", "TOO_LARGE",
        };

        public static bool ValidToken(string token)
        {
            if (token == null || token.Length != 32) return false;
            foreach (char c in token)
            {
                bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
                if (!hex) return false;
            }
            return true;
        }

        /// <summary>Heartbeat timeout from PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS (tests only), else 60 s.</summary>
        public static int HeartbeatTimeoutMs(IDictionary<string, string> env)
        {
            string raw;
            int value;
            if (env != null && env.TryGetValue(HeartbeatTestEnv, out raw) && int.TryParse(raw, out value) && value > 0) return value;
            return DefaultHeartbeatTimeoutMs;
        }
    }

    public sealed class FramingException : Exception
    {
        public FramingException(string message) : base(message) { }
    }

    public static class Framing
    {
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, false);

        /// <summary>
        /// Decodes one input line (without its LF). Returns the JSON object of a
        /// protocol line, or null for noise (no "&lt;token&gt; " prefix, blank line).
        /// Throws FramingException for a protocol line whose payload is not a JSON object.
        /// </summary>
        public static Dictionary<string, object> ParseLine(byte[] line, string token)
        {
            if (line.Length > Protocol.MaxLineBytes) throw new FramingException("line exceeds 64 MiB");
            string text = Utf8.GetString(line);
            if (text.EndsWith("\r", StringComparison.Ordinal)) text = text.Substring(0, text.Length - 1);
            string prefix = token + " ";
            if (!text.StartsWith(prefix, StringComparison.Ordinal)) return null;
            object message;
            try
            {
                message = Json.Parse(text.Substring(prefix.Length));
            }
            catch (JsonException e)
            {
                throw new FramingException("invalid JSON: " + e.Message);
            }
            var obj = message as Dictionary<string, object>;
            if (obj == null) throw new FramingException("protocol payload must be a JSON object");
            return obj;
        }

        public static byte[] EncodeLine(string token, object message)
        {
            return Utf8.GetBytes(token + " " + Json.Serialize(message) + "\n");
        }

        /// <summary>Splits text into pieces whose UTF-8 form is at most limit bytes, never inside a code point.</summary>
        public static List<string> SplitUtf8(string text, int limit)
        {
            var pieces = new List<string>();
            if (string.IsNullOrEmpty(text)) return pieces;
            byte[] data = Utf8.GetBytes(text);
            if (data.Length <= limit) { pieces.Add(text); return pieces; }
            int start = 0;
            while (start < data.Length)
            {
                int end = Math.Min(start + limit, data.Length);
                while (end < data.Length && end > start && (data[end] & 0xC0) == 0x80) end--;
                pieces.Add(Utf8.GetString(data, start, end - start));
                start = end;
            }
            return pieces;
        }
    }

    /// <summary>
    /// Reads LF-terminated lines from a stream with a bounded buffer. A line
    /// longer than the bound is skipped up to its LF and reported as oversized.
    /// It buffers ahead, so one instance must read both the stdin env preamble
    /// and the protocol lines that follow it.
    /// </summary>
    public sealed class LineReader
    {
        readonly Stream _stream;
        readonly int _maxLine;
        readonly byte[] _chunk = new byte[64 * 1024];
        int _chunkPos;
        int _chunkLen;

        public LineReader(Stream stream, int maxLine)
        {
            _stream = stream;
            _maxLine = maxLine;
        }

        /// <summary>Last ReadLine skipped an oversized line.</summary>
        public bool Oversized { get; private set; }

        /// <summary>Next line without its LF, or null at end of stream. An unterminated last line is returned as is.</summary>
        public byte[] ReadLine()
        {
            Oversized = false;
            var buffer = new MemoryStream();
            bool skipping = false;
            while (true)
            {
                if (_chunkPos >= _chunkLen)
                {
                    _chunkLen = _stream.Read(_chunk, 0, _chunk.Length);
                    _chunkPos = 0;
                    if (_chunkLen <= 0)
                    {
                        _chunkLen = 0;
                        if (skipping) { Oversized = true; return new byte[0]; }
                        return buffer.Length > 0 ? buffer.ToArray() : null;
                    }
                }
                int newline = Array.IndexOf(_chunk, (byte)'\n', _chunkPos, _chunkLen - _chunkPos);
                int end = newline >= 0 ? newline : _chunkLen;
                if (!skipping)
                {
                    if (buffer.Length + (end - _chunkPos) > _maxLine)
                    {
                        skipping = true;
                        buffer = new MemoryStream();
                    }
                    else
                    {
                        buffer.Write(_chunk, _chunkPos, end - _chunkPos);
                    }
                }
                _chunkPos = end;
                if (newline >= 0)
                {
                    _chunkPos = newline + 1;
                    if (skipping) { Oversized = true; return new byte[0]; }
                    return buffer.ToArray();
                }
            }
        }
    }

    /// <summary>Sink for app and setup output (log events).</summary>
    public interface ILogSink
    {
        void Log(string stream, string source, string text);
    }

    /// <summary>
    /// Thread-safe writer of protocol lines. Responses, events, and the ready
    /// line come from several threads; the lock keeps every line whole. A write
    /// failure marks the writer closed (the client is gone; teardown follows from EOF).
    /// </summary>
    public sealed class ProtocolWriter : ILogSink
    {
        readonly Stream _stream;
        readonly string _token;
        readonly object _lock = new object();

        public ProtocolWriter(Stream stream, string token)
        {
            _stream = stream;
            _token = token;
        }

        public bool Closed { get; private set; }

        void WriteBytes(byte[] data)
        {
            lock (_lock)
            {
                if (Closed) return;
                try
                {
                    _stream.Write(data, 0, data.Length);
                    _stream.Flush();
                }
                catch (IOException) { Closed = true; }
                catch (ObjectDisposedException) { Closed = true; }
                catch (NotSupportedException) { Closed = true; }
            }
        }

        public void Ready()
        {
            WriteBytes(Encoding.ASCII.GetBytes(Protocol.ReadyPrefix + " " + _token + "\n"));
        }

        public void Send(Dictionary<string, object> message)
        {
            WriteBytes(Framing.EncodeLine(_token, message));
        }

        public void RespondOk(long id, object result)
        {
            var m = new Dictionary<string, object>();
            m["id"] = id;
            m["ok"] = true;
            m["result"] = result;
            Send(m);
        }

        public void RespondError(long id, string code, string message)
        {
            var error = new Dictionary<string, object>();
            error["code"] = code;
            error["message"] = message ?? "";
            var m = new Dictionary<string, object>();
            m["id"] = id;
            m["ok"] = false;
            m["error"] = error;
            Send(m);
        }

        /// <summary>Sends text as one or more log events of at most 64 KiB of UTF-8 each.</summary>
        public void Log(string stream, string source, string text)
        {
            foreach (string piece in Framing.SplitUtf8(text, Protocol.MaxLogEventBytes))
            {
                var m = new Dictionary<string, object>();
                m["event"] = "log";
                m["stream"] = stream;
                m["source"] = source;
                m["data"] = piece;
                Send(m);
            }
        }
    }

    /// <summary>Diagnostics go to stderr, never to the protocol stream.</summary>
    public static class Diag
    {
        static TextWriter _out = Console.Error;
        static readonly object Lock = new object();

        public static void SetWriter(TextWriter writer) { _out = writer; }

        public static void Write(string text)
        {
            lock (Lock)
            {
                try
                {
                    _out.WriteLine("pi-gui-helper: " + text);
                    _out.Flush();
                }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
            }
        }
    }
}
