# Empty No Project startup

Complex follow-up: startup launcher semantics and browser first-submission ownership cross components. Parent integrates; two isolated Sol/high workers implement independent slices. User retains Sol reviews, max two rounds, no Anthropic. No installs/live settings or merge.

## Contract

Default CLI and /webui-start launches with no explicit project or restored sessions open zero sessions, no Pi child and no No Project directory. Render an empty No Project conversation. First user submission creates a fresh owned No Project tab through the existing endpoint and sends once to that exact tab. Empty submissions create nothing. Failures retain input and permit retry. Concurrent clicks cannot duplicate creation or submission; navigation or a changed draft during creation must not send into another session or erase newer input. Existing explicit create/Home actions retain their behavior. Default startup is not Pi --no-session (which disables session persistence). Explicit CLI --cwd, /webui-start --cwd PATH, managed session reattachment and private restore retain priority. Keep existing security, admission, persistence and native command contracts.

## Work boundaries and DAG

A owns index.ts and new tests/empty-startup-launcher.test.mjs: remove unconditional ctx.cwd startup argument; add explicit --cwd parsing/forwarding and command help; preserve process cwd and restoration. Do not change app/server/docs/shared tests.
B owns public/app.js and new tests/browser/empty-startup.spec.mjs plus an optional dedicated tests/browser/empty-startup-fixture.mjs: no-session welcome/header/composer and exact guarded lazy first submission. Reuse existing createTerminalTab and No Project lifecycle. Do not change index/server/cache/docs/shared tests. Browser fixture must launch without --cwd and assert zero tabs/no allocation on load. Capture and inspect screenshots.
Parent updates docs, preview script (remove its implicit --cwd), shared static tests/cache/inventory, integrates A/B, verifies combined flows, handles review fixes. Parallel isolated worktrees from committed plan; no overlapping writers or children.

## Checks and review

Verify zero sessions on fresh startup/reload; first Enter/click sends original text once into unique owned cwd; empty send no allocation; creation failure/double activation/navigation races retain correct draft and session. Explicit project and restore behavior preserved. Isolated HOME/XDG/Pi/npm/Git, fake Pi, system Chromium only. No preview tools for own-edit verification. Targeted checks then package suite, screenshots and two independent fresh Sol R1 outputs (startup/lifetime and browser/interaction), at most one bounded R2. Parent records dispositions. Self-contained HTML report linked here on acceptance. Archive only when verified. Rollback changes launcher/default empty view only; owned directories remain retained.

## Status

Plan committed before delegation. Both isolated worker changes are integrated at 23a0040, including shared assertions and offline cache updates. Parent verified 8 launcher cases, three shared static files and 17 actual-app browser cases. Empty-screen and first-message screenshots were inspected. The Settings symbols also use the requested gear outline; two actual-app Settings checks passed.

Full package verification and two independent Sol R1 reviews are running. No acceptance claim yet. Browser evidence is retained under `handoffs/empty-startup-evidence/`; tests use fake Pi and disposable state, not real providers or user configuration.

First package run failed 1/259 files: the send-lifetime VM fixture omitted the new `emptyStartSubmissionPending` variable. Parent supplied its normal false state in 569c8b9; all seven unchanged lifetime assertions now pass. The package rerun writes `/tmp/empty-startup-package-fixed.log` and its `.exit` file. Offline cache browser verification and ten inventory tests also pass.

R1 angle A: accept BUG-001, a background first `/name` opened against the intervening active session. Parent now retains native selector commands in the created session's draft after navigation; ordinary prompts still dispatch to their captured session. Returning to that session and submitting opens its selector. Two actual-app reproductions pass, covering another-session and Settings navigation. Accept BUG-002, the missing VM guard already fixed in 569c8b9. The package rerun completed with all 259 files passing before the selector repair. Final repair checks and R1 angle B remain pending.
