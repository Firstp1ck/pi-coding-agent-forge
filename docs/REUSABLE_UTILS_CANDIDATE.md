# Reusable Code Candidates for `pi-utils`

An audit of the whole monorepo (191 source files across the `pi-extension-*`,
`pi-package-*`, `pi-skill-*`, and `dev/` packages) for code that is **duplicated
across two or more packages** and could be centralized into the shared
[`@firstpick/pi-utils`](../pi-utils) package.

Everything already exported by `pi-utils` was excluded. Findings are split into:

- **Part A — New helpers to add** (logic not yet in `pi-utils`).
- **Part B — Migrate to existing helpers** (packages re-rolling something
  `pi-utils` already exports; the fix is an import, not new code).

Each entry lists the reuse count (**distinct packages** — the key signal) and
concrete file locations. Ranked by reuse × safety within each part.

> Reuse count is what matters. A byte-identical snippet in 4+ packages is a
> near-zero-risk extraction; a 2-package snippet with diverging implementations
> also forces a useful "which behavior is canonical?" decision.

---

## Part A — New helpers to add to `pi-utils`

### A1. `escapeRegExp(value)` — escape a string for literal use in a RegExp  ⭐ top pick
`value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` — byte-for-byte identical everywhere.

- **Distinct packages: 6+**
- `pi-extension-release-aur/index.ts:523` (named fn)
- `pi-extension-stats/index.ts:312`, `:387` (inline)
- `pi-extension-small-modal-reliability/tests/reliability-harness.test.mjs:497`
- `pi-skill-patch-md/skills/patch-md/scripts/patch_md_extract.mjs:52`
- `pi-package-webui/index.ts:400`, `webui-rpc-helper.mjs:138`, `bin/pi-webui.mjs:2414`, `public/app.js:16082`
- `pi-package-skill-lifecycle/vendor/pi-extension-memory-helper/index.ts:96`

The clearest, highest-frequency, zero-risk win. → `pi-utils/src/text.ts`

### A2. `exists(filePath)` — async `fs.access` → boolean wrapper  ⭐
`try { await fs.access(filePath); return true; } catch { return false; }` — verbatim.

- **Distinct packages: 6**
- `pi-extension-nixos-wiki-local/index.ts:62`
- `pi-extension-archwiki-local/index.ts:29`
- `pi-extension-hyprland-wiki-local/index.ts:29`
- `pi-extension-raspberrypi-wiki-local/index.ts:73`
- `pi-extension-wiki-tools/index.ts:188`
- `pi-package-skill-lifecycle/vendor/pi-skill-skill-bank-manager/src/audit.ts`, `.../pi-extension-memory-helper/index.ts`

→ `pi-utils/src/paths.ts` or a new `fs.ts` (as `pathExists`).

### A3. Atomic file write (temp-file + `rename`)  ⭐
Write to `${target}.${pid}.${Date.now()}.tmp` (pretty JSON + trailing newline,
often `mode 0o600`), `mkdir -p` the parent, then `rename` over the destination.

- **Distinct packages: 3**
- `pi-extension-cd/index.ts:158-167` — `writeStore()` (sync)
- `pi-package-natural-conversation/lib/voice-config.mjs:256-266` — `saveVoiceConfig()` (sync, `0o600` + `chmod`)
- `pi-package-webui/bin/pi-webui.mjs` — async, repeated 4× (`writePathFastPicks` ~1517, `writeWebuiSettings` ~1543, app-runner config ~1946, skill save ~6969)

Propose `writeFileAtomic(path, data, {mode})` + `writeJsonFileAtomic(...)`.
Differences are only sync/async and whether mode is set. → `pi-utils/src/json.ts` / `fs.ts`

### A4. `killGracefully(childOrPid, {timeoutMs})` — SIGTERM → SIGKILL escalation  ⭐
The "signal, then force-kill after a timeout (`.unref()`)" escalation is
re-implemented all over the process-spawning packages.

