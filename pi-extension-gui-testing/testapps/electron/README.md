# Electron sample app

Electron app with the text "Waiting" and a "Press me" button; clicking sets the text to "Pressed". Window title "Pi GUI Electron". Expected snapshot coverage: `full` (the helper appends `--force-renderer-accessibility`).

Configuration (`.pi/gui.json`): `workspaceMode: "copy"` because `npm install` writes `node_modules`; `setup` runs `npm install --no-audit --no-fund` (network needed); launch `./node_modules/.bin/electron . --no-sandbox`. The session needs `--shm-size=512m`, which the docker-linux backend adds for Electron apps. `--no-sandbox` applies only inside the unprivileged container.
