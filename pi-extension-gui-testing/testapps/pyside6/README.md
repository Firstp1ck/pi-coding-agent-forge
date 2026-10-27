# PySide6 sample app

Qt 6 (PySide6) app with the label "Waiting" and a "Press me" button; clicking sets the label to "Pressed". Window title "Pi GUI PySide6". Expected snapshot coverage: `full` (the session sets the Qt accessibility variables).

Configuration (`.pi/gui.json`): `setup` runs `python3 -m pip install --no-cache-dir -r requirements.txt`, which installs into `/deps/venv` inside the session (network needed); launch `python3 app.py`.
