// UI Automation snapshots and element actions (spec sections 4.5, 4.6), using
// the managed client (System.Windows.Automation, UIAutomationClient). Every
// call must run on a desktop thread (WinDesktop.Run): UI Automation reaches
// windows through messages, which do not cross desktops.
//
// The walk follows the control view breadth first with one CacheRequest, so
// each element costs one cross-process round trip, and stops at the node cap.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Windows.Automation;

namespace PiGuiHelper.Win
{
    internal static class WinUia
    {
        const int MaxTextChars = 65536;
        const int MaxChildrenPerNode = 2000;

        static CacheRequest BuildCacheRequest()
        {
            var request = new CacheRequest();
            request.TreeFilter = Automation.ControlViewCondition;
            request.TreeScope = TreeScope.Element;
            request.AutomationElementMode = AutomationElementMode.Full;
            request.Add(AutomationElement.NameProperty);
            request.Add(AutomationElement.ControlTypeProperty);
            request.Add(AutomationElement.BoundingRectangleProperty);
            request.Add(AutomationElement.IsEnabledProperty);
            request.Add(AutomationElement.IsOffscreenProperty);
            request.Add(AutomationElement.HasKeyboardFocusProperty);
            request.Add(AutomationElement.IsKeyboardFocusableProperty);
            request.Add(ValuePattern.ValueProperty);
            request.Add(ValuePattern.IsReadOnlyProperty);
            request.Add(RangeValuePattern.ValueProperty);
            request.Add(TogglePattern.ToggleStateProperty);
            request.Add(SelectionItemPattern.IsSelectedProperty);
            request.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
            return request;
        }

        static object Cached(AutomationElement e, AutomationProperty property)
        {
            try
            {
                object v = e.GetCachedPropertyValue(property, true);
                return v == AutomationElement.NotSupported ? null : v;
            }
            catch (InvalidOperationException) { return null; }
            catch (ElementNotAvailableException) { return null; }
        }

        static string Clip(string s)
        {
            if (s == null) return null;
            return s.Length > MaxTextChars ? s.Substring(0, MaxTextChars) : s;
        }

        public static Bounds ToBounds(System.Windows.Rect r)
        {
            if (r.IsEmpty || double.IsInfinity(r.X) || double.IsInfinity(r.Y) || double.IsNaN(r.Width) || double.IsNaN(r.Height)) return null;
            const double Limit = 2147483647.0;
            if (Math.Abs(r.X) > Limit || Math.Abs(r.Y) > Limit || r.Width > Limit || r.Height > Limit || r.Width < 0 || r.Height < 0) return null;
            return new Bounds((int)Math.Round(r.X), (int)Math.Round(r.Y), (int)Math.Round(r.Width), (int)Math.Round(r.Height));
        }

        static ElementNode Describe(AutomationElement e)
        {
            var node = new ElementNode();
            var type = Cached(e, AutomationElement.ControlTypeProperty) as ControlType;
            node.Role = Roles.FromControlType(type != null ? type.ProgrammaticName : null);
            node.Name = Clip(Cached(e, AutomationElement.NameProperty) as string) ?? "";
            object value = Cached(e, ValuePattern.ValueProperty);
            if (value is string) node.Value = Clip((string)value);
            else
            {
                object range = Cached(e, RangeValuePattern.ValueProperty);
                if (range is double) node.Value = ((double)range).ToString("R", CultureInfo.InvariantCulture);
            }
            object rect = Cached(e, AutomationElement.BoundingRectangleProperty);
            if (rect is System.Windows.Rect) node.Bounds = ToBounds((System.Windows.Rect)rect);
            if (Cached(e, AutomationElement.IsEnabledProperty) as bool? == true)
            {
                node.States.Add("enabled");
                node.States.Add("sensitive");
            }
            if (Cached(e, AutomationElement.IsOffscreenProperty) as bool? == false)
            {
                node.States.Add("showing");
                node.States.Add("visible");
            }
            if (Cached(e, AutomationElement.IsKeyboardFocusableProperty) as bool? == true) node.States.Add("focusable");
            if (Cached(e, AutomationElement.HasKeyboardFocusProperty) as bool? == true) node.States.Add("focused");
            object toggle = Cached(e, TogglePattern.ToggleStateProperty);
            if (toggle is ToggleState)
            {
                node.States.Add("checkable");
                if ((ToggleState)toggle == ToggleState.On) node.States.Add("checked");
                if ((ToggleState)toggle == ToggleState.Indeterminate) node.States.Add("indeterminate");
            }
            if (Cached(e, SelectionItemPattern.IsSelectedProperty) as bool? == true) node.States.Add("selected");
            object expand = Cached(e, ExpandCollapsePattern.ExpandCollapseStateProperty);
            if (expand is ExpandCollapseState)
            {
                var s = (ExpandCollapseState)expand;
                if (s == ExpandCollapseState.Expanded) node.States.Add("expanded");
                else if (s == ExpandCollapseState.Collapsed || s == ExpandCollapseState.PartiallyExpanded) node.States.Add("collapsed");
            }
            if (Cached(e, ValuePattern.IsReadOnlyProperty) as bool? == false) node.States.Add("editable");
            node.Handle = e;
            return node;
        }

