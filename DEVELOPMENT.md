# Development guide: Pi Coding Agent Forge

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

Extensions, skills, prompts, themes, companion packages, and developer tools for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

This public JavaScript/TypeScript monorepo contains Firstpick's Pi ecosystem packages, published through npm with npm and/or Bun. It includes **Pi extensions, Agent Skills, prompt collections, theme bundles, WebUI packages, and companion utilities**.

## Skill authoring standards

- Follow the packaged portability guide in [`pi-package-skill-lifecycle/vendor/pi-skill-skill-creator/skills/skill-creator/references/SKILL-PORTABILITY.md`](pi-package-skill-lifecycle/vendor/pi-skill-skill-creator/skills/skill-creator/references/SKILL-PORTABILITY.md) when creating or updating reusable skills.
- Keep portable skill workflows harness-neutral; isolate Pi-only tools, slash commands, and local settings under a `## Pi adapter` section.
- Keep personal runtime memory outside package directories, e.g. `~/.pi/agent/memory/skills/<skill-name>.md` for Pi-local observations.

## Skill packages

These package active Pi skills that are not already bundled in an existing `pi-extension-*` package. Each package uses `pi.skills: ["./skills"]` and includes its full skill directory, including bundled scripts/references/assets.

Extension-bundled skills kept as direct Pi config includes instead of duplicate packages:

- `arch-linux-local` from `pi-extension-archwiki-local`
- `hyprland-local` from `pi-extension-hyprland-wiki-local`
- `nixos-local` from `pi-extension-nixos-wiki-local`

