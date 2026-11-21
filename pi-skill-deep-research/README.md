# Deep Research

Investigate scientific claims with careful study appraisal, explicit evidence classification, and visible uncertainty.

## Helpful when

- You need to assess a scientific effect or evidence claim.
- Studies disagree or apply to different populations or conditions.
- You want scientific verdicts with an explicit decision trail.

## What to share with Pi

- The exact question or decision
- What evidence would be most useful
- Time period, location, or other boundaries

## Try asking

> Research this question using several reliable sources. Verify the most important claims and clearly show what remains uncertain.

## What you’ll get

- A focused answer with source links
- Evidence for the key claims
- Disagreements, gaps, evidence-based verdicts, and agreement ratios

## Keep in mind

Research quality depends on the available evidence. Missing, private, or outdated sources will lower confidence and be stated openly. The runner requires an initialized state JSON passed with `--state`; this package currently does not ship one. Classification and ordering are stable for identical evidence, but run IDs and timestamps vary.

Ordinary engineering questions use official documentation, source code, and relevant observations instead of paper-count verdicts. The skill separates those questions before selecting its scientific pipeline. Agreement ratios describe supplied evidence labels, not a probability that a claim is true.

## Install

```bash
pi install npm:@firstpick/pi-skill-deep-research
```

Restart Pi if the skill does not appear in your current session.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for advanced usage, configuration, compatibility, and limitations.
