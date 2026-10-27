# PATCH.md

Package a code change as a repeatable, reviewable patch with checks and rollback guidance.

## Helpful when

- A change must be applied consistently in more than one place.
- You need to detect whether the target has changed.
- A patch should be easy to review or undo.

## What to share with Pi

- The intended change, target app or files, and its configuration location
- How success should be checked
- Any version, safety, or rollback requirements

## Try asking

> Create a PATCH.md package for these changes. Include a clear plan, change checks, verification, and a safe rollback path.

## What you’ll get

- A complete patch package saved in the app's configuration directory when patching an app
- Checks for unexpected file changes
- Apply, verify, and rollback instructions

## Keep in mind

Applying a patch can change many files. Review the plan and target paths before approving any write operation.

## Install

```bash
pi install npm:@firstpick/pi-skill-patch-md
```

Restart Pi if the skill does not appear in your current session.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-skill-patch-md/TECHNICAL.md) for advanced usage, configuration, compatibility, and limitations.
