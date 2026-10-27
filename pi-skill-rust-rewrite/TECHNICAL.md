# Technical reference: Rewrite in Rust

Advanced usage, requirements, decision rounds, records, compatibility, and operational limitations.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Requirements

Use a Pi installation that supports skill packages. The package has no runtime dependencies or required settings, API keys, or services.

Assessment needs access to the source repository and its documented contracts. Implementation and verification need the source-language toolchain, an appropriate Rust toolchain, and any project-specific libraries or services. Diagnostic tools such as Miri, sanitizers, or fuzzers are optional and depend on the migration's risks and supported targets. The skill does not install these tools automatically.

The Grill Me extension (`@firstpick/pi-extension-grill-me`) is optional. With it installed and an interactive terminal or RPC session, Pi can offer a questionnaire-based interview for the decision rounds. Without it, Pi asks the same decisions through the questionnaire extension when that is installed, or in the conversation.

The guidance adapts to the actual source language and target platform; it does not promise that Rust can replace every framework, dependency, or application.

## Install and invoke

```bash
pi install npm:@firstpick/pi-skill-rust-rewrite
```

Run `/reload` in a running Pi session after installation, or start a new session. Pi can select the skill from a matching request; explicitly select it with:

```text
/skill:rewrite-in-rust Assess this Python service for an incremental Rust migration. Do not edit files.
```

Use `pi list` to check package registration and `pi config` to check that its skill is enabled. The npm package name is `@firstpick/pi-skill-rust-rewrite`; its skill command is `rewrite-in-rust`.

## Scope and expected results

