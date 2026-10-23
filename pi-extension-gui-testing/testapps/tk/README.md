# Tkinter sample app

Tkinter app with the label "Waiting" and a "Press me" button; clicking sets the label to "Pressed". Window title "Pi GUI Tk", placed at 40,40 with size 320×160. Tk has no accessibility tree here, so the expected snapshot coverage is `none` and the app is operated by screenshot coordinates.

Configuration (`.pi/gui.json`): no `setup`; launch `python3 app.py` (`python3-tk` comes from the base image).
