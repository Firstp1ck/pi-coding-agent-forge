# Language and security review examples

Repository policy comes first. These are opt-in examples for a request that needs them, not the user's standards, a replacement for existing tooling, or a reason to change configuration. Confirm the project's commands and authorization before running any check.

## Optional configuration profiles

The profiles below preserve useful starting points from the earlier skill. Adopt one only when the repository already uses it or the user explicitly asks for it. Do not add these settings, change a compiler target, enable a lint group, or treat a profile's warnings as merge blockers by default.

### Rust

Review behavior before style. Check error propagation, ownership at API boundaries, unsafe code, feature combinations, public compatibility, and error messages that callers may depend on.

A repository that deliberately wants these Clippy policies can keep them in its existing `Cargo.toml`:

```toml
[lints.clippy]
cognitive_complexity = "warn"
pedantic = { level = "deny", priority = -1 }
nursery = { level = "deny", priority = -1 }
unwrap_used = "deny"
```

This is not a universal Rust profile. `pedantic`, `nursery`, and `unwrap_used` can conflict with an established codebase or compatibility boundary. Treat an `unwrap`, an `allow`, or a missing documentation item as context to inspect, not as a universal violation.

When the repository uses the relevant tools and the request authorizes them, common read-oriented checks include:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo check
cargo test
```

Do not run `cargo fmt` as part of a read-only review because it rewrites files. Do not force serial tests. Use the repository's documented test selection and any required environment instead.

### TypeScript and JavaScript

Check the repository's compiler and lint configuration rather than adding strict options or plugins. Review public types, unchecked external data, error narrowing, async cancellation and cleanup, module boundaries, and dependency impact.

If a repository chooses a strict TypeScript profile and its compiler version supports the options, this is one possible starting point:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true
  }
}
```

Do not merge this into an existing `tsconfig.json` without checking the project's supported TypeScript version, public type contract, and current policy. If an existing project script provides a type check or lint check, use that authorized script. Do not install a linter, enable a rule, or silently replace the configured compiler policy. A temporary variable, wrapper, or explicit type can improve a real trust boundary even when it adds lines.

### Python

Use the project's selected formatter, linter, type checker, and test command when authorized. Review public inputs, exception scope, resource cleanup, compatibility versions, query construction, and framework-specific boundaries such as migrations or request validation.

A Python project that has chosen Ruff, mypy, Python 3.12, and these rule families can use this `pyproject.toml` example:

```toml
[tool.ruff]
target-version = "py312"
line-length = 88

[tool.ruff.lint]
select = ["E", "F", "W", "I", "N", "UP", "ANN", "B", "A", "C4", "DTZ", "ISC", "PIE", "PT", "RET", "SIM", "TCH", "ARG", "PTH", "ERA"]

[tool.mypy]
strict = true
warn_return_any = true
warn_unreachable = true
```

This is not a generic Python baseline. Match the target version, tool versions, line length, selected rules, and strictness to the repository before changing configuration. Ruff, mypy, and type annotations can be useful where the repository already uses them. They are not prerequisites for this skill, and a missing tool is evidence to report rather than an installation task.

## Shell

Keep shell reviews concrete. Check argument validation, quoting, command substitution, glob expansion, temporary-file ownership, cleanup on failure, exit-code handling, environment trust, and destructive command guards.

If the repository already uses ShellCheck, run its documented check mode only when authorized. Do not claim that shell behavior is covered by JavaScript, Rust, or Python tooling.

## Security concerns

Report a security concern directly with the affected boundary, evidence, impact, and a safe next check. Look for secrets, unsafe input handling, path traversal, injection, authorization gaps, dependency changes, unsafe temporary files, and accidentally broadened access.

Do not remove validation, escaping, authorization checks, or compatibility guards simply because tests do not cover them. If an available code-security skill fits the requested depth, suggest it as an optional follow-up. Do not assume a particular reviewer, persona, or external workflow exists.
