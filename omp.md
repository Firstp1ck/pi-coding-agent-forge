# Package readiness for oh-my-pi

Tested 96 top-level packages with the installed Linux standalone build of OMP 19.2.1 on 2026-11-27. The checkout was at `2cb90ceb` with local edits. Five vendored packages were also linked and tested individually. The four prompt bundles were retested after the compatibility edits described below. [OMP upstream](https://github.com/can1357/oh-my-pi/tree/v19.2.1)

All 40 top-level skill packages delivered their instructions through OMP’s read tool. Two also ship extension tools, so their overall status is “Registered” pending checks of those tools. Extensions need individual checks. For example, OMP can read the DOCX skill while rejecting the extension that supplies its editing tools. The ArchWiki smoke test succeeded on the host’s installed corpus.

The **omp packages catalog** column records the public badge for each npm package name on 2026-11-27. The catalog returned **Untested on omp** for 54 packages and **Not listed** for 47. Listed packages get their category from publisher tags and compatibility reports. The adjacent **Status** column records the local runtime tests. [How the independent catalog assigns badges](https://omppackages.com/about)

| Top-level status | Packages | What the result establishes |
|---|---:|---|
| Blocked | 19 | The loader, a required hook, or the format validator rejected the package. |
| Unavailable | 1 | The checkout lacks an implemented entry point for the advertised feature. |
| Partial | 7 | Some features worked and another documented surface failed or was absent. |
| Needs setup | 4 | The command ran and reported a missing local prerequisite. |
| Inactive by default | 1 | The entry point loads but its trigger does not match the default tools. |
| Registered | 14 | Commands or tools appeared. Their primary workflow remains unverified. |
| Library | 1 | Compatibility depends on the imported utility. |
| Works on OMP | 28 | These unlisted packages passed a live OMP 19.2.1 check: skill delivery, command execution or template expansion, or wiki template discovery. Each row identifies the behavior tested. |
| Command tested | 5 | The named command returned the recorded result or delivered the expected template to the model. |
| Workflow tested | 1 | A local operation returned usable data. |
| Skill verified | 15 | The skill body reached the model in a scripted tool round trip. |

## Blockers and setup requirements

| Local package | Version | Status | omp packages catalog | Observed behavior |
|---|---|---|---|---|
| [pi-extension-brave-search](pi-extension-brave-search/) | 0.2.4 | Blocked | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-brave-search.svg) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-btw](pi-extension-btw/) | 0.1.6 | Blocked | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-btw.svg) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-cd](pi-extension-cd/) | 0.1.3 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-cd) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-conditional-system-prompts](pi-extension-conditional-system-prompts/) | 0.1.3 | Blocked | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-conditional-system-prompts.svg) | A local model turn triggered the hook and OMP logged an exception reading event.systemPromptOptions.selectedTools. |
| [pi-extension-cursor-composer](pi-extension-cursor-composer/) | 0.2.0 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-cursor-composer) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-feature-system-prompt](pi-extension-feature-system-prompt/) | 0.1.7 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-feature-system-prompt) | `feature-system-prompt.ts` failed to load. Missing export `ModelRuntime`. |
| [pi-extension-fish-user-bash](pi-extension-fish-user-bash/) | 0.2.4 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-fish-user-bash) | `index.ts` failed to load. Missing export `createLocalBashOperations`. |
| [pi-extension-git-footer-status](pi-extension-git-footer-status/) | 0.5.5 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-git-footer-status) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-git-guided-workflow](pi-extension-git-guided-workflow/) | 0.1.8 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-git-guided-workflow) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-notes](pi-extension-notes/) | 0.2.4 | Blocked | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-notes.svg) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-plan-executor](pi-extension-plan-executor/) | 0.2.3 | Blocked | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-plan-executor.svg) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-release-npm](pi-extension-release-npm/) | 0.5.3 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-release-npm) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-reverse-last](pi-extension-reverse-last/) | 0.2.2 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-reverse-last) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-review](pi-extension-review/) | 0.1.3 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-review) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-safety-guard](pi-extension-safety-guard/) | 0.3.3 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-safety-guard) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-setup-skills](pi-extension-setup-skills/) | 0.3.0 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-setup-skills) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-tech-news](pi-extension-tech-news/) | 0.2.2 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-tech-news) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-extension-tools](pi-extension-tools/) | 0.2.7 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-tools) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. |
| [pi-package-themes-bundle](pi-package-themes-bundle/) | 0.1.7 | Blocked | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-themes-bundle) | All 16 palette files failed the OMP 19.2.1 validator. Missing required colors include pythonMode, btwMode and statusLineSep. |
| [pi-extension-gui-testing](pi-extension-gui-testing/) | 0.1.0 | Unavailable | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-gui-testing.svg) | The entry point is empty and the declared skills directory is absent. |
| [pi-extension-docx](pi-extension-docx/) | 0.1.6 | Partial | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-docx) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. Read `skill://docx-editor`. |
| [pi-extension-stats](pi-extension-stats/) | 0.3.4 | Partial | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-stats) | Registered `/stats-tokens`, `/stats-most-expense` and 7 more. `/stats-last` — No sessions found for this workspace yet. Built-in /stats takes precedence. OMP skipped the extension command. |
| [pi-extension-workbook](pi-extension-workbook/) | 0.1.7 | Partial | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-workbook) | Read `skill://workbook-editor`. Registered `/workbook-doctor`, `/workbook-vba`. 8 added tools, including `workbook_inspect`. `/workbook-doctor` — Doctor reported missing fflate and xmldom. A separate workbook_inspect tool call read the XLSX fixture with the OOXML engine. |
| [pi-package-prompts-code-workflows](pi-package-prompts-code-workflows/) | 0.1.8 | Partial | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-prompts-code-workflows) | OMP discovered and expanded 8/9 package commands directly from the packed bundle. Pi discovered all 9. OMP keeps its own `/review`. |
| [pi-package-learnings](pi-package-learnings/) | 0.1.7 | Partial | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-package-learnings) | `index.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. Read `skill://learnings`. The link exposed 0/2 package templates. Copying the Markdown files into `.omp/commands/` exposed 2/2. |
| [pi-package-skill-lifecycle](pi-package-skill-lifecycle/) | 0.1.7 | Partial | [Not listed](https://omppackages.com/badge/@firstpick/pi-package-skill-lifecycle.svg) | Registered `/remember`, `/memory-search` and 8 more. 16 added tools, including `remember_note`. `/memory-helper-status` — Memory helper reported its storage directory. A skill_memory_list call returned an empty store. None of the four bundled skills appeared through the parent link. |
| [pi-package-webui](pi-package-webui/) | 0.11.3 | Partial | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-package-webui) | `session-summary.ts` failed to load. OMP rejects the legacy `@earendil-works/pi-tui` import. Registered `/git-workflow-setup`, `/webui-start` and 2 more. 1 added tool, including `subagent_gate`. `/webui-status` — Status reported no Web UI server running. |
| [pi-extension-hyprland-wiki-local](pi-extension-hyprland-wiki-local/) | 0.1.9 | Needs setup | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-hyprland-wiki-local) | Read `skill://hyprland-local`. Registered `/hyprwiki-status`, `/hyprwiki-local-setup` and 1 more. 6 added tools, including `hyprwiki_search`. `/hyprwiki-smoke-test` — Smoke test found no local corpus in the fresh home. |
| [pi-extension-nixos-wiki-local](pi-extension-nixos-wiki-local/) | 0.1.8 | Needs setup | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-nixos-wiki-local) | Read `skill://nixos-local`. Registered `/nixoswiki-status`, `/nixoswiki-local-setup` and 1 more. 6 added tools, including `nixoswiki_search`. `/nixoswiki-smoke-test` — Smoke test found no local corpus in the fresh home. |
| [pi-extension-quickshell-wiki-local](pi-extension-quickshell-wiki-local/) | 0.2.1 | Needs setup | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-quickshell-wiki-local) | Read `skill://quickshell-local`. Registered `/quickshell-wiki-status`, `/quickshell-wiki-local-setup` and 1 more. 6 added tools, including `quickshell_wiki_search`. `/quickshell-wiki-smoke-test` — Smoke test found no local corpus in the fresh home. |
| [pi-extension-raspberrypi-wiki-local](pi-extension-raspberrypi-wiki-local/) | 0.1.8 | Needs setup | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-raspberrypi-wiki-local) | Read `skill://raspberrypi-local`. Registered `/raspberrypi_wiki-status`, `/raspberrypi-wiki-local-setup` and 1 more. 6 added tools, including `raspberrypi_wiki_search`. `/raspberrypi_wiki-smoke-test` — Smoke test found no local corpus in the fresh home. |
| [pi-extension-subagent-minimum-fanout](pi-extension-subagent-minimum-fanout/) | 0.1.6 | Inactive by default | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-subagent-minimum-fanout) | A local model turn completed. The hook requires an active subagent or subagent_gate tool. The OMP control provides task. |

