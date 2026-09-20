# Technical reference: Cursor Composer for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Install

Requires Pi 0.86.0 or newer. Update Pi before installing or updating this extension.

```bash
pi install npm:@firstpick/pi-extension-cursor-composer
```

Restart or reload Pi afterward.

## Sign in

Run:

```text
/cursor-composer-setup
```

The setup can keep the Cursor key only for the current process, save it for the current workspace, or save it in Pi’s global environment file. It can also add Composer 2.5 to Pi’s model-cycling list.

Use `/cursor-composer-status` to confirm sign-in and package readiness.

## Two ways to use Composer

### Select it as the current model

After setup, open `/model` and choose:

```text
cursor-composer/composer-2.5
```

Use `/cursor-composer-add-scoped-model` if you want it included in model cycling. A reload or new session may be needed after changing the model list.

### Run one explicit Cursor task

```text
/cursor-composer Review this project and suggest a safe migration plan.
```

Useful options:

- `--plan` — ask for a plan without implementation.
- `--agent` — allow the normal Cursor agent workflow.
- `--thinking=low|medium|high` — choose reasoning effort.
- `--sandbox` — request Cursor sandboxing.
- `--no-auto-review` — disable Cursor’s local automatic review.
- `--cwd=<subfolder>` — limit the task to a workspace subfolder.

Use `/cursor-composer-models` to see the Cursor models available to the signed-in account.

## Cost and display settings

Composer cost estimates use Cursor’s published pricing. Set `CURSOR_COMPOSER_PRICE_TIER=standard` when the account uses Standard rather than the default Fast tier. Published prices can change; Cursor billing remains authoritative.

Progress is quiet by default. Set `CURSOR_COMPOSER_PROVIDER_VERBOSITY=normal` for more status detail or `debug` for troubleshooting. Set `CURSOR_COMPOSER_PROVIDER_HEARTBEAT_MS=0` to disable repeated heartbeat messages.

## Safety

Cursor local-agent runs may execute commands and edit files. Pi asks for confirmation before using the delegated Cursor tool by default.

`CURSOR_COMPOSER_REQUIRE_CONFIRMATION=false` allows unattended delegated runs. Use it only when you accept that risk. `CURSOR_COMPOSER_PROVIDER_SANDBOX=true` requests Cursor sandboxing, but sandbox availability and guarantees remain controlled by Cursor.

## Privacy and limitations

- Keep `CURSOR_API_KEY` private and out of prompts or repository files.
- The available model list depends on the signed-in Cursor account.
- Token and cost values may be estimated when Cursor does not provide final usage.
- Long prior tool output may be shortened before it is sent to Cursor to avoid repeatedly resending large logs.
