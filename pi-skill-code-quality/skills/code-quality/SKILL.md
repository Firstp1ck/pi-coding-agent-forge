---
name: code-quality
description: Agents should invoke this skill whenever they write or edit code in permanent files, including source, scripts, tests, examples, migrations, notebooks, and configuration-as-code. Apply it before and throughout every such write, regardless of language or change size. Improve the code directly within the authorized task, not just review it afterward. Also use for explicit code-quality reviews, keeping review-only requests read-only.
license: MIT
compatibility: Requires access to the code being written. Guidance works without analyzers. The optional scanner needs Node.js; Git comparisons need Git. The Git-only path has Linux evidence. Optional structural evidence remains Windows x64-pinned only.
---

# Code Quality

Write code that is correct, clear, and easy to change. Improve it as you write it, rather than leaving avoidable problems for a later review.

## Always apply to permanent code

Load this skill before creating or editing code that will remain in a file. Apply it throughout the task and to every subsequent code write. A one-line fix is not exempt. You do not need to reload unchanged instructions before each write.

Permanent means intended to survive the task, whether tracked by Git or not. This includes application and library source, scripts, tests and fixtures, saved examples, migrations, notebook code cells, configuration-as-code, and code embedded in retained HTML, templates or documentation. Apply it when promoting a temporary prototype into a permanent file, too.

The writing method does not matter: direct writes, edits, patches, generated code and delegated implementation all follow the same standard. Give delegated writers this requirement within their assigned scope. For generated or vendored output, respect repository policy and improve the authorized source or generator instead of hand-editing protected artifacts.

Prose-only changes, explanations or code snippets shown only in chat, and disposable scratch experiments with no retained code do not require this skill. Explicit code-quality reviews still use its inspection criteria.

This is an always-apply instruction for the agent, not a filesystem hook. The skill does not intercept writes or guarantee that a model invokes it. It does not require a scanner run, extra edits or a formal report for every save.

## Work inside the requested task

A request to write or change code authorizes applying these quality practices to that code. Make justified local improvements directly; do not ask for a separate cleanup approval merely to write the requested code well.

An explicit **review-only** or **do not edit** request stays read-only. Inspect and explain findings without applying them. Loading the skill never grants permission to write code when the user only asked a question or requested a review.

Preserve the user's existing changes and the requested behavior. Ask before unrelated cleanup, public-interface changes beyond the request, broad architectural work, new dependencies or edits outside the authorized scope. Existing project policy takes precedence over language examples and measurements.

## Writing process

### 1. Understand the code before changing it

Read the applicable instructions, nearby implementation, callers and relevant tests. Identify the intended behavior, trust boundaries, failure modes and compatibility constraints.

Inspect staged, unstaged and relevant untracked changes. Distinguish your edits from existing work. `HEAD` is not the task's starting state in a dirty workspace. Find an existing implementation before adding a helper, wrapper or dependency.

Choose the smallest coherent change and the checks that can verify it. For a small edit, a focused inspection is enough; do not turn it into a repository-wide audit.

### 2. Write and improve together

Apply these criteria while composing every permanent code change:

- **Keep correctness first.** Implement the requested behavior, including failure cases. Do not remove validation, security checks, error handling or compatibility guards to shorten the code.
- **Make control flow explicit.** Prefer straightforward branches, clear names and cohesive functions over clever expressions or layers of forwarding wrappers.
- **Keep responsibilities together.** Split a function when it owns distinct responsibilities, not to satisfy an invented line or complexity limit. Avoid a maze of tiny helpers.
- **Reuse actual shared behavior.** Remove accidental duplication when the behavior and ownership really match. Similar-looking code with different contracts need not share an abstraction.
- **Validate at real boundaries.** Check external or untrusted inputs where they enter. Avoid repeated defensive checks for invariants already established inside the same trusted boundary.
- **Make failures and lifetimes visible.** Handle errors deliberately, release resources and account for cancellation, timeouts and partial work where relevant. Do not swallow a failure or retry without a bound.
- **Avoid speculative machinery.** Do not add generic frameworks, fallback paths, configuration, dependencies or extension points without a present requirement.
- **Use comments for reasons.** Explain non-obvious constraints and trade-offs, not what each line does. Remove stale comments and debugging residue from task-owned code.
- **Write meaningful tests.** Verify behavior and important edge cases. Keep characterization tests when behavior must be preserved; do not weaken tests to make a cleanup pass.

A useful temporary variable, wrapper, explicit type or extra branch can improve clarity or safety. Fewer lines are not automatically better code.

### 3. Inspect and finish the change

Read the resulting diff and changed code before declaring completion. Correct concrete problems you introduced or touched within scope rather than merely listing them as suggestions.

If additional local cleanup is justified, make **one focused pass** addressing at most **three confirmed findings** beyond the requested implementation. This bounds extra cleanup, not the quality practices applied while writing. Ask before a second extra pass or a broader redesign. Do not force a change when the code is already clear.

Run the relevant authorized project tests, type checks, lint checks, formatter checks or build. Rerun affected checks after an improvement. **Failed checks take priority** over optional structural cleanup. Tests and check-mode tools can execute code or write caches; choose actual project commands and respect their authorization. Do not run a modifying formatter in a read-only review.

If an improvement fails, correct it or undo only your isolated edits when safe. Never use a blanket Git rollback that discards the user's work.

### 4. Close with evidence, not ceremony

For small edits, briefly report what changed and what was checked. For larger changes, also identify important quality improvements, accepted trade-offs, deferred findings and missing evidence. Do not invent verification or claim that passing tests prove correctness.

Do not save workspace memory or a separate report unless the user requests a destination. The normal response is enough.

## Optional measurement feedback

The writing process is mandatory for permanent code; measurement is optional. Use the local scanner when scoped evidence can clarify a larger change, suspected duplication or a growing responsibility. Missing tools do not block writing good code.

When useful, capture or describe **S0** before task-owned edits, **S1** after implementation, and **S2** after a justified cleanup. Keep scope, tools and definitions compatible so feature cost and cleanup effects remain distinct. If no pre-task S0 exists, say so; do not reconstruct it from a dirty `HEAD` comparison.

The scanner only collects evidence. It never installs tools, runs project checks, applies fixes, formats files, commits, stashes, resets or publishes. Its existing operations are:

```bash
node <installed-skill-dir>/scripts/scan.mjs scan --base HEAD --scope src --format human
node <installed-skill-dir>/scripts/scan.mjs snapshot --scope src --format human
node <installed-skill-dir>/scripts/scan.mjs compare --before <saved-s0-or-s1.json> --after <saved-s2.json> --format human
```

Persistent snapshots require an explicit `--out` destination outside selected source roots. See [scanner options and safety](../../TECHNICAL.md) before using optional tools or saved output.

Treat increases as prompts to inspect, not automatic defects or merge blockers. Keep physical lines, direct dependencies, AST candidates and token clones separate. Missing or partial evidence is never a clean result. Live callable complexity, analyzer-defined SLOC, erosion and the combined verbosity proxy remain unavailable. Do not substitute line counts or lint warnings for these measurements.

## Related workflows and references

An available architecture-review skill can help with broad design decisions, refactoring-advisor with planning a refactor, and code-security with a dedicated security assessment. None replaces applying code-quality when the resulting code is written. They are optional workflows, not dependencies or automatic handoffs.

- [Opt-in language checks and security guidance](references/language-checks.md)
- [How to interpret measurements](references/measurement-guide.md)
- [Scanner commands, optional tools, limits and privacy](../../TECHNICAL.md)
- [Contributor contract and evaluation protocol](../../DEVELOPMENT.md)