- **Assessment:** feasibility, risks, a scale classification (bounded unit or large-scale), required evidence, a recommended boundary, a banded cost estimate, and the list of decisions that need you. A partial migration or no migration may be the right conclusion.
- **Decisions:** a fixed list with recommended answers, collected once after the assessment and once after the pilot. See [Your decisions](#your-decisions).
- **Planning:** an incremental replacement, separate complete port, or explicitly requested redesign with compatibility requirements, a migration contract, and acceptance checks.
- **Implementation:** scoped Rust changes, integration, and verification where the repository and available tools permit it.
- **Continuation:** inspect saved migration records and current files before resuming; do not treat stale test results as evidence for changed code.

Specify whether you want assessment, planning, or implementation. Keep architectural redesign and fixes to existing defined defects separate unless you explicitly include them.

## Your decisions

Some choices cannot be read from the code, so Pi asks you for them instead of guessing. They fall into seven groups:

- scope and strategy, including what to do with source changes made during the port;
- the compatibility surface: public API, command line, file formats, protocols, error text, locale, configuration;
- targets and the build system: platforms, toolchain floor, and what the existing build system keeps doing;
- the acceptance oracle: which tests decide, what happens to tests that import internals, how Pi compares outputs, and whether source defects stay bug-for-bug;
- Rust policy: unsafe policy, error handling, async runtime, strings, crate layout, dependencies;
- frameworks and external services, for applications that use them;
- process: review, parallelism, delivery, spending caps, and who approves rule changes.

Round one comes after the assessment. Round two, after the pilot, covers the cost estimate, redesigns that change public signatures, intentional deviations, and queued rule changes.

Every decision comes with a recommended answer and a reason. The first question of each round asks whether you accept all recommended answers; saying yes answers every entry that has a recommendation, and the few without one, such as the cost estimate, are still asked in the same round. Pi records decisions the code settles on its own as discovered, with the evidence, and does not ask them. Answers go into the migration contract with their source and date. Pi asks again only when answers conflict or the evidence changes.

Pi offers Grill Me but never starts it on its own and never answers its questionnaires. Starting `/grill-me` replaces that project's current interview state; save an earlier result first if you want to keep it. Do not enter secrets in questionnaires.

## Records written into your project

When you authorize file changes, Pi writes working records under `migration/` in the target repository unless the repository documents another place for plans or design records:

```text
migration/
  ASSESSMENT.md        the assessment, with the decisions that need you
  PILOT.md             the pilot report, with the cost estimate and round-two decisions
  CONTRACT.md          the single source of truth, including your decisions
  RULEBOOK.md          translation rules with stable IDs and a change log
  inventory.tsv        ownership and boundary sites
  types.tsv            observed types, for Python, JavaScript, and similar sources
  manifest.tsv         one row per unit of work (large-scale ports)
  parity-ledger.tsv    source commits after the pinned revision (when tracked)
  unsafe-register.tsv  every permitted unsafe block
  evidence/            build logs, check results, benchmark output
  *.grill-me.md        saved Grill Me results, when you ran the interview
```

Decide whether to commit or ignore these files; Pi records the choice in the contract. For an assessment-only request, Pi returns the assessment in the reply and writes nothing. Removing the package does not remove these files.

## Large-scale ports

A whole application, a boundary above roughly thirty thousand lines or fifty units, crate-level dependency cycles, parallel workers, more than a few sessions, or several target platforms make the migration large-scale. Expect:

- a dependency map, cycle-breaking work, and dependency tiers before translation starts;
- small project-specific helpers (dependency map, manifest status, build owner, guardrails, resource limits) written into your repository or a scoped workspace and reviewed like project code;
- one process building per integrated checkout, with workers that never run the build tool in a shared checkout;
- worktrees with their own build directories or a shared cache, and disk and memory limits you set;
- a cost estimate from the pilot that you approve before the bulk of the work, and a stop at the cap you set;
- more than a few sessions, each resumed from the manifest and the latest build log rather than from a summary.

No executable tooling is bundled. The helpers are created per project and stay with it.

## Safety and verification limits

The package provides instructions and reference documents, not executable migration helpers. An agent following it may run builds, create project-specific comparison tools and helpers, and edit the target project within the authorized scope.

Preserve a recoverable original and compare both implementations through an appropriate external interface. Use isolated fixtures rather than replaying production writes. Do not reproduce undefined behavior or introduce unsound Rust merely to imitate the original.

## Rust style and unsafe code

The skill asks for idiomatic Rust rather than a line-by-line transliteration. Error codes become `Result`, null values become `Option`, manual cleanup becomes ownership, and tagged unions become enums. Observable behavior, interfaces, and module responsibilities stay compatible.

When the original design would need `unsafe` Rust, such as back-pointers, self-referencing structures, or mutable globals, the agent should redesign that part in safe Rust and record the change. It permits `unsafe` in only two cases:

- calling a native library or C interface that the migration keeps;
- a small hot-path block where a benchmark shows the safe version misses an agreed performance target.

Each remaining `unsafe` block should have a written justification, a safety argument, and a safe version kept for comparison tests. If you want a stricter rule, such as no `unsafe` at all, choose it in the decision round; a retained native library then needs a separate process or another boundary.

A successful build does not prove behavioral compatibility, soundness, performance, or release readiness. Missing toolchains, unavailable source builds, incomplete fixtures, and unsupported safety checks must remain named limitations. Publication, deployment, external merges, and source retirement are not implied by a migration request.

## Compatibility and configuration

No package-specific configuration is required. The workflow is portable Agent Skills guidance; hosts other than Pi must provide their own skill installation and discovery mechanism. Outside Pi, the decision rounds run as ordinary questions in the conversation.

Independent reviewers and parallel workers are optional and require available, authorized facilities. Without them, the agent should disclose that review was not independent.

Background links in the skill are optional reading. Running the workflow does not require fetching those sources, although the target project's builds or dependencies may need network access.

## Updates and removal

```bash
pi update npm:@firstpick/pi-skill-rust-rewrite
pi remove npm:@firstpick/pi-skill-rust-rewrite
```

Reload or restart Pi after changing the installed skill. Removing the package does not undo changes already made in a target project; use that project's version control and recovery process.

## Troubleshooting

- **The skill is missing:** check `pi list` and `pi config`, then run `/reload` or restart Pi.
- **The wrong skill is selected:** enter `/skill:rewrite-in-rust` with your request. If Pi reports a duplicate skill name, disable the duplicate copy.
- **Grill Me is not offered or will not start:** it needs an interactive terminal or RPC session and its questionnaire extension enabled. Pi falls back to asking the decisions in the conversation; answer there or say "use the recommended answers".
- **Pi keeps asking the same decision:** check that the contract's decision table has the entry. A missing entry, a conflicting answer, or changed evidence are the only reasons to ask again.
- **The original cannot build:** share the failure and any specifications or fixtures. Verification claims must be narrower when the original cannot run.
- **Rust checks cannot run:** provide the required toolchains and supported target, or request an assessment-only result. Installing this package does not supply build tools.
- **Resuming after a break:** point Pi at the migration directory. It reads the contract, manifest, and latest build log before continuing and does not trust the previous session's summary.
- **The migration stalls:** ask for the exact blocker, preserved evidence, and next bounded action rather than relaxing compatibility or safety checks.
- **The estimate looks too high:** narrow the boundary, drop internal test ports in favor of a parity harness, or freeze the source. Pi re-estimates from the pilot numbers; it does not lower acceptance criteria to fit a budget.
