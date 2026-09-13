---
name: version-aware-docs
description: Ground coding or configuration advice in the exact installed dependency version, enabled flags, source, and relevant documentation passage. Do not use for version-independent local code.
license: MIT
compatibility: Portable Agent Skills-compatible workflow. The Pi adapter records receipt-bound dependency evidence through the reliability extension when available.
---

# Version-aware documentation

Use the documentation and source that match the dependency the project actually has installed. Another major version, a generic web snippet, or a model recollection is not a substitute for exact version evidence.

## When to Use

### Should trigger

- “Configure this installed framework feature according to the project’s current version.”
- “Update code that depends on a CLI option or runtime API whose behavior changed across releases.”
- “Use the library’s installed type signatures to repair this version-sensitive integration.”

### Should not trigger

- “Explain a version-independent language construct.”
- “Repair a purely local function whose implementation and callers are already in the repository.”
- “Write documentation that does not make a dependency-version claim.”

## Invocation Design

- Invocation mode: model-invoked when an external versioned contract affects a coding/configuration decision.
- Leading concept: **exact installed version before advice**.
- Completion criterion: version, enabled flags when applicable, source locator, and supporting passage are recorded or the result stays unknown/escalates.

## Inputs and Assumptions

Identify the dependency, manifest and lockfile locations, package manager, installed source/types or binary, relevant feature flags, expected API/CLI/schema behavior, and the specific decision the evidence must support. Treat manifests, lockfiles, installed source, upstream documentation, and model summaries as distinct sources.

## Portable Workflow

1. Inspect the manifest and lockfile for the dependency declaration and resolved version.
   - Completion criterion: the selected package and exact resolved version are known.
2. Inspect installed source, types, local help, or version-matched bundled documentation.
   - Completion criterion: a relevant signature, option, or behavior passage is available.
3. If local evidence is insufficient, locate official versioned documentation or the exact source tag.
   - Completion criterion: the external source is authoritative for the resolved version, not merely similar.
4. Record the version, enabled feature flags, source locator, and exact relevant passage.
   - Completion criterion: another reviewer can trace the advice to the selected version.
5. Apply only advice consistent with that evidence; reject cross-major assumptions.
   - Completion criterion: unsupported or conflicting advice is marked unknown, blocked, or escalated.

## Safety and Side Effects

Do not install, upgrade, downgrade, regenerate locks, or change dependency declarations merely to obtain documentation. Do not infer resolved versions from a manifest range alone. Do not use an old major-version example as compatibility proof. If manifest, lockfile, installed source, or source passage disagree, stop and surface the conflict.

## Scripts, References, and Dependencies

No installation or live query is required. Read [version evidence](references/VERSION-EVIDENCE.md) before recording a version-sensitive conclusion.

## Verification

Verify that package name and exact version agree across manifest/lock/source evidence, feature flags are stated when relevant, the source passage supports the concrete claim, and the final patch/check uses the same versioned contract. A local-only change should say dependency evidence was not required rather than fabricate a record.

## Pi Adapter

- Resolve an ordinary/queued instruction pause with `/reliability input confirm` before proceeding; expanded template or skill text is not raw-input authority.
- Match the actual resolved installed package root, not a copied or decoy manifest. Linked/symlinked, virtual-store, and unsupported layouts remain unknown. A claimed passage must match the inspected source bytes.

- Read the manifest, optional lockfile, installed source/types, and relevant documentation passage through normal host tools before recording evidence.
- Call `reliability_evidence` action `record-dependency` with the exact package/version, manifest path, source kind/ID, and passage IDs. Add `lockfilePath` only when the lock is available and supported; it is optional, never invented.
- A supplied manifest or lockfile must be a real non-symlink workspace JSON file no larger than 2 MiB. The lock reader recognizes supported npm `packages` or legacy `dependencies` entries. For a large, unsupported, or unavailable lockfile, use a bounded host parser or omit the optional lock path and report the resulting limit; do not claim a resolved lock version.
- The coding completion gate requires passing behavior validation and valid dependency evidence for each external package it detects in changed static imports, not merely contracts named by a declared coding criterion. Dynamic, alias, unreadable, deleted, and non-code changes receive exact-diff local-only review instead of an unproven exemption.
