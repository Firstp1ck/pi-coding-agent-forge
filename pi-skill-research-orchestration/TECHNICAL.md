# Technical reference: Research Orchestration

Advanced user setup, configuration, compatibility, security, and troubleshooting information.

[Back to the human-friendly README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Install

```bash
pi install npm:@firstpick/pi-skill-research-orchestration
```

The workflow uses available source-reading, search, and retrieval tools under the active host policy. It requires no private workspace files or particular delegation integration. If tools or sources are unavailable, provide material directly and keep the resulting evidence limits explicit.

## When to use it

Use this skill for engineering documentation/API questions and broad investigations needing multiple evidence passes or a citation audit. A narrow lookup stays a direct, bounded pass. More specialized comparison or paper-summary skills can be used when available and a better fit.

## What to provide

- The decision or final report the research should support
- The major questions that must be answered
- Required source quality and date range
- Geographic, legal, scientific, or product boundaries
- The acceptable level of remaining uncertainty

## What the result includes

- A research plan split into distinct claims
- Combined evidence without duplicate source work
- Follow-up work for missing or weak evidence
- A final source and citation check
- A synthesis that keeps disagreements and uncertainty visible

## Storage and limitations

Results stay in the conversation unless you requested a saved artifact or the active authorized workflow requires one. Saved artifacts use existing repository conventions. The workflow does not automatically write global memory or research history.

A broad workflow can still be limited by unavailable tools and inaccessible or weak sources. Source review checks whether material supports the stated claim. Structural citation checks establish only that references are present, not that the source is correct or entails the claim.

The packaged helper scripts and their file formats are contributor information documented in `DEVELOPMENT.md`.
