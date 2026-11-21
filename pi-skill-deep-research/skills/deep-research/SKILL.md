---
name: deep-research
description: Investigate scientific claims using collected studies, explicit evidence tiers, and policy-driven classification with lightweight output checks. Use for scientific fact-checking and evidence synthesis; ordinary API or code behavior belongs in primary-source engineering research, not paper-count verdicts.
---

# Deep Research

Scientific evidence workflow with policy-driven classification and lightweight output checks. Classification and ordering are stable for identical evidence and relevant state; timestamps and run IDs vary. Deterministic processing does not establish source quality or scientific truth.

## Choose the evidence method

Use this classifier for scientific claims whose evidence can be represented by its study tiers. For engineering behavior, version compatibility, or API documentation, use official documentation, source code, specifications, and relevant observations directly, or an available research-orchestration skill. Report sources and uncertainty without running the paper-count classifier or describing missing papers as missing engineering evidence.

For mixed questions, separate scientific claims from engineering claims. An explicit research request does not make scientific verdict rules appropriate for every facet. State which method supports each conclusion. The runner's existing scientific policy and output schema remain unchanged.

The runner consumes pre-collected claims/evidence and an initialized state JSON. It does not retrieve sources. Use an authorized task-owned state path; no state file is bundled. Read the skill-local [isolated runner setup](references/RUNNER.md) before execution. Do not write into the installed skill directory or global memory as an incidental research side effect.

## Triggers

For these explicit entry points, first choose the evidence method above. Use the scientific pipeline when its evidence model fits:
- `/deep-research [topic]`
- `/deepresearch [topic]`
- `/dpr [topic]`
- `/dp [topic]`
- `/dr [topic]`

## Quick Start

Create a fresh task directory and initialize its state using [isolated runner setup](references/RUNNER.md). Collect verified claims and evidence into that directory, then run the documented command with every mutable input/output under the same task directory. Concurrent investigations must not share state or fixed temporary filenames. To resume an investigation, select its existing task directory explicitly instead of reinitializing its state.

Exit codes: `0` success, `1` validation/policy error, `2` partial retrieval, `3` no-evidence fallback.

## Workflow

### Phase 1: General Research (Agent-Driven)

Search the web to understand the topic. Identify up to **5** key claims to fact-check.

Write claims to a JSON file using this exact schema:

```json
[
  {
    "claim_text": "Caffeine (100-300mg) improves sustained attention",
    "evidence_required": "RCTs or meta-analyses on caffeine and attention",
    "confidence_target": 0.7
  }
]
```

Required fields per claim: `claim_text`, `evidence_required`, `confidence_target`.

### Phase 2: Scientific Fact-Check (Agent-Driven)

For each claim, search source databases **in tier order**:

| Tier | Sources | Flag |
|---|---|---|
| `peer_reviewed` | PubMed, Google Scholar | ✅ |
| `preprint` | arXiv, bioRxiv, medRxiv | 📝 |
| `community` | Reddit, StackExchange, forums | 🗨️ |
| `social` | X/Twitter | 🐦 |

**Evidence budget per claim:** 2 peer-reviewed + 1 fallback (max 5 total).

Write evidence to a JSON file:

```json
[
  {
    "claim_id": "C001",
    "sources": [
      {
        "title": "Effects of caffeine on cognitive performance",
        "authors": "Smith et al.",
        "year": 2020,
        "tier": "peer_reviewed",
        "url": "https://pubmed.ncbi.nlm.nih.gov/12345678",
        "citation": "Smith et al., \"Effects of caffeine on cognitive performance\", J. Neuroscience, 2020. https://pubmed.ncbi.nlm.nih.gov/12345678",
        "supports_claim": true,
        "relevance_note": "RCT showing improved reaction time at 200mg dose",
        "retrieved_at": "2026-02-26T10:00:00+00:00"
      }
    ]
  }
]
```

**Important:** Always trace secondary-source citations back to original papers.

### Phase 3: Deterministic Classification (Runner)

Run the deterministic runner. It applies these verdict rules from `policy.json`:

