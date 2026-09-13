---
name: small-model-regression-eval
description: Plan and report a bounded comparison of fixed small-model task fixtures without claiming unrun live results or substituting a model/provider. Do not use for normal task execution.
license: MIT
compatibility: Portable Agent Skills-compatible workflow. The Pi adapter produces offline reports and never calls a live provider unless a separately authorized adapter exists.
---

# Small-model regression evaluation

Use this skill to compare a model, quantization, prompt, guard profile, or skill revision against frozen independent outcomes. It separates deterministic mechanism tests from live model quality results.

## When to use

### Should trigger

- “Compare this configured local model with the guarded workflow on held-out tasks.”
- “Report whether a reliability revision regressed retrieval, agentic, or coding fixtures.”
- “Create a baseline-versus-integrated evaluation plan without making live calls.”

### Should not trigger

- “Implement this feature.”
- “Use a model to solve the current task.”
- “Publish or enable a model.”

## Inputs

Provide a frozen task suite, independent expected outcomes, exact provider/model ID, quantization and sampling settings when applicable, package revision, guard profile, tool configuration, timeout, sample budget, and whether assisted mode is separately authorized.

## Portable workflow

1. Freeze sanitized task inputs and independent success checks before tuning.
2. Run deterministic guard fixtures separately from model executions.
3. Compare baseline, current extension, isolated feature, integrated guarded, and separately authorized assisted configurations.
4. Keep assisted results in their own column; do not combine them with small-model-only scores.
5. Record exact model/provider identity and all execution settings for every live run.
6. Report unavailable live evaluation truthfully instead of substituting a model, provider, or adapter.

## Safety and reporting boundary

Do not use the extension completion gate as the evaluation oracle. Do not make network or provider calls merely because a model name was supplied. Never claim an improvement from fixtures, mechanism tests, or unrun configurations.

## Verification

Verify that each actual task outcome is checked by an independent oracle, frozen inputs remain unchanged, configuration identity is complete, failures are retained, and unavailable live execution records zero calls with a reason.

## Pi adapter

Pending ordinary/queued instructions require `/reliability input confirm` before an evaluation can proceed. This creates new native task authority, not proof of prior ingress; it never substitutes for the exact-model evaluation dialog. Sanitization/redaction is pattern-limited best effort: inspect the disclosed packet and do not assume it is secret-free.

Run `/reliability eval --suite retrieval|agentic|coding|all [--model provider/id] [--run] [--write]`. The default adapter is offline-only: it reports frozen fixtures and exactly why a requested live run is unavailable. `--run` needs one exact configured model, an available matching native adapter, and native confirmation of the sanitized case packet; a UI-capable RPC invocation may show that dialog, while no-UI paths make zero calls. Without `--run`, no provider is called. An approved live run never substitutes another provider or model.