- **Distinct packages: 4+**
- `pi-package-remote-webui/index.ts:99-103` — `terminateFailedChild` (2000ms)
- `pi-package-webui/index.ts:348-366` — `terminatePid` (4000ms, PID-based)
- `pi-extension-workflows/src/task-runner.ts:178-262` — `killProc` (SIGTERM→SIGKILL 5000ms)
- `pi-extension-small-modal-reliability/src/orchestration.ts:194-243` — `abort` (same 5000ms)
- (group-kill variants) `pi-extension-release-npm/index.ts:199-221`, `pi-extension-release-aur/index.ts:172-189`

A single `killGracefully(target, {termSignal, killAfterMs, processGroup})` would
collapse all of them. Pairs naturally with A5. → `pi-utils/src/process.ts`

### A5. `isProcessRunning(pid)` — liveness probe via `process.kill(pid, 0)`
`function isProcessRunning(pid): boolean` treating `EPERM` as alive.

- **Distinct packages: 1–2** (companion to A4, worth centralizing together)
- `pi-package-webui/index.ts:338`
- `pi-package-webui/dev/scripts/natural-conversation-webui-validation.mjs:149`

→ `pi-utils/src/process.ts`

### A6. `fetchJson` / `fetchWithTimeout` — JSON HTTP fetch with abort-timeout  ⭐
Every networked package reimplements "fetch a URL, enforce a timeout via
`AbortSignal`, normalize non-2xx, parse JSON." Four independent variants:

- **Distinct packages: 4**
- `pi-package-remote-webui/lib/remote-core.mjs:159` — `fetchJsonWithTimeout(url, init, timeoutMs=1500, fetchImpl)` → `{ok,status,body,error}`
- `pi-package-webui/bin/pi-webui.mjs:489` — `fetchJsonWithTimeout(url, {timeoutMs, headers})` (throws on `!ok`)
- `pi-extension-tech-news/index.ts:370` — `fetchUrlJson<T>(url, signal)`
- `pi-package-natural-conversation/lib/providers/http-shared.mjs:40` — `fetchProvider(...)` (most complete: classifies timeout/abort/unreachable/HTTP errors)

`http-shared.mjs` is the most mature and a good template. → new `pi-utils/src/http.ts`

### A7. `combinedSignal(timeoutMs, signal)` — merge timeout + caller AbortSignal
```js
const timeout = AbortSignal.timeout(timeoutMs);
return signal ? AbortSignal.any([signal, timeout]) : timeout;
```
- **Distinct packages: 2+** (exported once, inlined elsewhere)
- `pi-package-natural-conversation/lib/providers/http-shared.mjs:7`
- inlined at `pi-package-webui/bin/pi-webui.mjs:492`, `:7536`

Small, general-purpose; ships alongside A6. → `pi-utils/src/http.ts`

### A8. `extractXmlTag(block, tag)` + `decodeXmlEntities()` — pull one tag's inner text + unescape
Near-identical "regex-extract one XML/HTML tag, then decode `&quot;/&#39;/&amp;`…"

- **Distinct packages: 2**
- `pi-extension-tech-news/index.ts:817` `decodeXmlEntities()` + `:828` `getXmlTag()` (feeds `parseRssItems`)
- `pi-extension-stats/index.ts:302` `xmlUnescape()` + `:311` `extractXmlTag()`

→ `pi-utils/src/text.ts` (or new `xml.ts`)

### A9. `stripHtml(html)` — strip tags + decode entities to plain text
Same core (`<[^>]+>` strip + entity decode), differing entity sets.

- **Distinct packages: 2**
- `pi-extension-tech-news/index.ts:387` `htmlToText()` (`<p>`→`\n\n`, `<br>`→`\n`)
- `pi-extension-archwiki-local/index.ts:36` `stripHtmlTitle()` (passed as `titleFromHtml` to the wiki engine)

→ `pi-utils/src/text.ts`

### A10. `truncate(value, maxChars, {ellipsis})` — whitespace-collapse + slice + `…`
`String(v).replace(/\s+/g," ").trim()`, then if too long `slice(0, max-1).trimEnd() + "…"`.

