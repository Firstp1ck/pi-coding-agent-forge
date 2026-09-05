

# Pi Coding Agent Forge

A collection of practical add-ons for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

You can add a browser interface, safer workflows, local documentation search, reusable skills, prompts, themes, and small quality-of-life tools. Install only the pieces that are useful to you.

## Start here

Most packages can be installed directly through Pi:

```bash
pi install npm:@firstpick/<package-name>
```

Open a package below for its exact install command and a short usage guide.

## Find what you need

### Packages

Packages bundle larger features, prompt collections, themes, or related tools.

- **[Troubleshooting learnings for Pi](pi-package-learnings/README.md)** — Keep a durable, searchable record of troubleshooting lessons that Pi can reuse later.
- **[Natural Conversation Mode for Pi](pi-package-natural-conversation/README.md)** — Adds a voice-friendly conversation mode with strict limits on what Pi can do while listening.
- **[Agent memory prompts for Pi](pi-package-prompts-agent-memory/README.md)** — Adds a reusable prompt for keeping Pi’s long-term memory useful and tidy.
- **[Code workflow prompts for Pi](pi-package-prompts-code-workflows/README.md)** — Adds ready-made prompts for reviews, bug fixes, issue work, and incident triage.
- **[Frontend design prompts for Pi](pi-package-prompts-frontend/README.md)** let you build and compare five working landing-page directions in one frontend project.
- **[Git and PR prompts for Pi](pi-package-prompts-git-pr/README.md)** — Adds ready-made prompts for commits, pull requests, and PR reviews.
- **[Release documentation prompts for Pi](pi-package-prompts-release-docs/README.md)** — Adds ready-made prompts for release notes, announcements, README updates, and wiki updates.
- **[Questionnaires for Pi](pi-package-questionnaire/README.md)** — Lets Pi ask clear single- and multiple-choice questions in the terminal and Web UI.
- **[Remote access for Pi Web UI](pi-package-remote-webui/README.md)** — Open an existing Pi Web UI safely to devices on a trusted local network.
- **[Skill lifecycle tools for Pi](pi-package-skill-lifecycle/README.md)** — Bundles the tools used to review, create, organize, and improve Pi skills.
- **[Theme bundle for Pi](pi-package-themes-bundle/README.md)** — Adds a collection of familiar color themes to Pi.
- **[Qt WebUI](pi-package-qt-webui/README.md)** — Use Pi in a Linux desktop window built with Quickshell and Qt Quick, with Markdown output, tool cards, extension dialogs, and transcript search.
- **[Pi Web UI](pi-package-webui/README.md)** — Use Pi from a local browser with tabs, streaming responses, uploads, model controls, Git helpers, and optional companion features.

### Extensions

Extensions add commands, tools, interface elements, or automatic behavior to Pi.

