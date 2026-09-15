# Development guide: Image generation for Pi

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Implementation

- `index.ts` registers two sequential tools, `/generate-image`, and `/setup-image-generation`. It shares command guards and resets workflow state on session start, tree navigation, and shutdown.
- `settings.ts` validates complete profiles, applies trust-aware scope precedence, and persists files atomically.
- `auth.ts` resolves the environment key and opt-in Pi credential fallback without storing secrets.
- `setup.ts` implements the draft settings menu, live capability choices, connection check, save, and reset.
- `command.ts` parses command prompts and runs selection and generation without a chat-model turn.
- `workflow.ts` owns selection, confirmation, cancellation, and file persistence. Its dependencies allow offline testing without Pi or credentials.
- `openrouter.ts` handles catalog parsing, request bounds, image validation, and usage normalization.
- `tests/image-generation.test.ts` covers the workflow and API boundary using mocked fetch and dialogs and temporary directories.
- `tests/command.test.ts` covers parsing, the direct workflow, cancellation, busy guards, failures, and lifecycle changes.
- `tests/setup.test.ts` covers settings validation and persistence, trust, auth precedence and cancellation, setup menus, default generation, capability failures, and privacy.

Pi uses native `ctx.ui.select`, `ctx.ui.confirm`, and `ctx.ui.input`, not a custom TUI component. These work through Pi's RPC extension UI protocol as well as the terminal. Unknown picker answers fail closed. Tool executions also share an in-memory busy guard in case callers bypass Pi's sequential scheduling.

## Command contract

`/generate-image` accepts the remaining command arguments as one prompt. `parseCommandPrompt` trims whitespace, removes one matching outer pair of ASCII single or double quotes, and uses the same `validatePrompt` function as the generation tool. It does not tokenize, unescape, or rewrite the prompt.

The handler requires an interactive, idle context and rejects overlapping invocations. It calls `workflow.selectForGeneration`, which uses a configured default only when explicitly enabled, or opens the normal picker. It passes the resulting selection ID to `workflow.generate` with no assistant-supplied model override. Generation reads saved preferences and applies model-specific defaults. Dialog cancellation stops the sequence. Errors appear as notifications without retrying.

Success calls `pi.sendMessage` with `customType: "image-generation"`, `display: true`, and `triggerTurn: false`. Content includes the submitted prompt, saved path, cost text, and eligible image content. Default TUI custom-message rendering displays only text; image blocks remain available in session context and to RPC clients. Usage is stored in message details for inspection but does not count toward Pi's tool-usage totals because no tool ran.

A separate lifecycle signal spans both workflow calls. Reset aborts the command and prevents late results or errors from being published into a replacement session. The existing workflow still preserves completed image files during cancellation.

## Setup and configuration contracts

`/setup-image-generation` has no arguments. Setup edits an in-memory draft of a complete global or project profile. Cancelling leaves files unchanged. A shared index-level guard prevents overlap between setup, generation commands, and image tools. Successful save/reset clears pending workflow selections but does not abort the setup command itself.

`getAgentDir()` and `CONFIG_DIR_NAME` supply canonical global and project locations. The settings store receives an explicit trust decision from `ctx.isProjectTrusted()`; it never probes untrusted project settings. Each file contains:

```json
{
  "version": 1,
  "settings": {
    "authentication": "environment",
    "defaultModel": null,
    "selectionBehavior": "ask",
    "aspectRatio": null,
    "resolution": null,
    "outputDirectory": "generated-images",
    "preview": "inline"
  }
}
```

`settings: null` disables that scope's override. All profile keys are required, unknown keys are rejected, and no credential field exists. The project profile overrides the complete global profile. The snapshot also retains separate global/project drafts so editing global settings never copies an overriding project profile by accident.

Config reads are bounded to 16 KiB and reject symlinked immediate config directories and nonregular files. Writes use `withFileMutationQueue`, compare the original bytes against the setup snapshot, create an exclusive temporary file with mode `0600`, and rename it into place. Cancellation is checked before committing. Temporary files are removed on failure. The byte comparison catches changes already present before saving; it is not a cross-process lock or protection against a hostile process racing filesystem operations.

Saving a model-bound draft refreshes the public catalog and validates ratio/resolution choices. Changing model in setup clears both values. Explicit picker calls always prompt and put the saved model first. `selectForGeneration` can mint a one-use selection for the explicitly configured default without a picker, but cannot bypass final confirmation or substitute another model. Saved options apply only when the selected model ID matches the configured default. Explicit tool options take precedence. Unsupported stale defaults fail before the paid request.

Paths-only mode removes all image content blocks from returned results and adds a no-read-without-user-request instruction. The generated bytes still exist locally. Other tools and prior session history are outside this control.

Authentication defaults to `OPENROUTER_API_KEY`. Optional `environment-or-pi` mode falls back to `ctx.modelRegistry.getProviderAuth("openrouter")` only when the variable is absent. Only the resolved API key is used, not custom headers. A configured base URL must match the canonical OpenRouter API base. Raw provider auth errors and source labels are not exposed. Pi auth resolution has a 30-second bounded wait and caller cancellation; the registry API does not accept a signal, so late underlying resolution may still finish and is ignored.

The connection check uses authenticated `GET https://openrouter.ai/api/v1/key`, then the public image catalog. It returns authentication status and a model count, never raw key labels, balances, or limits. This check is user-triggered from the setup draft and never sends a generation request. Reference: [OpenRouter current API key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key).