        /// <summary>
        /// Breadth-first control-view walk of the given top-level windows. Stops at the first node
        /// the budget refuses (node count or bytes), so the result always fits the client's limits.
        /// </summary>
        public static WalkResult Walk(IList<IntPtr> windows, TreeBudget budget, RequestContext ctx)
        {
            var nodes = new List<ElementNode>();
            CacheRequest request = BuildCacheRequest();
            TreeWalker walker = TreeWalker.ControlViewWalker;
            var queue = new Queue<KeyValuePair<AutomationElement, int>>();
            using (request.Activate())
            {
                for (int w = 0; w < windows.Count && !budget.Exhausted; w++)
                {
                    AutomationElement root;
                    try
                    {
                        root = AutomationElement.FromHandle(windows[w]);
                    }
                    catch (ElementNotAvailableException) { continue; }
                    catch (ArgumentException) { continue; }
                    ElementNode rootNode = Describe(root);
                    rootNode.Window = w;
                    if (!budget.Admit(rootNode)) break;
                    nodes.Add(rootNode);
                    queue.Enqueue(new KeyValuePair<AutomationElement, int>(root, nodes.Count - 1));
                    while (queue.Count > 0 && !budget.Exhausted)
                    {
                        if (ctx != null && nodes.Count % 50 == 0) ctx.Check();
                        var item = queue.Dequeue();
                        AutomationElement child;
                        try
                        {
                            child = walker.GetFirstChild(item.Key, request);
                        }
                        catch (ElementNotAvailableException) { continue; }
                        int siblings = 0;
                        while (child != null && siblings < MaxChildrenPerNode)
                        {
                            ElementNode node = Describe(child);
                            node.Parent = item.Value;
                            node.Window = w;
                            if (!budget.Admit(node)) break;
                            nodes.Add(node);
                            queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, nodes.Count - 1));
                            siblings++;
                            try
                            {
                                child = walker.GetNextSibling(child, request);
                            }
                            catch (ElementNotAvailableException) { child = null; }
                        }
                    }
                    queue.Clear();
                }
            }
            return new WalkResult(nodes, windows.Count, budget.Exhausted);
        }

        /// <summary>True when any accessible name or value contains text (case-sensitive, as on Linux).</summary>
        public static bool FindText(IList<IntPtr> windows, string text, RequestContext ctx)
        {
            WalkResult walk = Walk(windows, new TreeBudget(5000, Handlers.MaxTreeJsonBytes), ctx);
            foreach (ElementNode n in walk.Nodes)
            {
                if ((n.Name != null && n.Name.IndexOf(text, StringComparison.Ordinal) >= 0) ||
                    (n.Value != null && n.Value.IndexOf(text, StringComparison.Ordinal) >= 0)) return true;
            }
            return false;
        }

        public static bool Alive(AutomationElement e)
        {
            try
            {
                int unused = e.Current.ProcessId;
                return unused >= 0;
            }
            catch (ElementNotAvailableException) { return false; }
            catch (InvalidOperationException) { return false; }
        }

        public static Bounds LiveBounds(AutomationElement e)
        {
            try { return ToBounds(e.Current.BoundingRectangle); }
            catch (ElementNotAvailableException) { return null; }
        }

        public static bool Showing(AutomationElement e)
        {
            try { return !e.Current.IsOffscreen; }
            catch (ElementNotAvailableException) { return false; }
        }

        /// <summary>Invoke, Toggle, SelectionItem, ExpandCollapse in that order; false when none is supported.</summary>
        public static bool DefaultAction(AutomationElement e)
        {
            object pattern;
            if (e.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return true; }
            if (e.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); return true; }
            if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { ((SelectionItemPattern)pattern).Select(); return true; }
            if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
            {
                var ec = (ExpandCollapsePattern)pattern;
                if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) ec.Collapse();
                else ec.Expand();
                return true;
            }
            return false;
        }

        public static void SetValue(AutomationElement e, string text)
        {
            object pattern;
            if (e.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            {
                var vp = (ValuePattern)pattern;
                if (vp.Current.IsReadOnly) throw new ProtocolException("BAD_REQUEST", "the element's value is read-only");
                vp.SetValue(text);
                return;
            }
            if (e.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern))
            {
                double number;
                if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out number))
                    throw new ProtocolException("BAD_REQUEST", "set_value on a range element needs a number");
                var rv = (RangeValuePattern)pattern;
                if (rv.Current.IsReadOnly) throw new ProtocolException("BAD_REQUEST", "the element's value is read-only");
                rv.SetValue(number);
                return;
            }
            throw new ProtocolException("BAD_REQUEST", "set_value needs an element with the Value or RangeValue pattern");
        }

        public static bool Focus(AutomationElement e)
        {
            try
            {
                e.SetFocus();
                return true;
            }
            catch (InvalidOperationException) { return false; }
            catch (ElementNotAvailableException) { return false; }
        }

        /// <summary>Top-level window that holds the element (nearest ancestor with a window handle), or zero.</summary>
        public static IntPtr TopWindow(AutomationElement e)
        {
            TreeWalker walker = TreeWalker.RawViewWalker;
            AutomationElement current = e;
            for (int depth = 0; current != null && depth < 128; depth++)
            {
                int hwnd;
                try { hwnd = current.Current.NativeWindowHandle; }
                catch (ElementNotAvailableException) { return IntPtr.Zero; }
                if (hwnd != 0) return Native.GetAncestor(new IntPtr(hwnd), Native.GA_ROOT);
                try { current = walker.GetParent(current); }
                catch (ElementNotAvailableException) { return IntPtr.Zero; }
                if (current == AutomationElement.RootElement) return IntPtr.Zero;
            }
            return IntPtr.Zero;
        }
    }
}
