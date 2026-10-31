// Minimal JSON reader and writer for the helper protocol (docs/protocol.md).
//
// Pure managed code, C# 5 / .NET Framework 4.5 compatible, no Win32 calls, so
// it is compiled and tested on any host with PowerShell 7 as well. Values map
// to: object -> Dictionary<string, object>, array -> List<object>,
// string -> string, integer -> long, other numbers -> double, true/false ->
// bool, null -> null.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace PiGuiHelper
{
    public sealed class JsonException : Exception
    {
        public JsonException(string message) : base(message) { }
    }

    public static class Json
    {
        /// <summary>Nesting bound: protocol messages are shallow; deeper input is refused, not recursed into.</summary>
        public const int MaxDepth = 64;

        public static object Parse(string text)
        {
            if (text == null) throw new JsonException("no input");
            var parser = new Parser(text);
            parser.SkipWhitespace();
            object value = parser.ReadValue(0);
            parser.SkipWhitespace();
            if (!parser.AtEnd) throw new JsonException("trailing characters at offset " + parser.Position);
            return value;
        }

        public static string Serialize(object value)
        {
            var builder = new StringBuilder();
            Write(builder, value, 0);
            return builder.ToString();
        }

        static void Write(StringBuilder b, object value, int depth)
        {
            if (depth > MaxDepth) throw new JsonException("value nests deeper than " + MaxDepth);
            if (value == null) { b.Append("null"); return; }
            var s = value as string;
            if (s != null) { WriteString(b, s); return; }
            if (value is bool) { b.Append((bool)value ? "true" : "false"); return; }
            if (value is int || value is long || value is short || value is byte || value is uint || value is ushort || value is sbyte)
            {
                b.Append(Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (value is ulong)
            {
                b.Append(((ulong)value).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (value is double || value is float || value is decimal)
            {
                double d = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (double.IsNaN(d) || double.IsInfinity(d)) throw new JsonException("NaN and infinity have no JSON form");
                if (d == Math.Floor(d) && Math.Abs(d) < 9007199254740992.0)
                    b.Append(((long)d).ToString(CultureInfo.InvariantCulture));
                else
                    b.Append(d.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            var dict = value as IDictionary<string, object>;
            if (dict != null)
            {
                b.Append('{');
                bool first = true;
                foreach (var pair in dict)
                {
                    if (!first) b.Append(',');
                    first = false;
                    WriteString(b, pair.Key);
                    b.Append(':');
                    Write(b, pair.Value, depth + 1);
                }
                b.Append('}');
                return;
            }
            var list = value as IEnumerable;
            if (list != null)
            {
                b.Append('[');
                bool first = true;
                foreach (object item in list)
                {
                    if (!first) b.Append(',');
                    first = false;
                    Write(b, item, depth + 1);
                }
                b.Append(']');
                return;
            }
            throw new JsonException("cannot serialize " + value.GetType().Name);
        }

        /// <summary>Writes a JSON string. Lone surrogates become U+FFFD so the output is always valid UTF-8.</summary>
        /// <summary>UTF-8 bytes WriteString produces for s, quotes included, without building it.</summary>
        public static long EncodedLength(string s)
        {
            long n = 2;
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '"' || c == '\\' || c == '\n' || c == '\r' || c == '\t' || c == '\b' || c == '\f') n += 2;
                else if (c < 0x20 || c == '\u2028' || c == '\u2029') n += 6;
                else if (char.IsHighSurrogate(c))
                {
                    if (i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { n += 4; i++; }
                    else n += 3;
                }
                else if (char.IsLowSurrogate(c)) n += 3;
                else if (c < 0x80) n += 1;
                else if (c < 0x800) n += 2;
                else n += 3;
            }
            return n;
        }

        public static void WriteString(StringBuilder b, string s)
        {
            b.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    case '\b': b.Append("\\b"); break;
                    case '\f': b.Append("\\f"); break;
                    default:
                        if (c < 0x20 || c == '\u2028' || c == '\u2029')
                        {
                            b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else if (char.IsHighSurrogate(c))
                        {
                            if (i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { b.Append(c).Append(s[i + 1]); i++; }
                            else b.Append('\uFFFD');
                        }
                        else if (char.IsLowSurrogate(c))
                        {
                            b.Append('\uFFFD');
                        }
                        else
                        {
                            b.Append(c);
                        }
                        break;
                }
            }
            b.Append('"');
        }

        sealed class Parser
        {
            readonly string _text;
            int _pos;

            public Parser(string text) { _text = text; }

            public bool AtEnd { get { return _pos >= _text.Length; } }
            public int Position { get { return _pos; } }

            public void SkipWhitespace()
            {
                while (_pos < _text.Length)
                {
                    char c = _text[_pos];
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') _pos++;
                    else break;
                }
            }

            JsonException Error(string what)
            {
                return new JsonException(what + " at offset " + _pos);
            }

            public object ReadValue(int depth)
            {
                if (depth > MaxDepth) throw Error("nesting deeper than " + MaxDepth);
                if (AtEnd) throw Error("unexpected end");
                char c = _text[_pos];
                switch (c)
                {
                    case '{': return ReadObject(depth);
                    case '[': return ReadArray(depth);
                    case '"': return ReadString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default:
                        if (c == '-' || (c >= '0' && c <= '9')) return ReadNumber();
                        throw Error("unexpected character '" + c + "'");
                }
            }

            void Expect(string word)
            {
                if (string.CompareOrdinal(_text, _pos, word, 0, word.Length) != 0) throw Error("invalid literal");
                _pos += word.Length;
            }

            Dictionary<string, object> ReadObject(int depth)
            {
                var result = new Dictionary<string, object>(StringComparer.Ordinal);
                _pos++;
                SkipWhitespace();
                if (!AtEnd && _text[_pos] == '}') { _pos++; return result; }
                while (true)
                {
                    SkipWhitespace();
                    if (AtEnd || _text[_pos] != '"') throw Error("expected a member name");
                    string key = ReadString();
                    SkipWhitespace();
                    if (AtEnd || _text[_pos] != ':') throw Error("expected ':'");
                    _pos++;
                    SkipWhitespace();
                    // Duplicate names: the last one wins, as in JSON.parse.
                    result[key] = ReadValue(depth + 1);
                    SkipWhitespace();
                    if (AtEnd) throw Error("unterminated object");
                    char c = _text[_pos++];
                    if (c == '}') return result;
                    if (c != ',') throw Error("expected ',' or '}'");
                }
            }

            List<object> ReadArray(int depth)
            {
                var result = new List<object>();
                _pos++;
                SkipWhitespace();
                if (!AtEnd && _text[_pos] == ']') { _pos++; return result; }
                while (true)
                {
                    SkipWhitespace();
                    result.Add(ReadValue(depth + 1));
                    SkipWhitespace();
                    if (AtEnd) throw Error("unterminated array");
                    char c = _text[_pos++];
                    if (c == ']') return result;
                    if (c != ',') throw Error("expected ',' or ']'");
                }
            }

            string ReadString()
            {
                _pos++; // opening quote
                var b = new StringBuilder();
                while (true)
                {
                    if (AtEnd) throw Error("unterminated string");
                    char c = _text[_pos++];
                    if (c == '"') return b.ToString();
                    if (c < 0x20) throw Error("control character in string");
                    if (c != '\\') { b.Append(c); continue; }
                    if (AtEnd) throw Error("unterminated escape");
                    char e = _text[_pos++];
                    switch (e)
                    {
                        case '"': b.Append('"'); break;
                        case '\\': b.Append('\\'); break;
                        case '/': b.Append('/'); break;
                        case 'b': b.Append('\b'); break;
                        case 'f': b.Append('\f'); break;
                        case 'n': b.Append('\n'); break;
                        case 'r': b.Append('\r'); break;
                        case 't': b.Append('\t'); break;
                        case 'u':
                            if (_pos + 4 > _text.Length) throw Error("short \\u escape");
                            int code;
                            if (!int.TryParse(_text.Substring(_pos, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code))
                                throw Error("invalid \\u escape");
                            _pos += 4;
                            b.Append((char)code);
                            break;
                        default: throw Error("invalid escape");
                    }
                }
            }

            object ReadNumber()
            {
                int start = _pos;
                if (_text[_pos] == '-') _pos++;
                if (AtEnd) throw Error("invalid number");
                if (_text[_pos] == '0') _pos++;
                else if (_text[_pos] >= '1' && _text[_pos] <= '9') { while (!AtEnd && char.IsDigit(_text[_pos]) && _text[_pos] < 128) _pos++; }
                else throw Error("invalid number");
                bool integral = true;
                if (!AtEnd && _text[_pos] == '.')
                {
                    integral = false;
                    _pos++;
                    int digits = _pos;
                    while (!AtEnd && _text[_pos] >= '0' && _text[_pos] <= '9') _pos++;
                    if (_pos == digits) throw Error("invalid fraction");
                }
                if (!AtEnd && (_text[_pos] == 'e' || _text[_pos] == 'E'))
                {
                    integral = false;
                    _pos++;
                    if (!AtEnd && (_text[_pos] == '+' || _text[_pos] == '-')) _pos++;
                    int digits = _pos;
                    while (!AtEnd && _text[_pos] >= '0' && _text[_pos] <= '9') _pos++;
                    if (_pos == digits) throw Error("invalid exponent");
                }
                string token = _text.Substring(start, _pos - start);
                if (integral)
                {
                    long l;
                    if (long.TryParse(token, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out l)) return l;
                }
                double d;
                if (!double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out d) || double.IsInfinity(d))
                    throw Error("number out of range");
                return d;
            }
        }
    }
}
