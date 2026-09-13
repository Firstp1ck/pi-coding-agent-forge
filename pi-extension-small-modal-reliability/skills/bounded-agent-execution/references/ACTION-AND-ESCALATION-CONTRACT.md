# Action and escalation contract

Use this contract to keep multi-step work bounded.

## Before an action

Record the outcome, the active step, allowed tools and resources, path boundaries, budgets, validation checks, and stop conditions. A boundary is enforceable only when its values are explicit.

## Mutation preconditions

For an existing file, inspect the exact current target before modifying it. The read must complete at the current workspace revision; a parallel or pending sibling read is not evidence. Normalize paths from the task workspace and reject traversal, unresolved paths, or symlink escapes before a protected write.

Treat an unknown tool as potentially mutating until a trusted host integration classifies it. Tool visibility does not grant permission.

## Shell and effects

A shell action requires a current native-confirmed mutating scope and a single-use native approval for its exact normalized effect. A model-provided validation string is metadata for a verifier, not independent shell authority. A criterion/check mapping can describe which observed result covers a criterion; it is never shell permission. An approval binds one normalized tool effect, current scope, task/branch/session, and expiry window; consume it before execution so concurrent calls cannot reuse it.

If an effect is uncertain, headless, expired, changed, or outside scope, block it. Requesting approval never grants it.

## Recovery and stopping

Count attempts, errors, and iterations independently. After an equivalent failure, choose a cheap discriminating check rather than replaying the same action. Stop and report a blocker when any configured budget, side-effect boundary, or escalation condition is reached. Do not broaden scope, create a new approval, or repeat a non-idempotent action automatically.

## Result reporting

Report the completed artifact and actual verification outcomes separately from model claims. A partial result is valid when it names the completed boundary, the unresolved blocker, and the next safe decision.
