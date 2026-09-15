# Image generation technical reference

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Requirements and authentication

- Node.js 22.19 or later.
- Pi with native extension dialogs in TUI or RPC.
- A working internet connection to OpenRouter.
- An OpenRouter API key with enough credits for generation.

By default, the extension reads `OPENROUTER_API_KEY` from Pi's environment. In `/setup-image-generation`, you can enable fallback to Pi's existing OpenRouter credentials when that variable is unset. An environment key always takes precedence; an invalid environment key does not trigger a retry with another credential.

The extension never saves keys, reads `.env` files, or asks the model or a dialog to supply a key. Configure credentials through the environment or Pi's own OpenRouter login flow. Restart Pi after changing its environment. Pi credential fallback requires Pi's provider-auth support and does not support custom OpenRouter service addresses.

The model list is public and can be opened without a key. Generation requires a key. Your current chat model can use another provider.

## Setup command

Run `/setup-image-generation` while Pi is idle. It opens a native settings menu in TUI or an RPC client with extension dialogs. No prompt argument is needed.

| Setting | Choices and behavior |
| --- | --- |
| OpenRouter authentication | Environment key only, or environment key followed by Pi credential fallback when unset. No keys are entered or saved here. |
| Default image model | Choose from the live catalog or clear the default. Changing models clears the saved ratio and resolution. |
| Model selection behavior | Ask every time, the initial setting, or use the saved default for `/generate-image`. A default model is required for the latter. Explicit model-list requests still open the picker. |
| Default aspect ratio | Model default or an advertised value for the saved model. |
| Default resolution | Model default or an advertised value for the saved model. This is generation resolution, not upscaling. |
| Output directory | A relative or absolute path up to 1,024 characters. Relative paths resolve against each working directory; `~` is not expanded. |
| Preview privacy | Include previews up to 5 MiB, the initial setting, or return file paths only without image bytes. |

Additional actions:

- **Check connection, no image generated** verifies the draft's credentials and refreshes the public model list. It does not generate a paid image or guarantee a particular model will accept a later request.
- **Show current configuration** shows saved preferences, their source, file locations, credential source without its key, and the unsaved draft. Credential presence alone is not proof that it works.
- **Save settings** validates the selected model and options, shows the draft and destination, and asks for confirmation.
- **Reset this scope** disables that profile after confirmation. It leaves credentials and generated files untouched.
- **Discard and close**, Escape from the main menu, or its timeout discards the draft. Cancelling a submenu leaves its setting unchanged.

Each dialog has a five-minute timeout. Setup and generation commands cannot run concurrently. Successful save or reset invalidates pending one-use model choices; no reload is needed for the next generation.

## Settings scope and storage

Choose global or project scope when opening setup:

- Global preferences normally live at `~/.pi/agent/image-generation.json`. Pi's `PI_CODING_AGENT_DIR` override changes the agent directory.
- Project preferences normally live at `<working-directory>/.pi/image-generation.json`. Rebranded Pi distributions may use a different project configuration directory name.
- Project profiles are available only in trusted projects. Untrusted project settings are neither read nor written.

Each saved profile contains every preference. A project profile replaces the whole global profile rather than merging individual fields. Saving global preferences while a project profile exists does not change that project's effective preferences; setup warns about this.

Resetting a project profile restores global preferences or built-in defaults. Resetting a global profile restores built-in defaults unless a project profile overrides them. Neither reset changes authentication stored by Pi, environment variables, or images.

Preferences are not secrets, but paths may reveal local directory names. Review project settings before committing them. Malformed, oversized, unsupported, or symbolic-link settings files fail closed rather than silently changing the model or privacy behavior. Repair the file or restore a known-good copy, then reopen setup. If another process edits the target settings file while setup is open, reopen setup rather than overwriting it.

## Model selection

`show_image_model_list` opens the current OpenRouter model catalog, limited to models that accept text and produce images. An optional search matches model names and IDs without case sensitivity. The catalog is fetched whenever the picker opens, with no hardcoded fallback. Your saved default appears first and is labelled.

Use the native picker to choose a model. The extension does not infer a choice from assistant text or accept a model override during generation.

A choice expires after 15 minutes, after one generation attempt, when another picker opens, or when you reload, restart, change sessions, or navigate the session tree. A working-directory change also invalidates the choice. Failed attempts require a fresh selection, not an automatic retry.

## Direct command

```text
/generate-image "create an image of a cat"
/generate-image create an image of a cat
```

The command opens the model picker unless you enabled use of a saved default. It always asks for final confirmation, then generates and saves one image without starting a chat-model turn. It passes your prompt directly and applies saved ratio and resolution preferences only when generating with the saved default model. For per-image options, use the conversational tool flow instead.

A missing or unavailable saved model fails without selecting a replacement. Stale unsupported ratio or resolution preferences also fail rather than silently changing your request. Correct them in setup.