- **Distinct packages: 3+**
- `pi-extension-btw/index.ts:156` `truncatePlain(value, max=180)`
- `pi-extension-small-modal-reliability/src/utils.ts:28` `truncate(value, maxChars)`
- `pi-package-webui/bin/pi-webui.mjs:1020` `truncateTabTitle`, `:1070` `truncateStatusText`
- (line variant) `pi-package-remote-webui/index.ts:181` `truncatePlainLine`

→ `pi-utils/src/text.ts`

### A11. XDG base-directory resolvers — `xdgDataHome()` / `xdgConfigHome()`
`env.XDG_DATA_HOME || join(home, ".local/share")` and `XDG_CONFIG_HOME || join(home, ".config")`.

- **Distinct packages: 3**
- `pi-extension-bang-command-autocomplete/index.ts:98`
- `pi-package-natural-conversation/lib/tts-provisioner.mjs:28,116`, `lib/stt-provisioner.mjs:26-28`, `lib/voice-switch.mjs:92`
- `pi-package-webui/bin/pi-webui.mjs:1929`
- (near-miss, hardcodes `~/.config`) `pi-package-learnings/index.ts:41`

→ `pi-utils/src/paths.ts`

### A12. `pluralize(count, singular, plural?)` / plural suffix `count === 1 ? "" : "s"`
Copy-pasted ternary for "N item(s)" messages.

- **Distinct packages: 4**
- `pi-extension-reverse-last/index.ts:412,431,463`
- `pi-extension-stats/index.ts:397,472,489`
- `pi-extension-cursor-composer/index.ts:699`
- `pi-package-webui/index.ts:840`, `bin/pi-webui.mjs:2697`, `public/app.js:*`

→ `pi-utils/src/text.ts`

### A13. `capitalize(str)` / `titleCaseFromSlug(slug)`
`charAt(0).toUpperCase() + slice(1)` and slug→Title Case.

- **Distinct packages: 3**
- `pi-extension-wiki-tools/index.ts:51` `titleCaseFromSlug()`
- `pi-package-webui/bin/pi-webui.mjs:1026` `titleCaseTabTitle`
- `pi-package-skill-lifecycle/vendor/pi-skill-skill-creator/.../skill_creator_lib.mjs:61`

→ `pi-utils/src/text.ts`

### A14. `formatBytes(n)` — human-readable size  *(implementations diverge)*
- **Distinct packages: 2**
- `pi-extension-cursor-composer/context.ts:98` — **binary** `B/KiB/MiB`
- `pi-package-webui/bin/pi-webui.mjs:688` + `public/app.js:3222` — **decimal** `B/KB/MB/GB`

Centralizing also standardizes the unit convention. → `pi-utils/src/text.ts`

### A15. `formatDuration(ms)` — compact "3m 20s"  *(implementations diverge)*
- **Distinct packages: 2**
- `pi-extension-workflows/src/utils.ts:79` `formatDuration(startIso, endIso)` → `"Xms/Xs/Xm Ys"`
- `pi-package-webui/public/app.js:7184` `formatDuration(ms)` (+ `formatDurationParts` :10431 with days)

→ `pi-utils/src/text.ts`

### A16. Line-buffered stream reader — `readLines(stream, onLine)`
The `buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; …`
NDJSON/line splitter, copy-pasted.

- **Distinct packages: ~5**
- `pi-extension-workflows/src/task-runner.ts`, `pi-extension-small-modal-reliability/src/orchestration.ts`,
  `pi-package-webui/bin/pi-webui.mjs`, `pi-package-skill-lifecycle/.../pi-extension-memory-helper/index.ts`,
  `pi-extension-btw/index.ts`, `pi-extension-archwiki-local/index.ts`

→ `pi-utils/src/process.ts` or `async.ts`

### A17. `gitRevision()` / `gitRemote()` — short-HEAD & origin URL, gated on `.git`
- **Distinct packages: 3**
- `pi-extension-nixos-wiki-local/index.ts:67-68`, `pi-extension-hyprland-wiki-local/index.ts:31-32`, `pi-extension-raspberrypi-wiki-local/index.ts:82`

