# Development guide: PR Writing

Contributor-only implementation, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Layout

- `skills/pr-writing/SKILL.md`: the rules agents load.
- `skills/pr-writing/references/examples.md`: annotated excerpts with links to the source PRs.

## Refreshing the research

The sample came from these queries:

```bash
gh pr list -R pingdotgg/t3code --state merged --author juliusmarminge --limit 60 --json number,title,body,additions,deletions
gh pr list -R pingdotgg/t3code --state merged --author t3dotgg --limit 50 --json number,title,body,additions,deletions
gh search prs --author badlogic --merged --owner earendil-works --json repository,number,title
```

Also re-read `CONTRIBUTING.md`, `AGENTS.md`, and `.github/pull_request_template.md` in both repos. When the template headings change, update the "The four sections" part of `SKILL.md` and the Precedence notes in `TECHNICAL.md`.

Keep excerpts in `examples.md` short and linked. Do not paste whole PR bodies.

## Local integration

In the dotfiles setup the skill is linked from `~/.dotfiles/.pi/agent/skills/pr-writing` to this package's `skills/pr-writing`. `~/.dotfiles/.config/agent-harmony/sync.py --apply` then links it into Claude Code and Codex, and T3 Code uses those provider skills. The name must stay in Pi's `enabledSkills` list for Claude and Codex to keep it model-invocable.

## Testing

There is nothing to run. Check a change by asking an agent to write a PR for a small known diff and confirming that the title states the outcome, the body size matches the diff, and Verification includes base-fails evidence or an explicit "Not checked" line.
