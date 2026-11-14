const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("s1", { pressed: () => ipcRenderer.send("pressed") });