- `@firstpick/pi-skill-acceptance-tester` (`pi-skill-acceptance-tester`) — Use automatically as the final gate before release, handoff, or claiming completion for substantial changes. Runs acceptance/readiness checks, determines pass/fail, and gives a go/no-go recommendation.
- `@firstpick/pi-skill-architecture-review` (`pi-skill-architecture-review`) — Use automatically for architecture reviews, module boundaries, dependency direction, coupling/cohesion, SOLID concerns, system design trade-offs, layering, service boundaries, or design decisions before implementation.
- `@firstpick/pi-skill-backup-manager` (`pi-skill-backup-manager`) — Use automatically for backup health checks, restore testing, NAS/Gitea backup integrity, 3-2-1 strategy review, backup script audits, or verifying repositories and archives can be restored safely.
- `@firstpick/pi-skill-bug-reporter` (`pi-skill-bug-reporter`) — Use automatically when defects, regressions, failed tests, unexpected behavior, or spec mismatches are found. Produces structured reproducible bug reports with severity, evidence, environment, and actionable next steps.
- `@firstpick/pi-skill-code-quality` (`pi-skill-code-quality`) — Use automatically for code reviews, linting/formatting setup, maintainability checks, complexity concerns, warning cleanup, coding standards, or quality gates in Rust, TypeScript, Python, shell, and mixed repos.
- `@firstpick/pi-skill-code-security` (`pi-skill-code-security`) — Use automatically for code security reviews, leaked secret checks, dependency risk, unsafe shell/Python/TypeScript/Rust patterns, auth/input-validation flaws, SAST-style audits, or supply-chain concerns in repositories.
- `@firstpick/pi-skill-competitor-analysis` (`pi-skill-competitor-analysis`) — Use automatically when comparing competing products, services, libraries, tools, vendors, or approaches for market/product positioning, feature matrices, strategic trade-offs, pricing, adoption, or differentiation.
- `@firstpick/pi-skill-deep-research` (`pi-skill-deep-research`) — Use automatically for high-stakes or complex research needing multi-source evidence, scientific/technical fact-checking, decision traces, or rigorous verification. Runs deterministic two-phase research with schema/policy validation.
- `@firstpick/pi-skill-deployment-automation` (`pi-skill-deployment-automation`) — Use automatically for Docker Compose deployments, container updates, stack health checks, rollbacks, compose-file changes, image upgrades, failed deploys, or service restart planning. Provides safe deployment and rollback workflows.
- `@firstpick/pi-skill-design-patterns` (`pi-skill-design-patterns`) — Use automatically when choosing patterns, designing traits/interfaces/components, deciding abstraction boundaries, evaluating dependency injection/callbacks, or comparing implementation approaches in Rust, TypeScript/React, or Django/Python.
- `@firstpick/pi-skill-dolt-database-version-control` (`pi-skill-dolt-database-version-control`) — Use automatically when evaluating or applying Dolt, the Git-like version-controlled SQL database, for database branching, merging, diffs, audit history, rollback, or versioned MySQL replica workflows.
- `@firstpick/pi-skill-feature-development-workflow` (`pi-skill-feature-development-workflow`) — Use for authorized new-capability implementation to classify lightweight versus complex features and govern planning, implementation, integration, review, reporting, and completion gates.
- `@firstpick/pi-skill-network-diagnostics` (`pi-skill-network-diagnostics`) — Use automatically for connectivity, DNS, Pi-hole, port reachability, routing, firewall reachability, TLS/network timeouts, or service access failures. Provides structured network troubleshooting commands and interpretation.
- `@firstpick/pi-skill-paper-summarizer` (`pi-skill-paper-summarizer`) — Use automatically for academic or technical papers, arXiv/PubMed/IEEE/ACM links, PDFs, methodology review, limitations, practical implications, or extracting findings for engineering decisions.
- `@firstpick/pi-skill-performance-optimizer` (`pi-skill-performance-optimizer`) — Use automatically for slow code, high CPU/memory, latency, large data processing, algorithmic complexity, profiling plans, benchmarks, or optimization requests. Profiles first and weighs trade-offs before changing code.
- `@firstpick/pi-skill-refactoring-advisor` (`pi-skill-refactoring-advisor`) — Use automatically for refactors, code smells, migrations, duplication removal, module splitting, API cleanup, or restructuring plans. Emphasizes small safe steps, behavior preservation, and verification after each change.
- `@firstpick/pi-skill-repo-explorer` (`pi-skill-repo-explorer`) — Use automatically before modifying unfamiliar codebases, answering where/how something is implemented, tracing dependencies, mapping repo structure, or planning changes. Explores a repository and returns a strict JSON handoff with key files, symbols, risks, and evidence.
- `@firstpick/pi-skill-research-orchestration` (`pi-skill-research-orchestration`) — Use automatically for broad multi-claim research projects needing planning, parallel investigation, source merging, gap closure, citation audit, and final synthesis when narrower research skills are insufficient.
- `@firstpick/pi-skill-server-audit` (`pi-skill-server-audit`) — Use automatically for Linux server security reviews, SSH hardening, firewall/open-port audits, user/permission checks, exposed services, or host hardening requests. Produces severity-rated findings and practical remediation steps.
- `@firstpick/pi-skill-spec-vs-impl-checker` (`pi-skill-spec-vs-impl-checker`) — Use automatically when a spec, plan, README, issue, or requirement must be verified against implementation. Traces requirements to code, checks interface contracts, and reports gaps or mismatches.
- `@firstpick/pi-skill-subagent-governance` (`pi-skill-subagent-governance`) — Use when a parent orchestrator must decide delegation admissibility, role-fit, writer isolation, retry safety, integration acceptance, or reviewer-finding dispositions without duplicating runtime mechanics.
- `@firstpick/pi-skill-tauri-django-react` (`pi-skill-tauri-django-react`) — Use automatically for Tauri + Django + React desktop apps, especially backend lifecycle, CORS/auth, frontend integration, build packaging, dual desktop/web deployment, Rust commands, and platform-specific gotchas.
- `@firstpick/pi-skill-tech-debt-tracker` (`pi-skill-tech-debt-tracker`) — Use automatically when identifying, categorizing, prioritizing, or planning technical debt work, debt sprints, cleanup backlogs, TODO consolidation, or long-term maintainability risks. Tracks debt with severity/effort.
- `@firstpick/pi-skill-tech-deep-dive` (`pi-skill-tech-deep-dive`) — Use automatically when choosing or evaluating libraries, frameworks, tools, platforms, models, databases, APIs, or architectures for a use case. Produces criteria scoring, ecosystem assessment, and recommendations.
- `@firstpick/pi-skill-test-plan-generator` (`pi-skill-test-plan-generator`) — Use automatically when planning tests from specs, architecture docs, PRs, risky changes, new features, bug fixes, or release work. Generates prioritized unit, integration, E2E, regression, and edge-case coverage.
- `@firstpick/pi-skill-vulnerability-scanner` (`pi-skill-vulnerability-scanner`) — Use automatically when checking CVEs or known vulnerabilities in installed packages, dependencies, Docker images, OS packages, exposed services, or software versions. Produces severity-rated scan reports.

