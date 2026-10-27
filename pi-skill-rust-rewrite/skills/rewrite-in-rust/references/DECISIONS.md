# User decision catalogue

The decisions in this file belong to the user, not to the agent. Step 2 of [SKILL.md](../SKILL.md) collects round one once after the assessment; step 5 collects round two once after the pilot. Every entry has a stable ID, a recommended answer, and the record it lands in. Use the IDs in the contract, the rulebook, and the manifest so a later session can see which choice governs a unit.

## How to run a round

1. Settle from evidence everything the code can answer. Record those entries as `discovered`, with the file or count that settled them, and do not ask the user to repeat them.
2. Drop entries that do not apply, for example framework decisions for a C library, and say which were dropped.
3. Ask first whether the user accepts every recommended answer; that is a valid answer and the minimal-intervention path. Entries marked "no default" are excluded from that question and asked in the same round. If accepted, record the other remaining entries as `default accepted`. Otherwise present them with the recommended answer and a one-line reason, ordered by catalogue group, in as few rounds as the interface allows.
4. Hold an entry for a later round only when its question depends on an unanswered one.
5. Record each answer in the contract's decision table: ID, answer, source (`interview`, `questionnaire`, `conversation`, `discovered`, `default accepted`, or `dropped`), date. A recorded ID is not asked again unless answers conflict or evidence changes.
6. If the user postpones an entry, list it as open and keep dependent work out of the next batch.

A saved interview or questionnaire result tied to this migration and round counts as answers; an unfinished result supplies the answers it contains, and only the IDs it leaves open are asked. A generic result that does not name this migration does not count. Never ask for passwords, tokens, or other secrets. In Pi, use the interview and questionnaire protocol in the SKILL.md Pi adapter.

## Round one, after the assessment

### Scope

**D-SCOPE-01 Boundary.** Which modules move to Rust in this migration, and which stay in the source language?
Choices: the boundary the assessment proposed; a narrower boundary; a wider boundary, named.
Default: the assessment's boundary, because it sits where interfaces and tests already exist.
Lands in: contract boundary; manifest unit list.

**D-SCOPE-02 Strategy.** Incremental replacement, separate complete port, or redesign?
Choices: the three strategies in SKILL.md step 4.
Default: incremental replacement when the program must keep working and the boundary has usable interfaces; otherwise the strategy the assessment evidence supports.
Lands in: contract strategy; interop decisions in [SOURCE-LANGUAGES.md](SOURCE-LANGUAGES.md).

**D-SCOPE-03 Motivation ranking.** Rank what the migration must deliver: memory safety, performance, maintainability, binary size, dependency reduction, platform reach, other.
Default: the ranking stated in the request; if none, memory safety first and performance parity second.
Lands in: contract acceptance criteria. The ranking decides which evidence the acceptance step must show.

**D-SCOPE-04 Source changes during the port.** Freeze the source at the pinned revision until acceptance, or keep tracking source commits in a parity ledger?
Choices: freeze; track with the ledger; track only security fixes.
Default: freeze when the port should finish within one release cycle; otherwise track with the ledger in [RECORDS.md](RECORDS.md).
Lands in: contract; parity ledger.

### Compatibility surface

One decision per interface. Answer each with keep, change with a recorded deviation, or not applicable.

**D-COMPAT-01 Public API.** Names, signatures, and semantics of exported functions and types.
Default: keep for every caller outside the boundary.

**D-COMPAT-02 Command line.** Flags, exit codes, stdout and stderr bytes, ordering.
Default: keep byte-for-byte; normalize only documented nondeterminism.

**D-COMPAT-03 Files and persistence formats.** Written bytes, permissions, hashes, version markers.
Default: keep byte-identical where the original writes them.

**D-COMPAT-04 Wire protocols.** Message formats, ordering, timeouts, error frames.
Default: keep; prove with recorded exchanges.

**D-COMPAT-05 Error messages and diagnostics.** Text that users or scripts may match on.
Default: keep text; allow richer structured errors only behind the boundary.

**D-COMPAT-06 Locale and formatting.** Translations, number, date, and currency formatting, collation.
Default: keep; note that Rust format strings are compile-time, so translatable output needs a runtime formatter.

**D-COMPAT-07 Configuration.** Config files, environment variables, defaults, precedence.
Default: keep names, formats, and precedence.

### Targets and build

**D-TARGET-01 Platform matrix.** Which operating systems and architectures must pass at acceptance, and which may lag behind?
Default: every platform the original releases for; name the ones allowed to lag and the condition for closing the gap.
Lands in: contract supported configurations; acceptance evidence.

**D-TARGET-02 Toolchain floor.** Minimum supported Rust version, edition, and whether `no_std` or a restricted allocator is required.
Default: current stable edition; the lowest Rust version the project's CI already installs, otherwise current stable; `no_std` only when the assessment found a target that needs it.

**D-TARGET-03 Build system responsibilities.** Which of code generation, install targets, documentation, man pages, scripts, feature detection, and localization stay with the existing build system, and which move to cargo or a replacement?
Default: keep the existing build system driving everything cargo does not do; cargo alone installs none of those artifacts.

### Oracle

