#!/usr/bin/env python3
"""e2e fixture: one GTK 3 window that reacts to every gui_act action.

- Entry "Name": type / key / set_value; Return sets the status to "Hello <text>".
- Label "Click target": a double click sets "double", a right click sets "right".
- A scrolled list of 60 rows: scrolling sets "scrolled".
The status label starts as "Ready". Window title "Pi GUI fields".
"""
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk  # noqa: E402


def main():
    window = Gtk.Window(title="Pi GUI fields")
    window.set_default_size(420, 360)
    window.connect("destroy", Gtk.main_quit)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin=12)

    status = Gtk.Label(label="Ready")
    entry = Gtk.Entry()
    entry.get_accessible().set_name("Name")
    entry.connect("activate", lambda e: status.set_text("Hello %s" % e.get_text()))

    target = Gtk.EventBox()
    target_label = Gtk.Label(label="Click target")
    target.add(target_label)

    def on_press(_widget, event):
        if event.type == Gdk.EventType._2BUTTON_PRESS:
            status.set_text("double")
        elif event.button == 3:
            status.set_text("right")
        return False

    target.connect("button-press-event", on_press)

    rows = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    for i in range(60):
        rows.pack_start(Gtk.Label(label="Row %d" % i), False, False, 2)
    scroller = Gtk.ScrolledWindow()
    scroller.set_min_content_height(120)
    scroller.add(rows)
    scroller.get_vadjustment().connect("value-changed", lambda _a: status.set_text("scrolled"))

    for widget in (status, entry, target, scroller):
        box.pack_start(widget, widget is scroller, widget is scroller, 0)
    window.add(box)
    window.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
