# Model Research for Pi

Compare any two model names using configured research workers, then turn their independent research and reciprocal reviews into a dated model-selection skill draft.

## What you can do

- Compare any two model names, including unconfigured models, overall across coding, research, writing, reasoning, learning, automation, and other major task families.
- Gather arguments from X/Twitter, Reddit, other discussions, and primary sources, with evidence-quality labels.
- Exchange both original evaluations and compare each report’s usefulness against the other.
- Choose a configured research worker to write the skill, separately from the comparison outcome.
- Save comparison tables, original reports, reviews, and an uninstalled skill draft, ending with a precise task-by-task “when to use which model” summary.

## Install

Once published:

```bash
pi install npm:@firstpick/pi-extension-model-research
```

This package is currently a source implementation, not a published release. To try a local checkout without changing your installed packages, run this from the repository root:

```bash
pi -e ./pi-extension-model-research/index.ts
```

## How to use it

Start the dedicated workflow:

```text
/model-research
```

1. Type the two models you want to compare in the native input dialogs—for example, `gpt-6.1-sol` and `claude-opus-5.5`. They do not need to be configured or available locally.
2. Choose two authenticated research workers from Pi’s native lists. The workers must come from different model-author families; the models you compare can share an author or have an unknown author.
3. Review both the comparison names and the research workers, settings, limits, privacy notice, and run-specific confirmation.

There is no task-scope question: every new study compares the models overall. Names are unverified labels; unknown or ambiguous models remain evidence gaps instead of being replaced with a worker.

The final summary names which model to use for each major task family, under what conditions, with evidence gaps and confidence. It can say “Either”, “Neither”, or “Insufficient evidence” instead of forcing a winner. The extension does not reuse the generic Workflows extension.

In Pi TUI, the model calls run directly through your configured providers. Inside **T3 Code’s Pi provider**, research, review, and drafting run as tracked T3 child tasks. Completion notifications guide continuation; there is no polling loop.

Useful commands:

- `/model-research list` — find this session/thread’s runs.
- `/model-research status <id>` — inspect without starting more work.
- `/model-research continue <id>` — reconcile completed T3 tasks and advance.
- `/model-research writer <id>` — choose a configured research worker to write the skill after the reviews.
- `/model-research cancel <id>` — stop further work and cancel known pending tasks.

A completed run returns paths to `comparison.md` and `SKILL.md`, alongside the preserved evidence. Review the draft before installing or relying on it.

## Before you start

Requires Pi 1.3 or newer and Node.js 22.19 or newer. Standalone Pi needs a callable search tool such as [Brave Search for Pi](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/main/pi-extension-brave-search); a bounded public-page reader is bundled. T3 requires available, authenticated providers and app-owned orchestration tools.

Both research providers receive your comparison names and research task and, later, both reports and reviews. Public search queries go to your web tools. **Do not include secrets or private customer information.** No parent conversation history is copied.

Source access and factual claims remain **model-reported**, not independently fact-checked. Inaccessible X/Reddit threads must be recorded as gaps. Agreement and self-ratings are not benchmarks.

T3 children use approval-required mode, but their inherited tools are **not sandboxed by this extension**. T3 delegation offers no enforceable per-call token or USD cap. Headless model dispatch is disabled unless the operator explicitly opts in; a model-supplied confirmation flag alone cannot enable it. Nothing is installed, published, or switched automatically.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for complete commands, limits, storage, compatibility, security, and troubleshooting.
