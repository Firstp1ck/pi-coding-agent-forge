# Development guide: Deep Research

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

## Additional implementation details

- Adds the `deep-research` skill to Pi's skill library.
- Routes scientific claims to the existing policy-driven classifier and engineering behavior to question-appropriate primary-source research. The runner provides classification and lightweight output checks; it does not fetch sources or perform full JSON Schema validation.
- Bundles `skills/deep-research/SKILL.md` plus any supporting references, scripts, tests, fixtures, or assets used by the skill.

## Preserved implementation and format details

A Pi skill for scientific fact-checking with explicit study tiers and policy-driven classification; engineering questions use primary-source research outside the scientific classifier. Classification and ordering are stable for equivalent normalized evidence, while timestamps and run IDs vary.

## Expected usage structure

The skill bundles policy, JSON Schema, tests, fixtures, and a runner script. It does not ship initialized run state.

Bundled layout:

```text
skills/deep-research/
  SKILL.md
  policy.json
  output-schema.json
  references/RUNNER.md
  scripts/run_deep_research.py
  tests/test_determinism.py
  tests/fixtures/
```

Runtime initialization and execution live in the skill-local [runner reference](skills/deep-research/references/RUNNER.md), so a copied skill folder remains self-contained. It creates a unique task directory and initializes state with exclusive creation. Concurrent investigations must not share mutable state. The runner implementation, scientific policy, and schema are unchanged.

The runner’s `validate_output` function performs lightweight checks for selected required fields, ID syntax, verdict values, and key nested fields. It does not implement full JSON Schema Draft-07 validation. Reproducibility tests normalize time-varying IDs/timestamps before comparing semantic output.

## Verification

```bash
python3 skills/deep-research/tests/test_determinism.py
npm pack --dry-run --json
```

Normal skill use has no package-specific user configuration. Manual runner use requires the initialized external state file and input artifacts described above.
