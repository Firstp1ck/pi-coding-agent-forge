# Language and security review examples

Repository policy comes first. These are opt-in examples for a request that needs them, not the user's standards, a replacement for existing tooling, or a reason to change configuration. Confirm the project's commands and authorization before running any check.

## Rust

Review behavior before style. Check error propagation, ownership at API boundaries, unsafe code, feature combinations, public compatibility, and error messages that callers may depend on.

When the repository uses the relevant tools and the request authorizes them, common read-oriented checks include:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo check
cargo test
```

Do not run `cargo fmt` as part of a read-only review because it rewrites files. Do not force serial tests. Use the repository's documented test selection and any required environment instead.

Treat an `unwrap`, an `allow`, or a missing documentation item as context to inspect, not as a universal violation. A clear error path, a documented exception, or a narrow test-only use can be appropriate.

## TypeScript and JavaScript

Check the repository's compiler and lint configuration rather than adding strict options or plugins. Review public types, unchecked external data, error narrowing, async cancellation and cleanup, module boundaries, and dependency impact.

If an existing project script provides a type check or lint check, use that authorized script. Do not install a linter, enable a rule, or silently replace the configured compiler policy. A temporary variable, wrapper, or explicit type can improve a real trust boundary even when it adds lines.

## Python

Use the project's selected formatter, linter, type checker, and test command when authorized. Review public inputs, exception scope, resource cleanup, compatibility versions, query construction, and framework-specific boundaries such as migrations or request validation.

Ruff, mypy, and type annotations can be useful where the repository already uses them. They are not prerequisites for this skill, and a missing tool is evidence to report rather than an installation task.

## Shell

Keep shell reviews concrete. Check argument validation, quoting, command substitution, glob expansion, temporary-file ownership, cleanup on failure, exit-code handling, environment trust, and destructive command guards.

If the repository already uses ShellCheck, run its documented check mode only when authorized. Do not claim that shell behavior is covered by JavaScript, Rust, or Python tooling.

## Security concerns

Report a security concern directly with the affected boundary, evidence, impact, and a safe next check. Look for secrets, unsafe input handling, path traversal, injection, authorization gaps, dependency changes, unsafe temporary files, and accidentally broadened access.

Do not remove validation, escaping, authorization checks, or compatibility guards simply because tests do not cover them. If an available code-security skill fits the requested depth, suggest it as an optional follow-up. Do not assume a particular reviewer, persona, or external workflow exists.
