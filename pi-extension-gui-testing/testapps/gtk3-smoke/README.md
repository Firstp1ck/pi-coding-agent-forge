# GTK 3 smoke app

Baked into the base image at `/opt/pi-gui-testing/testapps/gtk3-smoke/` and used by the setup smoke test. It shows the label "Waiting" and a "Press me" button; clicking sets the label to "Pressed". Window title: "Pi GUI smoke".

Launch: `{"cmd": "python3", "args": ["/opt/pi-gui-testing/testapps/gtk3-smoke/app.py"]}` (no `setup`).