## Packages

### `@firstpick/pi-package-webui`
Pi Web UI companion package for Pi coding agent RPC mode.

- Bundles the `pi-webui` CLI server and `/webui-start` Pi extension command (`/start-webui` alias)
- Starts `pi --mode rpc` and serves a no-build HTTP/SSE web app
- Supports prompt, steer, follow-up, abort, new session, model/thinking controls, slash-command autocomplete, and guided git workflow
- Binds to `127.0.0.1` by default; no authentication, so do not expose it to untrusted networks

### `@firstpick/pi-package-skill-lifecycle`
Bundles the skill lifecycle packages that are designed to work together.

- Includes per-skill memory, skill-bank audit/management, skill evaluation, skill creation, skill refinement-loop resources, and the package-bundled skill lifecycle policy
- Uses Pi package `dependencies` + `bundledDependencies` so npm publication can be self-contained
- Does not include repository-level `tests/routing/`; those fixtures are development/evaluation data

### `@firstpick/pi-prompts-code-workflows`
Adds reusable prompt templates for code review, bug fixing, issue analysis, and incident triage.

- Prompt templates loaded via `pi.prompts: ["./prompts"]`
- Includes `/fix`, `/incident`, `/issue-fix`, `/issue-new`, `/review`, and `/sum-issue`
- Generalized for public repositories and maintainer-friendly workflows

### `@firstpick/pi-prompts-git-pr`
Adds reusable prompt templates for commits, pull requests, and PR review workflows.

- Prompt templates loaded via `pi.prompts: ["./prompts"]`
- Includes `/check-pr`, `/git-staged-msg`, `/pr`, `/pr-review-branch`, `/pr-review-implement`, and `/pr-update`
- Detects the repository default branch instead of assuming only `main`

### `@firstpick/pi-prompts-release-docs`
Adds reusable prompt templates for release preparation, announcements, and documentation updates.

- Prompt templates loaded via `pi.prompts: ["./prompts"]`
- Includes `/announce-branch`, `/announce-version`, `/readme-update`, `/release-new`, `/ship`, `/summary`, and `/wiki-update`
- Writes generated release/announcement artifacts under project-local `dev/` paths

### `@firstpick/pi-prompts-agent-memory`
Adds a reusable prompt template for durable Pi agent memory curation.

- Prompt templates loaded via `pi.prompts: ["./prompts"]`
- Includes `/update-memory`
- Uses standard Pi memory paths under `~/.pi/agent/`

### `@firstpick/pi-themes-bundle`
Adds Firstpick's custom Pi coding-agent themes.

- Theme bundle loaded via `pi.themes: ["./themes"]`
- Includes Catppuccin, Dracula, Tokyo Night, Gruvbox, Nord, Rosé Pine, One Dark, Solarized, and Everforest themes
- No commands or tools; select themes through `/settings` or `settings.json`

### `@firstpick/pi-extension-archwiki-local`
Adds local ArchWiki retrieval tools to Pi using the installed `arch-wiki-docs` package.

- `/archwiki-status` cache/docs status command
- `archwiki_search`, `archwiki_read`, `archwiki_sections`, `archwiki_extract`, `archwiki_related` tools
- Prefers local ArchWiki evidence for Arch/Linux troubleshooting

### `@firstpick/pi-extension-bang-command-autocomplete`
Adds autocomplete for `!<command>` in Pi.

- Fast suggestions from a built-in command list
- Optional shell-history command indexing via env flag

### `@firstpick/pi-extension-brave-search`
Adds a `brave_search` tool to Pi for up-to-date web search.

- Uses Brave Search API
- Supports query options like country/language/freshness/safesearch
- Includes status/test helper commands

### `@firstpick/pi-extension-cursor-composer`
Adds Cursor SDK Composer 2.5 integration to Pi.

- Registers native Pi provider `cursor-composer/composer-2.5`
- Adds `/cursor-composer-*` setup/status/model commands
- Adds `cursor_composer_agent` tool for explicit delegated Cursor agent runs
- Can append Composer 2.5 to Pi `enabledModels` scoped-model cycling

