# Cursor Composer for Pi

Connects Cursor Composer 2.5 to Pi as both a model provider and an explicitly requested coding agent.

## What you can do

- Adds Cursor Composer 2.5 as a model option in Pi.
- Lets you explicitly send a coding task to a Cursor agent.
- Provides setup, sign-in, connection, and model-status commands.
- Keeps Cursor delegation opt-in rather than automatic.

## Install

Requires Pi 0.86.0 or newer. Install it through Pi:

```bash
pi install npm:@firstpick/pi-extension-cursor-composer
```

Restart Pi if the package does not appear in your current session.

## How to use it

1. Run `/cursor-composer-setup` and follow the sign-in prompt.
2. Check the connection with `/cursor-composer-status`.
3. Choose how you want to work:
   - Select Composer from Pi’s model picker for a normal conversation.
   - Run `/cursor-composer <your request>` for one explicit Cursor task.

Example:

```text
/cursor-composer Review this project and suggest a safe migration plan.
```

Use `/cursor-composer-models` if you want to see which Cursor models are available. Planning mode, reasoning levels, workspace selection, and other advanced options are listed in the technical reference.

## Before you start

Run `/cursor-composer-setup` inside Pi and follow the sign-in or API-key prompt. You can check the connection with `/cursor-composer-status`.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-cursor-composer/TECHNICAL.md) for complete commands, configuration, compatibility, security, and troubleshooting information.
