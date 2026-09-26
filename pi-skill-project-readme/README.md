# Project README

Create or improve a project README that matches its audience, uses verified repository facts, and keeps optional sections relevant.

## Helpful when

- You are starting a README for an existing project.
- A README has grown inconsistent, incomplete, or hard to scan.
- You want to audit whether a README serves users without exposing contributor-only detail.

## What to share with Pi

- The repository and whether you want to create, update, harmonize, or review its README
- The primary audience and any repository-specific documentation rules
- Important user workflows, safety constraints, and verified image paths

## Try asking

> Review this desktop application's README for new users. Preserve verified instructions, use existing screenshots where possible, and tell me what evidence or images are missing before you rewrite it.

## What you’ll get

- A README structure adapted to the project and its primary audience
- Evidence-based wording that does not invent commands, features, compatibility, or visuals
- Clear gaps, conditional-section decisions, and links to deeper documentation where appropriate

## Keep in mind

Pi follows repository-local documentation rules first. For visual user products, it will ask for missing Main Window and common-feature images or an explicit choice to continue without them; it will not invent or capture visuals. Review proposed changes before applying them to important documentation. This package is not installed automatically and is not enabled automatically; installation requires explicit authorization, and there are no runtime package dependencies.

## Install

```bash
pi install npm:@firstpick/pi-skill-project-readme
```

Restart Pi if the skill does not appear in your current session.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-skill-project-readme/TECHNICAL.md) for advanced usage, compatibility, safety, and limitations.
