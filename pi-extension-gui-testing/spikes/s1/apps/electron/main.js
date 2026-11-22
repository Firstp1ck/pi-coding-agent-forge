// S1 sample app (Electron): a label over a large "Press me" button. The click
// sets the label to "Pressed" and writes the S1_MARKER file when that variable
// is set. The page is local; no network access, no Node integration in it.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

ipcMain.on("pressed", () => {
  if (process.env.S1_MARKER) fs.writeFileSync(process.env.S1_MARKER, "pressed\n");
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    x: 80,
    y: 80,
    width: 480,
    height: 320,
    title: "S1 Electron",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