## Extensions, libraries and command checks

| Local package | Version | Status | omp packages catalog | Observed behavior |
|---|---|---|---|---|
| [pi-extension-anthropic-auth-recovery](pi-extension-anthropic-auth-recovery/) | 0.3.1 | Registered | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-anthropic-auth-recovery) | Registered `/anthropic-auth-status`. The status probe yielded no result in its observation window. Auth recovery remains unverified. |
| [pi-extension-aur-review](pi-extension-aur-review/) | 0.1.3 | Registered | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-aur-review.svg) | Registered `/aur-review`. 1 added tool, including `aur_review_request`. |
| [pi-extension-grill-me](pi-extension-grill-me/) | 0.1.8 | Registered | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-grill-me) | Registered `/grill-me`. 4 added tools, including `grill_record_turn`. The interview also needs questionnaire. Its tool registered in the separate questionnaire package test. |
| [pi-extension-image-generation](pi-extension-image-generation/) | 0.1.0 | Registered | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-image-generation) | Registered `/setup-image-generation`, `/generate-image`. 2 added tools, including `show_image_model_list`. The provider-backed image request was not exercised. |
| [pi-extension-model-research](pi-extension-model-research/) | 0.1.0 | Registered | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-model-research) | Registered `/model-research`. 2 added tools, including `model_research_fetch`. |
| [pi-extension-plan-mode-toggle](pi-extension-plan-mode-toggle/) | 0.2.1 | Registered | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-plan-mode-toggle.svg) | Registered `/plan-mode`, `/plan-model`. `/plan-model status` — Use /plan-model and pick from selector, or pass provider/model-id. The response was usage guidance. Model switching remains unverified. |
| [pi-extension-release-aur](pi-extension-release-aur/) | 0.1.9 | Registered | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-release-aur.svg) | Read `skill://release-aur`. Registered `/release-aur-setup`, `/release-aur`. Publishing was outside the probe. |
| [pi-extension-upgrade-extensions](pi-extension-upgrade-extensions/) | 0.1.9 | Registered | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-upgrade-extensions.svg) | Registered `/extensions-update`. |
| [pi-package-natural-conversation](pi-package-natural-conversation/) | 0.1.5 | Registered | [Not listed](https://omppackages.com/badge/@firstpick/pi-package-natural-conversation.svg) | Registered `/talk`, `/voice` and 1 more. |
| [pi-package-qt-webui](pi-package-qt-webui/) | 0.2.1 | Registered | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-package-qt-webui) | Registered `/qt-webui-start`. The desktop launcher and its client session were not exercised. |
| [pi-package-questionnaire](pi-package-questionnaire/) | 0.1.1 | Registered | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-package-questionnaire) | Read `skill://questionnaire`. 1 added tool, including `questionnaire`. |
| [pi-package-remote-webui](pi-package-remote-webui/) | 0.1.9 | Registered | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-package-remote-webui) | Registered `/remote`. Needs a running Pi Web UI for remote access. |
| [pi-skill-patch-md](pi-skill-patch-md/) | 0.1.6 | Registered | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-patch-md) | Read `skill://patch-md`. 1 added tool, including `patch_apply_with_approval`. Package tests passed. |
| [pi-skill-repo-explorer](pi-skill-repo-explorer/) | 0.2.2 | Registered | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-repo-explorer.svg) | Read `skill://repo-explorer`. 1 added tool, including `repo_explorer_explore`. |
| [pi-utils](pi-utils/) | 0.3.2 | Library | [Not listed](https://omppackages.com/badge/@firstpick/pi-utils.svg) | The extension entry point intentionally does nothing. ArchWiki exercised shared wiki code. The TUI selector import blocked pi-extension-tools. |
| [pi-extension-bang-command-autocomplete](pi-extension-bang-command-autocomplete/) | 0.2.3 | Command tested | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-bang-command-autocomplete) | Registered `/bang-refresh`, `/bang-status`. `/bang-status` — Reported 43 commands with history disabled. Interactive completion remains unverified. |
| [pi-extension-codex-fast-mode](pi-extension-codex-fast-mode/) | 0.1.2 | Command tested | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-codex-fast-mode) | Registered `/fast-mode`. `/fast-mode status` — Fast mode: off. It only requests priority service for openai-codex/openai-codex-responses. |
| [pi-extension-small-modal-reliability](pi-extension-small-modal-reliability/) | 0.1.8 | Command tested | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-small-modal-reliability) | Read all 6 discovered skills. Registered `/reliability`. 10 added tools, including `reliability_status`. `/reliability status` — The harness was disabled. The `reliability_status` tool also returned the disabled harness state. |
| [pi-extension-todo-progress](pi-extension-todo-progress/) | 0.3.4 | Command tested | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-todo-progress) | Registered `/goal`, `/goal-status` and 3 more. 3 added tools, including `todo_update`. `/todo-progress-status` — todo-progress loaded · visible no · items 0 · goal no |
| [pi-extension-workflows](pi-extension-workflows/) | 0.2.0 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-workflows.svg) | Registered `/workflow`, `/workflow-setup` and 2 more. 2 added tools, including `workflow_run`. `/workflows` — No workflow runs have been recorded in this session. The workflow_status tool also returned the expected empty session. |
| [pi-package-prompts-agent-memory](pi-package-prompts-agent-memory/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-prompts-agent-memory.svg) | OMP discovered and expanded 6/6 package commands directly from the packed bundle. Pi discovered all 6. |
| [pi-package-prompts-git-pr](pi-package-prompts-git-pr/) | 0.1.8 | Command tested | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-prompts-git-pr) | OMP discovered and expanded 7/7 package commands directly from the packed bundle. Pi discovered all 7. |
| [pi-package-prompts-release-docs](pi-package-prompts-release-docs/) | 0.1.6 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-prompts-release-docs.svg) | OMP discovered and expanded 7/7 package commands directly from the packed bundle. Pi discovered all 7. |
| [pi-package-writer](pi-package-writer/) | 0.1.0 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-package-writer.svg) | Read all 18 discovered skills. Registered `/writer`. `/writer list` — No writing projects yet. |
| [pi-extension-archwiki-local](pi-extension-archwiki-local/) | 0.1.9 | Workflow tested | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-extension-archwiki-local) | Read `skill://arch-linux-local`. Registered `/archwiki-status`, `/archwiki-local-setup` and 1 more. 6 added tools, including `archwiki_search`. `/archwiki-smoke-test` — Passed all nine corpus, search, section, extract and read checks on 2,496 pages. |
| [pi-extension-wiki-tools](pi-extension-wiki-tools/) | 0.1.6 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-wiki-tools.svg) | Read `skill://wiki-tools`. Registered `/wiki-templates`, `/wiki-create` and 2 more. 4 added tools, including `list_wiki_templates`. The list_wiki_templates tool returned the template roots and inventory in a model tool round trip. |

