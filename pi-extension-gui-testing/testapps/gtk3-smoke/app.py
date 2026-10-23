#!/usr/bin/env python3
"""GTK 3 smoke-test app (spec §5.5): label "Waiting", button "Press me".

Clicking the button sets the label to "Pressed". Window title "Pi GUI smoke".
"""
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402


def main():
    window = Gtk.Window(title="Pi GUI smoke")
    window.set_default_size(320, 160)
    window.connect("destroy", Gtk.main_quit)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, margin=24)
    label = Gtk.Label(label="Waiting")
    button = Gtk.Button(label="Press me")
    button.connect("clicked", lambda _b: label.set_text("Pressed"))
    box.pack_start(label, True, True, 0)
    box.pack_start(button, False, False, 0)
    window.add(box)
    window.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
