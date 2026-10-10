# Development guide: Shared Pi extension utilities

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

Shared helper utilities used by `@firstpick/pi-extension-*` packages.

## Exports

- `getAgentDir()`
- `getPiDir()`
- `getAgentEnvPath()`
- `getAgentSettingsPath()`
- `getWorkspaceEnvPath(cwd?)`
- `envFlag(name, fallback?)`
- `resolvePathFromAgentDir(configuredPath)`
- `parseEnvFile(filePath)`
- `readEnvValue(filePath, key)`
- `resolveEnvValue(key, options?)`
- `quoteEnvValue(value)`
- `upsertEnvValue(filePath, key, value)`
- `slugify(input, options?)` / `truncate(value, maxChars, options?)` / `truncateWithFlag(value, maxChars, options?)`
- `formatTokens(count)`
- `estimateTokensFromCharCount(charCount)`
- `estimateTokensFromText(text)`
- `estimatePromptInjectionTokens(systemPrompt)`
- `estimateInitialPromptInput(options)`
- `collectInitialPromptCalibration(sessionDir, maxSamples?)`
- `buildInitialPromptCalibrationRecord(args)`
- `appendInitialPromptCalibrationRecord(appendEntry, record)`
- `delay(ms)`
- `tokenizeArgs(input)` / `takeValue(tokens, index, flag)`
- `readJsonFile(path)` / `readJsonIfExists(path, fallback)` / `readJsonSafe(path, fallback)` / `writeJsonFile(path, data)`
- `runCommand(command, args, options?)` / `runShellCommand(cwd, command, options?)`
- `shellQuote(value)` / `stripAnsi(input)` / `resolveExecutableFromPath(name)`
- `detachChildProcess(child)` / `killGracefully(target, options?)` / `terminateProcessTree(target, signal?)`
- `sha256Bytes(data)` / `sha256Text(value)` / `sha256File(path)` / `shortHash(value, length?)` / `crc32(data)`
- `ensureDir(path, options?)` / `syncFile(path)` / `syncDirectory(path)`
- `normalizeTimestampMs(timestamp)`
- `jsonToolResult(payload)` / `textToolResult(text, details?)`
- `createRunLog(cwd)` / `appendRunLog(log, chunk)` / `saveRunLog(log, options)` / `listRunLogs(dir)`
- `parseChecklistLine(line)` / `extractChecklist(text)` / `stripChecklistLines(text)` / `countChecklistProgress(textOrItems)`
- `expandTilde(input)` / `resolveUserPath(input, cwd?)` / `safeResolveInside(base, ref)` / `samePath(a, b)` / `formatUserPath(path)`
- `createExtensionWorkingIndicator(ctx, initialMessage, options?)`
- `withExtensionWorkingIndicator(ctx, initialMessage, run, options?)`
- `appendDisplayChunk(lines, chunk)` / `outputLinesFromDisplay(lines)` / `formatElapsed(startMs)`
- `createLocalWikiEngine(config)`
- `@firstpick/pi-utils/resource-management`: resource normalization, scope resolution, model profiles, and locked shared defaults
- `@firstpick/pi-utils/scoped-resource-command`: shared Session, Global, and Model command flow
- `@firstpick/pi-utils/tui-resource-selector`: searchable multi-resource selector with caller-supplied display labels, discovery values, and selected-item descriptions
- `src/tui-setup-option-selector.mjs`: setup-menu navigation that distinguishes Back from immediate exit
- `@firstpick/pi-utils/tui-model-profile-selector`: searchable exact-model profile picker

`scoped-resource-command` keeps resource names as persistence identifiers. Callers may return separate `getResourcePresentation()` entries with `label`, `discovery`, or `description` fields. The TUI selector renders name, discovery, and status columns, includes presentation text in search, and shows the selected description without changing saved resource names.

`resource-management` exports `isT3ResourceProfileContext(ctx, env = process.env, pid = process.pid)`. It accepts only RPC mode with the exact marker `T3_PI_RESOURCE_PROFILES=t3-v1:<pid>`. The injected T3 extension binds `t3-v1` to its own PID before `session_start`; consumers never adopt an unbound request. This keeps inherited ownership from leaking to child processes. It does not alter the canonical defaults reader, scope resolver, branch directive or storage format. `tests/resource-management.test.mjs` covers marker/mode rejection and a real descendant process with an inherited parent binding.

`createExtensionWorkingIndicator` renders a reusable extension-owned spinner using `ctx.ui.setWidget` plus footer `setStatus`, so it works inside slash-command handlers where Pi's built-in model-streaming working row is not shown.

`createLocalWikiEngine` centralizes local documentation corpus handling for wiki-style extensions: file discovery, Markdown/HTML parsing, section/link extraction, cache freshness, query expansion, search ranking, snippets, page reads, focused extracts, related links, and status payloads.

## Resource selector search

For ordinary queries, `TuiResourceSelectorComponent.filterResources()` uses native Pi TUI `fuzzyFilter` over three cumulative field groups: name/display label, then discovery/source, then description. Each pass appends its matches in native fuzzy-score order and removes them from subsequent passes. Priority is strict, not a weighted score bonus. Multi-term queries can span fields; the earliest group that matches the whole query determines priority. The final group uses the original concatenated search text, preserving the existing match set. Native stable ties preserve caller order, and blank queries restore that order. Selection and persistence continue using resource names, not display labels or ranked positions.

`getSortPreference()` recognizes only whole queries `enabled`, `disabled`, `auto`, and `Pi built-in` after case folding, trimming, and whitespace collapsing. Status preferences use the live enabled-name set; Discovery preferences compare normalized exact Discovery values. These modes bypass fuzzy filtering and stably sort a copy of all resource names with matching rows first. They never hide a row or change persistence. The footer advertises sort-only mode and its all-row bulk-action scope. Enter passes the toggled name to `refresh()` so selection follows that identity when status sorting moves it.

Run `npm test --prefix pi-utils` from the repository root. `tests/tui-resource-selector.test.mjs` covers strict field priority, display labels, case folding, multi-term and slash queries, unchanged ordinary-search match sets, native within-group ordering, stable ties, blank searches, and bulk/save behavior. Keyword tests cover exact column matching despite misleading names/descriptions, normalized whitespace, stable all-row sorting, unmatched preferences, empty lists, partial and mixed queries, live toggling with identity-preserving selection, and all-row bulk actions.
