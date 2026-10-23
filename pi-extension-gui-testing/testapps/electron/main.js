// Electron sample app: label "Waiting", button "Press me" → label "Pressed".
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 360, height: 220, title: "Pi GUI Electron" });
  win.loadFile(path.join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