- **[Anthropic Auth Recovery for Pi](pi-extension-anthropic-auth-recovery/README.md)** — Helps you recover from a narrow class of Anthropic compatibility errors without changing anything automatically.
- **[ArchWiki Local for Pi](pi-extension-archwiki-local/README.md)** — Lets Pi search your local ArchWiki copy before reaching for the public web.
- **[AUR Review for Pi](pi-extension-aur-review/README.md)** — Adds a careful review checkpoint before AUR-related Git changes move forward.
- **[Bang Command Autocomplete for Pi](pi-extension-bang-command-autocomplete/README.md)** — Suggests shell commands when you type `!` or `!!` in Pi.
- **[Brave Search for Pi](pi-extension-brave-search/README.md)** — Lets Pi search the current web through the Brave Search API.
- **[BTW for Pi](pi-extension-btw/README.md)** — Ask a quick side question without derailing the main conversation.
- **[cd for Pi](pi-extension-cd/README.md)** — Makes changing directories in Pi faster with suggestions, history, and aliases.
- **[Codex Fast Mode for Pi](pi-extension-codex-fast-mode/README.md)** — Adds an easy on/off switch for subscription-backed Codex Fast mode.
- **[Conditional System Prompts for Pi](pi-extension-conditional-system-prompts/README.md)** — Loads only the extra system guidance that matches the current platform and enabled tools.
- **[Cursor Composer for Pi](pi-extension-cursor-composer/README.md)** — Connects Cursor Composer 2.5 to Pi as both a model provider and an explicitly requested coding agent.
- **[DOCX for Pi](pi-extension-docx/README.md)** — Lets Pi inspect and carefully edit Word documents while keeping validation and rollback in the workflow.
- **[Feature System Prompt for Pi](pi-extension-feature-system-prompt/README.md)** — Recognizes feature requests and loads the feature workflow only when it is actually needed.
- **[Fish User Bash for Pi](pi-extension-fish-user-bash/README.md)** — Runs Pi’s `!` and `!!` commands through Fish instead of the default shell.
- **[Git Footer Status for Pi](pi-extension-git-footer-status/README.md)** — Shows Git state, token use, context use, and model information in Pi’s footer.
- **[Guided Git workflow for Pi](pi-extension-git-guided-workflow/README.md)** — Guides staged changes through message, commit, and push with explicit safety checks and confirmations.
- **[Grill Me for Pi](pi-extension-grill-me/README.md)** — Turns an early idea into a focused design interview so important decisions are made before implementation.
- **[Hyprland Wiki Local for Pi](pi-extension-hyprland-wiki-local/README.md)** — Lets Pi search a local copy of the official Hyprland Wiki first.
- **[NixOS Wiki Local for Pi](pi-extension-nixos-wiki-local/README.md)** — Lets Pi search local NixOS and Nix documentation before using the public web.
- **[Notes for Pi](pi-extension-notes/README.md)** — Keep small local notes inside Pi and optionally use selected notes as operating rules.
- **[Plan Executor for Pi](pi-extension-plan-executor/README.md)** — Works through a PLAN.md checklist and keeps going until the plan is complete or needs your input.
- **[Plan Mode Toggle for Pi](pi-extension-plan-mode-toggle/README.md)** — Adds a planning mode for thinking through a change before code is written.
- **[Raspberry Pi Wiki Local for Pi](pi-extension-raspberrypi-wiki-local/README.md)** — Lets Pi search a local Raspberry Pi documentation collection.
- **[Release AUR for Pi](pi-extension-release-aur/README.md)** — Guides AUR setup, review, and publishing with explicit safety checks and confirmation.
- **[Release npm for Pi](pi-extension-release-npm/README.md)** — Guides this workspace’s npm release process and asks before publishing.
- **[Reverse Last for Pi](pi-extension-reverse-last/README.md)** — Undo the most recent changes made through Pi’s write and edit tools.
- **[Safety Guard for Pi](pi-extension-safety-guard/README.md)** — Adds confirmation and path protection around commands and edits that could cause serious damage.
- **[Setup Skills for Pi](pi-extension-setup-skills/README.md)** — Choose which local Pi skills are enabled from one interactive list.
- **[Small Modal Reliability for Pi](pi-extension-small-modal-reliability/README.md)** — Gives smaller language models a clearer task loop, scratchpad, and verification routine.
- **[Stats for Pi](pi-extension-stats/README.md)** — See where your Pi tokens and model costs are going over time.
- **[Subagent Review Diversity for Pi](pi-extension-subagent-minimum-fanout/README.md)** — Enforces reviewer model diversity without restricting worker or workflow fanout.
- **[Tech News for Pi](pi-extension-tech-news/README.md)** — Bring technology news from several sources into Pi for browsing and summaries.
- **[Todo Progress for Pi](pi-extension-todo-progress/README.md)** — Shows a live checklist for prompts that contain several steps or goals.
- **[Tools for Pi](pi-extension-tools/README.md)** — Turn Pi tools on or off from an interactive selector.
- **[Upgrade Extensions for Pi](pi-extension-upgrade-extensions/README.md)** — Check and update npm-installed Pi extensions from inside Pi.
- **[Wiki Tools for Pi](pi-extension-wiki-tools/README.md)** — Create and maintain local documentation-search extensions from a reusable template.
- **[Workbook for Pi](pi-extension-workbook/README.md)** — Lets Pi inspect and carefully edit Excel workbooks with visual checks and validation.
- **[Workflows for Pi](pi-extension-workflows/README.md)** — Run saved, repeatable Pi workflows without putting all workflow logic in one large prompt.

### Skills

Skills give Pi a reusable workflow for a particular kind of work. You normally ask in plain language rather than calling a command.

