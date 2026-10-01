# Codex Fast Mode for Pi

Choose Normal, Fast, or Ultrafast processing for subscription-backed Codex sessions.

## What you can do

- Select Fast mode or GPT-6 Astra Ultrafast for the current session branch.
- Check your selected mode with `/fast-mode status`.
- Keep your preference when resuming or navigating that branch.
- Leave other providers and API-key billing unchanged.

## Install

```bash
pi install npm:@firstpick/pi-extension-codex-fast-mode
```

Restart Pi or run `/reload` after installing or updating the extension.

## How to use it

Select a subscription-backed Codex model, then run `/fast-mode on` to request Fast processing. Run `/fast-mode status` to inspect the preference, or `/fast-mode off` to stop overriding the request tier.

For Ultrafast, select **GPT-6 Astra** through the `openai-codex` provider, check the requirements below, then run:

```text
/fast-mode ultrafast
/fast-mode status
```

- `/fast-mode` switches Normal to Fast, or turns either enabled mode off.
- `/fast-mode on` or `/fast-mode fast` selects Fast.
- `/fast-mode ultrafast` selects Ultrafast for GPT-6 Astra.
- `/fast-mode off` or `/fast-mode normal` removes the override.
- `/fast-mode status` reports the current session-branch preference.

The updated Pi Web UI companion also offers Normal, Fast, and Ultrafast under Codex Usage. It asks you to confirm the higher cost before selecting Ultrafast.

## Before you start

**Ultrafast uses substantially more allowance or credits.** It currently requires Pro $500 or eligible Enterprise/Edu access and uses **8× Standard included usage** or **6× purchased-credit/pay-as-you-go usage**. Workspace terms and permissions may differ. Other self-serve plans do not have subscription Ultrafast access at launch, even with purchased credits.

Fast also increases usage. Selecting a mode requests that tier; it does not prove OpenAI accepted it. The extension does not inspect your plan or credentials, choose a model, or add missing models. Changes are blocked while Pi is busy.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for all commands, eligibility, credit use, migration, and troubleshooting.