→ new `pi-utils/src/git.ts`

### A18. `stripQuotes(value)` — remove surrounding quotes  *(prefer matched-pair variant)*
- **Distinct packages: 2**
- `dev/scripts/validate-skill-routing-fixtures.mjs:37` (strips ends independently)
- `pi-package-skill-lifecycle/vendor/pi-skill-skill-bank-manager/src/audit.ts:220` (matched-pair — safer)

→ `pi-utils/src/text.ts`

---

## Part B — Migrate to helpers `pi-utils` ALREADY exports

These are not new code — packages re-rolled something already shared. The fix is
to import from `@firstpick/pi-utils` and delete the local copy.

### B1. `runCommand` (execFile wrapper) → import from `pi-utils/process`
`{ok,stdout,stderr,error}` execFile runner. `pi-utils` exports `runCommand`;
`pi-extension-raspberrypi-wiki-local` already migrated. Stale copies remain in:
- `pi-extension-archwiki-local/index.ts:31`, `pi-extension-hyprland-wiki-local/index.ts:30`, `pi-extension-nixos-wiki-local/index.ts:63` (**3 packages**; nixos only differs in timeout)

### B2. `tokenizeArgs` / `takeValue` → import from `pi-utils/cli`
Byte-identical private copies instead of the existing export:
- `pi-package-webui/index.ts:55,96`, `pi-package-remote-webui/lib/remote-core.mjs:16,57` (**2 packages**)

### B3. `sleep(ms)` → use existing `delay(ms)`
Identical `(ms) => new Promise(r => setTimeout(r, ms))`:
- `pi-package-webui/index.ts:321`, `pi-package-natural-conversation/lib/native-audio-loop.mjs:153` (**2 packages**)

### B4. Home-relative path display (tildify) → use existing `formatUserPath`
- `pi-extension-cd/index.ts:95` `formatPath`, `pi-package-webui/index.ts:601` `displayPath`,
  `bin/pi-webui.mjs:1426` `displayPath`, `pi-package-skill-lifecycle/.../audit.ts:895` `shortPath` (**3 packages**)
  - Note: `pi-extension-small-modal-reliability/src/paths.ts:28` is a *cwd-relative* variant `formatUserPath` does **not** cover — genuinely new, but single-package.

### B5. `getAgentDir` (`PI_CODING_AGENT_DIR ?? ~/.pi/agent`) → use existing export
Re-rolled in ~6 packages: `pi-extension-cd/index.ts:52`, `pi-extension-tools/index.ts:18`,
`pi-package-learnings/index.ts:29`, `pi-package-webui/bin/pi-webui.mjs`, and 3 skill-lifecycle vendor files.

### B6. `expandTilde` → use existing export
Re-rolled in ~7 packages: `pi-extension-cd/index.ts:65`, `pi-extension-plan-executor/index.ts`,
`pi-package-learnings/index.ts:68`, `pi-package-webui/bin/pi-webui.mjs:1435` (`expandUserPath`),
`dev/scripts/validate-skill-routing-fixtures.mjs:76`, and 3 skill-lifecycle vendor files.

### B7. `resolveEnvValue` → use existing export (API-key resolution)
`resolveApiKey()` + `ApiKeySource`/`ApiKeyResolution` types are `resolveEnvValue` renamed:
- `pi-extension-brave-search/index.ts:31-37,79-91`, `pi-extension-cursor-composer/index.ts:50-56,218-230` (**2 packages**)

### B8. `envFlag` → use existing export (boolean-env parsing)
Hand-rolled `["1","true","yes","on"].includes(raw)`:
- `pi-extension-git-footer-status/index.ts:159`, `pi-extension-cursor-composer/context.ts:76`, `pi-extension-notes/index.ts:40` (**3 packages**)

