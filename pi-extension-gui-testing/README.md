# GUI Testing for Pi

Let Pi start your desktop app somewhere out of sight, click through it, and look at screenshots to check its own work.

> **Status:** in development. The design is complete, but nothing is implemented yet. The commands below describe the planned behavior.

## What you can do

- Run your app in a private environment: a Docker container, your own Linux server or Raspberry Pi over SSH, or a cloud sandbox. It never opens on your desktop.
- Let Pi find buttons and fields by name, click and type, and take screenshots to judge the result.
- Test Linux, Windows, and macOS apps, depending on which environment you choose.
- Set everything up with one command that checks your system and fixes what it can.
- Keep your code on your own machine: remote environments are wiped after every session.

## Install

Once published:

```bash
pi install npm:@firstpick/pi-extension-gui-testing
```

## How to use it

1. Run `/gui-setup` and pick an environment. For a server from your SSH config, pick it from the list.
2. Approve any fixes setup proposes. When everything is already in place, setup finishes without questions.
3. Ask Pi to check your app, for example: "Start the app, open the settings dialog, and make sure the Save button works."

## Before you start

- Remote and cloud environments receive a copy of your project for the length of a session. Files such as `.env`, keys, and credentials are never sent.
- Cloud sandboxes cost money. Setup asks you to acknowledge this, and Pi warns you when usage looks unusual.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for all commands and options, configuration files, where data is stored, privacy rules, limitations, and troubleshooting.