A matching pair of outer single or double quotes is optional and removed. Internal quotes and backslashes remain literal; this is not a shell command. Empty prompts, unmatched opening quotes, control characters, and prompts over 8,000 characters are rejected before the picker opens. Running `/generate-image` without a prompt shows usage help.

Wait until Pi is idle before running the command. Cancelling either dialog stops the command without generating an image. It does not retry on failure.

The command returns a persistent result with the prompt, saved file path, and reported cost. The standard TUI displays its text and path, not an inline image; RPC preview display depends on the client. Small image previews still enter the session context unless paths-only privacy is enabled. Command costs appear in the result but are not added to Pi's tool-usage totals.

## Generation options

`generate_image_with_openrouter` generates one image per confirmed request.

- Describe the image in up to 8,000 characters.
- Ask for an aspect ratio, such as `16:9`, only when the selected model advertises it.
- Ask for a resolution, such as `1K` or `2K`, only when the selected model advertises it.
- Omit either option to use a saved preference for the same default model, otherwise the model's default. Explicit tool options override saved values after capability validation.

Availability can differ between providers serving the same model. An advertised option can still fail if no eligible provider accepts the combination. The extension does not substitute another model or automatically repeat the request.

This version has no reference-image uploads, image editing, batch generation, quality control, provider pinning, custom service address, or streaming previews. Vector-only models may appear in the catalog, but SVG responses are rejected rather than rendered or saved.

## Files and previews

By default, images are saved under `generated-images/generation-<unique suffix>/` in the current working directory. Setup can change the output directory; each generation still gets its own subdirectory. The result includes the exact absolute path. Filenames use the returned raster format. Existing images are not overwritten.

The output directory must be a real directory, not a symbolic link. Files remain after a session ends and are not automatically deleted. Add `generated-images/` to your project's ignore rules if you do not want Git to track these outputs.

- Supported saved formats: PNG, JPEG, WebP, GIF.
- Maximum image size: 20 MiB.
- Inline preview limit: 5 MiB. Larger supported images are saved without a preview.
- Actual preview display depends on your terminal or RPC client and its image support.

When enabled, previews enter results and session history, and may be sent to the normal chat model. Paths-only mode omits image bytes from both tool and direct-command results and asks the agent not to read or attach the file unless you request it. This is not a restriction on other tools: an explicit later read can still send the image to your chat model. Switching privacy modes does not erase prior history. The extension does not send the conversation history or any local files to the image provider. Saved files, prompts, and session history are not encrypted by this extension.

## Confirmation, charges, and cancellation

The final confirmation shows the selected model, a pricing link, the prompt, options, and save location. It warns that generation may spend credits. There is no exact cost estimate or spending cap. OpenRouter's returned usage contributes to Pi's session totals for tool-based generation when available. Direct command costs are shown in the command result only.

Both dialogs cancel after five minutes without an answer. Cancelling either dialog makes no image-generation request. Print and JSON modes cannot provide the required user interaction and fail without making requests. RPC clients must support native extension select and confirm dialogs.

Catalog requests have a 30-second timeout. Generation requests have a three-minute timeout. The extension makes no automatic retries and rejects concurrent image operations. Aborting stops local waiting and attempts to cancel the network request; it is not proof of the provider's final billing outcome.

Once an image response has completed, the extension attempts to preserve it on disk even if cancellation arrives during the save. A local save failure can occur after successful paid generation. Check OpenRouter activity before requesting another attempt.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| No matching models | Ask for the unfiltered list. Check your connection and OpenRouter availability. |
| Authentication failure | Check the auth mode in setup. Set `OPENROUTER_API_KEY` and restart Pi, or configure Pi credentials and enable fallback. |
| Insufficient credits | Check your OpenRouter balance. |
| Rate limited | Wait, then request a fresh model selection if you still want the image. |
| Choice expired or already used | Open `show_image_model_list` again. |
| Unsupported option | Choose an advertised value or clear the stale default in setup. |
| Default model unavailable | Choose another model in setup; there is no automatic replacement. |
| Settings changed while setup was open | Reopen setup to read the updated file. |
| Global preferences seem ignored | Check whether a complete project profile overrides them. |
| Request timed out or failed | Check OpenRouter activity before requesting another attempt. |
| Unsupported output format | Choose a raster image model rather than a vector-only model. |
| Image saved without a preview | Open the returned file path. The preview may exceed the size limit or your client may not display images. |
| Save failed | Check free disk space, directory permissions, and whether the configured output directory is a file or symbolic link. Do not automatically regenerate. |

## Updates and removal

For an npm-installed release, use `pi update npm:@firstpick/pi-extension-image-generation` to update and reload Pi afterward. Remove it with `pi remove npm:@firstpick/pi-extension-image-generation`. Neither operation removes generated images, preferences, or prior session history. To return to the earlier tool-only behavior, reset preferences or choose environment-only authentication and ask-every-time selection before rolling back.

[OpenRouter image models and pricing](https://openrouter.ai/models?output_modalities=image)