### `@firstpick/pi-extension-fish-user-bash`
Runs Pi `!` / `!!` commands through fish shell.

- Fish as default shell backend
- Configurable shell path via env var

### `@firstpick/pi-extension-memory-helper`
Adds lightweight daily and per-skill memory commands/tools.

- `/remember` to append notes
- `/memory-search` to search memory files
- `/skill-memory-*` commands and `skill_memory_*` tools for local per-skill memory
- `remember_note` tool for agent use

### `@firstpick/pi-extension-notes`
Adds local notes management inside Pi.

- Create, list, read, update, delete notes
- Fuzzy note lookup and quick status command
- Optional rule-note injection into prompt

### `@firstpick/pi-extension-plan-mode-toggle`
Plan mode workflow controls for Pi.

- `/plan-mode on|off|status`
- `/plan-model [select|provider/model-id]`
- `Ctrl+Q` shortcut for toggle/arm flow

### `@firstpick/pi-extension-git-footer-status`
Enhanced footer/status line for Pi sessions.

- Git status snapshot (branch, dirty state, sync, operations)
- Token/cost/context usage telemetry in footer
- `/git-footer-refresh` command

### `@firstpick/pi-extension-reverse-last`
Undo support for Pi `write`/`edit` file mutations.

- Per-session undo stack
- `/reverse-last [count]` command
- Optional state directory override via env var

### `@firstpick/pi-extension-safety-guard`
Protective confirmation layer for risky operations.

- Confirmation prompts for dangerous bash commands
- Protected-path checks for `write`/`edit`
- Auto-block behavior in non-interactive mode

### `@firstpick/pi-extension-stats`
Usage analytics command for Pi session history.

- Daily token graph (`/stats`, `/stats N`, `/stats all`)
- Input/output/cache breakdown
- Top model usage summary

### `@firstpick/pi-extension-plan-executor`
Autonomous `PLAN.md` checklist execution loop.

- `/execute-plan [path]`
- `/stop-plan`
- `/plan-status`

### `@firstpick/pi-extension-release-npm`
Release orchestration command for this monorepo.

- `/release-npm` runs release checks and optional publish flow

### `@firstpick/pi-extension-release-aur`
Reviewed AUR package setup and release workflow.

- `/release-aur-setup` sets up AUR publishing prerequisites, starting with native Pi-guided SSH key/config/test flow
- `/release-aur` plans, checks, queues agent review, and can create/publish AUR package repos after confirmation
- preflight includes `.SRCINFO`, `makepkg`, `namcap`, optional clean-chroot/repro checks, and conservative git staging

### `@firstpick/pi-extension-todo-progress`
Auto todo/progress tracking extension.

- auto-creates todos for multi-step prompts
- persistent progress widget until completion

### `@firstpick/pi-extension-upgrade-extensions`
Update npm-installed Pi extensions.

- `/extensions-update` with interactive multi-select
- `/extensions-update all` to directly update all available updates

### `@firstpick/pi-extension-wiki-tools`
Scaffold and maintain local wiki/documentation extension packages from templates.

- `/wiki-create`, `/wiki-update`, `/wiki-validate`, and `/wiki-templates` user commands
- `create_wiki`, `update_wiki`, `validate_wiki`, and `list_wiki_templates` agent tools
- bundled `wiki-tools` skill for using `templates/local-wiki-extension`
- safe defaults: create refuses existing targets; update defaults to dry-run

### `@firstpick/pi-extension-anthropic-auth-recovery`
Plan-only recovery assistance for narrowly classified Anthropic compatibility errors.

- selects an authenticated non-Anthropic model only after confirmation
- runs external compatibility-patch status and planning without automatic apply
- supports explicit authenticated RPC/WebUI recovery endpoints and secure local fallback

### `@firstpick/pi-extension-codex-fast-mode`
Session-scoped Fast mode for subscription-backed Codex requests.

- `/fast-mode` toggle with `on`, `off`, and `status` forms
- applies `service_tier: "priority"` only to `openai-codex` / `openai-codex-responses` requests
- defaults off, persists per session branch, and rejects mutations while busy

### `@firstpick/pi-extension-conditional-system-prompts`
Conditionally appends the local Windows policy and a governance-skill routing bridge.

