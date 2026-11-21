// Screenshot encoding: lossless PNG, downscaling, pixel hash, all-black flag
// (docs/protocol.md "screenshot", spec section 4.5). Pure managed code: the Win32
// layer only delivers raw 8-bit RGB pixels.
//
// sha256 is the SHA-256 of the unscaled RGB pixels (row-major, 3 bytes per
// pixel, no header), exactly as the Linux helper computes it, so identical
// screens hash the same on every platform.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace PiGuiHelper
{
    /// <summary>Raw 8-bit RGB image, row-major, no padding.</summary>
    public sealed class RgbImage
    {
        public RgbImage(int width, int height, byte[] rgb)
        {
            if (width <= 0 || height <= 0) throw new ArgumentException("empty image");
            if (rgb == null || rgb.Length != checked(width * height * 3)) throw new ArgumentException("pixel buffer does not match " + width + "x" + height);
            Width = width;
            Height = height;
            Rgb = rgb;
        }

        public int Width { get; private set; }
        public int Height { get; private set; }
        public byte[] Rgb { get; private set; }
    }

    public static class Imaging
    {
        public const int DefaultMaxEdge = 1280;
        /// <summary>Same bound as the client's screenshot validation (RESPONSE_LIMITS.pixels).</summary>
        public const int MaxEdgePixels = 32768;
        /// <summary>Base64 text of one screenshot (RESPONSE_LIMITS.pngBase64Chars).</summary>
        public const int MaxPngBase64Chars = 48 * 1024 * 1024;
        /// <summary>Encodings tried before a capture that does not fit is refused.</summary>
        public const int MaxEncodeAttempts = 6;

        static readonly uint[] CrcTable = BuildCrcTable();

        static uint[] BuildCrcTable()
        {
            var table = new uint[256];
            for (uint n = 0; n < 256; n++)
            {
                uint c = n;
                for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
                table[n] = c;
            }
            return table;
        }

        public static uint Crc32(byte[] data, int offset, int count)
        {
            uint c = 0xFFFFFFFFu;
            for (int i = offset; i < offset + count; i++) c = CrcTable[(c ^ data[i]) & 0xFF] ^ (c >> 8);
            return c ^ 0xFFFFFFFFu;
        }

        public static uint Adler32(byte[] data)
        {
            const uint Mod = 65521;
            uint a = 1, b = 0;
            int i = 0;
            while (i < data.Length)
            {
                int n = Math.Min(3800, data.Length - i);
                for (int k = 0; k < n; k++)
                {
                    a += data[i + k];
                    b += a;
                }
                a %= Mod;
                b %= Mod;
                i += n;
            }
            return (b << 16) | a;
        }

        static void WriteUInt32BE(Stream s, uint v)
        {
            s.WriteByte((byte)(v >> 24));
            s.WriteByte((byte)(v >> 16));
            s.WriteByte((byte)(v >> 8));
            s.WriteByte((byte)v);
        }

        static void WriteChunk(Stream s, string kind, byte[] payload)
        {
            WriteUInt32BE(s, (uint)payload.Length);
            byte[] body = new byte[4 + payload.Length];
            Encoding.ASCII.GetBytes(kind, 0, 4, body, 0);
            Buffer.BlockCopy(payload, 0, body, 4, payload.Length);
            s.Write(body, 0, body.Length);
            WriteUInt32BE(s, Crc32(body, 0, body.Length));
        }

        /// <summary>zlib stream (RFC 1950) around .NET's raw deflate.</summary>
        public static byte[] ZlibCompress(byte[] data)
        {
            var output = new MemoryStream();
            output.WriteByte(0x78);
            output.WriteByte(0x9C);
            using (var deflate = new DeflateStream(output, CompressionMode.Compress, true))
            {
                deflate.Write(data, 0, data.Length);
            }
            WriteUInt32BE(output, Adler32(data));
            return output.ToArray();
        }

        /// <summary>Encodes raw 8-bit RGB as a PNG (colour type 2, filter 0 on every row, no ancillary chunks).</summary>
        public static byte[] EncodePng(RgbImage image)
        {
            int stride = image.Width * 3;
            byte[] scanlines = new byte[checked((stride + 1) * image.Height)];
            for (int row = 0; row < image.Height; row++)
            {
                scanlines[row * (stride + 1)] = 0;
                Buffer.BlockCopy(image.Rgb, row * stride, scanlines, row * (stride + 1) + 1, stride);
            }
            var png = new MemoryStream();
            png.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }, 0, 8);
            var header = new MemoryStream();
            WriteUInt32BE(header, (uint)image.Width);
            WriteUInt32BE(header, (uint)image.Height);
            header.Write(new byte[] { 8, 2, 0, 0, 0 }, 0, 5);
            WriteChunk(png, "IHDR", header.ToArray());
            WriteChunk(png, "IDAT", ZlibCompress(scanlines));
            WriteChunk(png, "IEND", new byte[0]);
            return png.ToArray();
        }

        /// <summary>Scale and output size so the long edge is at most maxEdge (never upscales).</summary>
        public static void ScaledSize(int width, int height, int maxEdge, out double scale, out int outW, out int outH)
        {
            int longEdge = Math.Max(width, height);
            if (longEdge <= maxEdge)
            {
                scale = 1;
                outW = width;
                outH = height;
                return;
            }
            scale = maxEdge / (double)longEdge;
            outW = Math.Max(1, (int)Math.Round(width * scale, MidpointRounding.AwayFromZero));
            outH = Math.Max(1, (int)Math.Round(height * scale, MidpointRounding.AwayFromZero));
        }

        /// <summary>Area-average (box filter) downscale. Deterministic integer arithmetic.</summary>
        public static RgbImage Resize(RgbImage src, int outW, int outH)
        {
            if (outW == src.Width && outH == src.Height) return src;
            byte[] dst = new byte[checked(outW * outH * 3)];
            int[] x0 = new int[outW], x1 = new int[outW];
            for (int x = 0; x < outW; x++)
            {
                x0[x] = (int)((long)x * src.Width / outW);
                x1[x] = Math.Max(x0[x] + 1, (int)((long)(x + 1) * src.Width / outW));
            }
            for (int y = 0; y < outH; y++)
            {
                int y0 = (int)((long)y * src.Height / outH);
                int y1 = Math.Max(y0 + 1, (int)((long)(y + 1) * src.Height / outH));
                for (int x = 0; x < outW; x++)
                {
                    long r = 0, g = 0, b = 0;
                    for (int sy = y0; sy < y1; sy++)
                    {
                        int rowBase = sy * src.Width * 3;
                        for (int sx = x0[x]; sx < x1[x]; sx++)
                        {
                            int p = rowBase + sx * 3;
                            r += src.Rgb[p];
                            g += src.Rgb[p + 1];
                            b += src.Rgb[p + 2];
                        }
                    }
                    long count = (long)(y1 - y0) * (x1[x] - x0[x]);
                    int o = (y * outW + x) * 3;
                    dst[o] = (byte)((r + count / 2) / count);
                    dst[o + 1] = (byte)((g + count / 2) / count);
                    dst[o + 2] = (byte)((b + count / 2) / count);
                }
            }
            return new RgbImage(outW, outH, dst);
        }

        public static string Sha256Hex(byte[] data)
        {
            using (var sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(data);
                var b = new StringBuilder(64);
                foreach (byte x in hash) b.Append(x.ToString("x2", CultureInfo.InvariantCulture));
                return b.ToString();
            }
        }

        public static bool AllBlack(byte[] rgb)
        {
            for (int i = 0; i < rgb.Length; i++) if (rgb[i] != 0) return false;
            return true;
        }

        /// <summary>Crops a rectangle (already clipped to the image).</summary>
        public static RgbImage Crop(RgbImage src, int x, int y, int width, int height)
        {
            if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > src.Width || y + height > src.Height)
                throw new ArgumentException("crop rectangle outside the image");
            byte[] dst = new byte[checked(width * height * 3)];
            for (int row = 0; row < height; row++)
                Buffer.BlockCopy(src.Rgb, ((y + row) * src.Width + x) * 3, dst, row * width * 3, width * 3);
            return new RgbImage(width, height, dst);
        }

        /// <summary>Base64 characters of n bytes.</summary>
        public static long Base64Length(long n)
        {
            return (n + 2) / 3 * 4;
        }

        /// <summary>The screenshot result fields that depend only on the pixels.</summary>
        public static Dictionary<string, object> BuildCapture(RgbImage image, int maxEdge)
        {
            return BuildCapture(image, maxEdge, MaxPngBase64Chars);
        }

        /// <summary>
        /// As BuildCapture, with at most maxBase64Chars of PNG text: a capture that does not compress
        /// enough is downscaled further (the reported scale says how far) until it fits, and refused with
        /// TOO_LARGE when it still does not fit after MaxEncodeAttempts encodings.
        /// </summary>
        public static Dictionary<string, object> BuildCapture(RgbImage image, int maxEdge, long maxBase64Chars)
        {
            double scale;
            int outW, outH;
            int edge = Math.Max(1, Math.Min(maxEdge, Math.Max(image.Width, image.Height)));
            byte[] png = null;
            scale = 1;
            for (int attempt = 0; ; attempt++)
            {
                ScaledSize(image.Width, image.Height, edge, out scale, out outW, out outH);
                png = EncodePng(scale == 1 ? image : Resize(image, outW, outH));
                long chars = Base64Length(png.Length);
                if (chars <= maxBase64Chars) break;
                // PNG size grows about with the pixel count: shrink the edge by the square root of the excess, with a margin.
                int next = (int)Math.Floor(edge * Math.Sqrt(maxBase64Chars / (double)chars) * 0.95);
                if (next >= edge) next = edge - 1;
                if (next < 1 || attempt + 1 >= MaxEncodeAttempts)
                    throw new ProtocolException("TOO_LARGE", "the screenshot does not fit the transfer limit (" + chars + " base64 characters at " + outW + "x" + outH + ", at most " + maxBase64Chars +
                        "); capture a window or an element, or pass a smaller maxEdge");
                Diag.Write("the screenshot (" + outW + "x" + outH + ") exceeds " + maxBase64Chars + " base64 characters; downscaling to a long edge of " + next);
                edge = next;
            }
            var result = new Dictionary<string, object>();
            result["width"] = image.Width;
            result["height"] = image.Height;
            result["scale"] = scale;
            result["png_base64"] = Convert.ToBase64String(png);
            result["sha256"] = Sha256Hex(image.Rgb);
            if (AllBlack(image.Rgb)) result["allBlack"] = true;
            return result;
        }
    }
}
