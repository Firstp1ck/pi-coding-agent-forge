---
name: code-quality
description: Review a substantial code change or refactor for maintainability, duplication, complexity evidence, correctness risks, and useful project checks. Use for read-only review by default, or for one explicitly authorized focused cleanup pass.
license: MIT
compatibility: Requires repository read access. The optional local scanner needs Node.js; Git comparisons need Git. The Git-only path has current Linux evidence. Optional structural evidence remains Windows x64-pinned only.
---

# Code Quality

Review a change before proposing cleanup. Prefer a concrete maintenance or correctness problem over a style preference or a lower number.

## Use this skill for

- a substantial implementation, refactor, or change that needs maintainability review;
- duplication, growing functions, dependency changes, warnings, or unclear ownership in code;
- a request to set up or review project quality checks without replacing repository policy;
- one small behavior-preserving cleanup after the user authorizes it.

Do not use this skill for prose editing, a simple code explanation, a non-code task, or an open-ended architecture redesign. Use an available architecture-review skill for a broader design boundary, an available refactoring-advisor skill for a planned refactor, or an available code-security skill for a dedicated security review. Those skills are optional related workflows, not requirements or automatic handoffs.

## Default mode and authorization

Start in **review-only** mode unless the request explicitly authorizes implementation or cleanup. Review-only work may inspect code and produce a report, but it does not edit reviewed files, apply fixes, run modifying formatters, write workspace memory, or persist a report automatically.

Project instructions and the user's authorization control every project check. Tests, builds, type checks, linters, and even check modes can execute code or write caches. Do not run a command only because a language example mentions it. Use an existing project command when it is relevant and authorized.

The local scanner collects evidence only. It does not run project checks, install tools, download tools, apply fixes, format files, commit, stash, reset, or publish.

## Workflow

### 1. Establish scope and S0

1. Read applicable repository instructions, the requested change, relevant architecture, package boundaries, and existing checks.
2. Inspect staged, unstaged, and relevant untracked work before attributing a difference to this task. `HEAD` can be a review baseline, but it is not the task baseline in a dirty workspace.
3. Record whether the request is review-only or authorizes edits. Discover available verification commands and missing tools without changing configuration.
4. Choose fixed module or package roots. Capture or describe the initial observation as **S0** before task-owned edits when possible. If invocation happens after implementation, state that a pre-task S0 is unavailable instead of attributing all worktree differences to the task.

For a Git review, the scanner requires an explicit baseline and at least one scope:

```bash
node <installed-skill-dir>/scripts/scan.mjs scan --base HEAD --scope src --format human
```

For a current-only observation, use `snapshot` with an explicit scope. It writes no saved report unless `--out` is supplied:

```bash
node <installed-skill-dir>/scripts/scan.mjs snapshot --scope src --format human
```

### 2. Implement and verify S1

1. Make only the requested change using repository conventions. Do not reduce lines at the expense of clarity, safety, compatibility, or behavior.
2. Run relevant, authorized correctness checks. Failed checks take priority over optional structural cleanup.
3. Capture or describe the post-implementation observation as **S1** with the same scope and compatible settings. Separate feature cost from pre-existing work and from any later cleanup.

### 3. Inspect and optionally clean up

Inspect changed functions and nearby code first. A measured increase starts an inspection; it is not a merge blocker or an automatic refactoring instruction.

Look for:

- repeated branches that implement the same behavior;
- a function that acquired an unrelated responsibility;
- an existing abstraction that should be reused before another one is added;
- direct dependency changes, module direction, lifecycle ownership, and cohesion concerns;
- guards, wrappers, temporary variables, validation, and error handling that protect a real trust or compatibility boundary.

When a cleanup is explicitly authorized, make **one focused pass** on at most **three confirmed findings** in the touched scope. Keep public behavior, error handling, security checks, and compatibility intact. Add characterization coverage first when it is needed. Do not extract helpers merely to lower a metric. A helper needs a meaningful responsibility boundary; many tiny helpers can make navigation worse.

Ask before broad architectural work, a second cleanup pass, or edits outside the agreed scope. If a cleanup fails, do not use a blanket rollback. Undo only safe, isolated edits owned by that cleanup, or report the failure.

### 4. Recheck and report S2

1. Rerun affected authorized correctness gates after cleanup, plus broader checks when risk warrants them.
2. Capture or describe **S2** using the same scope, tools, and definitions as S0 and S1. Saved snapshots can be compared only when they are compatible:

   ```bash
   node <installed-skill-dir>/scripts/scan.mjs compare --before <saved-s0-or-s1.json> --after <saved-s2.json> --format human
   ```

3. Classify each finding as fixed, accepted with a reason, deferred, false positive, or blocked by missing evidence. A larger metric can be the right outcome.
4. Report scope, baseline, dirty-start attribution, evidence, checks run or not run, tool coverage, and unresolved risks. Write a persistent report only to a location the user explicitly requests.

## Use scanner evidence carefully

The scanner has three operations: `scan`, `snapshot`, and `compare`. It requires explicit scope for capture and explicit baseline for `scan`. `--include-untracked`, `--git`, `--ast-grep`, `--jscpd`, `--format`, and `--out` are opt-in options where supported by the selected operation. See [scanner use and limits](../../TECHNICAL.md) before choosing optional tools or a saved output path.

Treat unavailable or partial evidence as a limitation, not a clean result. Current scanner reports physical lines and direct npm dependency changes where coverage permits. Callable complexity, analyzer-defined SLOC, erosion, and the combined verbosity proxy are intentionally unavailable until a complete callable-analysis contract exists. Optional AST-pattern and token-clone evidence has its own coverage limits.

## Review prompts

Ask for the scope and mode you need:

> Review this change against its dirty-start baseline. Do not edit files or save a report. Focus on correctness and repeated error handling in `src/auth`.

> Inspect `src/parser` after this implementation. Run the project's authorized checks, then propose no more than three behavior-preserving cleanup candidates. Do not apply them yet.

> Perform one authorized cleanup pass for the confirmed duplicate validation branches in `lib/import`. Preserve the existing error messages and rerun the affected tests.

## References

- [Language and security review examples](references/language-checks.md)
- [How to interpret measurements](references/measurement-guide.md)
- [Scanner commands, optional tools, limits, privacy, and troubleshooting](../../TECHNICAL.md)
- [Contributor contract and evaluation protocol](../../DEVELOPMENT.md)
