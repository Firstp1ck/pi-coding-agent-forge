# Technical reference: Codex Fast Mode for Pi

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Install and update

```bash
pi install npm:@firstpick/pi-extension-codex-fast-mode
```

Restart Pi or run `/reload` after updating. Update the Pi Web UI companion too if you use its speed selector. Older companion versions understand only Normal and Fast.

## Commands

| Command | Result |
| --- | --- |
| `/fast-mode` | Select Fast from Normal, or turn Fast/Ultrafast off |
| `/fast-mode on` | Select Fast, including when leaving Ultrafast |
| `/fast-mode fast` | Select Fast |
| `/fast-mode ultrafast` | Select Ultrafast for subscription-backed GPT-6 Astra |
| `/fast-mode off` | Remove the speed override |
| `/fast-mode normal` | Remove the speed override |
| `/fast-mode status` | Report the current branch's preference |

Arguments are case-insensitive. Mode changes are refused while Pi is working or has queued messages; `status` remains available.

Normal is the default. The preference belongs to the active session branch and is restored when that branch is resumed or navigated. Normal leaves any existing provider request tier unchanged rather than forcing Standard processing.

## Eligibility and credit use

Both enabled modes apply only to subscription-backed Codex requests through the `openai-codex` provider. API-key billing and other providers are unchanged.

### Fast

Fast processing depends on model and account support. Current Codex documentation lists 2.5× Standard included subscription usage and 2× Standard purchased-credit or Enterprise pay-as-you-go usage for supported models. GPT-5.5 and GPT-5.6 have a documented 1.5× speed increase; other supported models have different speed characteristics.

### Ultrafast

This extension limits Ultrafast to the exact GPT-6 Astra model. Select it yourself before running `/fast-mode ultrafast`; selecting Ultrafast with another model is rejected without changing your preference.

Current OpenAI requirements and charges are:

- Pro $500 or eligible Enterprise/Edu plans. Other self-serve plans do not qualify at launch, even with purchased credits.
- 8× Standard included subscription usage or 6× purchased-credit/pay-as-you-go usage. Enterprise billing follows the workspace agreement.
- Enterprise owners must enable the appropriate workspace access; per-user spend controls still apply.
- Eligible Enterprise agreements are credit-based or USD usage-based, and eligible Edu plans use credits. Legacy rate-limit-based Enterprise plans are unsupported.
- Workspaces requiring inference residency outside the United States are unsupported. Workspace location alone does not determine eligibility.

These usage multipliers are charges, not promised speedups or task-completion times. Provider terms can change. See [Codex speed and billing](https://developers.openai.com/codex/speed) for current requirements.

## Status and model changes

The footer and `/fast-mode status` report your preference, not confirmation that OpenAI served that tier. Account eligibility and upstream acceptance remain authoritative.

If you switch models or restore an Ultrafast branch while another model is selected, the preference stays Ultrafast but requests for that model are unchanged. `/fast-mode status` identifies it as inactive. Switch back to subscription-backed GPT-6 Astra or select another mode explicitly.

The updated Web UI disables the Ultrafast option for other models and asks for cost confirmation before selecting it. Turning off the optional integration removes either enabled override from live tabs before hiding the control.

## Migration and rollback

Old on/off session preferences restore as Fast/Normal. Existing `on`, `off`, and bare-toggle commands keep working.

Before downgrading to an older extension, run `/fast-mode off` on branches where you selected Ultrafast. Older versions restore a saved Ultrafast preference as Fast, not Ultrafast. An older Web UI cannot accurately display the new mode; update it or use the command directly and inspect `/fast-mode status`.

## Privacy and troubleshooting

The extension does not inspect credentials or account plans, change authentication, select or register models, or make a separate network request.

- **GPT-6 Astra is missing:** update Pi or configure the model through Pi's supported model setup. This extension does not add it.
- **Ultrafast cannot be selected:** check that the selected model is GPT-6 Astra through the subscription-backed Codex provider and that Pi is idle.
- **OpenAI rejects the request:** verify plan eligibility, workspace access, spend controls, and inference residency. Use `/fast-mode fast` or `/fast-mode off` if Ultrafast is unavailable.
- **A selected mode is inactive:** inspect `/fast-mode status` and the current model. The preference may have been restored from another branch.

No automatic downgrade is attempted after an upstream rejection. Changing modes is an explicit user choice.