- loads `APPEND_WINDOWS.md` on Windows
- routes turns with the `subagent` tool to the enabled `subagent-governance` skill
- preserves Windows-first ordering and fail-closed missing-skill guidance

### `@firstpick/pi-extension-feature-system-prompt`
Routes feature requests to the enabled `feature-development-workflow` skill.

- classifies requests with the active conversation model in an isolated tool-free session
- distinguishes lightweight and complex features
- injects a short fail-closed skill bridge while preserving bounded continuation context and safe classifier fallbacks

### `@firstpick/pi-extension-subagent-minimum-fanout`
Checks reviewer provider/model diversity for Pi subagent tool calls without restricting child fanout.

- allows direct single workers and sequential or parallel workflows
- checks distinct explicit reviewer routes for statically inspectable requests
- leaves workflow scripts and management/recovery actions unrestricted

### `@firstpick/pi-utils`
Shared helpers used by multiple Pi extensions.

- Agent-dir resolution (`PI_CODING_AGENT_DIR` aware)
- Environment boolean parsing
- Agent-relative path resolution

## Templates

### `templates/local-wiki-extension`
Reusable scaffold for local documentation/wiki extensions analogous to the ArchWiki and Hyprland Wiki packages.

- local search/read/sections/extract/related tools
- setup/status commands
- packaged skill template for local-docs-first routing
- cache-backed Markdown/HTML corpus indexing

## Utility scripts

- `dev/scripts/install-pi-add.sh` – discovers local `pi-extension-*`, `pi-skill-*`, and `pi-package-*` packages, compares installed versions against npm `latest` with concurrent status queries, repairs packages present in `node_modules` but missing from Pi user settings, and registers/installs selected or all packages via `pi install npm:<package>` with concise per-package results and end-of-run failure diagnostics (supports interactive mode, `--non-interactive`, `--all`, `--dry-run`, `--force`; set `PI_NPM_STATUS_CONCURRENCY` to tune the default concurrency of 8)
- `dev/scripts/pi-tui-perf-diagnose.sh` – runs read-mostly Pi TUI startup, idle-render, extension-isolation, and optional CPU-profile diagnostics with reports written under `/tmp`
- `dev/scripts/check-publish-readiness.sh` – validates package metadata, extension entries, dry-run publish, registry/version status, and local-vs-npm packed contents
- `dev/scripts/package-publishable-changes.sh` – compares ordinary packages through a script-free fast path and compares packages with `prepare`, `prepack`, or `postpack` hooks through their actual temporary tarball, so lifecycle-generated files match the artifact npm publishes
- `dev/scripts/publish-packages.sh` – plans/applies publish actions dynamically for all package folders or a `--targets-file` shortlist
- `dev/scripts/bump-package-versions.sh` – checks npm published versions first and enforces the next release version for changed packages (`+0.0.1`, rolling `*.9` to next minor `.0`; bumps up or reduces down only when needed); can write publish candidates to a target list
- `dev/scripts/release-workflow.sh` – orchestrates release checks: `--check` reports required bumps, `--plan` uses bump planning to shortlist packages and prepares missing bundled dependencies in a temporary workspace before publish checks, and `--publish` applies required bumps and prepares missing bundles before publishing
- `dev/scripts/sync-pi-package-symlinks.sh` – uses Pi's package resource resolver to symlink local development extensions, skills, prompts, and themes from top-level `pi-*` workspace packages into `~/.pi/agent/`; package-local `node_modules` resources referenced by Pi manifests are linked to top-level workspace packages first, so dev packages win over stale installed optional dependencies; index-based extensions are linked as directories, standalone package resources as files, and direct relative-import companion directories beside standalone files; local-only dev extensions use generated wrappers so their relative imports resolve from the source checkout; unrelated non-symlink conflicts are renamed to `.hardcoded.<timestamp>.bak`
- `dev/scripts/validate-skill-routing-fixtures.mjs` – validates development-only `tests/routing/*.json`; schema-only by default, with optional `--settings` or `--skill-root` target coverage

## Publish model

- Registry: **npm**
- Client: **npm** by default; **bun** is the fallback publisher when available
- Installation for users remains standard npm registry usage, e.g.:

```bash
pi install npm:@firstpick/pi-extension-notes
```