- **[Acceptance Tester](pi-skill-acceptance-tester/README.md)** — Check whether substantial work is truly ready to release or hand off.
- **[Architecture Review](pi-skill-architecture-review/README.md)** — Review a system design before implementation and spot coupling, layering, or boundary problems.
- **[Backup Manager](pi-skill-backup-manager/README.md)** — Check backup health, test restore readiness, and find gaps before an emergency.
- **[Bug Reporter](pi-skill-bug-reporter/README.md)** — Turn a defect or failed test into a clear, reproducible bug report.
- **[Code Quality](pi-skill-code-quality/README.md)** — Review code for maintainability, complexity, consistency, and useful quality checks.
- **[Code Security](pi-skill-code-security/README.md)** — Look for security flaws, leaked secrets, risky dependencies, and unsafe coding patterns.
- **[Competitor Analysis](pi-skill-competitor-analysis/README.md)** — Compare products, tools, or approaches using clear criteria and practical trade-offs.
- **[Deep Research](pi-skill-deep-research/README.md)** — Research complex or high-stakes questions with multiple sources and explicit verification.
- **[Deployment Automation](pi-skill-deployment-automation/README.md)** — Plan and review safer container deployments, updates, health checks, and rollbacks.
- **[Desktop Visual Design](pi-skill-desktop-visual-design/README.md)** — Style desktop apps and Quickshell components with coherent palettes, states, spacing, typography, borders, and motion.
- **[Design Patterns](pi-skill-design-patterns/README.md)** — Choose an appropriate design pattern without adding unnecessary abstraction.
- **[Dolt Database Version Control](pi-skill-dolt-database-version-control/README.md)** — Evaluate or use Dolt when database history, branching, merging, or rollback matters.
- **[Feature Development Workflow](pi-skill-feature-development-workflow/README.md)** — Guide a feature from scope and planning through implementation, review, and completion.
- **[Frontend Design](pi-skill-frontend-design/README.md)** gives web interfaces a brief-specific visual direction instead of a familiar AI template.
- **[HTML Report](pi-skill-html-report/README.md)** — Create polished, self-contained HTML reports for complex explanations and investigations.
- **[Lab QC Presentation Theme](pi-skill-lab-qc-presentation-theme/README.md)** — Create modern green presentations for chemical production and quality-control teams.
- **[Network Diagnostics](pi-skill-network-diagnostics/README.md)** — Troubleshoot DNS, routing, ports, firewalls, TLS, and general connectivity problems.
- **[Omarchy Plugin](pi-skill-omarchy-plugin/README.md)** — Develop, validate, review, and prepare Omarchy Quattro plugins for Marketplace submission.
- **[Paper Summarizer](pi-skill-paper-summarizer/README.md)** — Read technical or academic papers and explain their findings, limits, and practical value.
- **[Patch MD](pi-skill-patch-md/README.md)** — Create and manage reproducible PATCH.md packages with validation and rollback guidance.
- **[Performance Optimizer](pi-skill-performance-optimizer/README.md)** — Find why software is slow or resource-heavy before recommending optimizations.
- **[Project README](pi-skill-project-readme/README.md)** — Create, update, or review evidence-based project READMEs for the right audience.
- **[Refactoring Advisor](pi-skill-refactoring-advisor/README.md)** — Plan small, safe refactors that preserve behavior while improving maintainability.
- **[Repo Explorer](pi-skill-repo-explorer/README.md)** — Map an unfamiliar repository and return the files, symbols, risks, and evidence needed for the next step.
- **[Research Orchestration](pi-skill-research-orchestration/README.md)** — Coordinate broad research across several claims, sources, and verification passes.
- **[Server Audit](pi-skill-server-audit/README.md)** — Review a Linux server for exposed services, weak access controls, and practical hardening opportunities.
- **[Shoo Auth](pi-skill-shoo-auth/README.md)** — Implement or troubleshoot Shoo Google sign-in in browser applications.
- **[Spec vs Impl Checker](pi-skill-spec-vs-impl-checker/README.md)** — Check whether code actually matches a specification, plan, README, or issue.
- **[Subagent Governance](pi-skill-subagent-governance/README.md)** — Keep delegated agent work properly scoped, isolated, reviewed, and safely retried.
- **[Tauri Django React](pi-skill-tauri-django-react/README.md)** — Build and troubleshoot desktop apps that combine Tauri, Django, and React.
- **[Tech Debt Tracker](pi-skill-tech-debt-tracker/README.md)** — Find, group, and prioritize technical debt so cleanup work becomes actionable.
- **[Tech Deep Dive](pi-skill-tech-deep-dive/README.md)** — Evaluate libraries, frameworks, platforms, models, databases, APIs, or architectures for a real use case.
- **[Test Plan Generator](pi-skill-test-plan-generator/README.md)** — Turn a change or specification into a prioritized, practical test plan.
- **[Unslop](pi-skill-unslop/README.md)** — Strip AI writing tells from prose and restore a human voice.
- **[Vulnerability Scanner](pi-skill-vulnerability-scanner/README.md)** — Check software, containers, and services for known vulnerabilities and explain the risk.

### Shared utilities

These are building blocks for package authors and are usually installed indirectly.

- **[Shared Pi extension utilities](pi-utils/README.md)** — Shared building blocks used by Firstpick’s Pi extensions. Most users do not need to install this package directly.

## Technical and contributor information

See [TECHNICAL.md](TECHNICAL.md) for package types, installation, and compatibility. Contributors can use [DEVELOPMENT.md](DEVELOPMENT.md) for repository layout, authoring standards, release tooling, and maintenance.