**D-ORACLE-01 Acceptance judge.** Which test suites, fixture sets, or recorded outputs decide acceptance?
Default: every suite that runs through the public surface, unchanged, against both implementations.

**D-ORACLE-02 Internal tests.** Tests that import source-language internals: port them with their unit, replace them with a parity harness over the public surface, or drop them with justification?
Default: port them as test units when the unit they protect is ported; build a parity harness when the public-surface judge would otherwise be too thin.

**D-ORACLE-03 Comparison policy.** Bytes, normalized text, or numeric tolerance, and which nondeterminism is documented and normalized.
Default: bytes; tolerance only for floating-point output the original already documents as approximate.

**D-ORACLE-04 Defined defects in the source.** Reproduce source defects bug-for-bug and fix them later, or fix them during the migration?
Default: bug-for-bug, each marked in code and listed in the contract, with fixes shipped as separate flagged changes after acceptance.

### Rust policy

**D-RUST-01 Unsafe policy.** The SKILL.md default (unavoidable FFI plus benchmarked hot paths), forbid everywhere, or a looser policy with a register?
Default: the SKILL.md default. Forbid everywhere means a retained native library needs a separate process or another boundary.

**D-RUST-02 Error handling style.** Hand-written error types, `thiserror`, `anyhow` at the application boundary, and the panic policy.
Default: what the project already uses; otherwise typed errors in libraries and an opaque error type only in the binary.

**D-RUST-03 Async runtime.** None, the runtime the project already uses, or a named runtime.
Default: the existing runtime; none when the source is synchronous.

**D-RUST-04 Strings and bytes.** Validated UTF-8, bytes, or both, and how paths are represented.
Default: `&str`/`String` where the source guarantees UTF-8, `&[u8]` where it does not, `Path`/`OsStr` for paths.

**D-RUST-05 Crate layout.** One crate, a workspace by subsystem, or a mapping the user names.
Default: the simplest layout that keeps the dependency graph acyclic; not one crate per source directory.

**D-RUST-06 Dependencies.** Allowed crates, license limits, vendoring, and which native libraries stay.
Default: crates the project already depends on plus the allow-list proposed in the assessment; license limits from the project's policy.

### Frameworks and services

Only for sources that use them.

**D-FRAME-01 Framework replacement.** For each framework service in use (routing, authentication, ORM and migrations, templating, background jobs, logging, serialization, CLI parsing): replace with a named crate, bridge to the original through interop, or keep in the source language.
Default: no default. Each service is a design decision with an end-to-end pilot path.

**D-FRAME-02 External services.** Databases, queues, and remote APIs that stay external, and the clients that reach them.
Default: keep every external service and its protocol; replace only the client code.

### Process

**D-PROC-01 Rulebook amendment authority.** The user approves every amendment; the agent applies behavior-neutral clarifications and logs them, queuing the rest; or the agent applies all amendments.
Default: the middle option. Any amendment that changes public behavior, the unsafe policy, or a compatibility decision waits for the user.

**D-PROC-02 Review.** Independent reviewers required, and how many per unit.
Default: two reviewers in separate contexts where the environment provides them; one separate pass with a stated limitation otherwise.

**D-PROC-03 Parallelism and resources.** Maximum workers, worktrees, build concurrency, memory and disk limits.
Default: one worker and one build at a time; when parallel work is authorized, a bounded two-worker trial in the pilot measures contention and sets the counts.

**D-PROC-04 Delivery.** Branch, change granularity (per unit, per batch, per tier), who merges, and when the source code is retired.
Default: one branch; one reviewable change per batch; the user merges; the source is retired only after acceptance with a recoverable reference.

**D-PROC-05 Spending limits.** Token, cost, and wall-clock caps, and what to do at the cap.
Default: stop at the cap, preserve evidence, and report the next bounded action. The pilot refines the cap in round two.

## Round two, after the pilot

**D-BUDGET-01 Estimate approval.** Units times the per-unit cost measured in the pilot: tokens or turns, wall-clock, review findings, repair rounds, attention minutes. Present the band, the drivers, and the resource plan.
Default: no default. Scaling without an approved estimate is not minimal intervention; it is an unapproved spend.

**D-BUDGET-02 Model plan.** Which model or tier runs each phase when more than one is available.
Default: the plan the pilot measured as adequate for each phase.

**D-DESIGN-nn Redesigns.** One decision per redesign that changes a public signature, data layout, or module boundary because the direct translation would need `unsafe` or cannot be expressed safely.
Default: the safe design the pilot verified, with the benchmark that shows it meets the budget.

**D-DEV-nn Deviations.** One decision per intentional behavior difference found so far.
Default: no default. Each deviation is recorded with the source location and the reason.

**D-RULE-nn Queued amendments.** Rulebook amendments queued during the pilot, under the authority chosen in D-PROC-01.

## Recording format

Use this table in the contract:

```text
| ID          | Answer                                   | Source           | Date       |
| D-SCOPE-01  | src/parser/ only; CLI stays in C         | interview        | 2026-10-15 |
| D-COMPAT-02 | keep byte-for-byte                       | default accepted | 2026-10-15 |
| D-RUST-03   | none; source is synchronous              | discovered       | 2026-10-15 |
| D-FRAME-01  | not applicable (C library)               | dropped          | 2026-10-15 |
```
