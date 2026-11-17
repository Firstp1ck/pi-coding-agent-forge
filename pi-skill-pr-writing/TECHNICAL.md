# Technical reference: PR Writing

Advanced user reference for the sources, rules, compatibility, and limits of the skill.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Install

```bash
pi install npm:@firstpick/pi-skill-pr-writing
```

## What the skill contains

- `skills/pr-writing/SKILL.md` holds the rules: title format, how to size the body, the four standard sections, optional sections, agent attribution, voice, and a final checklist.
- `skills/pr-writing/references/examples.md` holds short, annotated excerpts from merged PRs. Agents read it when they want a model to follow.

The skill is guidance only. Loading it changes no files and runs no commands.

## Where the rules come from

The rules were distilled in November 2026 from:

- 60 merged PRs by Julius Marminge and 50 by Theo Browne in [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
- The merged PRs Mario Zechner authored in [earendil-works/pi](https://github.com/earendil-works/pi). Most of his work lands as direct commits, so his sample is small, and the pi `CONTRIBUTING.md` and `AGENTS.md` writing rules fill the gap.
- The T3 Code PR template and `CONTRIBUTING.md`

Both projects have since changed parts of their process. Re-check their current contribution rules before you file there.

## Precedence

1. The target repo's `CONTRIBUTING.md`, `AGENTS.md`, and PR template
2. The harness's required attribution footer, if any
3. This skill

For example, T3 Code accepts only bug fixes from outside the team, and Pi auto-closes PRs from contributors a maintainer has not approved. The skill reminds the agent to read those files, but it cannot know rules added after November 2026.

## Working with other skills and workflows

- `/pr` (Pi prompt template and Claude command) saves a draft description under `dev/PR`. It can follow this skill for the wording.
- `file-pr`, `full-stop`, and `full-send` create live PRs. The skill's description tells agents to load it when those workflows reach the description step.
- `unslop` cleans up the prose afterwards. The skill points to it when available.

## Example

```text
User: Write the PR text for my branch. It fixes a test that reuses a port.
Agent: Proposes the title "test(desktop): two-account callback test uses two distinct ports", a Problem section with the CI failure and the 5-in-20,000 port reuse rate, a one-line Change, a Scope line saying no issue is needed, and Verification showing 3/3 failures on main and 5/5 passes on the branch, plus a "Not checked" item.
```

## Compatibility

Portable Agent Skills-style skill. It works in Pi, Claude Code, Codex, and anything else that reads `SKILL.md` folders. No runtime, network access, or toolchain is needed.

## Limits

- The skill cannot verify a claim. If the agent has no evidence, the skill asks it to say so, but you still have to check what it wrote.
- The style fits fix-oriented repos. Projects that want long design write-ups in the PR need their own template.
- Model names in the examples reflect what was current in November 2026.
