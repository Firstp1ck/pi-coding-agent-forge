#!/usr/bin/env python3
"""GTK 4 sample app: label "Waiting", button "Press me" → label "Pressed"."""
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gio, Gtk  # noqa: E402


def on_activate(app):
    window = Gtk.ApplicationWindow(application=app, title="Pi GUI GTK 4")
    window.set_default_size(320, 160)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
    for side in ("top", "bottom", "start", "end"):
        getattr(box, "set_margin_" + side)(24)
    label = Gtk.Label(label="Waiting")
    button = Gtk.Button(label="Press me")
    button.connect("clicked", lambda _b: label.set_text("Pressed"))
    box.append(label)
    box.append(button)
    window.set_child(box)
    window.present()


def main():
    # NON_UNIQUE: a second launch must not hand off to a running instance.
    app = Gtk.Application(application_id="dev.firstpick.PiGuiGtk4", flags=Gio.ApplicationFlags.NON_UNIQUE)
    app.connect("activate", on_activate)
    return app.run(sys.argv)


if __name__ == "__main__":
    sys.exit(main())
