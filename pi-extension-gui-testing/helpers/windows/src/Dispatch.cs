// Request envelope, sequential queue, cancellation, and heartbeat watchdog
// (docs/protocol.md "Requests and responses", "Ordering"). Mirrors
// helpers/linux/pi_gui_helper/dispatch.py. Pure managed code.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;

namespace PiGuiHelper
{
    /// <summary>A failure reported to the client as error {code, message}.</summary>
    public class ProtocolException : Exception
    {
        public ProtocolException(string code, string message) : base(message)
        {
            if (Array.IndexOf(Protocol.ErrorCodes, code) < 0) throw new ArgumentException("unknown error code " + code);
            Code = code;
        }

        public string Code { get; private set; }
    }

    public sealed class CancelledException : ProtocolException
    {
        public CancelledException() : base("CANCELLED", "request cancelled") { }
    }

    /// <summary>
    /// Per-request state handed to a handler. Handlers call Check() between
    /// steps and Sleep() instead of Thread.Sleep so cancel interrupts them.
    /// After runs once the response has been written (stop, mismatched hello).
    /// </summary>
    public sealed class RequestContext
    {
        readonly ManualResetEvent _cancelled = new ManualResetEvent(false);

        public RequestContext(long id, string method)
        {
            Id = id;
            Method = method;
        }

        public long Id { get; private set; }
        public string Method { get; private set; }
        public Action After { get; set; }

        public bool Cancelled { get { return _cancelled.WaitOne(0); } }

        /// <summary>Signalled on cancel; for waits that need several handles.</summary>
        public WaitHandle CancelHandle { get { return _cancelled; } }

        public void Cancel() { _cancelled.Set(); }

        public void Check()
        {
            if (Cancelled) throw new CancelledException();
        }

        public void Sleep(int milliseconds)
        {
            if (_cancelled.WaitOne(Math.Max(0, milliseconds))) throw new CancelledException();
        }
    }

    public delegate object Handler(RequestContext ctx, Dictionary<string, object> parameters);

    /// <summary>
    /// Routes decoded requests to handlers: one at a time in arrival order, except
    /// ping and cancel, which run on the reader thread at once.
    /// </summary>
    public sealed class Dispatcher
    {
        static readonly string[] Bypass = new string[] { "ping", "cancel" };

        readonly ProtocolWriter _writer;
        readonly Dictionary<string, Handler> _handlers;
        readonly LinkedList<KeyValuePair<RequestContext, Dictionary<string, object>>> _queue =
            new LinkedList<KeyValuePair<RequestContext, Dictionary<string, object>>>();
        readonly object _lock = new object();
        readonly Thread _thread;
        RequestContext _current;
        bool _closed;

        public Dispatcher(ProtocolWriter writer, Dictionary<string, Handler> handlers)
        {
            _writer = writer;
            _handlers = new Dictionary<string, Handler>(handlers, StringComparer.Ordinal);
            _thread = new Thread(Run);
            _thread.IsBackground = true;
            _thread.Name = "queue";
            _thread.Start();
        }

        /// <summary>Accepts one decoded request object from the reader thread.</summary>
        public void Submit(Dictionary<string, object> message)
        {
            object rawId;
            message.TryGetValue("id", out rawId);
            if (!(rawId is long))
            {
                object m;
                message.TryGetValue("method", out m);
                Diag.Write("dropping request without integer id: " + (m as string ?? "?"));
                return;
            }
            long id = (long)rawId;
            object rawMethod;
            message.TryGetValue("method", out rawMethod);
            object rawParams;
            if (!message.TryGetValue("params", out rawParams) || rawParams == null) rawParams = new Dictionary<string, object>();
            string method = rawMethod as string;
            var parameters = rawParams as Dictionary<string, object>;
            if (method == null || parameters == null)
            {
                _writer.RespondError(id, "BAD_REQUEST", "request needs a string method and object params");
                return;
            }
            if (method != "cancel" && !_handlers.ContainsKey(method))
            {
                _writer.RespondError(id, "BAD_REQUEST", "unknown method '" + method + "'");
                return;
            }
            var ctx = new RequestContext(id, method);
            if (Array.IndexOf(Bypass, method) >= 0)
            {
                Execute(ctx, parameters);
                return;
            }
            lock (_lock)
            {
                if (_closed)
                {
                    _writer.RespondError(id, "CANCELLED", "helper is shutting down");
                    return;
                }
                _queue.AddLast(new KeyValuePair<RequestContext, Dictionary<string, object>>(ctx, parameters));
                Monitor.PulseAll(_lock);
            }
        }

