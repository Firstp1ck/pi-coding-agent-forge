# Technical reference: Deep Research

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Install

```bash
pi install npm:@firstpick/pi-skill-deep-research
```

No configuration is required for normal use.

## Using the skill

Ask Pi a focused research question and state why the answer matters. Include useful boundaries such as location, date range, audience, required source quality, and decisions the research should support.

The skill separates research from final verification. Important claims are checked against the collected evidence before the result is presented.

Scientific effects use the study-based pipeline. API behavior, code contracts, and version compatibility use engineering primary sources directly or an available research-orchestration skill. Mixed topics keep these methods separate; a lack of papers does not invalidate documented engineering behavior.

## What the result includes

- A focused answer to the research question
- Sources for the important claims
- Conflicting evidence and unresolved gaps
- A visible decision trail
- Confidence and limitations

## Limitations

Unavailable, private, paywalled, or outdated sources can lower confidence. A completed research workflow does not turn weak source material into strong evidence.

Verdicts are policy classifications over supplied scientific evidence. They are not calibrated confidence estimates or substitutes for checking study methods, applicability, and independence. No runner or scientific policy behavior changes are required by this routing distinction.

The packaged runner, policy files, output format, required external state file, and reproducibility limits are contributor information documented in `DEVELOPMENT.md`.
