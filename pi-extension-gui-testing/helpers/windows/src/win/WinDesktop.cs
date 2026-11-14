// Private desktop, desktop-bound worker threads, window listing, capture, and
// message-based input (spec section 4.5).
//
// Window messages and UI Automation only reach windows on the calling
// thread's desktop, so every operation on the session's windows runs on a
// fresh worker thread that first calls SetThreadDesktop. The helper never
// calls SwitchDesktop, never touches the clipboard, and calls SendInput only
// in guest mode on that guest's interactive desktop (PI_GUI_WIN_INPUT=sendinput).
// Per-thread DPI awareness (per-monitor v2) is set for each operation and
// restored afterwards, so coordinates are physical pixels.
//
// Click routing (WM_NCHITTEST, deepest visible child via SendMessageTimeoutW for
// client hits, PostMessageW for non-client hits, HTCLOSE as SC_CLOSE) is adapted
// from @iiwate/pi-silent-gui 0.2.0 (MIT, Copyright (c) 2026 IIwate; see
// ../../THIRD_PARTY_NOTICES.md).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace PiGuiHelper.Win
{
    internal sealed class WinDesktop
    {
        /// <summary>Abandoned desktop workers allowed at once; one more request then ends the session.</summary>
        public const int MaxAbandonedWorkers = 2;

        readonly WorkerBudget _workers = new WorkerBudget(MaxAbandonedWorkers);
        IntPtr _handle;

        WinDesktop(IntPtr handle, string name, bool interactive)
        {
            _handle = handle;
            Name = name;
            Interactive = interactive;
            FullName = WindowStationName() + "\\" + name;
        }

        public string Name { get; private set; }
        /// <summary>"&lt;window station&gt;\&lt;desktop&gt;", for STARTUPINFO.lpDesktop.</summary>
        public string FullName { get; private set; }
        public bool Interactive { get; private set; }
        public IntPtr Handle { get { return _handle; } }

        public static string ObjectName(IntPtr obj)
        {
            var b = new StringBuilder(512);
            int needed;
            if (!Native.GetUserObjectInformationW(obj, Native.UOI_NAME, b, b.Capacity * 2, out needed)) return "";
            return b.ToString();
        }

        public static string WindowStationName()
        {
            string name = ObjectName(Native.GetProcessWindowStation());
            return string.IsNullOrEmpty(name) ? "WinSta0" : name;
        }

        public static string RandomHex(int bytes)
        {
            var data = new byte[bytes];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(data);
            var b = new StringBuilder(bytes * 2);
            foreach (byte x in data) b.Append(x.ToString("x2", CultureInfo.InvariantCulture));
            return b.ToString();
        }

        /// <summary>A new desktop named pi-gui-testing-&lt;tag&gt;-&lt;random&gt;; the caller cannot choose the name.</summary>
        public static WinDesktop CreatePrivate(string tag)
        {
            for (int attempt = 0; attempt < 4; attempt++)
            {
                string name = "pi-gui-testing-" + tag + "-" + RandomHex(16);
                IntPtr existing = Native.OpenDesktopW(name, 0, false, Native.DESKTOP_READOBJECTS);
                if (existing != IntPtr.Zero)
                {
                    Native.CloseDesktop(existing);
                    continue;
                }
                IntPtr h = Native.CreateDesktopW(name, IntPtr.Zero, IntPtr.Zero, 0, Native.DESKTOP_ALL, IntPtr.Zero);
                if (h == IntPtr.Zero) throw new InvalidOperationException(Native.Error("CreateDesktop"));
                return new WinDesktop(h, name, false);
            }
            throw new InvalidOperationException("could not find an unused private desktop name");
        }

        /// <summary>The guest's own desktop (guest mode only): WinSta0, an interactive session.</summary>
        public static WinDesktop OpenInteractive()
        {
            string station = WindowStationName();
            int session;
            Native.ProcessIdToSessionId(Native.GetCurrentProcessId(), out session);
            if (!string.Equals(station, "WinSta0", StringComparison.OrdinalIgnoreCase) || session == 0)
                throw new InvalidOperationException("PI_GUI_WIN_DESKTOP=interactive needs the helper in an interactive session (WinSta0, session > 0); " +
                    "this one runs in window station " + station + ", session " + session + " (an SSH or service session); use the private desktop");
            IntPtr h = Native.OpenDesktopW("Default", 0, false, Native.DESKTOP_ALL);
            if (h == IntPtr.Zero) throw new InvalidOperationException(Native.Error("OpenDesktop(Default)"));
            return new WinDesktop(h, "Default", true);
        }

        /// <summary>Closes the handle; false when Windows refused (threads still attached).</summary>
        public bool Close()
        {
            IntPtr h = _handle;
            _handle = IntPtr.Zero;
            return h == IntPtr.Zero || Native.CloseDesktop(h);
        }

        /// <summary>True when a desktop with this name still exists (some process still uses it).</summary>
        public static bool Exists(string name)
        {
            IntPtr h = Native.OpenDesktopW(name, 0, false, Native.DESKTOP_READOBJECTS);
            if (h == IntPtr.Zero) return false;
            Native.CloseDesktop(h);
            return true;
        }

        /// <summary>
        /// Runs fn on a new MTA thread attached to this desktop, with per-monitor DPI awareness for
        /// the operation. Waits up to timeoutMs (TIMEOUT) and honours cancel (CANCELLED); a worker
        /// stuck in a hung app is abandoned (background thread), never killed. At most
        /// MaxAbandonedWorkers may be outstanding: the next call fails with UnhealthyException and
        /// the helper ends the session (its teardown terminates the hung app, which frees them).
        /// </summary>
        public T Run<T>(string what, int timeoutMs, RequestContext ctx, Func<T> fn)
        {
            T result = default(T);
            Exception failure = null;
            var done = new ManualResetEvent(false);
            IntPtr desktop = _handle;
            bool attach = !Interactive;
            WorkerBudget.Worker worker = _workers.Begin(what);
            var thread = new Thread(delegate()
            {
                try
                {
                    if (attach && !Native.SetThreadDesktop(desktop)) throw new InvalidOperationException(Native.Error("SetThreadDesktop"));
                    using (DpiScope.PerMonitor())
                    {
                        result = fn();
                    }
                }
                catch (Exception e)
                {
                    failure = e;
                }
                finally
                {
                    worker.Done();
                    done.Set();
                }
            });
            thread.IsBackground = true;
            thread.Name = "desktop-" + what;
            thread.SetApartmentState(ApartmentState.MTA);
            try
            {
                thread.Start();
            }
            catch
            {
                worker.Done();
                throw;
            }
            var handles = ctx != null ? new WaitHandle[] { done, ctx.CancelHandle } : new WaitHandle[] { done };
            int index = WaitHandle.WaitAny(handles, timeoutMs);
            if (index == WaitHandle.WaitTimeout)
            {
                worker.Abandon();
                throw new ProtocolException("TIMEOUT", what + " did not finish within " + (timeoutMs / 1000) + " s; the app may be hung");
            }
            if (index == 1)
            {
                worker.Abandon();
                throw new CancelledException();
            }
            if (failure != null)
            {
                if (failure is ProtocolException) throw failure;
                throw new ProtocolException("INTERNAL", what + ": " + failure.GetType().Name + ": " + failure.Message);
            }
            return result;
        }

        public void Run(string what, int timeoutMs, RequestContext ctx, Action fn)
        {
            Run<bool>(what, timeoutMs, ctx, delegate { fn(); return true; });
        }
    }

    /// <summary>Per-thread DPI awareness for one operation, restored on Dispose.</summary>
    internal sealed class DpiScope : IDisposable
    {
        IntPtr _previous;

        public static DpiScope PerMonitor()
        {
            var scope = new DpiScope();
            try
            {
                scope._previous = Native.SetThreadDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                if (scope._previous == IntPtr.Zero) scope._previous = Native.SetThreadDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE);
            }
            catch (EntryPointNotFoundException)
            {
                scope._previous = IntPtr.Zero; // before Windows 10 1607: process awareness applies
            }
            return scope;
        }

        public void Dispose()
        {
            if (_previous != IntPtr.Zero)
            {
                Native.SetThreadDpiAwarenessContext(_previous);
                _previous = IntPtr.Zero;
            }
        }
    }

    /// <summary>Window enumeration and description. Call on a desktop thread.</summary>
    internal static class WinWindows
    {
        static readonly string[] HiddenClasses = new string[] { "#32768", "tooltips_class32", "SysShadow", "IME", "MSCTFIME UI", "Default IME" };

        /// <summary>Top-level windows of the desktop in z-order, topmost first.</summary>
        public static List<IntPtr> ZOrder(IntPtr desktop)
        {
            var list = new List<IntPtr>();
            EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr lParam)
            {
                if (list.Count < 4096) list.Add(hwnd);
                return true;
            };
            Native.EnumDesktopWindows(desktop, callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return list;
        }

        public static string ClassName(IntPtr hwnd)
        {
            var b = new StringBuilder(256);
            Native.GetClassNameW(hwnd, b, b.Capacity);
            return b.ToString();
        }

        public static string Title(IntPtr hwnd)
        {
            int length = Native.GetWindowTextLengthW(hwnd);
            if (length <= 0) return "";
            var b = new StringBuilder(Math.Min(length, 65536) + 1);
            Native.GetWindowTextW(hwnd, b, b.Capacity);
            return b.ToString();
        }

        public static bool Cloaked(IntPtr hwnd)
        {
            try
            {
                int cloaked;
                return Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0;
            }
            catch (DllNotFoundException) { return false; }
        }

        public static Bounds Rect(IntPtr hwnd)
        {
            RECT r;
            if (!Native.GetWindowRect(hwnd, out r)) return null;
            if (r.Right <= r.Left || r.Bottom <= r.Top) return null;
            return new Bounds(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
        }

        /// <summary>Painted at all: visible, not minimized, not cloaked, non-empty.</summary>
        public static bool Painted(IntPtr hwnd)
        {
            return Native.IsWindowVisible(hwnd) && !Native.IsIconic(hwnd) && !Cloaked(hwnd) && Rect(hwnd) != null;
        }

        /// <summary>A window the protocol lists: painted, not a menu/tooltip/IME helper, not an untitled tool window.</summary>
        public static bool Listed(IntPtr hwnd)
        {
            if (!Painted(hwnd)) return false;
            if (Array.IndexOf(HiddenClasses, ClassName(hwnd)) >= 0) return false;
            int ex = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
            if ((ex & Native.WS_EX_TOOLWINDOW) != 0 && Title(hwnd).Length == 0) return false;
            Bounds b = Rect(hwnd);
            const int At = 65536, Edge = 65535;
            return b.X >= -At && b.X <= At && b.Y >= -At && b.Y <= At && b.Width <= Edge && b.Height <= Edge;
        }

        public static string Ref(IntPtr hwnd)
        {
            return "win:0x" + hwnd.ToInt64().ToString("x", CultureInfo.InvariantCulture);
        }

        public static IntPtr ParseRef(string reference)
        {
            if (!Handlers.IsWindowRef(reference)) return IntPtr.Zero;
            long value;
            if (!long.TryParse(reference.Substring(6), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out value)) return IntPtr.Zero;
            return new IntPtr(value);
        }

        public static int Pid(IntPtr hwnd)
        {
            int pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            return pid;
        }
    }

    /// <summary>Lossless captures. Call on a desktop thread.</summary>
    internal static class WinCapture
    {
        const long MaxPixels = 64L * 1024 * 1024;

        /// <summary>PrintWindow(PW_RENDERFULLCONTENT) of the full window rect as RGB.</summary>
        public static RgbImage PrintWindowRgb(IntPtr hwnd, int width, int height)
        {
            byte[] bgra = Draw(width, height, delegate(IntPtr dc)
            {
                if (!Native.PrintWindow(hwnd, dc, Native.PW_RENDERFULLCONTENT))
                    throw new ProtocolException("INTERNAL", Native.Error("PrintWindow"));
            });
            return new RgbImage(width, height, ToRgb(bgra, width, height));
        }

        /// <summary>BitBlt of the visible virtual screen (guest interactive desktop only).</summary>
        public static RgbImage ScreenRgb(Bounds screen)
        {
            byte[] bgra = Draw(screen.Width, screen.Height, delegate(IntPtr dc)
            {
                IntPtr screenDc = Native.GetDC(IntPtr.Zero);
                try
                {
                    if (!Native.BitBlt(dc, 0, 0, screen.Width, screen.Height, screenDc, screen.X, screen.Y, Native.SRCCOPY | Native.CAPTUREBLT))
                        throw new ProtocolException("INTERNAL", Native.Error("BitBlt"));
                }
                finally
                {
                    Native.ReleaseDC(IntPtr.Zero, screenDc);
                }
            });
            return new RgbImage(screen.Width, screen.Height, ToRgb(bgra, screen.Width, screen.Height));
        }

        static byte[] Draw(int width, int height, Action<IntPtr> paint)
        {
            if (width <= 0 || height <= 0 || (long)width * height > MaxPixels)
                throw new ProtocolException("INTERNAL", "capture size " + width + "x" + height + " is out of range");
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            IntPtr memDc = IntPtr.Zero, bitmap = IntPtr.Zero, old = IntPtr.Zero;
            try
            {
                memDc = Native.CreateCompatibleDC(screenDc);
                if (memDc == IntPtr.Zero) throw new ProtocolException("INTERNAL", Native.Error("CreateCompatibleDC"));
                var header = new BITMAPINFOHEADER();
                header.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
                header.biWidth = width;
                header.biHeight = -height; // top-down rows
                header.biPlanes = 1;
                header.biBitCount = 32;
                header.biCompression = Native.BI_RGB;
                IntPtr bits;
                bitmap = Native.CreateDIBSection(memDc, ref header, Native.DIB_RGB_COLORS, out bits, IntPtr.Zero, 0);
                if (bitmap == IntPtr.Zero || bits == IntPtr.Zero) throw new ProtocolException("INTERNAL", Native.Error("CreateDIBSection"));
                old = Native.SelectObject(memDc, bitmap);
                paint(memDc);
                Native.GdiFlush();
                var data = new byte[checked(width * height * 4)];
                Marshal.Copy(bits, data, 0, data.Length);
                return data;
            }
            finally
            {
                if (old != IntPtr.Zero) Native.SelectObject(memDc, old);
                if (bitmap != IntPtr.Zero) Native.DeleteObject(bitmap);
                if (memDc != IntPtr.Zero) Native.DeleteDC(memDc);
                Native.ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        static byte[] ToRgb(byte[] bgra, int width, int height)
        {
            var rgb = new byte[checked(width * height * 3)];
            for (int i = 0, o = 0; o < rgb.Length; i += 4, o += 3)
            {
                rgb[o] = bgra[i + 2];
                rgb[o + 1] = bgra[i + 1];
                rgb[o + 2] = bgra[i];
            }
            return rgb;
        }

        /// <summary>The virtual screen in physical pixels (1280x800 at 0,0 when the session reports none).</summary>
        public static Bounds VirtualScreen()
        {
            int x = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN), y = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int w = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN), h = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            if (w <= 0 || h <= 0) return new Bounds(0, 0, 1280, 800);
            return new Bounds(x, y, w, h);
        }

        /// <summary>
        /// A private desktop is never shown, so there is no framebuffer: the screen is composed
        /// from PrintWindow captures of its windows, bottom of the z-order first, on black.
        /// </summary>
        public static RgbImage Compose(List<IntPtr> zOrderTopFirst, Bounds screen)
        {
            var canvas = new byte[checked(screen.Width * screen.Height * 3)];
            for (int i = zOrderTopFirst.Count - 1; i >= 0; i--)
            {
                IntPtr hwnd = zOrderTopFirst[i];
                if (!WinWindows.Painted(hwnd)) continue;
                Bounds rect = WinWindows.Rect(hwnd);
                Bounds clip = rect == null ? null : rect.Intersect(screen);
                if (clip == null) continue;
                RgbImage image;
                try
                {
                    image = PrintWindowRgb(hwnd, rect.Width, rect.Height);
                }
                catch (ProtocolException)
                {
                    continue; // a window that vanished or refuses PrintWindow leaves the area below it
                }
                for (int row = 0; row < clip.Height; row++)
                {
                    int srcOffset = ((clip.Y - rect.Y + row) * rect.Width + (clip.X - rect.X)) * 3;
                    int dstOffset = ((clip.Y - screen.Y + row) * screen.Width + (clip.X - screen.X)) * 3;
                    Buffer.BlockCopy(image.Rgb, srcOffset, canvas, dstOffset, clip.Width * 3);
                }
            }
            return new RgbImage(screen.Width, screen.Height, canvas);
        }
    }

    /// <summary>Input by window messages (default) or SendInput (guest interactive desktop). Call on a desktop thread.</summary>
    internal static class WinInput
    {
        const uint MessageTimeoutMs = 2000;

        static IntPtr Point(int x, int y)
        {
            if (x < short.MinValue || x > short.MaxValue || y < short.MinValue || y > short.MaxValue)
                throw new ProtocolException("BAD_REQUEST", "point " + x + "," + y + " cannot be expressed in a window message");
            return Native.MakeLParam(x, y);
        }

        /// <summary>SendMessageTimeoutW; false when the window did not answer in time (the message may still be processed).</summary>
        static bool Send(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, out IntPtr result)
        {
            if (!Native.IsWindow(hwnd)) throw new ProtocolException("NOT_FOUND", "the target window is gone");
            return Native.SendMessageTimeoutW(hwnd, msg, wParam, lParam, Native.SMTO_ABORTIFHUNG, MessageTimeoutMs, out result) != IntPtr.Zero;
        }

        static void Post(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam)
        {
            for (int attempt = 0; ; attempt++)
            {
                if (!Native.IsWindow(hwnd)) throw new ProtocolException("NOT_FOUND", "the target window is gone");
                if (Native.PostMessageW(hwnd, msg, wParam, lParam)) return;
                int error = Marshal.GetLastWin32Error();
                if (error != Native.ERROR_NOT_ENOUGH_QUOTA || attempt >= 50) throw new ProtocolException("INTERNAL", "PostMessage failed (" + error + ")");
                Thread.Sleep(20); // the app's message queue is full; let it catch up
            }
        }

        /// <summary>The topmost listed window under a screen point, from a z-order list.</summary>
        public static IntPtr WindowAt(List<IntPtr> zOrderTopFirst, int x, int y)
        {
            foreach (IntPtr hwnd in zOrderTopFirst)
            {
                if (!WinWindows.Painted(hwnd)) continue;
                Bounds r = WinWindows.Rect(hwnd);
                if (r != null && r.Contains(x, y)) return hwnd;
            }
            return IntPtr.Zero;
        }

        /// <summary>Activates a window on the session's desktop (never the user's input desktop).</summary>
        public static void Activate(IntPtr hwnd)
        {
            int pid;
            int target = Native.GetWindowThreadProcessId(hwnd, out pid);
            int self = Native.GetCurrentThreadId();
            bool attached = target != 0 && target != self && Native.AttachThreadInput(self, target, true);
            try
            {
                Native.BringWindowToTop(hwnd);
                Native.SetActiveWindow(hwnd);
                Native.SetFocus(hwnd);
                Native.SetForegroundWindow(hwnd);
            }
            finally
            {
                if (attached) Native.AttachThreadInput(self, target, false);
            }
        }

        /// <summary>Deepest visible, non-transparent child under a client point of top; returns it and the point in its client space.</summary>
        static IntPtr DeepestChild(IntPtr top, ref POINT point)
        {
            IntPtr target = top;
            for (int depth = 0; depth < 64; depth++)
            {
                IntPtr child = Native.ChildWindowFromPointEx(target, point, Native.CWP_SKIPINVISIBLE | Native.CWP_SKIPTRANSPARENT);
                if (child == IntPtr.Zero || child == target) return target;
                POINT mapped = point;
                Native.MapWindowPoints(target, child, ref mapped, 1);
                target = child;
                point = mapped;
            }
            return target;
        }

        static POINT ScreenToClient(IntPtr hwnd, int x, int y)
        {
            var p = new POINT(x, y);
            Native.MapWindowPoints(IntPtr.Zero, hwnd, ref p, 1);
            return p;
        }

        /// <summary>click, double_click, right_click at a screen point by window messages. Returns the top-level window hit.</summary>
        public static IntPtr Pointer(List<IntPtr> zOrder, string action, int x, int y)
        {
            IntPtr top = WindowAt(zOrder, x, y);
            if (top == IntPtr.Zero) throw new ProtocolException("NOT_FOUND", "no window at " + x + "," + y);
            IntPtr screenPoint = Point(x, y);
            IntPtr hitResult;
            if (!Send(top, Native.WM_NCHITTEST, IntPtr.Zero, screenPoint, out hitResult))
                throw new ProtocolException("TIMEOUT", "the window under " + x + "," + y + " did not answer the hit test; the app may be hung");
            int hit = unchecked((int)hitResult.ToInt64());
            Activate(top);
            if (hit == Native.HTCLIENT)
            {
                POINT p = ScreenToClient(top, x, y);
                IntPtr target = DeepestChild(top, ref p);
                IntPtr lp = Point(p.X, p.Y);
                IntPtr ignored;
                Send(target, Native.WM_MOUSEMOVE, IntPtr.Zero, lp, out ignored);
                if (action == "right_click")
                {
                    Send(target, Native.WM_RBUTTONDOWN, new IntPtr(Native.MK_RBUTTON), lp, out ignored);
                    Send(target, Native.WM_RBUTTONUP, IntPtr.Zero, lp, out ignored);
                    return top;
                }
                Send(target, Native.WM_LBUTTONDOWN, new IntPtr(Native.MK_LBUTTON), lp, out ignored);
                Thread.Sleep(20);
                // A button that opens a modal dialog does not return from WM_LBUTTONUP: a timeout means delivered.
                Send(target, Native.WM_LBUTTONUP, IntPtr.Zero, lp, out ignored);
                if (action == "double_click")
                {
                    Send(target, Native.WM_LBUTTONDBLCLK, new IntPtr(Native.MK_LBUTTON), lp, out ignored);
                    Send(target, Native.WM_LBUTTONUP, IntPtr.Zero, lp, out ignored);
                }
                return top;
            }
            // Non-client hits are posted so title-bar and menu modal loops cannot block the helper.
            if (action == "click" && hit == Native.HTCLOSE) Post(top, Native.WM_SYSCOMMAND, new IntPtr(Native.SC_CLOSE), screenPoint);
            else if (action == "click" && hit == Native.HTMINBUTTON) Post(top, Native.WM_SYSCOMMAND, new IntPtr(Native.SC_MINIMIZE), screenPoint);
            else if (action == "click" && hit == Native.HTMAXBUTTON)
                Post(top, Native.WM_SYSCOMMAND, new IntPtr(Native.IsZoomed(top) ? Native.SC_RESTORE : Native.SC_MAXIMIZE), screenPoint);
            else if (action == "right_click")
            {
                Post(top, Native.WM_NCRBUTTONDOWN, new IntPtr(hit), screenPoint);
                Post(top, Native.WM_NCRBUTTONUP, new IntPtr(hit), screenPoint);
            }
            else
            {
                Post(top, Native.WM_NCLBUTTONDOWN, new IntPtr(hit), screenPoint);
                Post(top, Native.WM_NCLBUTTONUP, new IntPtr(hit), screenPoint);
                if (action == "double_click") Post(top, Native.WM_NCLBUTTONDBLCLK, new IntPtr(hit), screenPoint);
            }
            return top;
        }

        public static void Scroll(List<IntPtr> zOrder, int x, int y, string direction, int amount)
        {
            IntPtr top = WindowAt(zOrder, x, y);
            if (top == IntPtr.Zero) throw new ProtocolException("NOT_FOUND", "no window at " + x + "," + y);
            POINT p = ScreenToClient(top, x, y);
            IntPtr target = DeepestChild(top, ref p);
            bool horizontal = direction == "left" || direction == "right";
            int delta = (direction == "up" || direction == "right") ? 120 : -120;
            for (int i = 0; i < amount; i++)
                Post(target, horizontal ? Native.WM_MOUSEHWHEEL : Native.WM_MOUSEWHEEL, Native.MakeWParam(0, delta), Point(x, y));
        }

        /// <summary>The focused control of a window's GUI thread when it belongs to that window, else the window.</summary>
        public static IntPtr FocusTarget(IntPtr top)
        {
            int pid;
            int thread = Native.GetWindowThreadProcessId(top, out pid);
            var info = new GUITHREADINFO();
            info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
            if (thread != 0 && Native.GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero &&
                Native.GetAncestor(info.hwndFocus, Native.GA_ROOT) == top)
                return info.hwndFocus;
            return top;
        }

        static bool IsExtended(int vk)
        {
            switch (vk)
            {
                case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27: case 0x28:
                case 0x2D: case 0x2E: case 0x5B: case 0x5C: case 0x5D: case 0x6F: case 0x90:
                    return true;
                default:
                    return false;
            }
        }

        static IntPtr KeyLParam(int vk, bool up)
        {
            uint scan = Native.MapVirtualKeyW((uint)vk, 0);
            uint lp = 1u | (scan << 16);
            if (IsExtended(vk)) lp |= 1u << 24;
            if (up) lp |= (1u << 30) | (1u << 31);
            return new IntPtr(unchecked((int)lp));
        }

        /// <summary>Resolves a chord's character to a virtual key plus the modifiers it needs.</summary>
        static bool Resolve(KeyChord chord, out int vk, out List<int> modifiers)
        {
            modifiers = new List<int>(chord.Modifiers);
            vk = chord.Vk;
            if (vk != 0) return true;
            short scan = Native.VkKeyScanW(chord.Char);
            if (scan == -1) return false;
            vk = scan & 0xFF;
            int shift = (scan >> 8) & 0xFF;
            if ((shift & 1) != 0 && !modifiers.Contains(0x10)) modifiers.Add(0x10);
            if ((shift & 2) != 0 && !modifiers.Contains(0x11)) modifiers.Add(0x11);
            if ((shift & 4) != 0 && !modifiers.Contains(0x12)) modifiers.Add(0x12);
            return true;
        }

        /// <summary>
        /// Posts key chords. Posted messages do not change the target's keyboard state, so for
        /// chords with modifiers the helper attaches to the target thread's input and sets the
        /// modifier state around the chord (best effort; apps that poll GetAsyncKeyState or use
        /// raw input may not see modifiers).
        /// </summary>
        public static void Keys(IntPtr top, IList<KeyChord> chords)
        {
            IntPtr target = FocusTarget(top);
            int pid;
            int targetThread = Native.GetWindowThreadProcessId(target, out pid);
            int self = Native.GetCurrentThreadId();
            foreach (KeyChord chord in chords)
            {
                int vk;
                List<int> modifiers;
                if (!Resolve(chord, out vk, out modifiers))
                {
                    if (chord.Modifiers.Count > 0) throw new ProtocolException("BAD_REQUEST", "'" + chord.Text + "' has no key on this keyboard layout");
                    Post(target, Native.WM_CHAR, new IntPtr(chord.Char), new IntPtr(1));
                    continue;
                }
                bool alt = modifiers.Contains(0x12);
                bool attached = false;
                byte[] saved = null;
                if (modifiers.Count > 0 && targetThread != 0 && targetThread != self && Native.AttachThreadInput(self, targetThread, true))
                {
                    attached = true;
                    saved = new byte[256];
                    Native.GetKeyboardState(saved);
                    var state = (byte[])saved.Clone();
                    foreach (int m in modifiers) state[m] |= 0x80;
                    Native.SetKeyboardState(state);
                }
                try
                {
                    foreach (int m in modifiers) Post(target, alt ? Native.WM_SYSKEYDOWN : Native.WM_KEYDOWN, new IntPtr(m), KeyLParam(m, false));
                    Post(target, alt ? Native.WM_SYSKEYDOWN : Native.WM_KEYDOWN, new IntPtr(vk), KeyLParam(vk, false));
                    Post(target, alt ? Native.WM_SYSKEYUP : Native.WM_KEYUP, new IntPtr(vk), KeyLParam(vk, true));
                    for (int i = modifiers.Count - 1; i >= 0; i--) Post(target, alt ? Native.WM_SYSKEYUP : Native.WM_KEYUP, new IntPtr(modifiers[i]), KeyLParam(modifiers[i], true));
                    if (attached) Thread.Sleep(50); // let the target read the chord while the state is set
                }
                finally
                {
                    if (attached)
                    {
                        Native.SetKeyboardState(saved);
                        Native.AttachThreadInput(self, targetThread, false);
                    }
                }
            }
        }

        /// <summary>Posts text as WM_CHAR (line breaks as Return), throttled so the target's queue never overflows.</summary>
        public static void Type(IntPtr top, string text)
        {
            IntPtr target = FocusTarget(top);
            int count = 0;
            foreach (char c in text)
            {
                if (c == '\r') continue;
                if (c == '\n')
                {
                    Post(target, Native.WM_KEYDOWN, new IntPtr(0x0D), KeyLParam(0x0D, false));
                    Post(target, Native.WM_KEYUP, new IntPtr(0x0D), KeyLParam(0x0D, true));
                }
                else
                {
                    Post(target, Native.WM_CHAR, new IntPtr(c), new IntPtr(1));
                }
                if (++count % 200 == 0) Thread.Sleep(20);
            }
        }

        // ----- SendInput (guest interactive desktop only) -----

        static void SendInputs(List<INPUT> inputs)
        {
            if (inputs.Count == 0) return;
            INPUT[] array = inputs.ToArray();
            if (Native.SendInput(array.Length, array, Marshal.SizeOf(typeof(INPUT))) != array.Length)
                throw new ProtocolException("INTERNAL", Native.Error("SendInput"));
        }

        static INPUT Mouse(int flags, int dx, int dy, int data)
        {
            var i = new INPUT();
            i.type = Native.INPUT_MOUSE;
            i.u.mi.dx = dx;
            i.u.mi.dy = dy;
            i.u.mi.mouseData = data;
            i.u.mi.dwFlags = flags;
            return i;
        }

        static INPUT Key(int vk, char unicode, bool up)
        {
            var i = new INPUT();
            i.type = Native.INPUT_KEYBOARD;
            i.u.ki.wVk = (short)vk;
            i.u.ki.wScan = unicode != '\0' ? (short)unicode : (short)Native.MapVirtualKeyW((uint)vk, 0);
            i.u.ki.dwFlags = (unicode != '\0' ? Native.KEYEVENTF_UNICODE : 0) | (up ? Native.KEYEVENTF_KEYUP : 0) |
                (unicode == '\0' && IsExtended(vk) ? Native.KEYEVENTF_EXTENDEDKEY : 0);
            return i;
        }

        static INPUT MoveTo(int x, int y)
        {
            Bounds screen = WinCapture.VirtualScreen();
            int nx = (int)(((long)(x - screen.X) * 65535 + (screen.Width - 1) / 2) / Math.Max(1, screen.Width - 1));
            int ny = (int)(((long)(y - screen.Y) * 65535 + (screen.Height - 1) / 2) / Math.Max(1, screen.Height - 1));
            return Mouse(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK, nx, ny, 0);
        }

        public static IntPtr PointerSendInput(List<IntPtr> zOrder, string action, int x, int y)
        {
            IntPtr top = WindowAt(zOrder, x, y);
            if (top == IntPtr.Zero) throw new ProtocolException("NOT_FOUND", "no window at " + x + "," + y);
            Native.SetForegroundWindow(top);
            var inputs = new List<INPUT>();
            inputs.Add(MoveTo(x, y));
            int clicks = action == "double_click" ? 2 : 1;
            for (int i = 0; i < clicks; i++)
            {
                inputs.Add(Mouse(action == "right_click" ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0));
                inputs.Add(Mouse(action == "right_click" ? Native.MOUSEEVENTF_RIGHTUP : Native.MOUSEEVENTF_LEFTUP, 0, 0, 0));
            }
            SendInputs(inputs);
            return top;
        }

        public static void ScrollSendInput(int x, int y, string direction, int amount)
        {
            var inputs = new List<INPUT>();
            inputs.Add(MoveTo(x, y));
            bool horizontal = direction == "left" || direction == "right";
            int delta = (direction == "up" || direction == "right") ? 120 : -120;
            for (int i = 0; i < amount; i++) inputs.Add(Mouse(horizontal ? Native.MOUSEEVENTF_HWHEEL : Native.MOUSEEVENTF_WHEEL, 0, 0, delta));
            SendInputs(inputs);
        }

        public static void KeysSendInput(IntPtr top, IList<KeyChord> chords)
        {
            Native.SetForegroundWindow(top);
            foreach (KeyChord chord in chords)
            {
                int vk;
                List<int> modifiers;
                var inputs = new List<INPUT>();
                if (!Resolve(chord, out vk, out modifiers))
                {
                    inputs.Add(Key(0, chord.Char, false));
                    inputs.Add(Key(0, chord.Char, true));
                }
                else
                {
                    foreach (int m in modifiers) inputs.Add(Key(m, '\0', false));
                    inputs.Add(Key(vk, '\0', false));
                    inputs.Add(Key(vk, '\0', true));
                    for (int i = modifiers.Count - 1; i >= 0; i--) inputs.Add(Key(modifiers[i], '\0', true));
                }
                SendInputs(inputs);
            }
        }

        public static void TypeSendInput(IntPtr top, string text)
        {
            Native.SetForegroundWindow(top);
            var inputs = new List<INPUT>();
            foreach (char c in text)
            {
                if (c == '\r') continue;
                if (c == '\n')
                {
                    inputs.Add(Key(0x0D, '\0', false));
                    inputs.Add(Key(0x0D, '\0', true));
                }
                else
                {
                    inputs.Add(Key(0, c, false));
                    inputs.Add(Key(0, c, true));
                }
                if (inputs.Count >= 400)
                {
                    SendInputs(inputs);
                    inputs.Clear();
                    Thread.Sleep(10);
                }
            }
            SendInputs(inputs);
        }
    }
}