        object CancelRequest(RequestContext ctx, Dictionary<string, object> parameters)
        {
            object raw;
            parameters.TryGetValue("targetId", out raw);
            if (!(raw is long)) throw new ProtocolException("BAD_REQUEST", "cancel needs an integer targetId");
            long target = (long)raw;
            bool removed = false;
            lock (_lock)
            {
                var node = _queue.First;
                while (node != null)
                {
                    if (node.Value.Key.Id == target)
                    {
                        _queue.Remove(node);
                        removed = true;
                        break;
                    }
                    node = node.Next;
                }
                if (!removed && _current != null && _current.Id == target) _current.Cancel();
            }
            if (removed) _writer.RespondError(target, "CANCELLED", "request cancelled before it started");
            // Unknown or finished targets also answer ok: a late cancel cannot be told from an early one.
            return Results.Ok();
        }

        void Execute(RequestContext ctx, Dictionary<string, object> parameters)
        {
            Handler handler = ctx.Method == "cancel" ? new Handler(CancelRequest) : _handlers[ctx.Method];
            try
            {
                object result = handler(ctx, parameters);
                if (ctx.Cancelled) _writer.RespondError(ctx.Id, "CANCELLED", "request cancelled");
                else _writer.RespondOk(ctx.Id, result);
            }
            catch (ProtocolException e)
            {
                _writer.RespondError(ctx.Id, e.Code, e.Message);
            }
            catch (ThreadAbortException)
            {
                throw;
            }
            catch (Exception e)
            {
                Diag.Write("internal error in " + ctx.Method + ": " + e);
                _writer.RespondError(ctx.Id, "INTERNAL", e.GetType().Name + ": " + e.Message);
            }
            Action after = ctx.After;
            if (after != null) after();
        }

        void Run()
        {
            var pending = new List<RequestContext>();
            while (true)
            {
                KeyValuePair<RequestContext, Dictionary<string, object>> item;
                lock (_lock)
                {
                    while (_queue.Count == 0 && !_closed) Monitor.Wait(_lock);
                    if (_closed)
                    {
                        foreach (var queued in _queue) pending.Add(queued.Key);
                        _queue.Clear();
                        break;
                    }
                    item = _queue.First.Value;
                    _queue.RemoveFirst();
                    _current = item.Key;
                }
                try
                {
                    Execute(item.Key, item.Value);
                }
                finally
                {
                    lock (_lock) { _current = null; }
                }
            }
            foreach (var ctx in pending) _writer.RespondError(ctx.Id, "CANCELLED", "helper is shutting down");
        }

        /// <summary>Stops accepting work, cancels the running request, and flushes the queue with CANCELLED.</summary>
        public void Close()
        {
            lock (_lock)
            {
                _closed = true;
                if (_current != null) _current.Cancel();
                Monitor.PulseAll(_lock);
            }
        }

        public bool Idle
        {
            get { lock (_lock) { return _current == null && _queue.Count == 0; } }
        }
    }

    /// <summary>Fires onTimeout once when no client message arrived for timeoutMs.</summary>
    public sealed class Watchdog
    {
        readonly int _timeoutMs;
        readonly Action _onTimeout;
        readonly Stopwatch _clock = Stopwatch.StartNew();
        readonly ManualResetEvent _stop = new ManualResetEvent(false);
        long _lastMs;

        public Watchdog(int timeoutMs, Action onTimeout)
        {
            _timeoutMs = timeoutMs;
            _onTimeout = onTimeout;
        }

        public void Start()
        {
            var thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Name = "heartbeat";
            thread.Start();
        }

        public void Touch() { Interlocked.Exchange(ref _lastMs, _clock.ElapsedMilliseconds); }

        public bool Expired { get { return _clock.ElapsedMilliseconds - Interlocked.Read(ref _lastMs) >= _timeoutMs; } }

        public void Stop() { _stop.Set(); }

        void Run()
        {
            int interval = Math.Min(1000, Math.Max(50, _timeoutMs / 10));
            while (!_stop.WaitOne(interval))
            {
                if (Expired)
                {
                    _onTimeout();
                    return;
                }
            }
        }
    }

    /// <summary>Small result builders.</summary>
    public static class Results
    {
        public static Dictionary<string, object> Ok()
        {
            var r = new Dictionary<string, object>();
            r["ok"] = true;
            return r;
        }
    }
}
