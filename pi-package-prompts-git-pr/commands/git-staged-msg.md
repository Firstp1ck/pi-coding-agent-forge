---
description: Generate short + long conventional commit messages from staged diff and save both files.
argument-hint: "[language: en|de] [scope: auto|never|required]"
---
Create commit messages for the **currently staged files only**.

Preferences supplied by the caller:
- Output language: `$1` (default `en` for English, `de` for German).
- Conventional Commit scope policy: `$2` (default `auto`).
  - `auto`: include a concise scope only when the staged work has one clear component.
  - `never`: use `<type>: <summary>` without a scope.
  - `required`: always choose a concise lowercase scope and use `<type>(<scope>): <summary>`.

Process:
1. Resolve the Git repository root before inspecting or writing anything:
   `REPO_ROOT="$(git rev-parse --show-toplevel)"`
   - Stop and report the Git error if this command fails.
   - Treat the returned absolute path as the only repository root. Do not use the process working directory, which may be a subdirectory.
2. Inspect the staged diff only from that root:
   `git -C "$REPO_ROOT" diff --cached`
3. Choose the best primary type from:
   `fix|feat|change|perf|test|chore|refactor|docs|style|build|ci|revert`
4. Produce in the requested language:
   - one short subject line (single line)
   - one long commit message (subject + typed bullet list)
5. Create `$REPO_ROOT/dev/COMMIT` if needed, then write exactly:
   - `$REPO_ROOT/dev/COMMIT/staged-commit-short.txt`
   - `$REPO_ROOT/dev/COMMIT/staged-commit-long.txt`

Path requirements:
- Use the absolute paths formed from `REPO_ROOT` for every directory-creation and file-writing tool call.
- Never write to `dev/COMMIT` relative to the current working directory.
- The output location must remain the repository-root `dev/COMMIT` directory even when `/git-staged-msg` is invoked from a nested subdirectory.

Required content format:

`staged-commit-short.txt`
```text
<type>[(<scope>)]: <short summary>
```

`staged-commit-long.txt`
```text
<type>[(<scope>)]: <short summary>
- <type>: <change 1>
- <type>: <change 2>
```

Rules:
- Imperative mood
- Subject <= 72 chars
- Bullet points must describe only staged hunks
- No unstaged/unrelated changes
- No code fences or extra prose in either output file
