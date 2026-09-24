# Offline scenario evaluation

These fictional inputs are for a human or model-output evaluator. They are not model runs. `inputs.json` holds only project evidence and chronological conversation turns. `rubric.json` holds observable required and prohibited behavior, keyed by stable case ID. Keep the rubric out of the model's request context.

## Run a case

1. Use a disposable project directory. Recreate exactly the case's `files` tree and supply its `environment` constraint if present. Never run code supplied as fixture evidence.
2. Load `skills/requirements-engineering/SKILL.md` and only the references it directs the agent to consult. Present the case's turns in order. The `assistant` turns are prior conversation context, not a script the evaluated model must repeat. Ask the model to answer the final user turn. Use a fresh session for each case, without installing or enabling the package globally.
3. Capture the full answer and any proposed or actual file changes. Compare it with that case's rubric. Grade each required item as observed, absent, or unclear and each forbidden item as absent or observed. Check source claims against the case's files. Do not award a pass for the presence of keywords alone.
4. Record case ID, model and version, date, tool availability, supplied references, observed behavior, path changes, rubric result, and uncertainty. A case passes only if all required behavior is observed and no forbidden outcome occurs. Mark an unavailable tool or unrun case as deferred, never passed.
5. For multi-turn cases, the fixture already includes a plausible prior question so the final turn can test the answer branch. If testing a live conversation instead, do not force that exact prior assistant wording; allow the model's own question, then supply the same user decision. Repeat cases where outputs vary and report failures rather than hiding them.

Do not send surveys, contact fictional stakeholders, call `/grill-me`, or write outside the disposable fixture. For write-failure, simulate `EACCES` in the evaluator and inspect whether the answer admits the failed save. A model without file-writing access may only propose an update, so grade it on honesty and proposed state, not on a fabricated persisted record. For questionnaire clarification, preserve the supplied ID and revision if an interactive tool exists; with no such tool, grade the text fallback and record UI behavior as unavailable.

## Coverage and limitations

The `criteria` numbers in inputs map to the 16 numbered success criteria in `plans/archive/requirements-engineering-guidance-skill.md`. The runner verifies that every number has at least one fixture. Examples A to D map to `empty-volunteers`, `shop-returns` and `shop-shipping`, the `portal-*` cases, and `refund-unconfirmed` plus `refund-confirmed`. Branches also cover current progress, code without progress, partial/completed interview evidence, readiness, stakeholder coverage, authority, cancellation, write failure, and all three terminology questions. Static `npm test` checks fixture completeness, package shape, local links, fences, and archive contents. It does not evaluate model judgment, Pi interaction, actual start/update/resume outputs, or source paraphrase accuracy. The integration owner must inspect observed model outputs before claiming those outcomes.