### B9. `readJsonIfExists` → reconcile onto existing export
Three divergent re-rolls (return `undefined` vs fallback; ENOENT-only vs catch-all):
- `pi-extension-small-modal-reliability/src/utils.ts:10`, `pi-package-skill-lifecycle/.../audit.ts:203`,
  `pi-package-webui/bin/pi-webui.mjs:1581` (**3 packages**). Reconcile the ENOENT-vs-catch-all contract when migrating.

---

## Part C — Larger shared patterns (extension-level, higher effort)

Worth noting but bigger than a single utility function.

### C1. Local-wiki extension registration + parameter schemas
The four wiki-local packages (`archwiki`, `hyprland`, `nixos`, `raspberrypi`) copy the
**entire registration block** — 3 commands (`*-status`, `*-local-setup`, `*-smoke-test`)
+ 6 tools (`_search/_read/_sections/_extract/_related/_smoke_test`) + 6 near-identical
TypeBox param schemas — differing only in id/label strings and a couple of bounds.
The engine (`createLocalWikiEngine`) and `jsonToolResult` are already shared, but the
glue is not. A `registerLocalWikiExtension(pi, config)` + exported schema factories would
collapse **4 packages**. (See `pi-extension-{archwiki,hyprland,nixos,raspberrypi}-wiki-local/index.ts`.)

### C2. Live bash runner `runScriptLive()` + `RunResult`/`AbortableChild` types
`spawn("bash", ["-lc", cmd], {detached})` streamer with process-group SIGINT→SIGTERM
abort (`abortReleaseStep`). Near line-for-line identical in **2 packages**:
`pi-extension-release-npm/index.ts:170`, `pi-extension-release-aur/index.ts:162`.
Related to `pi-utils` `runLiveShellCommand` but adds the group-kill abort. Overlaps A4.

### C3. pi subprocess NDJSON runner (spawn `pi`, parse `message_end` events, abort)
`pi-extension-workflows/src/task-runner.ts:178-262` and
`pi-extension-small-modal-reliability/src/orchestration.ts:194-243` (**2 packages**) share the
whole "spawn a `pi` child, line-split NDJSON stdout, wire AbortSignal→graceful kill" block.
Combines A16 (readLines) + A4 (killGracefully).

### C4. Toggle command dispatcher (`on`/`off`/`status` subcommands)
Same shape — read first token, branch on `status`/`on`/`off`, flip a persisted flag, `ctx.ui.notify`:
`pi-extension-safety-guard/index.ts:399-411`, `pi-extension-plan-mode-toggle/index.ts:419-428`,
`pi-extension-small-modal-reliability/index.ts:347-362`,
`pi-package-natural-conversation/extensions/natural-conversation.ts:87-102` (**4 packages**).
A `makeToggleCommand(...)` helper would fit. Related: `notifyJson(ctx, value)` for the JSON-dump
status idiom seen across the wiki extensions.

### C5. `SetupUiContext` structural type
Both `pi-extension-brave-search/index.ts:39-46` and `pi-extension-tech-news/index.ts:288-293`
re-declare the pi UI-context shape (`confirm`/`input`/`select`/`notify`). Export a shared type.

---

## Suggested rollout order

1. **Zero-risk, high-frequency (Part A):** A1 `escapeRegExp`, A2 `exists`, A3 atomic write.
2. **Import-only cleanups (Part B):** B1–B9 — delete stale copies, no behavior change.
3. **Process family (Part A):** A4 `killGracefully` + A5 `isProcessRunning` + A16 `readLines`
   (these unblock C2/C3).
4. **HTTP family (Part A):** A6 `fetchJson` + A7 `combinedSignal`, then A8/A9 (XML/HTML).
5. **String formatters (Part A):** A10–A15, A18 — batch into `text.ts`; resolve the
   diverging conventions (bytes binary-vs-decimal, duration granularity) as you go.
6. **Structural (Part C):** C1 (local-wiki registration) is the single biggest LOC win
   but needs the most design; do it last.

---

*Generated by a repo-wide audit. Line numbers are point-in-time; grep the named
functions if they have drifted.*