## Tool contracts

### `show_image_model_list`

Input: optional `search`, a case-insensitive substring up to 100 characters.

The tool fetches the catalog, filters for text input and image output, deduplicates by ID, sorts names, and opens a native picker. The result includes the selected model ID, a random `selection_id`, supported aspect-ratio and resolution values, and a pricing link.

The model name and ID both appear in each option. Model IDs are validated and display names have control and bidirectional formatting characters removed. Only bounded advertised option values are retained. Model descriptions are not injected into the conversation.

### `generate_image_with_openrouter`

Inputs:

- `selection_id`, the exact ID returned by the picker.
- `prompt`, 1 to 8,000 characters after trimming. Reject terminal control and bidirectional formatting characters, apart from normal tabs and newlines, so the confirmed prompt matches the sent prompt.
- Optional `aspect_ratio` and `resolution`, validated against the selected model's advertised enum values.

There is no model, API key, output path, base URL, or arbitrary parameter input. Both tool schemas reject additional properties. Generation uses the model held in extension state, never an assistant-supplied model ID.

The selection is in memory, bound to the working directory, expires after 15 minutes, and is consumed before asynchronous generation work begins. No selection is restored from session history. Reset aborts pending operations and clears selection. A failed validation, missing key, cancelled confirmation, or failed request after consumption requires another picker choice.

Results have a `selected`, `cancelled`, or `generated` status in `details`. Cancellation returns text that tells the agent to stop. Other failures throw so Pi marks the tool result as an error. Generated results contain an absolute path, media type, preview flag, optional image content, and normalized usage.

## OpenRouter integration

Canonical reference: [OpenRouter image generation documentation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation).

Discovery uses public `GET https://openrouter.ai/api/v1/images/models`. Entries expose `id`, `name`, `architecture.input_modalities`, `architecture.output_modalities`, and `supported_parameters`. This dedicated Image API avoids relying on Pi's chat-model catalog, which need not include image-output models.

Generation uses `POST https://openrouter.ai/api/v1/images` with a resolved bearer key and JSON body:

```json
{
  "model": "provider/user-selected-image-model",
  "prompt": "A watercolor paper boat",
  "n": 1,
  "aspect_ratio": "16:9"
}
```

The response must contain exactly one `data` entry with `b64_json`. `media_type` is checked against recognized raster magic bytes when supplied. Supported bytes are PNG, JPEG, WebP, and GIF. URLs, SVG, unknown formats, noncanonical base64, mismatched types, and oversized data are rejected. Magic-byte checks identify formats; they are not a complete image decoder or malware scanner.

Usage comes from `usage.prompt_tokens`, `usage.completion_tokens`, and `usage.cost`. Pi's cost structure places the provider's total charge in `cost.output` and `cost.total`, with zero input and cache costs because the response does not provide that split. Missing or invalid numeric fields normalize to zero for accounting; this is not a quote for generation cost. The human-readable result distinguishes an unreported charge from a reported zero charge.

Trusted project image preferences may be read, and opt-in Pi OpenRouter credentials may be resolved. No reference images, conversation history, settings files, or unrelated credentials are sent to OpenRouter. No model fallback, endpoint discovery fanout, or automatic retry is implemented. OpenRouter may route between providers serving the same selected model.

## Execution and storage bounds

- Catalog download: 4 MiB and 30 seconds.
- Authentication check response: 64 KiB and 30 seconds.
- Settings file: 16 KiB.
- Pi credential resolution: 30-second bounded wait.
- Generation download: 32 MiB and 180 seconds.
- Decoded image: 20 MiB.
- Preview: 5 MiB; text output and selection metadata are independently bounded.
- Dialogs: 300 seconds.
- Selection lifetime: 900 seconds.

HTTP redirects are rejected. The request deadline remains active while reading the body. Abort signals combine caller cancellation with session lifecycle cancellation. Readers are cancelled on oversized bodies and timers are cleared in `finally`. Error messages report status and safe troubleshooting hints, not raw response bodies or authentication headers.

The output root is checked before payment and again before saving. `mkdtemp` creates a new generation directory. Each write uses `withFileMutationQueue` and exclusive `wx` creation with mode `0600`, subject to platform permissions. If a write fails, only the directory created by that save attempt is removed. This is not a sandbox against another process racing filesystem operations in the same working directory.

Completed responses are saved without using the network abort signal so cancellation during a local write does not intentionally discard a paid result. Local save errors are reported as post-generation failures rather than retried.

## Local development

From the repository root, load the unpublished extension for one Pi invocation:

```bash
pi -e ./pi-extension-image-generation/index.ts
```

This does not register it permanently or publish it. Set `OPENROUTER_API_KEY` outside the conversation if you want to test paid generation.

Run offline validation:

```bash
npm --prefix pi-extension-image-generation test
npm --prefix pi-extension-image-generation run check
npm pack ./pi-extension-image-generation --dry-run --ignore-scripts
```

Tests use Node's built-in runner and TypeScript stripping. They do not require network access or real credentials. The `check` script validates syntax, not full TypeScript typing. Core Pi packages and TypeBox are peer dependencies supplied by the Pi loader.

Before release, smoke-test both dialogs and a real generation in TUI and an RPC client with user approval. Test display with an image-capable and text-only chat model. Offline mocks do not verify provider billing, actual raster decoding, rendering, or changing provider capabilities.