| Verdict | Rule |
|---|---|
| **Supported** | >= 2 peer-reviewed sources, agreement ratio >= 0.8 |
| **Partially Supported** | >= 1 peer-reviewed source, agreement ratio >= 0.5 |
| **Insufficient Evidence** | 0 peer-reviewed sources or no evidence at all |
| **Contradicted** | >= 1 contradicting source, agreement ratio < 0.3 |

Every verdict includes a `decision_trace` entry with `rule_id`, `inputs`, and `result`.

## Fallback Behaviors

All fallbacks are explicit and policy-defined. There is no implicit "best effort" path.

| Condition | Action | Verdict Cap |
|---|---|---|
| No peer-reviewed sources found | Descend to next tier in fallback order | `partially_supported` max |
| No sources found at all | Emit `insufficient_evidence` | `insufficient_evidence` |
| Source database unreachable | Mark partial, continue with available | Exit code 2 |
| Cannot extract claims from topic | Reject run, require explicit claims | Exit code 1 |

### Fallback Text Blocks (Verbatim)

**No peer-reviewed sources:**
```
No peer-reviewed papers found on this specific claim. Checking alternative sources.
```

**No sources at all:**
```
No evidence found across any source tier for this claim.
```

**Retrieval failure:**
```
One or more source databases were unreachable. Results may be incomplete.
```

**Claim extraction failure:**
```
Could not extract structured claims from the topic. Provide explicit claims.
```

## Output Contract

The intended output shape is described in `output-schema.json`. The runner performs lightweight checks on selected fields, not full JSON Schema validation. Required top-level fields:
`topic`, `run_id`, `policy_version`, `claims[]`, `verdict_summary`, `decision_trace[]`, `failures[]`.

Run IDs follow the pattern: `dr-YYYYMMDDTHHMMSSZ-<8-char topic hash>`.

### Deterministic Ordering

- Claims ordered by `claim_id` ascending (C001, C002, ...).
- Evidence per claim ordered by: tier (highest first) -> recency (newest first) -> URL lexical.
- Sections in fixed order: topic_summary, claims, evidence_matrix, verdict_summary, decision_trace, failures.

## Source Priority

1. **Highest:** Peer-reviewed journals (open access)
2. **Medium:** Preprints (arXiv, bioRxiv) — flag as "not peer-reviewed"
3. **Low:** Community discussions — flag as anecdotal
4. **Lowest:** Social media — flag as unverified

## Deduplication

Sources are deduped by composite key: `title_normalized + canonical_url_host + publication_year`.
URLs are normalized by stripping query parameters and fragments.

## File Inventory

```
skills/deep-research/
  SKILL.md              # This file
  policy.json           # Deterministic decision rules
  output-schema.json    # JSON Schema for output validation
  references/RUNNER.md  # Task-isolated state initialization and execution
  scripts/
    ./scripts/run_deep_research.py  # Deterministic runner (collect/normalize/classify/render/validate)
  tests/
    fixtures/             # Test input fixtures
    ./tests/test_determinism.py   # Reproducibility and schema tests
```

## Scripts Reference

### ./scripts/run_deep_research.py

| Arg | Required | Description |
|---|---|---|
| `--topic` | Yes | Research topic |
| `--topic-summary` | No | Phase 1 summary text |
| `--claims-file` | Yes | JSON file with structured claims |
| `--evidence-file` | No | JSON file with pre-collected evidence |
| `--policy` | Yes | Path to policy.json |
| `--schema` | No | Path to output-schema.json |
| `--state` | Yes | Authorized path to initialized state JSON; not bundled |
| `--output-json` | No | Write JSON output to file |
| `--output-md` | No | Write Markdown output to file |

| Exit Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Validation or policy error |
| 2 | Upstream retrieval partial |
| 3 | No-evidence fallback produced |

## Interpretation and verification

Check whether sources actually support the claim, whether their populations and methods apply, and whether sources are independent. Numerical agreement is a policy classification over supplied labels, not a measured probability of truth or a substitute for scientific appraisal. Keep conflicting evidence and methodological limitations visible even when the runner returns Supported.

Run only on verified, redacted inputs and an authorized state/output location. Keep inaccessible sources and partial retrieval explicit. Do not claim the runner searched the web, that a schema-valid result proves a claim, or that passing deterministic tests establishes research correctness.
