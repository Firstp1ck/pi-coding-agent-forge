# Quickshell docs local for Pi

Give Pi offline Quickshell and Qt documentation to build panels, widgets and the services behind a desktop shell.

## What you can do

- Search Quickshell's guides and complete published API reference, including audio, media, battery, tray, notifications and compositor integrations.
- Look up Qt QML, Quick, Controls, Layouts and related UI references alongside Quickshell types.
- Download the newest published Quickshell documentation release automatically.
- Extract specific properties, methods and signals with local citations and source versions.
- Keep your previous download usable if an update fails, or restore it without network access.

## Install

This package is prepared locally and has not yet been published. After publication:

```bash
pi install npm:@firstpick/pi-extension-quickshell-wiki-local
```

You need Pi and Python 3.10 or newer. Setup downloads text documentation from the official Quickshell and Qt sites. Lookups work offline afterward. See the [development guide](DEVELOPMENT.md) for local-checkout installation.

## How to use it

1. Run `/quickshell-wiki-local-setup` in Pi. This downloads the newest published Quickshell guides and API, plus core Qt references. Allow several minutes.
2. Run `/quickshell-wiki-status` to see source versions, page counts and any unavailable upstream links.
3. Run `/quickshell-wiki-smoke-test` to check retrieval.
4. Ask:

> Use the offline Quickshell and Qt docs to design a volume slider. Check the PipeWire binding requirements and the Slider user-interaction signal. Cite the exact sections before writing code.

The included `quickshell-local` skill chooses between tutorials, Quickshell APIs and Qt references. Load it explicitly with `/skill:quickshell-local` if needed.

Run setup again to refresh the collection. Use `/quickshell-wiki-local-setup --rollback` to restore the preceding snapshot.

## Before you start

Newest documentation can describe APIs newer than your installed Quickshell or Qt. The tools report their versions separately; Pi should check installed versions before using new APIs. Setup never installs or upgrades Quickshell or Qt.

This is a text-reference collection, not a rendered browser mirror or every Qt module. It includes the published Quickshell API and core Qt UI documentation, but not images, videos, third-party shells or every external service manual. Upstream pages can still lack explanations for individual members.

QML can execute programs. Downloading these docs never launches examples or changes your desktop. Local lookup is offline, but your configured Pi model may still receive retrieved text and local paths.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for version selection, download limits, offline transfer, rollback, migration from the guide-only package and troubleshooting.