## Skills with verified content delivery

| Local package | Version | Status | omp packages catalog | Observed behavior |
|---|---|---|---|---|
| [pi-skill-acceptance-tester](pi-skill-acceptance-tester/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-acceptance-tester.svg) | Read `skill://acceptance-tester`. |
| [pi-skill-architecture-review](pi-skill-architecture-review/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-architecture-review.svg) | Read `skill://architecture-review`. |
| [pi-skill-backup-manager](pi-skill-backup-manager/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-backup-manager.svg) | Read `skill://backup-manager`. |
| [pi-skill-bug-reporter](pi-skill-bug-reporter/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-bug-reporter.svg) | Read `skill://bug-reporter`. |
| [pi-skill-code-quality](pi-skill-code-quality/) | 0.1.8 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-code-quality) | Read `skill://code-quality`. Package tests passed. |
| [pi-skill-code-security](pi-skill-code-security/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-code-security.svg) | Read `skill://code-security`. |
| [pi-skill-competitor-analysis](pi-skill-competitor-analysis/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-competitor-analysis.svg) | Read `skill://competitor-analysis`. |
| [pi-skill-deep-research](pi-skill-deep-research/) | 0.1.9 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-deep-research) | Read `skill://deep-research`. |
| [pi-skill-deployment-automation](pi-skill-deployment-automation/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-deployment-automation.svg) | Read `skill://deployment-automation`. |
| [pi-skill-design-patterns](pi-skill-design-patterns/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-design-patterns.svg) | Read `skill://design-patterns`. |
| [pi-skill-desktop-visual-design](pi-skill-desktop-visual-design/) | 0.1.1 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-desktop-visual-design.svg) | Read `skill://desktop-visual-design`. Package tests passed. |
| [pi-skill-dolt-database-version-control](pi-skill-dolt-database-version-control/) | 0.1.4 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-dolt-database-version-control.svg) | Read `skill://dolt-database-version-control`. Package tests passed. |
| [pi-skill-explainer-video](pi-skill-explainer-video/) | 0.1.0 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-explainer-video) | Read `skill://explainer-video`. Package tests passed. The 66-test run used a snapshot containing local edits. |
| [pi-skill-feature-development-workflow](pi-skill-feature-development-workflow/) | 0.1.3 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-feature-development-workflow) | Read `skill://feature-development-workflow`. Package tests passed. |
| [pi-skill-frontend-design](pi-skill-frontend-design/) | 0.1.1 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-frontend-design) | Read `skill://frontend-design`. Package tests passed. |
| [pi-skill-html-report](pi-skill-html-report/) | 0.1.3 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-html-report.svg) | Read `skill://html-report`. Package tests passed. |
| [pi-skill-lab-qc-presentation-theme](pi-skill-lab-qc-presentation-theme/) | 0.1.9 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-lab-qc-presentation-theme) | Read `skill://lab-qc-presentation-theme`. Package tests passed. |
| [pi-skill-network-diagnostics](pi-skill-network-diagnostics/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-network-diagnostics.svg) | Read `skill://network-diagnostics`. |
| [pi-skill-paper-summarizer](pi-skill-paper-summarizer/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-paper-summarizer.svg) | Read `skill://paper-summarizer`. |
| [pi-skill-performance-optimizer](pi-skill-performance-optimizer/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-performance-optimizer.svg) | Read `skill://performance-optimizer`. |
| [pi-skill-pr-writing](pi-skill-pr-writing/) | 0.1.0 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-pr-writing) | Read `skill://pr-writing`. |
| [pi-skill-project-readme](pi-skill-project-readme/) | 0.1.2 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-project-readme) | Read `skill://project-readme`. Package tests passed. |
| [pi-skill-refactoring-advisor](pi-skill-refactoring-advisor/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-refactoring-advisor.svg) | Read `skill://refactoring-advisor`. |
| [pi-skill-requirements-engineering](pi-skill-requirements-engineering/) | 0.1.1 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-requirements-engineering) | Read `skill://requirements-engineering`. Package tests passed. |
| [pi-skill-research-orchestration](pi-skill-research-orchestration/) | 0.1.8 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-research-orchestration) | Read `skill://research-orchestration`. |
| [pi-skill-rust-rewrite](pi-skill-rust-rewrite/) | 0.2.0 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-rust-rewrite) | Read `skill://rewrite-in-rust`. Package tests passed. |
| [pi-skill-sailfishos](pi-skill-sailfishos/) | 0.1.0 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-sailfishos) | Read `skill://sailfishos`. Package tests passed. |
| [pi-skill-server-audit](pi-skill-server-audit/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-server-audit.svg) | Read `skill://server-audit`. |
| [pi-skill-shoo-auth](pi-skill-shoo-auth/) | 0.1.4 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-shoo-auth.svg) | Read `skill://shoo-auth`. Package tests passed. |
| [pi-skill-spec-vs-impl-checker](pi-skill-spec-vs-impl-checker/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-spec-vs-impl-checker.svg) | Read `skill://spec-vs-impl-checker`. |
| [pi-skill-stop-slop](pi-skill-stop-slop/) | 0.1.0 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-stop-slop.svg) | Read `skill://stop-slop`. Package tests passed. |
| [pi-skill-subagent-governance](pi-skill-subagent-governance/) | 0.1.4 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-subagent-governance) | Read `skill://subagent-governance`. Package tests passed. |
| [pi-skill-tauri-django-react](pi-skill-tauri-django-react/) | 0.2.3 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-tauri-django-react) | Read `skill://tauri-django-react`. |
| [pi-skill-tech-debt-tracker](pi-skill-tech-debt-tracker/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-tech-debt-tracker.svg) | Read `skill://tech-debt-tracker`. |
| [pi-skill-tech-deep-dive](pi-skill-tech-deep-dive/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-tech-deep-dive.svg) | Read `skill://tech-deep-dive`. |
| [pi-skill-test-plan-generator](pi-skill-test-plan-generator/) | 0.1.5 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-test-plan-generator.svg) | Read `skill://test-plan-generator`. |
| [pi-skill-unslop](pi-skill-unslop/) | 0.1.2 | Works on OMP | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-unslop.svg) | Read `skill://unslop`. |
| [pi-skill-vulnerability-scanner](pi-skill-vulnerability-scanner/) | 0.1.5 | Skill verified | [Untested on omp](https://omppackages.com/packages/@firstpick/pi-skill-vulnerability-scanner) | Read `skill://vulnerability-scanner`. |

## Vendored packages

These five rows describe direct links to the child directories. The parent bundle has its own result above.

| Local package | Version | Status | omp packages catalog | Observed behavior |
|---|---|---|---|---|
| [pi-extension-memory-helper](pi-package-skill-lifecycle/vendor/pi-extension-memory-helper/) | 0.1.9 | Registered | [Not listed](https://omppackages.com/badge/@firstpick/pi-extension-memory-helper.svg) | Registered `/remember`, `/memory-search` and 5 more. 6 added tools, including `remember_note`. |
| [pi-skill-skill-bank-manager](pi-package-skill-lifecycle/vendor/pi-skill-skill-bank-manager/) | 0.1.0 | Registered | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-skill-bank-manager.svg) | Read `skill://skill-bank-manager`. Registered `/skillbank-audit`, `/skillbank-overlap` and 1 more. 4 added tools, including `skillbank_audit`. |
| [pi-skill-skill-creator](pi-package-skill-lifecycle/vendor/pi-skill-skill-creator/) | 0.1.0 | Registered | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-skill-creator.svg) | Read `skill://skill-creator`. 3 added tools, including `skill_create_draft`. |
| [pi-skill-skill-evaluator](pi-package-skill-lifecycle/vendor/pi-skill-skill-evaluator/) | 0.1.0 | Registered | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-skill-evaluator.svg) | Read `skill://skill-evaluator`. 2 added tools, including `skill_eval_run`. |
| [pi-skill-skill-refinement-loop](pi-package-skill-lifecycle/vendor/pi-skill-skill-refinement-loop/) | 0.1.0 | Registered | [Not listed](https://omppackages.com/badge/@firstpick/pi-skill-skill-refinement-loop.svg) | Read `skill://skill-refinement-loop`. 1 added tool, including `skill_refinement_plan`. |

## Other manifests

These components have no OMP extension or skill contract. Their product-specific services, test applications and runtime patches were outside the compatibility runs.

| Manifest | omp packages catalog | Purpose |
|---|---|---|
| [package.json](package.json) | N/A | Private repository root |
| [patches/pi-anthropic-provider-dist-compat/package.json](patches/pi-anthropic-provider-dist-compat/package.json) | N/A | Runtime patch for its named host |
| [patches/pi-coding-agent-session-scoped-model-effort/package.json](patches/pi-coding-agent-session-scoped-model-effort/package.json) | N/A | Runtime patch for its named host |
| [patches/t3-pi-native-todo/package.json](patches/t3-pi-native-todo/package.json) | N/A | Runtime patch for its named host |
| [services/issue-bot-gateway/package.json](services/issue-bot-gateway/package.json) | N/A | Standalone gateway service |
| [pi-extension-gui-testing/testapps/electron/package.json](pi-extension-gui-testing/testapps/electron/package.json) | N/A | Electron GUI test app |
| [pi-skill-repo-explorer/skills/repo-explorer/tests/fixtures/bash-usage-corpus/repo/package.json](pi-skill-repo-explorer/skills/repo-explorer/tests/fixtures/bash-usage-corpus/repo/package.json) | N/A | Synthetic repository fixture |

## How the checks ran

Each local checkout was linked with `omp plugin link` in its own temporary home. A clean RPC control established the built-in commands and tools. The probes checked startup errors, `get_state`, `available_commands_update`, registered tool names, and command notifications. A linked manifest alone earned no readiness credit.

For skills, `omp read skill://NAME` checked URI resolution. For each standalone skill a scripted loopback provider asked the real OMP read tool for that URI and received its contents on the next request. This checks delivery. It does not measure whether a model follows the instructions or produces good work. All 16 top-level skill packages with an npm test script also passed their package suites.

For the four updated prompt packages, the tests extracted fresh npm archives and loaded them together in Pi 1.6.0 and OMP 19.2.1. A scripted local provider captured each of the 28 available OMP commands after expansion. These checks covered prompt delivery and caller arguments. They did not execute the tasks described by the templates.

A separate loopback tool call exercised ArchWiki, wiki template discovery, workflow status, reliability status, skill memory listing and workbook inspection. Only the specified commands and paths were exercised. Authenticated provider calls, interactive TUI behavior, publishing, live Web UI sessions, interactions between extensions installed together, and npm registry installs remain unverified.

The theme check ran all package JSON files through the validator from the matching upstream tag. [OMP 19.2.1 theme validator](https://github.com/can1357/oh-my-pi/blob/v19.2.1/packages/tui/src/theme/schema.ts)

To repeat a package discovery check, run this from the repository root. Replace the package and skill names as needed.

```bash
pkg="$PWD/pi-skill-architecture-review"
scratch=$(mktemp -d)
mkdir -p "$scratch/work" "$scratch/home"
(
  cd "$scratch/work" || exit 1
  isolated_omp() { env -i HOME="$scratch/home" PATH="$PATH" omp "$@"; }
  isolated_omp plugin link "$pkg"
  printf '%s\n' '{"type":"get_state"}' | isolated_omp --offline --no-session --mode rpc --no-ui
  isolated_omp read skill://architecture-review
)
```
